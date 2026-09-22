/**
 * Folds a Google Vault Chat export into the workspace store.
 *
 * The Chat API path is authoritative. Vault data is lower fidelity by nature:
 * second-precision timestamps, no threads, no reactions, no edit or delete
 * history. So this importer only ever *fills gaps*:
 *
 * - a Space that already holds Chat API messages is skipped entirely,
 * - a message id already present from the API is never replaced,
 * - everything it does write is tagged `source: 'vault'` so later passes and
 *   the Slack archive can tell the two apart.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  AttachmentRecord,
  RecordSource,
  StoredMembership,
  StoredMessage,
  StoredSpace,
  StoredUser,
} from '../../types/export-store';
import { safeFilename } from '../../utils/fs-atomic';
import type { Logger } from '../../utils/logger';
import { compareTimestamps, toSlackTs } from '../../utils/timestamps';
import {
  attachmentsFilesDir,
  type ExportStore,
  listStoredSpaceIds,
  loadAttachmentIndex,
  loadMessages,
  loadSpace,
  loadUsers,
  saveAttachmentIndex,
  saveMessages,
  saveSpace,
  saveState,
  saveUsers,
} from '../export-store';
import { assignAttachments, parseVaultHtml, type VaultMessage } from './html';
import { streamMboxDocuments } from './mbox';
import {
  parseVaultMetadata,
  summarizeSpaces,
  type VaultDocumentMetadata,
  type VaultSpaceInfo,
} from './metadata';
import { type MimeDocument, parseMimeDocument } from './mime';

const VAULT_SOURCE: RecordSource = 'vault';

export interface VaultImportOptions {
  mboxPath: string;
  metadataPath: string;
  runId: string;
  /** Write nothing; report what would change. */
  dryRun: boolean;
  /** Import even into Spaces that already hold Chat API messages. Off by default. */
  allowApiSpaces: boolean;
  /** Only these space ids. Empty means all. */
  spaceFilter: string[];
  logger: Logger;
}

export interface VaultSpaceResult {
  spaceId: string;
  roomName: string;
  conversationType: string;
  documents: number;
  messagesParsed: number;
  messagesAdded: number;
  messagesSkippedExisting: number;
  attachments: number;
  attachmentBytes: number;
  participants: number;
  skippedReason?: string;
}

export interface VaultImportReport {
  runId: string;
  mboxPath: string;
  dryRun: boolean;
  spaces: VaultSpaceResult[];
  totals: {
    spaces: number;
    spacesSkipped: number;
    documents: number;
    messagesParsed: number;
    messagesAdded: number;
    messagesSkippedExisting: number;
    attachments: number;
    attachmentBytes: number;
    usersCreated: number;
    messagesWithoutTimestamp: number;
  };
}

/**
 * Chat API message names duplicate the id (`abc.abc`); Vault renders the bare
 * id (`abc`). Compare on the leading segment so the same message from either
 * source collapses to one key.
 */
export function messageKey(messageIdOrName: string): string {
  const afterPrefix =
    messageIdOrName.split('/messages/').pop() ?? messageIdOrName;
  return afterPrefix.split('.')[0];
}

/** Synthesises a Chat-style user id for someone only seen as an email. */
export function syntheticUserId(email: string): string {
  const digest = createHash('sha256').update(email.toLowerCase()).digest('hex');
  return `users/vault-${digest.slice(0, 16)}`;
}

interface UserIndex {
  byEmail: Map<string, StoredUser>;
  users: Record<string, StoredUser>;
  created: number;
}

function buildUserIndex(users: Record<string, StoredUser>): UserIndex {
  const byEmail = new Map<string, StoredUser>();
  for (const user of Object.values(users)) {
    if (user.email) {
      byEmail.set(user.email.toLowerCase(), user);
    }
  }
  return { byEmail, users, created: 0 };
}

