/**
 * Persistence for the workspace export store and the pure merge logic that
 * keeps it additive across runs.
 *
 * Layout under the store root:
 *   manifest.json                 run history
 *   users.json                    chat user id → StoredUser
 *   spaces/<spaceId>/space.json   space, memberships, readers
 *   spaces/<spaceId>/messages.json
 *   spaces/<spaceId>/state.json   sync cursor and status
 *   attachments/index.json        attachment key → AttachmentRecord
 *   attachments/files/<spaceId>/<messageId>/<file>
 *   unreachable-spaces.json       named spaces no selected user can read
 *   runs/<runId>.json             full run report
 *   logs/<runId>.log
 */
import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { chat_v1 } from 'googleapis';
import type {
  AttachmentRecord,
  DiscoveredSpaceRecord,
  MemberType,
  RunPointer,
  RunReport,
  SpaceSyncState,
  StoredMembership,
  StoredMessage,
  StoredSpace,
  StoredUser,
  StoreManifest,
  UnreachableSpace,
} from '../types/export-store';
import { STORE_VERSION } from '../types/export-store';
import { readJsonFile, writeJsonAtomic } from '../utils/fs-atomic';
import { extractLinks } from '../utils/links';
import { compareTimestamps, toSlackTs } from '../utils/timestamps';

const SPACES_PREFIX_REGEX = /^spaces\//;

export interface ExportStore {
  rootDir: string;
  manifest: StoreManifest;
}

// ---------------------------------------------------------------------------
// Paths

export function manifestPath(root: string): string {
  return path.join(root, 'manifest.json');
}
export function usersPath(root: string): string {
  return path.join(root, 'users.json');
}
export function spacesDir(root: string): string {
  return path.join(root, 'spaces');
}
export function spaceDir(root: string, spaceId: string): string {
  return path.join(spacesDir(root), spaceId);
}
export function spaceJsonPath(root: string, spaceId: string): string {
  return path.join(spaceDir(root, spaceId), 'space.json');
}
export function messagesPath(root: string, spaceId: string): string {
  return path.join(spaceDir(root, spaceId), 'messages.json');
}
export function statePath(root: string, spaceId: string): string {
  return path.join(spaceDir(root, spaceId), 'state.json');
}
export function attachmentsIndexPath(root: string): string {
  return path.join(root, 'attachments', 'index.json');
}
export function attachmentsFilesDir(root: string): string {
  return path.join(root, 'attachments', 'files');
}
export function discoveredPath(root: string): string {
  return path.join(root, 'discovered-spaces.json');
}
export function unreachablePath(root: string): string {
  return path.join(root, 'unreachable-spaces.json');
}
export function runsDir(root: string): string {
  return path.join(root, 'runs');
}
export function runReportPath(root: string, runId: string): string {
  return path.join(runsDir(root), `${runId}.json`);
}

// ---------------------------------------------------------------------------
// Identifiers

export function spaceIdFromName(name: string): string {
  return name.replace(SPACES_PREFIX_REGEX, '');
}

/**
 * Identity shared by both sources. The Chat API duplicates the id in a message
 * name (`abc.abc`) where Vault renders it bare (`abc`), so both collapse to the
 * same key and a message can never be stored twice.
 */
export function messageIdentity(name: string): string {
  const afterPrefix = name.split('/messages/').pop() ?? name;
  return afterPrefix.split('.')[0];
}

export function messageIdFromName(name: string): string {
  const parts = name.split('/messages/');
  return parts[1] ?? name;
}

// ---------------------------------------------------------------------------
// Manifest and files

export async function openStore(rootDir: string): Promise<ExportStore> {
  const existing = await readJsonFile<StoreManifest>(manifestPath(rootDir));
  if (existing) {
    if (existing.version !== STORE_VERSION) {
      throw new Error(
        `Store at ${rootDir} has version ${existing.version}; this build writes version ${STORE_VERSION}.`
      );
    }
    return { rootDir, manifest: existing };
  }
  const manifest: StoreManifest = {
    version: STORE_VERSION,
    createdAt: new Date().toISOString(),
    runs: [],
  };
  await writeJsonAtomic(manifestPath(rootDir), manifest);
  return { rootDir, manifest };
}

