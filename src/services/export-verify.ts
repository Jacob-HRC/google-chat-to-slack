/**
 * Integrity and completeness checks for the workspace export store.
 *
 * - Store vs Google: re-lists every space and compares message sets.
 * - Files: every downloaded attachment exists and hashes to what was recorded.
 * - People: how many references still lack a directory record.
 */
import type {
  AttachmentRecord,
  StoredMessage,
  StoredSpace,
} from '../types/export-store';
import { digestFile, fileExists } from '../utils/fs-atomic';
import type { Logger } from '../utils/logger';
import { listMessagesAs } from './chat-reader';
import {
  type ExportStore,
  listStoredSpaceIds,
  loadAttachmentIndex,
  loadMessages,
  loadSpace,
  loadUsers,
  openStore,
} from './export-store';
import { describeGoogleError } from './google-auth';
import { matchesSpaceFilter } from './workspace-export';

export interface VerifyOptions {
  outputDir: string;
  /** Re-list messages from Google and compare. */
  live: boolean;
  /** Hash every downloaded file. */
  files: boolean;
  spaceFilter: string[];
}

export interface SpaceVerifyResult {
  spaceId: string;
  displayName: string;
  spaceType: string;
  stored: { total: number; deleted: number; missing: number; active: number };
  live?: { total: number; deleted: number; active: number };
  lastMessageAt?: string;
  liveLastMessageAt?: string;
  issues: string[];
  ok: boolean;
}

export interface AttachmentVerifyResult {
  records: number;
  verified: number;
  linkOnly: number;
  pending: number;
  failed: number;
  missingFile: number;
  hashMismatch: number;
  issues: string[];
}

export interface VerifyReport {
  checkedAt: string;
  outputDir: string;
  spaces: SpaceVerifyResult[];
  attachments: AttachmentVerifyResult;
  users: { total: number; placeholders: number; unresolved: number };
  ok: boolean;
}

function storedCounts(messages: StoredMessage[]): SpaceVerifyResult['stored'] {
  const deleted = messages.filter((m) => m.isDeleted).length;
  const missing = messages.filter((m) => m.missingSince && !m.isDeleted).length;
  return {
    total: messages.length,
    deleted,
    missing,
    active: messages.length - deleted - missing,
  };
}

function lastCreateTime(
  messages: Array<{ createTime?: string | null }>
): string | undefined {
  let last: string | undefined;
  for (const message of messages) {
    if (message.createTime && (!last || message.createTime > last)) {
      last = message.createTime;
    }
  }
  return last;
}

async function compareWithLive(
  space: StoredSpace,
  messages: StoredMessage[],
  result: SpaceVerifyResult,
  logger: Logger
): Promise<void> {
  try {
    const live = await listMessagesAs(space.readerSubject, space.name);
    const liveDeleted = live.filter((m) => m.deleteTime).length;
    result.live = {
      total: live.length,
      deleted: liveDeleted,
      active: live.length - liveDeleted,
    };
    result.liveLastMessageAt = lastCreateTime(live);

    const storedNames = new Set(messages.map((m) => m.name));
    const liveNames = new Set(live.map((m) => m.name ?? ''));
    const notStored = live.filter((m) => !storedNames.has(m.name ?? ''));
    const notLive = messages.filter(
      (m) => !(m.isDeleted || m.missingSince || liveNames.has(m.name))
    );
    if (notStored.length > 0) {
      result.issues.push(
        `${notStored.length} message(s) exist in Google but not in the store (run export-workspace again)`
      );
    }
    if (notLive.length > 0) {
      result.issues.push(
        `${notLive.length} stored message(s) are no longer returned by Google and are not marked deleted or missing`
      );
    }
    if (result.stored.deleted !== liveDeleted) {
      result.issues.push(
        `deleted count differs: store ${result.stored.deleted}, Google ${liveDeleted}`
      );
    }
  } catch (error) {
    const message = describeGoogleError(error);
    result.issues.push(`live comparison failed: ${message}`);
    logger.addError('verify', space.spaceId, message);
  }
}

async function verifySpaces(
  store: ExportStore,
  options: VerifyOptions,
  logger: Logger
): Promise<SpaceVerifyResult[]> {
  const results: SpaceVerifyResult[] = [];
  for (const spaceId of await listStoredSpaceIds(store)) {
    // biome-ignore lint/nursery/noAwaitInLoop: spaces verified sequentially to keep API load predictable.
    const space = await loadSpace(store, spaceId);
    if (!(space && matchesSpaceFilter(space.raw, options.spaceFilter))) {
      continue;
    }
    const messages = await loadMessages(store, spaceId);
    const result: SpaceVerifyResult = {
      spaceId,
      displayName: space.derivedDisplayName ?? space.displayName,
      spaceType: space.spaceType,
      stored: storedCounts(messages),
      lastMessageAt: lastCreateTime(messages),
      issues: [],
      ok: true,
    };
    if (options.live) {
      await compareWithLive(space, messages, result, logger);
    }
    result.ok = result.issues.length === 0;
    results.push(result);
  }
  return results;
}