/** Existing person for an email, or a new Vault-sourced placeholder. */
export function resolveByEmail(
  index: UserIndex,
  email: string,
  runId: string,
  now: string
): StoredUser {
  const normalized = email.toLowerCase();
  const existing = index.byEmail.get(normalized);
  if (existing) {
    return existing;
  }
  const user: StoredUser = {
    chatUserId: syntheticUserId(normalized),
    source: VAULT_SOURCE,
    email: normalized,
    fullName: normalized,
    status: 'deleted',
    isPlaceholder: true,
    placeholderName: normalized,
    sources: ['sender'],
    firstSeenRun: runId,
    lastResolvedAt: now,
    lastResolvedRun: runId,
  };
  index.byEmail.set(normalized, user);
  index.users[user.chatUserId] = user;
  index.created += 1;
  return user;
}

function toStoredMessage(
  parsed: VaultMessage,
  spaceId: string,
  senderId: string | undefined,
  createTime: string,
  runId: string,
  now: string
): StoredMessage {
  const name = `spaces/${spaceId}/messages/${parsed.messageId}`;
  const text = parsed.viaUser
    ? `${parsed.text}\n_(relayed by an app on behalf of ${parsed.viaUser})_`
    : parsed.text;
  return {
    name,
    source: VAULT_SOURCE,
    messageId: parsed.messageId,
    spaceId,
    createTime,
    slackTs: toSlackTs(createTime),
    senderId,
    senderType: 'HUMAN',
    threadReply: false,
    text,
    mentions: [],
    links: [],
    reactions: [],
    attachmentKeys: [],
    isDeleted: false,
    contentHash: createHash('sha256')
      .update(`${parsed.messageId}\u0000${text}`)
      .digest('hex'),
    raw: {
      name,
      createTime,
      text,
      sender: senderId ? { name: senderId, type: 'HUMAN' } : undefined,
    },
    history: [],
    firstSeenRun: runId,
    firstSeenAt: now,
    lastSeenRun: runId,
    lastSeenAt: now,
  };
}

function membershipsFor(
  spaceId: string,
  participants: Iterable<string>,
  index: UserIndex,
  runId: string,
  now: string
): StoredMembership[] {
  const memberships: StoredMembership[] = [];
  for (const email of participants) {
    const user = resolveByEmail(index, email, runId, now);
    memberships.push({
      name: `spaces/${spaceId}/members/${user.chatUserId.split('/').pop()}`,
      chatUserId: user.chatUserId,
      memberType: 'HUMAN',
      state: 'JOINED',
      raw: { member: { name: user.chatUserId, type: 'HUMAN' } },
    });
  }
  return memberships;
}

interface SpaceAccumulator {
  spaceId: string;
  info: {
    roomName: string;
    conversationType: string;
    participants: Set<string>;
  };
  documents: number;
  parsed: VaultMessage[];
  /** Records for files already written to disk; bodies are never retained. */
  attachments: AttachmentRecord[];
  attachmentSeq: number;
}

/**
 * Writes one attachment out as soon as its document is parsed. The body is
 * released immediately afterwards; holding 3 GB of attachments in memory is
 * what an earlier version got wrong.
 */
async function writeAttachment(
  store: ExportStore,
  spaceId: string,
  messageId: string,
  originalName: string,
  body: Buffer,
  index: number,
  dryRun: boolean
): Promise<AttachmentRecord> {
  const fileName = safeFilename(originalName, `vault-file-${index}`);
  const dir = path.join(
    attachmentsFilesDir(store.rootDir),
    spaceId,
    'vault',
    safeFilename(messageId, 'msg')
  );
  const localPath = path.join(dir, fileName);
  const sha256 = createHash('sha256').update(body).digest('hex');
  if (!dryRun) {
    await mkdir(dir, { recursive: true });
    await writeFile(localPath, body);
  }
  return {
    key: `${spaceId}/${messageId}/vault-${index}`,
    source: VAULT_SOURCE,
    kind: 'UPLOADED_CONTENT',
    spaceId,
    messageName: `spaces/${spaceId}/messages/${messageId}`,
    index,
    contentName: originalName,
    policy: 'download',
    status: 'downloaded',
    localPath,
    fileName,
    size: body.length,
    sha256,
    downloadedBy: 'google-vault',
    downloadedAt: new Date().toISOString(),
    attempts: 1,
  };
}