export async function saveManifest(store: ExportStore): Promise<void> {
  await writeJsonAtomic(manifestPath(store.rootDir), store.manifest);
}

export async function recordRunPointer(
  store: ExportStore,
  pointer: RunPointer
): Promise<void> {
  const index = store.manifest.runs.findIndex((r) => r.runId === pointer.runId);
  if (index >= 0) {
    store.manifest.runs[index] = pointer;
  } else {
    store.manifest.runs.push(pointer);
  }
  store.manifest.lastRun = pointer;
  await saveManifest(store);
}

export async function loadSpace(
  store: ExportStore,
  spaceId: string
): Promise<StoredSpace | undefined> {
  return await readJsonFile<StoredSpace>(spaceJsonPath(store.rootDir, spaceId));
}

export async function saveSpace(
  store: ExportStore,
  space: StoredSpace
): Promise<void> {
  await writeJsonAtomic(spaceJsonPath(store.rootDir, space.spaceId), space);
}

export async function loadMessages(
  store: ExportStore,
  spaceId: string
): Promise<StoredMessage[]> {
  return (
    (await readJsonFile<StoredMessage[]>(
      messagesPath(store.rootDir, spaceId)
    )) ?? []
  );
}

export async function saveMessages(
  store: ExportStore,
  spaceId: string,
  messages: StoredMessage[]
): Promise<void> {
  await writeJsonAtomic(messagesPath(store.rootDir, spaceId), messages);
}

export async function loadState(
  store: ExportStore,
  spaceId: string
): Promise<SpaceSyncState | undefined> {
  return await readJsonFile<SpaceSyncState>(statePath(store.rootDir, spaceId));
}

export async function saveState(
  store: ExportStore,
  state: SpaceSyncState
): Promise<void> {
  await writeJsonAtomic(statePath(store.rootDir, state.spaceId), state);
}

export async function loadUsers(
  store: ExportStore
): Promise<Record<string, StoredUser>> {
  return (
    (await readJsonFile<Record<string, StoredUser>>(
      usersPath(store.rootDir)
    )) ?? {}
  );
}

export async function saveUsers(
  store: ExportStore,
  users: Record<string, StoredUser>
): Promise<void> {
  await writeJsonAtomic(usersPath(store.rootDir), users);
}

export async function loadAttachmentIndex(
  store: ExportStore
): Promise<Record<string, AttachmentRecord>> {
  return (
    (await readJsonFile<Record<string, AttachmentRecord>>(
      attachmentsIndexPath(store.rootDir)
    )) ?? {}
  );
}

export async function saveAttachmentIndex(
  store: ExportStore,
  index: Record<string, AttachmentRecord>
): Promise<void> {
  await writeJsonAtomic(attachmentsIndexPath(store.rootDir), index);
}

export async function saveDiscoveredSpaces(
  store: ExportStore,
  spaces: DiscoveredSpaceRecord[]
): Promise<void> {
  await writeJsonAtomic(discoveredPath(store.rootDir), spaces);
}

export async function loadDiscoveredSpaces(
  store: ExportStore
): Promise<DiscoveredSpaceRecord[]> {
  return (
    (await readJsonFile<DiscoveredSpaceRecord[]>(
      discoveredPath(store.rootDir)
    )) ?? []
  );
}

export async function saveUnreachableSpaces(
  store: ExportStore,
  spaces: UnreachableSpace[]
): Promise<void> {
  await writeJsonAtomic(unreachablePath(store.rootDir), spaces);
}

export async function saveRunReport(
  store: ExportStore,
  report: RunReport
): Promise<void> {
  await writeJsonAtomic(runReportPath(store.rootDir, report.runId), report);
}

export async function loadRunReport(
  store: ExportStore,
  runId: string
): Promise<RunReport | undefined> {
  return await readJsonFile<RunReport>(runReportPath(store.rootDir, runId));
}