async function verifyRecord(
  record: AttachmentRecord,
  options: VerifyOptions,
  summary: AttachmentVerifyResult
): Promise<void> {
  if (record.status === 'link-only' || record.status === 'skipped') {
    summary.linkOnly += 1;
    return;
  }
  if (record.status === 'pending') {
    summary.pending += 1;
    return;
  }
  if (record.status === 'failed') {
    summary.failed += 1;
    summary.issues.push(
      `${record.key}: download failed (${record.error ?? 'unknown'})`
    );
    return;
  }
  if (!(record.localPath && (await fileExists(record.localPath)))) {
    summary.missingFile += 1;
    summary.issues.push(
      `${record.key}: file missing at ${record.localPath ?? '(none)'}`
    );
    return;
  }
  if (options.files && record.sha256) {
    const digest = await digestFile(record.localPath);
    if (digest.sha256 !== record.sha256 || digest.size !== record.size) {
      summary.hashMismatch += 1;
      summary.issues.push(
        `${record.key}: content changed on disk since download`
      );
      return;
    }
  }
  summary.verified += 1;
}

async function verifyAttachments(
  store: ExportStore,
  options: VerifyOptions,
  spaceIds: Set<string>
): Promise<AttachmentVerifyResult> {
  const index = await loadAttachmentIndex(store);
  const summary: AttachmentVerifyResult = {
    records: 0,
    verified: 0,
    linkOnly: 0,
    pending: 0,
    failed: 0,
    missingFile: 0,
    hashMismatch: 0,
    issues: [],
  };
  for (const record of Object.values(index)) {
    if (!spaceIds.has(record.spaceId)) {
      continue;
    }
    summary.records += 1;
    // biome-ignore lint/nursery/noAwaitInLoop: hashing files one at a time bounds memory use.
    await verifyRecord(record, options, summary);
  }
  return summary;
}

export async function verifyExportStore(
  options: VerifyOptions,
  logger: Logger
): Promise<VerifyReport> {
  const store = await openStore(options.outputDir);
  const spaces = await verifySpaces(store, options, logger);
  const attachments = await verifyAttachments(
    store,
    options,
    new Set(spaces.map((s) => s.spaceId))
  );
  const users = Object.values(await loadUsers(store));
  const report: VerifyReport = {
    checkedAt: new Date().toISOString(),
    outputDir: options.outputDir,
    spaces,
    attachments,
    users: {
      total: users.length,
      placeholders: users.filter((u) => u.isPlaceholder).length,
      unresolved: users.filter((u) => u.status === 'unknown').length,
    },
    ok:
      spaces.every((s) => s.ok) &&
      attachments.failed === 0 &&
      attachments.missingFile === 0 &&
      attachments.hashMismatch === 0 &&
      attachments.pending === 0,
  };
  return report;
}

export function printVerifyReport(report: VerifyReport): void {
  console.log(`\n🔍 Export verification (${report.outputDir})`);
  for (const s of report.spaces) {
    const icon = s.ok ? '✔' : '✖';
    const live = s.live
      ? ` · Google ${s.live.active} active / ${s.live.deleted} deleted`
      : '';
    console.log(
      `${icon} ${s.displayName || s.spaceId} (${s.spaceType}) · store ${s.stored.active} active / ${s.stored.deleted} deleted / ${s.stored.missing} missing${live}`
    );
    for (const issue of s.issues) {
      console.log(`     - ${issue}`);
    }
  }
  const a = report.attachments;
  console.log(
    `\nAttachments: ${a.records} records · ${a.verified} verified · ${a.linkOnly} link-only · ${a.pending} pending · ${a.failed} failed · ${a.missingFile} missing files · ${a.hashMismatch} hash mismatches`
  );
  for (const issue of a.issues.slice(0, 20)) {
    console.log(`     - ${issue}`);
  }
  if (a.issues.length > 20) {
    console.log(`     … ${a.issues.length - 20} more`);
  }
  console.log(
    `People: ${report.users.total} referenced · ${report.users.placeholders} placeholders · ${report.users.unresolved} unresolved`
  );
  console.log(
    report.ok
      ? '\n✅ Export store is complete and consistent.'
      : '\n❌ Export store has issues; see above.'
  );
}