async function importSpace(
  store: ExportStore,
  accumulator: SpaceAccumulator,
  index: UserIndex,
  options: VaultImportOptions,
  attachmentIndex: Record<string, AttachmentRecord>
): Promise<VaultSpaceResult> {
  const now = new Date().toISOString();
  const { spaceId } = accumulator;
  const result: VaultSpaceResult = {
    spaceId,
    roomName: accumulator.info.roomName,
    conversationType: accumulator.info.conversationType,
    documents: accumulator.documents,
    messagesParsed: accumulator.parsed.length,
    messagesAdded: 0,
    messagesSkippedExisting: 0,
    attachments: 0,
    attachmentBytes: 0,
    participants: accumulator.info.participants.size,
  };

  const existingSpace = await loadSpace(store, spaceId);
  const existingMessages = await loadMessages(store, spaceId);
  const apiMessages = existingMessages.filter(
    (message) => (message.source ?? 'chat-api') === 'chat-api'
  );
  if (apiMessages.length > 0 && !options.allowApiSpaces) {
    result.skippedReason = `already holds ${apiMessages.length} Chat API message(s); the API copy is higher fidelity`;
    return result;
  }

  const existingKeys = new Set(
    existingMessages.map((message) => messageKey(message.name))
  );
  const merged = [...existingMessages];
  const added: StoredMessage[] = [];

  for (const parsed of accumulator.parsed) {
    const key = messageKey(parsed.messageId);
    if (existingKeys.has(key)) {
      result.messagesSkippedExisting += 1;
      continue;
    }
    if (!parsed.createTime) {
      options.logger.addWarning(
        'store',
        `${spaceId}/${parsed.messageId}`,
        'Vault rendered no timestamp for this message; skipped'
      );
      continue;
    }
    const sender = parsed.senderEmail
      ? resolveByEmail(index, parsed.senderEmail, options.runId, now)
      : undefined;
    const message = toStoredMessage(
      parsed,
      spaceId,
      sender?.chatUserId,
      parsed.createTime,
      options.runId,
      now
    );
    existingKeys.add(key);
    merged.push(message);
    added.push(message);
    result.messagesAdded += 1;
  }

  const byMessageId = new Map(added.map((m) => [m.messageId, m]));
  for (const record of accumulator.attachments) {
    const owner = byMessageId.get(messageKey(record.messageName));
    if (!owner) {
      continue;
    }
    attachmentIndex[record.key] = record;
    owner.attachmentKeys.push(record.key);
    result.attachments += 1;
    result.attachmentBytes += record.size ?? 0;
  }

  merged.sort((a, b) => compareTimestamps(a.createTime, b.createTime));

  if (options.dryRun) {
    return result;
  }

  const space: StoredSpace =
    existingSpace ??
    ({
      spaceId,
      source: VAULT_SOURCE,
      name: `spaces/${spaceId}`,
      spaceType: 'SPACE',
      displayName: accumulator.info.roomName,
      derivedDisplayName: accumulator.info.roomName,
      isBotDm: false,
      readers: [],
      readerSubject: 'google-vault',
      memberships: membershipsFor(
        spaceId,
        accumulator.info.participants,
        index,
        options.runId,
        now
      ),
      membershipsFetchedAt: now,
      discoveredAt: now,
      discoveredRun: options.runId,
      lastSeenRun: options.runId,
      lastSeenAt: now,
      raw: {
        name: `spaces/${spaceId}`,
        displayName: accumulator.info.roomName,
        spaceType: 'SPACE',
      },
    } satisfies StoredSpace);
  space.lastSeenRun = options.runId;
  space.lastSeenAt = now;

  await saveSpace(store, space);
  await saveMessages(store, spaceId, merged);
  await saveState(store, {
    spaceId,
    status: 'complete',
    lastRunId: options.runId,
    lastMessagesSyncAt: now,
    messageCount: merged.length,
    deletedCount: 0,
    missingCount: 0,
    maxCreateTime: merged.at(-1)?.createTime,
    attachmentsPending: 0,
  });
  return result;
}