export async function listStoredSpaceIds(
  store: ExportStore
): Promise<string[]> {
  try {
    const entries = await readdir(spacesDir(store.rootDir), {
      withFileTypes: true,
    });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Pure transforms

function memberTypeOf(membership: chat_v1.Schema$Membership): MemberType {
  if (membership.groupMember?.name) {
    return 'GROUP';
  }
  if (membership.member?.type === 'BOT') {
    return 'BOT';
  }
  if (membership.member?.type === 'HUMAN') {
    return 'HUMAN';
  }
  return 'UNKNOWN';
}

export function toStoredMembership(
  raw: chat_v1.Schema$Membership
): StoredMembership {
  return {
    name: raw.name ?? '',
    chatUserId: raw.member?.name ?? undefined,
    groupName: raw.groupMember?.name ?? undefined,
    memberType: memberTypeOf(raw),
    state: raw.state ?? undefined,
    role: raw.role ?? undefined,
    affiliation: (raw as { affiliation?: string }).affiliation,
    createTime: raw.createTime ?? undefined,
    deleteTime: raw.deleteTime ?? undefined,
    raw,
  };
}

export interface SpaceMergeInput {
  raw: chat_v1.Schema$Space;
  readers: string[];
  readerSubject: string;
  memberships?: chat_v1.Schema$Membership[];
  runId: string;
  now: string;
}

/** Merges a freshly listed space into the stored one, never dropping readers. */
export function mergeSpace(
  existing: StoredSpace | undefined,
  input: SpaceMergeInput
): StoredSpace {
  const readers = Array.from(
    new Set([...(existing?.readers ?? []), ...input.readers])
  );
  const memberships = input.memberships
    ? input.memberships.map(toStoredMembership)
    : (existing?.memberships ?? []);
  const spaceId = spaceIdFromName(input.raw.name ?? '');
  return {
    spaceId,
    name: input.raw.name ?? `spaces/${spaceId}`,
    spaceType: input.raw.spaceType ?? existing?.spaceType ?? 'UNKNOWN',
    displayName: input.raw.displayName ?? existing?.displayName ?? '',
    derivedDisplayName: existing?.derivedDisplayName,
    isBotDm: Boolean(input.raw.singleUserBotDm),
    readers,
    readerSubject: input.readerSubject,
    memberships,
    membershipsFetchedAt: input.memberships
      ? input.now
      : existing?.membershipsFetchedAt,
    discoveredAt: existing?.discoveredAt ?? input.now,
    discoveredRun: existing?.discoveredRun ?? input.runId,
    lastSeenRun: input.runId,
    lastSeenAt: input.now,
    raw: input.raw,
  };
}

/**
 * Hash of the parts of a message that can change after creation. Reactions
 * summaries are included so a new reaction triggers a per-user refetch.
 */
/** Attachment fields that identify content; download URLs are signed and rotate. */
function stableAttachment(
  attachment: chat_v1.Schema$Attachment
): Record<string, unknown> {
  return {
    name: attachment.name ?? '',
    contentName: attachment.contentName ?? '',
    contentType: attachment.contentType ?? '',
    source: attachment.source ?? '',
    attachmentDataRef: attachment.attachmentDataRef ?? null,
    driveDataRef: attachment.driveDataRef ?? null,
  };
}

export function messageContentHash(raw: chat_v1.Schema$Message): string {
  const subset = {
    text: raw.text ?? '',
    formattedText: raw.formattedText ?? '',
    lastUpdateTime: raw.lastUpdateTime ?? '',
    deleteTime: raw.deleteTime ?? '',
    deletionMetadata: raw.deletionMetadata ?? null,
    attachment: (raw.attachment ?? []).map(stableAttachment),
    attachedGifs: raw.attachedGifs ?? [],
    annotations: raw.annotations ?? [],
    emojiReactionSummaries: raw.emojiReactionSummaries ?? [],
    quotedMessageMetadata: raw.quotedMessageMetadata ?? null,
    thread: raw.thread ?? null,
    cardsV2: raw.cardsV2 ?? [],
  };
  return createHash('sha256').update(JSON.stringify(subset)).digest('hex');
}

function mentionsOf(raw: chat_v1.Schema$Message): string[] {
  const ids = new Set<string>();
  for (const annotation of raw.annotations ?? []) {
    const userName = annotation.userMention?.user?.name;
    if (annotation.type === 'USER_MENTION' && userName) {
      ids.add(userName);
    }
  }
  return Array.from(ids);
}

export function toStoredMessage(
  raw: chat_v1.Schema$Message,
  spaceId: string,
  runId: string,
  now: string
): StoredMessage {
  const name = raw.name ?? '';
  const createTime = raw.createTime ?? now;
  const isDeleted = Boolean(raw.deleteTime);
  return {
    name,
    messageId: messageIdFromName(name),
    spaceId,
    createTime,
    slackTs: toSlackTs(createTime),
    lastUpdateTime: raw.lastUpdateTime ?? undefined,
    senderId: raw.sender?.name ?? undefined,
    senderType: raw.sender?.type ?? undefined,
    threadName: raw.thread?.name ?? undefined,
    threadReply: Boolean(raw.threadReply),
    text: raw.text ?? '',
    formattedText: raw.formattedText ?? undefined,
    mentions: mentionsOf(raw),
    links: extractLinks(raw),
    reactions: [],
    attachmentKeys: [],
    isDeleted,
    deletion: isDeleted
      ? {
          deleteTime: raw.deleteTime ?? undefined,
          deletionType: raw.deletionMetadata?.deletionType ?? undefined,
        }
      : undefined,
    contentHash: messageContentHash(raw),
    raw,
    history: [],
    firstSeenRun: runId,
    firstSeenAt: now,
    lastSeenRun: runId,
    lastSeenAt: now,
  };
}

export interface MergeDiff {
  added: number;
  updated: number;
  deleted: number;
  unchanged: number;
  missing: number;
  reappeared: number;
  /** Names of messages whose reactions must be (re)fetched. */
  reactionRefresh: string[];
  /** Names of messages whose attachments must be (re)indexed. */
  attachmentRefresh: string[];
}

export interface MergeResult {
  messages: StoredMessage[];
  diff: MergeDiff;
}

export interface MergeOptions {
  runId: string;
  now: string;
  /**
   * True when `fetched` is a complete listing of the space. Only then can a
   * stored message that is absent from `fetched` be marked missing.
   */
  fetchedIsComplete: boolean;
}

function hasReactions(raw: chat_v1.Schema$Message): boolean {
  return (raw.emojiReactionSummaries?.length ?? 0) > 0;
}

function applyDeletion(
  existing: StoredMessage,
  fetched: chat_v1.Schema$Message,
  options: MergeOptions
): StoredMessage {
  // Google no longer returns the content, so keep the last known version as
  // `raw` and record the deletion alongside it.
  return {
    ...existing,
    isDeleted: true,
    deletion: {
      deleteTime: fetched.deleteTime ?? undefined,
      deletionType: fetched.deletionMetadata?.deletionType ?? undefined,
    },
    history: [
      ...existing.history,
      {
        runId: existing.lastSeenRun,
        seenAt: existing.lastSeenAt,
        contentHash: existing.contentHash,
        raw: existing.raw,
      },
    ],
    contentHash: messageContentHash(fetched),
    lastSeenRun: options.runId,
    lastSeenAt: options.now,
    missingSince: undefined,
  };
}

function applyUpdate(
  existing: StoredMessage,
  fetched: chat_v1.Schema$Message,
  options: MergeOptions
): StoredMessage {
  const fresh = toStoredMessage(
    fetched,
    existing.spaceId,
    existing.firstSeenRun,
    existing.firstSeenAt
  );
  return {
    ...fresh,
    // Reactions and attachment keys are refreshed by later steps; keep the
    // old values until then so nothing disappears if the run stops early.
    reactions: existing.reactions,
    reactionsFetchedRun: existing.reactionsFetchedRun,
    attachmentKeys: existing.attachmentKeys,
    history: [
      ...existing.history,
      {
        runId: existing.lastSeenRun,
        seenAt: existing.lastSeenAt,
        contentHash: existing.contentHash,
        raw: existing.raw,
      },
    ],
    lastSeenRun: options.runId,
    lastSeenAt: options.now,
    missingSince: undefined,
  };
}

function mergeOne(
  existing: StoredMessage | undefined,
  fetched: chat_v1.Schema$Message,
  spaceId: string,
  options: MergeOptions,
  diff: MergeDiff
): StoredMessage {
  if (!existing) {
    diff.added += 1;
    if (hasReactions(fetched)) {
      diff.reactionRefresh.push(fetched.name ?? '');
    }
    diff.attachmentRefresh.push(fetched.name ?? '');
    return toStoredMessage(fetched, spaceId, options.runId, options.now);
  }

  if (existing.missingSince) {
    diff.reappeared += 1;
  }

  const fetchedDeleted = Boolean(fetched.deleteTime);
  if (fetchedDeleted && !existing.isDeleted) {
    diff.deleted += 1;
    return applyDeletion(existing, fetched, options);
  }

  const hash = messageContentHash(fetched);
  // Recompute the stored version's hash too, so a change in the hashing
  // rules (not in the message) never shows up as an edit.
  const isSameContent =
    hash === existing.contentHash || hash === messageContentHash(existing.raw);
  if (fetchedDeleted || isSameContent) {
    diff.unchanged += 1;
    const needsReactions =
      hasReactions(fetched) && existing.reactionsFetchedRun === undefined;
    if (needsReactions) {
      diff.reactionRefresh.push(existing.name);
    }
    return {
      ...existing,
      contentHash: existing.isDeleted ? existing.contentHash : hash,
      lastSeenRun: options.runId,
      lastSeenAt: options.now,
      missingSince: undefined,
    };
  }

  diff.updated += 1;
  if (hasReactions(fetched)) {
    diff.reactionRefresh.push(existing.name);
  }
  diff.attachmentRefresh.push(existing.name);
  return applyUpdate(existing, fetched, options);
}

/**
 * Merges one fetched message, or returns undefined when it is unusable or a
 * repeat within the same listing.
 */
function mergeFetched(
  raw: chat_v1.Schema$Message,
  byIdentity: Map<string, StoredMessage>,
  seen: Set<string>,
  spaceId: string,
  options: MergeOptions,
  diff: MergeDiff
): StoredMessage | undefined {
  const name = raw.name ?? '';
  if (!name) {
    return;
  }
  const identity = messageIdentity(name);
  if (seen.has(identity)) {
    return;
  }
  seen.add(identity);
  const previous = byIdentity.get(identity);
  // A Vault record carries no threads, reactions or exact time, so the API
  // version supersedes it outright instead of being treated as an edit.
  const supersedesVault = previous?.source === 'vault';
  return mergeOne(
    supersedesVault ? undefined : previous,
    raw,
    spaceId,
    options,
    diff
  );
}

/**
 * Merges a listing into the stored messages. Never drops a record: edits keep
 * prior versions in `history`, deletions keep the last content, and messages
 * that vanish without a deletion marker are flagged `missingSince`.
 */
export function mergeMessages(
  existing: StoredMessage[],
  fetched: chat_v1.Schema$Message[],
  spaceId: string,
  options: MergeOptions
): MergeResult {
  const diff: MergeDiff = {
    added: 0,
    updated: 0,
    deleted: 0,
    unchanged: 0,
    missing: 0,
    reappeared: 0,
    reactionRefresh: [],
    attachmentRefresh: [],
  };
  // Keyed by shared identity so a Vault-sourced copy of a message is replaced
  // by the Chat API copy rather than sitting beside it.
  const byIdentity = new Map(existing.map((m) => [messageIdentity(m.name), m]));
  const seen = new Set<string>();
  const merged: StoredMessage[] = [];

  for (const raw of fetched) {
    const fresh = mergeFetched(raw, byIdentity, seen, spaceId, options, diff);
    if (fresh) {
      merged.push(fresh);
    }
  }

  for (const message of existing) {
    if (seen.has(messageIdentity(message.name))) {
      continue;
    }
    if (
      options.fetchedIsComplete &&
      !message.isDeleted &&
      !message.missingSince
    ) {
      diff.missing += 1;
      merged.push({ ...message, missingSince: options.now });
    } else {
      if (message.missingSince && !message.isDeleted) {
        diff.missing += 1;
      }
      merged.push(message);
    }
  }

  merged.sort((a, b) => compareTimestamps(a.createTime, b.createTime));
  return { messages: merged, diff };
}

export function maxCreateTime(messages: StoredMessage[]): string | undefined {
  let max: string | undefined;
  for (const message of messages) {
    if (!max || compareTimestamps(message.createTime, max) > 0) {
      max = message.createTime;
    }
  }
  return max;
}
