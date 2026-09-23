/**
 * Serialises an archive model to a Slack-import ZIP and, optionally, an
 * unpacked directory for inspection. Also prints the build report.
 */
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { ZipFile } from 'yazl';
import type { ArchiveModel } from '../../types/slack-export';
import { kindLabel } from './messages';

export interface ArchiveEntry {
  path: string;
  content: string;
}

export interface WriteArchiveOptions {
  zipPath?: string;
  unpackedDir?: string;
}

export interface WriteArchiveResult {
  zipPath?: string;
  unpackedDir?: string;
  /** Entries in the ZIP itself. */
  entries: number;
  /** Manifest and file lists written beside the ZIP. */
  sidecars: string[];
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/**
 * Every file Slack's importer reads, in a stable order. Pure. The manifest and
 * file lists are deliberately not here: the importer has no use for them, and
 * they hold every person's address. See `sidecarEntries`.
 */
export function archiveEntries(model: ArchiveModel): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [
    { path: 'users.json', content: json(model.users) },
    { path: 'channels.json', content: json(model.channels) },
    { path: 'groups.json', content: json(model.groups) },
    { path: 'dms.json', content: json(model.dms) },
    { path: 'mpims.json', content: json(model.mpims) },
    { path: 'integration_logs.json', content: json([]) },
  ];
  const sorted = [...model.conversations].sort((a, b) =>
    a.plan.name.localeCompare(b.plan.name)
  );
  for (const conversation of sorted) {
    const days = Object.keys(conversation.days).sort();
    for (const day of days) {
      entries.push({
        path: `${conversation.plan.name}/${day}.json`,
        content: json(conversation.days[day]),
      });
    }
  }
  return entries;
}

/** Files the tooling needs beside the archive: manifest, upload and host lists. */
export function sidecarEntries(model: ArchiveModel): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [
    { path: 'archive-manifest.json', content: json(model.manifest) },
  ];
  if (model.manifest.files.strategy === 'manifest') {
    entries.push({
      path: 'files-to-upload.json',
      content: json(model.uploads),
    });
  } else {
    entries.push({
      path: 'hosted-files.json',
      content: json(model.hostedFiles),
    });
  }
  return entries;
}

/** `archive.zip` → `archive.archive-manifest.json`, beside the ZIP. */
export function sidecarPath(zipPath: string, name: string): string {
  const base = zipPath.endsWith('.zip') ? zipPath.slice(0, -4) : zipPath;
  return `${base}.${name}`;
}

async function writeZip(
  entries: ArchiveEntry[],
  zipPath: string
): Promise<void> {
  await mkdir(path.dirname(zipPath), { recursive: true });
  const zip = new ZipFile();
  for (const entry of entries) {
    zip.addBuffer(Buffer.from(entry.content, 'utf-8'), entry.path, {
      mtime: new Date(),
      mode: 0o644,
    });
  }
  zip.end();
  await pipeline(zip.outputStream, createWriteStream(zipPath));
}

async function writeUnpacked(
  entries: ArchiveEntry[],
  dir: string
): Promise<void> {
  for (const entry of entries) {
    const target = path.join(dir, entry.path);
    // biome-ignore lint/nursery/noAwaitInLoop: sequential writes keep directory creation simple.
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, entry.content, 'utf-8');
  }
}

export async function writeArchive(
  model: ArchiveModel,
  options: WriteArchiveOptions
): Promise<WriteArchiveResult> {
  const entries = archiveEntries(model);
  const sidecars = sidecarEntries(model);
  const sidecarPaths: string[] = [];
  if (options.zipPath) {
    const { zipPath } = options;
    await writeZip(entries, zipPath);
    for (const sidecar of sidecars) {
      const target = sidecarPath(zipPath, sidecar.path);
      // biome-ignore lint/nursery/noAwaitInLoop: a handful of small files.
      await writeFile(target, sidecar.content, 'utf-8');
      sidecarPaths.push(target);
    }
  }
  if (options.unpackedDir) {
    // The unpacked copy is for inspection, so it carries the sidecars too.
    await writeUnpacked([...entries, ...sidecars], options.unpackedDir);
  }
  return {
    zipPath: options.zipPath,
    unpackedDir: options.unpackedDir,
    entries: entries.length,
    sidecars: sidecarPaths,
  };
}