interface ReadResult {
  accumulators: Map<string, SpaceAccumulator>;
  documentCount: number;
  withoutTimestamp: number;
  /** Space ids whose documents were skipped because the API already has them. */
  skipped: Set<string>;
  spaceInfo: Map<string, VaultSpaceInfo>;
}

function accumulatorFor(
  accumulators: Map<string, SpaceAccumulator>,
  spaceId: string,
  info: VaultSpaceInfo | undefined,
  meta: VaultDocumentMetadata | undefined
): SpaceAccumulator {
  const existing = accumulators.get(spaceId);
  if (existing) {
    return existing;
  }
  const created: SpaceAccumulator = {
    spaceId,
    info: {
      roomName: info?.roomName ?? meta?.roomName ?? spaceId,
      conversationType:
        info?.conversationType ?? meta?.conversationType ?? 'Room',
      participants: new Set<string>(info?.participants ?? []),
    },
    documents: 0,
    parsed: [],
    attachments: [],
    attachmentSeq: 0,
  };
  accumulators.set(spaceId, created);
  return created;
}

async function absorbDocument(
  store: ExportStore,
  accumulator: SpaceAccumulator,
  mime: MimeDocument,
  messages: VaultMessage[],
  meta: VaultDocumentMetadata | undefined,
  options: VaultImportOptions
): Promise<void> {
  accumulator.documents += 1;
  for (const participant of meta?.participants ?? []) {
    accumulator.info.participants.add(participant);
  }

  const partNames = mime.attachments.map((part) => part.filename ?? '');
  const assigned = assignAttachments(messages, partNames);
  const claimedNames = new Map<string, Set<string>>();

  for (const [messageId, indices] of assigned) {
    const names = new Set<string>();
    for (const partIndex of indices) {
      names.add(partNames[partIndex]);
      accumulator.attachmentSeq += 1;
      // biome-ignore lint/nursery/noAwaitInLoop: files are written one at a time so bodies are released.
      const record = await writeAttachment(
        store,
        accumulator.spaceId,
        messageId,
        partNames[partIndex] || `file-${partIndex}`,
        mime.attachments[partIndex].body,
        accumulator.attachmentSeq,
        options.dryRun
      );
      accumulator.attachments.push(record);
    }
    claimedNames.set(messageId, names);
  }

  // A trailing block that matched no attachment is quoted or preview text.
  // Fold it into the message rather than dropping it.
  for (const message of messages) {
    const claimed = claimedNames.get(message.messageId) ?? new Set<string>();
    const leftovers = message.attachmentNames.filter(
      (name) => !claimed.has(name)
    );
    if (leftovers.length > 0) {
      const quoted = leftovers.map((line) => `> ${line}`).join('\n');
      message.text = message.text ? `${message.text}\n${quoted}` : quoted;
    }
    message.attachmentNames = [];
    accumulator.parsed.push(message);
  }
}

/**
 * Spaces already covered by the Chat API. Computed before streaming so their
 * documents can be skipped outright, which avoids decoding attachments that
 * would only be thrown away.
 */
async function spacesCoveredByApi(store: ExportStore): Promise<Set<string>> {
  const covered = new Set<string>();
  for (const spaceId of await listStoredSpaceIds(store)) {
    // biome-ignore lint/nursery/noAwaitInLoop: one space at a time bounds memory.
    const messages = await loadMessages(store, spaceId);
    if (messages.some((m) => (m.source ?? 'chat-api') === 'chat-api')) {
      covered.add(spaceId);
    }
  }
  return covered;
}

/** Streams the mbox once, writing files out and grouping messages by space. */
async function readExport(
  store: ExportStore,
  options: VaultImportOptions,
  skip: ReadonlySet<string>
): Promise<ReadResult> {
  const documentsByFile = parseVaultMetadata(
    await readFile(options.metadataPath, 'utf-8')
  );
  const spaceInfo = summarizeSpaces(documentsByFile.values());
  const wanted = new Set(
    options.spaceFilter.map((filter) => filter.replace('spaces/', ''))
  );

  const accumulators = new Map<string, SpaceAccumulator>();
  const skipped = new Set<string>();
  let documentCount = 0;
  let withoutTimestamp = 0;

  for await (const document of streamMboxDocuments(options.mboxPath)) {
    if (wanted.size > 0 && !wanted.has(document.spaceId)) {
      continue;
    }
    if (skip.has(document.spaceId)) {
      skipped.add(document.spaceId);
      continue;
    }
    const mime = parseMimeDocument(document.raw);
    if (!mime.html) {
      continue;
    }
    documentCount += 1;
    const messages = parseVaultHtml(mime.html);
    withoutTimestamp += messages.filter((m) => !m.createTime).length;
    const meta = mime.messageId
      ? documentsByFile.get(mime.messageId)
      : undefined;
    const accumulator = accumulatorFor(
      accumulators,
      document.spaceId,
      spaceInfo.get(document.spaceId),
      meta
    );
    await absorbDocument(store, accumulator, mime, messages, meta, options);
  }
  return { accumulators, documentCount, withoutTimestamp, skipped, spaceInfo };
}

function emptyReport(
  options: VaultImportOptions,
  read: ReadResult
): VaultImportReport {
  return {
    runId: options.runId,
    mboxPath: options.mboxPath,
    dryRun: options.dryRun,
    spaces: [],
    totals: {
      spaces: 0,
      spacesSkipped: 0,
      documents: read.documentCount,
      messagesParsed: 0,
      messagesAdded: 0,
      messagesSkippedExisting: 0,
      attachments: 0,
      attachmentBytes: 0,
      usersCreated: 0,
      messagesWithoutTimestamp: read.withoutTimestamp,
    },
  };
}

/** Reads the export end to end and merges it into the store. */
export async function importVaultExport(
  store: ExportStore,
  options: VaultImportOptions
): Promise<VaultImportReport> {
  const covered = options.allowApiSpaces
    ? new Set<string>()
    : await spacesCoveredByApi(store);
  const read = await readExport(store, options, covered);
  const index = buildUserIndex(await loadUsers(store));
  const attachmentIndex = await loadAttachmentIndex(store);
  const report = emptyReport(options, read);

  for (const spaceId of read.skipped) {
    const info = read.spaceInfo.get(spaceId);
    report.spaces.push({
      spaceId,
      roomName: info?.roomName ?? spaceId,
      conversationType: info?.conversationType ?? 'Room',
      documents: 0,
      messagesParsed: 0,
      messagesAdded: 0,
      messagesSkippedExisting: 0,
      attachments: 0,
      attachmentBytes: 0,
      participants: info?.participants.size ?? 0,
      skippedReason:
        'already covered by the Chat API, which keeps threads, reactions and exact timestamps',
    });
    report.totals.spacesSkipped += 1;
  }

  for (const accumulator of read.accumulators.values()) {
    // biome-ignore lint/nursery/noAwaitInLoop: spaces are written one at a time.
    const result = await importSpace(
      store,
      accumulator,
      index,
      options,
      attachmentIndex
    );
    report.spaces.push(result);
    if (result.skippedReason) {
      report.totals.spacesSkipped += 1;
    } else {
      report.totals.spaces += 1;
    }
    report.totals.messagesParsed += result.messagesParsed;
    report.totals.messagesAdded += result.messagesAdded;
    report.totals.messagesSkippedExisting += result.messagesSkippedExisting;
    report.totals.attachments += result.attachments;
    report.totals.attachmentBytes += result.attachmentBytes;
  }
  report.totals.usersCreated = index.created;

  if (!options.dryRun) {
    await saveUsers(store, index.users);
    await saveAttachmentIndex(store, attachmentIndex);
  }
  return report;
}