/** Conversations the importer will drop because a participant cannot be mapped. */
export function conversationsAtRisk(
  model: ArchiveModel
): { name: string; kind: string; messages: number; unmapped: string[] }[] {
  const unmappable = new Map<string, string>();
  for (const mapping of Object.values(model.manifest.users)) {
    if (mapping.importAction === 'no-email' || mapping.guest) {
      unmappable.set(mapping.slackId, mapping.name);
    }
  }
  const atRisk: ReturnType<typeof conversationsAtRisk> = [];
  for (const c of model.conversations) {
    if (c.plan.kind !== 'dm' && c.plan.kind !== 'mpim') {
      continue;
    }
    const unmapped = c.plan.members
      .filter((id) => unmappable.has(id))
      .map((id) => unmappable.get(id) ?? id);
    if (unmapped.length > 0) {
      atRisk.push({
        name: c.plan.name,
        kind: c.plan.kind,
        messages: c.messageCount,
        unmapped,
      });
    }
  }
  return atRisk.sort((a, b) => b.messages - a.messages);
}

function printMappingRisks(model: ArchiveModel): void {
  const m = model.manifest;
  if (!m.options.slackMembersFetchedAt) {
    console.log(
      '   ⚠️  Built without a Slack member snapshot; run `slack-members` and pass --slack-members to see who merges.'
    );
  }
  if (m.totals.guests > 0) {
    console.log(
      `   ⚠️  ${m.totals.guests} person(s) match a guest account, which Slack will not merge into; handle by hand.`
    );
  }
  const atRisk = conversationsAtRisk(model);
  if (atRisk.length === 0) {
    return;
  }
  const messages = atRisk.reduce((sum, c) => sum + c.messages, 0);
  console.log(
    `   ⚠️  ${atRisk.length} DM/group DM(s) holding ${messages} messages include someone with no address and will be dropped by the importer. Use --placeholder-email-domain. Largest:`
  );
  for (const c of atRisk.slice(0, 5)) {
    console.log(
      `     ${c.name.padEnd(40)} ${String(c.messages).padStart(6)} msgs · ${c.unmapped.join(', ')}`
    );
  }
}

export function printArchiveReport(model: ArchiveModel, dryRun: boolean): void {
  const m = model.manifest;
  const t = m.totals;
  console.log(`\n📦 ${dryRun ? '[Dry run] ' : ''}Slack archive`);
  console.log(
    `   People: ${t.users} · ${t.merge} merge into existing members · ${t.deactivated} created deactivated · ${t.noEmail} with no address · ${t.placeholders} placeholders`
  );
  printMappingRisks(model);
  console.log(
    `   Conversations: ${t.channels} public channels · ${t.groups} private channels · ${t.dms} DMs · ${t.mpims} group DMs · ${t.skippedConversations} skipped`
  );
  console.log(
    `   Messages: ${t.messages} written · ${t.omittedMessages} omitted (deleted policy "${m.options.deletedPolicy}" or delta cut-off)`
  );
  const f = m.files;
  const fileLine =
    f.strategy === 'hosted'
      ? `${f.hosted} referenced from ${m.options.filesBaseUrl ?? '(no base URL)'}`
      : `${f.uploads} queued in files-to-upload.json for the post-import uploader`;
  console.log(
    `   Files: ${fileLine} · ${f.linkOnly} Drive links kept as links · ${f.unavailable} unavailable`
  );

  const kinds = new Map<string, number>();
  for (const c of model.conversations) {
    kinds.set(c.plan.kind, (kinds.get(c.plan.kind) ?? 0) + 1);
  }
  const largest = [...model.conversations]
    .sort((a, b) => b.messageCount - a.messageCount)
    .slice(0, 8);
  if (largest.length > 0) {
    console.log('   Largest conversations:');
    for (const c of largest) {
      console.log(
        `     ${c.plan.name.padEnd(40)} ${kindLabel(c.plan.kind).padEnd(16)} ${String(c.messageCount).padStart(6)} msgs · ${c.plan.members.length} members`
      );
    }
  }
  const skipped = Object.values(m.conversations).filter((c) => c.skippedReason);
  if (skipped.length > 0) {
    console.log(
      `   Skipped: ${skipped.length} conversation(s), e.g. ${skipped[0].skippedReason}`
    );
  }
  if (m.warnings.length > 0) {
    console.log(
      `   ⚠️  ${m.warnings.length} warning(s); first: ${m.warnings[0]}`
    );
  }
}
