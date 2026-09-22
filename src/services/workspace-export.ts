/**
 * Whole-workspace export. Impersonates each selected user to discover their
 * spaces, deduplicates spaces across users, then syncs each space once into
 * the additive export store: memberships, every message (including deleted
 * and edited ones), per-user reactions, attachments, Drive links and the
 * people involved.
 *
 * Runs are idempotent. A second run over the same store is a delta: it
 * re-lists (cheap), merges, and only downloads what is new.
 */
import type { chat_v1 } from 'googleapis';
import type {
  AttachmentRecord,
  RunReport,
  SpaceRunResult,
  SpaceSyncState,
  StoredMessage,
  StoredReaction,
  StoredSpace,
  StoredUser,
  SubjectRunResult,
  UnreachableSpace,
} from '../types/export-store';
import { mapWithConcurrency } from '../utils/concurrency';
import { Logger } from '../utils/logger';
import { makeRunId } from '../utils/timestamps';
import {
  buildAttachmentRecords,
  type DriveLinkPolicy,
  syncAttachments,
} from './attachments';
import {
  listMembershipsAs,
  listMessagesAs,
  listReactionsAs,
  listSpacesAs,
  searchNamedSpacesAsAdmin,
} from './chat-reader';
import {
  type DomainUser,
  getDomainUser,
  listDomainUsers,
  type UserSelection,
} from './directory';
import type { DriveExportPreference } from './drive';
import {
  attachmentsFilesDir,
  type ExportStore,
  loadAttachmentIndex,
  loadMessages,
  loadSpace,
  loadState,
  loadUsers,
  maxCreateTime,
  mergeMessages,
  mergeSpace,
  openStore,
  recordRunPointer,
  saveAttachmentIndex,
  saveMessages,
  saveRunReport,
  saveSpace,
  saveState,
  saveUnreachableSpaces,
  saveUsers,
  spaceIdFromName,
} from './export-store';
import {
  describeGoogleError,
  getServiceAccountCredentials,
} from './google-auth';
import {
  addUserRef,
  type ChatUserRef,
  displayNameOf,
  resolveChatUsers,
} from './user-resolver';

export interface WorkspaceExportOptions {
  outputDir: string;
  selection: UserSelection;
  dryRun: boolean;
  /** RFC 3339. Only list messages created after this; skips missing-detection. */
  since?: string;
  /** Continue the previous run if it did not finish. */
  resume: boolean;
  /** Space ids, resource names or display names. Empty = all. */
  spaceFilter: string[];
  skipBotDms: boolean;
  driveLinks: DriveLinkPolicy;
  driveExportFormat: DriveExportPreference;
  skipAttachments: boolean;
  /** Use admin space search to report named spaces no selected user can read. */
  adminSweep: boolean;
  /** Parallel `spaces.list` calls during discovery. */
  concurrency: number;
  refreshUsers: boolean;
  /** Test hook: cap messages listed per space. */
  messageLimit?: number;
}

export interface DiscoveredSpace {
  spaceId: string;
  raw: chat_v1.Schema$Space;
  readers: string[];
}

// ---------------------------------------------------------------------------
// Pure helpers

export function dedupeDiscoveredSpaces(
  listings: Array<{ subject: string; spaces: chat_v1.Schema$Space[] }>
): Map<string, DiscoveredSpace> {
  const map = new Map<string, DiscoveredSpace>();
  for (const { subject, spaces } of listings) {
    for (const raw of spaces) {
      if (!raw.name) {
        continue;
      }
      const spaceId = spaceIdFromName(raw.name);
      const existing = map.get(spaceId);
      if (existing) {
        if (!existing.readers.includes(subject)) {
          existing.readers.push(subject);
        }
      } else {
        map.set(spaceId, { spaceId, raw, readers: [subject] });
      }
    }
  }
  return map;
}

export function matchesSpaceFilter(
  space: chat_v1.Schema$Space,
  filters: string[]
): boolean {
  if (filters.length === 0) {
    return true;
  }
  const spaceId = spaceIdFromName(space.name ?? '').toLowerCase();
  const displayName = (space.displayName ?? '').toLowerCase();
  return filters.some((filter) => {
    const value = filter.trim().toLowerCase();
    return (
      value === spaceId ||
      value === `spaces/${spaceId}` ||
      (displayName !== '' && value === displayName)
    );
  });
}

/** Keeps the reader stable across runs when that user can still see the space. */
export function chooseReaderSubject(
  readers: string[],
  previous?: string
): string {
  if (previous && readers.includes(previous)) {
    return previous;
  }
  return readers[0];
}

export function toStoredReaction(raw: chat_v1.Schema$Reaction): StoredReaction {
  return {
    name: raw.name ?? undefined,
    user: raw.user?.name ?? '',
    emoji: {
      unicode: raw.emoji?.unicode ?? undefined,
      customEmoji: raw.emoji?.customEmoji
        ? {
            uid: raw.emoji.customEmoji.uid ?? undefined,
            emojiName: raw.emoji.customEmoji.emojiName ?? undefined,
          }
        : undefined,
    },
    raw,
  };
}

function collectMembershipRefs(
  refs: Map<string, ChatUserRef>,
  space: StoredSpace
): void {
  for (const membership of space.memberships) {
    if (membership.memberType === 'GROUP') {
      continue;
    }
    addUserRef(refs, membership.chatUserId, 'membership', {
      type: membership.raw.member?.type ?? undefined,
      displayName: membership.raw.member?.displayName ?? undefined,
      domainId: membership.raw.member?.domainId ?? undefined,
      affiliation: membership.affiliation,
    });
  }
}

function collectMessageRefs(
  refs: Map<string, ChatUserRef>,
  message: StoredMessage
): void {
  addUserRef(refs, message.senderId, 'sender', {
    type: message.senderType,
    displayName: message.raw.sender?.displayName ?? undefined,
    domainId: message.raw.sender?.domainId ?? undefined,
  });
  for (const annotation of message.raw.annotations ?? []) {
    const user = annotation.userMention?.user;
    if (annotation.type === 'USER_MENTION' && user?.name) {
      addUserRef(refs, user.name, 'mention', {
        type: user.type ?? undefined,
        displayName: user.displayName ?? undefined,
        domainId: user.domainId ?? undefined,
      });
    }
  }
  for (const reaction of message.reactions) {
    addUserRef(refs, reaction.user, 'reaction');
  }
}

/** Every person referenced by a space: members, senders, mentions, reactors. */
export function collectUserRefs(
  refs: Map<string, ChatUserRef>,
  space: StoredSpace,
  messages: StoredMessage[]
): void {
  collectMembershipRefs(refs, space);
  for (const message of messages) {
    collectMessageRefs(refs, message);
  }
}

/**
 * Human members' names, for DMs and group chats that have no title. People
 * who wrote in the conversation but are no longer members (deleted accounts
 * drop out of the membership list) are included so a DM with a former staff
 * member is still named after both people.
 */
export function deriveSpaceName(
  space: StoredSpace,
  users: Record<string, StoredUser>,
  messages: StoredMessage[] = []
): string {
  if (space.spaceType === 'SPACE' && space.displayName) {
    return space.displayName;
  }
  const ids = new Set<string>();
  for (const m of space.memberships) {
    if (m.memberType === 'HUMAN' && m.chatUserId) {
      ids.add(m.chatUserId);
    }
  }
  for (const message of messages) {
    if (message.senderId && message.senderType !== 'BOT') {
      ids.add(message.senderId);
    }
  }
  const names = Array.from(ids)
    .filter((id) => users[id]?.status !== 'bot')
    .map((id) => displayNameOf(users[id], id))
    .sort((a, b) => a.localeCompare(b));
  if (names.length === 0) {
    return space.displayName || space.spaceId;
  }
  return names.join(', ');
}

// ---------------------------------------------------------------------------
// Run context

interface RunContext {
  options: WorkspaceExportOptions;
  store: ExportStore;
  runId: string;
  mode: RunReport['mode'];
  logger: Logger;
  report: RunReport;
  subjectEmails: Set<string>;
  users: Record<string, StoredUser>;
  attachmentIndex: Record<string, AttachmentRecord>;
}

function now(): string {
  return new Date().toISOString();
}

function emptySpaceResult(
  space: DiscoveredSpace,
  readerSubject: string
): SpaceRunResult {
  return {
    spaceId: space.spaceId,
    displayName: space.raw.displayName ?? '',
    spaceType: space.raw.spaceType ?? 'UNKNOWN',
    readerSubject,
    members: 0,
    status: 'complete',
    messages: {
      listed: 0,
      added: 0,
      updated: 0,
      deleted: 0,
      unchanged: 0,
      missing: 0,
      reappeared: 0,
      total: 0,
    },
    reactions: { fetched: 0, messagesWithReactions: 0 },
    attachments: {
      total: 0,
      downloaded: 0,
      linkOnly: 0,
      skipped: 0,
      failed: 0,
      bytes: 0,
    },
    durationMs: 0,
  };
}

function initialReport(
  ctx: Omit<
    RunContext,
    'report' | 'users' | 'attachmentIndex' | 'subjectEmails'
  >
): RunReport {
  return {
    runId: ctx.runId,
    startedAt: now(),
    status: ctx.options.dryRun ? 'dry-run' : 'running',
    dryRun: ctx.options.dryRun,
    mode: ctx.mode,
    since: ctx.options.since,
    selection: ctx.options.selection,
    outputDir: ctx.options.outputDir,
    subjects: [],
    spaces: [],
    unreachableSpaces: [],
    totals: {
      spacesDiscovered: 0,
      spacesExported: 0,
      spacesSkipped: 0,
      spacesFailed: 0,
      messagesAdded: 0,
      messagesUpdated: 0,
      messagesDeleted: 0,
      messagesMissing: 0,
      messagesTotal: 0,
      attachmentsDownloaded: 0,
      attachmentsFailed: 0,
      attachmentBytes: 0,
      usersResolved: 0,
      usersPlaceholder: 0,
    },
    errors: 0,
    warnings: 0,
  };
}

function chooseRun(
  store: ExportStore,
  options: WorkspaceExportOptions
): { runId: string; mode: RunReport['mode'] } {
  const last = store.manifest.lastRun;
  if (options.resume && last?.status === 'running') {
    return { runId: last.runId, mode: 'resume' };
  }
  if (options.since) {
    return { runId: makeRunId(), mode: 'delta-since' };
  }
  return { runId: makeRunId(), mode: 'full' };
}

// ---------------------------------------------------------------------------
// Discovery

async function discoverSpaces(
  ctx: RunContext,
  subjects: DomainUser[]
): Promise<Map<string, DiscoveredSpace>> {
  console.log(
    `🔎 Listing spaces for ${subjects.length} user(s) (concurrency ${ctx.options.concurrency})...`
  );
  const listings = await mapWithConcurrency(
    subjects,
    ctx.options.concurrency,
    async (user) => {
      const result: SubjectRunResult = { email: user.email, spacesListed: 0 };
      try {
        const spaces = await listSpacesAs(user.email);
        result.spacesListed = spaces.length;
        ctx.report.subjects.push(result);
        return { subject: user.email, spaces };
      } catch (error) {
        result.error = describeGoogleError(error);
        ctx.report.subjects.push(result);
        ctx.logger.addError('space_list', user.email, result.error);
        return { subject: user.email, spaces: [] };
      }
    }
  );
  const discovered = dedupeDiscoveredSpaces(listings);
  const failed = ctx.report.subjects.filter((s) => s.error).length;
  console.log(
    `   ${discovered.size} unique space(s) across ${subjects.length} user(s)${failed ? `, ${failed} user(s) failed` : ''}`
  );
  return discovered;
}

async function adminSweep(
  ctx: RunContext,
  discovered: Map<string, DiscoveredSpace>
): Promise<void> {
  const credentials = await getServiceAccountCredentials();
  if (!credentials) {
    return;
  }
  const admin = credentials.subject;
  let all: chat_v1.Schema$Space[];
  try {
    all = await searchNamedSpacesAsAdmin(admin);
  } catch (error) {
    ctx.logger.addWarning(
      'admin_search',
      'spaces.search',
      `Admin sweep skipped: ${describeGoogleError(error)}. Grant chat.admin.spaces.readonly to enable it.`
    );
    return;
  }
  const unreachable: UnreachableSpace[] = [];
  for (const space of all) {
    const spaceId = spaceIdFromName(space.name ?? '');
    if (!spaceId || discovered.has(spaceId)) {
      continue;
    }
    const entry: UnreachableSpace = {
      spaceId,
      displayName: space.displayName ?? '',
      reason: 'No selected user is a member of this space.',
    };
    try {
      // biome-ignore lint/nursery/noAwaitInLoop: one admin call per unreachable space, sequential to respect quota.
      const members = await listMembershipsAs(admin, space.name ?? '', true);
      entry.members = members
        .map((m) => m.member?.name ?? m.groupMember?.name ?? '')
        .filter(Boolean);
    } catch (error) {
      entry.reason += ` Membership lookup failed: ${describeGoogleError(error)}`;
    }
    unreachable.push(entry);
    ctx.logger.addWarning(
      'admin_search',
      `${spaceId} (${entry.displayName})`,
      entry.reason
    );
  }
  ctx.report.unreachableSpaces = unreachable;
  if (!ctx.options.dryRun) {
    await saveUnreachableSpaces(ctx.store, unreachable);
  }
  console.log(
    `🛡  Admin sweep: ${all.length} named space(s) in the domain, ${unreachable.length} not reachable by the selected users`
  );
}

// ---------------------------------------------------------------------------
// Per-space sync

function activeEmail(
  ctx: RunContext,
  chatUserId: string | undefined
): string | undefined {
  if (!chatUserId) {
    return;
  }
  const user = ctx.users[chatUserId];
  if (
    user?.status === 'active' &&
    user.email &&
    ctx.subjectEmails.has(user.email)
  ) {
    return user.email;
  }
  return;
}

async function resolveUsersFor(
  ctx: RunContext,
  space: StoredSpace,
  messages: StoredMessage[]
): Promise<void> {
  const refs = new Map<string, ChatUserRef>();
  collectUserRefs(refs, space, messages);
  ctx.users = await resolveChatUsers(refs, ctx.users, getDomainUser, {
    runId: ctx.runId,
    now: now(),
    refresh: ctx.options.refreshUsers,
  });
  if (!ctx.options.dryRun) {
    await saveUsers(ctx.store, ctx.users);
  }
}

async function fetchReactions(
  ctx: RunContext,
  readerSubject: string,
  messages: StoredMessage[],
  names: string[]
): Promise<number> {
  if (names.length === 0) {
    return 0;
  }
  const byName = new Map(messages.map((m) => [m.name, m]));
  const results = await mapWithConcurrency(names, 4, async (name) => {
    const message = byName.get(name);
    if (!message) {
      return 0;
    }
    try {
      const reactions = await listReactionsAs(readerSubject, name);
      message.reactions = reactions.map(toStoredReaction);
      message.reactionsFetchedRun = ctx.runId;
      return reactions.length;
    } catch (error) {
      ctx.logger.addWarning('reaction_list', name, describeGoogleError(error));
      return 0;
    }
  });
  return results.reduce((sum, n) => sum + n, 0);
}

function countAttachmentRecords(
  ctx: RunContext,
  messages: StoredMessage[],
  names: string[]
): number {
  const wanted = new Set(names);
  let count = 0;
  for (const message of messages) {
    if (wanted.has(message.name)) {
      count += buildAttachmentRecords(message, {
        driveLinks: ctx.options.driveLinks,
      }).length;
    }
  }
  return count;
}

function indexAttachments(
  ctx: RunContext,
  messages: StoredMessage[],
  names: string[]
): string[] {
  const byName = new Map(messages.map((m) => [m.name, m]));
  const keys: string[] = [];
  for (const name of names) {
    const message = byName.get(name);
    if (!message) {
      continue;
    }
    const records = buildAttachmentRecords(message, {
      driveLinks: ctx.options.driveLinks,
    });
    const messageKeys = new Set(message.attachmentKeys);
    for (const record of records) {
      if (!ctx.attachmentIndex[record.key]) {
        ctx.attachmentIndex[record.key] = record;
      }
      messageKeys.add(record.key);
    }
    message.attachmentKeys = Array.from(messageKeys);
    keys.push(...message.attachmentKeys);
  }
  return Array.from(new Set(keys));
}

function pendingAttachmentKeys(ctx: RunContext, spaceId: string): string[] {
  return Object.values(ctx.attachmentIndex)
    .filter(
      (r) =>
        r.spaceId === spaceId &&
        (r.status === 'pending' || r.status === 'failed')
    )
    .map((r) => r.key);
}

async function syncSpaceAttachments(
  ctx: RunContext,
  space: StoredSpace,
  result: SpaceRunResult
): Promise<void> {
  const keys = pendingAttachmentKeys(ctx, space.spaceId);
  const memberSubjects = space.memberships
    .map((m) => activeEmail(ctx, m.chatUserId))
    .filter((email): email is string => Boolean(email));
  const stats = await syncAttachments(ctx.attachmentIndex, keys, {
    filesDir: attachmentsFilesDir(ctx.store.rootDir),
    readerSubject: space.readerSubject,
    subjectForUser: (id) => activeEmail(ctx, id),
    memberSubjects,
    driveExportFormat: ctx.options.driveExportFormat,
    logger: ctx.logger,
    save: () => saveAttachmentIndex(ctx.store, ctx.attachmentIndex),
  });
  result.attachments = {
    total: Object.values(ctx.attachmentIndex).filter(
      (r) => r.spaceId === space.spaceId
    ).length,
    downloaded: stats.downloaded,
    linkOnly: stats.linkOnly,
    skipped: stats.skipped,
    failed: stats.failed,
    bytes: stats.bytes,
  };
}

function formatSpaceLine(space: StoredSpace, result: SpaceRunResult): string {
  const label =
    space.spaceType === 'SPACE'
      ? `#${space.displayName || space.spaceId}`
      : `${space.spaceType.toLowerCase()} ${space.spaceId}`;
  const m = result.messages;
  const delta = `+${m.added} ~${m.updated} -${m.deleted}${m.missing ? ` ?${m.missing}` : ''}`;
  const files = result.attachments.total
    ? ` · ${result.attachments.downloaded}/${result.attachments.total} files`
    : '';
  const icon = result.status === 'failed' ? '✖' : '✔';
  return `${icon} ${label} · ${result.members} members · ${m.total} msgs (${delta})${files}`;
}

async function syncSpace(
  ctx: RunContext,
  discovered: DiscoveredSpace
): Promise<SpaceRunResult> {
  const started = Date.now();
  const { store, options } = ctx;
  const spaceId = discovered.spaceId;
  const existingSpace = await loadSpace(store, spaceId);
  const previousState = await loadState(store, spaceId);
  const readerSubject = chooseReaderSubject(
    discovered.readers,
    existingSpace?.readerSubject
  );
  const result = emptySpaceResult(discovered, readerSubject);

  if (
    ctx.mode === 'resume' &&
    previousState?.lastRunId === ctx.runId &&
    previousState.status === 'complete'
  ) {
    result.status = 'skipped';
    result.messages.total = previousState.messageCount;
    return result;
  }

  // Memberships
  let memberships: chat_v1.Schema$Membership[] | undefined;
  try {
    memberships = await listMembershipsAs(
      readerSubject,
      discovered.raw.name ?? ''
    );
  } catch (error) {
    ctx.logger.addWarning(
      'membership_list',
      spaceId,
      describeGoogleError(error)
    );
  }
  const space = mergeSpace(existingSpace, {
    raw: discovered.raw,
    readers: discovered.readers,
    readerSubject,
    memberships,
    runId: ctx.runId,
    now: now(),
  });
  result.members = space.memberships.filter(
    (m) => m.memberType !== 'BOT'
  ).length;
  if (!options.dryRun) {
    await saveSpace(store, space);
  }

  // Messages
  const existingMessages = await loadMessages(store, spaceId);
  const since = ctx.mode === 'delta-since' ? options.since : undefined;
  const fetched = await listMessagesAs(readerSubject, space.name, {
    since,
    limit: options.messageLimit,
  });
  const merge = mergeMessages(existingMessages, fetched, spaceId, {
    runId: ctx.runId,
    now: now(),
    fetchedIsComplete: !(since || options.messageLimit),
  });
  result.messages = {
    listed: fetched.length,
    added: merge.diff.added,
    updated: merge.diff.updated,
    deleted: merge.diff.deleted,
    unchanged: merge.diff.unchanged,
    missing: merge.diff.missing,
    reappeared: merge.diff.reappeared,
    total: merge.messages.length,
  };
  result.reactions.messagesWithReactions = merge.diff.reactionRefresh.length;

  if (options.dryRun) {
    result.status = 'dry-run';
    result.attachments.total = countAttachmentRecords(
      ctx,
      merge.messages,
      merge.diff.attachmentRefresh
    );
    await resolveUsersFor(ctx, space, merge.messages);
    result.durationMs = Date.now() - started;
    console.log(formatSpaceLine(space, result));
    return result;
  }

  await saveMessages(store, spaceId, merge.messages);
  const state: SpaceSyncState = {
    spaceId,
    status: 'messages-synced',
    lastRunId: ctx.runId,
    lastMessagesSyncAt: now(),
    lastFullListingAt: since ? previousState?.lastFullListingAt : now(),
    messageCount: merge.messages.length,
    deletedCount: merge.messages.filter((m) => m.isDeleted).length,
    missingCount: merge.messages.filter((m) => m.missingSince).length,
    maxCreateTime: maxCreateTime(merge.messages),
    attachmentsPending: 0,
  };
  await saveState(store, state);

  // Reactions, people, attachments
  result.reactions.fetched = await fetchReactions(
    ctx,
    readerSubject,
    merge.messages,
    merge.diff.reactionRefresh
  );
  await resolveUsersFor(ctx, space, merge.messages);
  indexAttachments(ctx, merge.messages, merge.diff.attachmentRefresh);
  await saveMessages(store, spaceId, merge.messages);
  await saveAttachmentIndex(store, ctx.attachmentIndex);
  if (!options.skipAttachments) {
    await syncSpaceAttachments(ctx, space, result);
  }

  state.status = 'complete';
  state.attachmentsPending = pendingAttachmentKeys(ctx, spaceId).length;
  await saveState(store, state);
  space.derivedDisplayName = deriveSpaceName(space, ctx.users, merge.messages);
  await saveSpace(store, space);

  result.durationMs = Date.now() - started;
  console.log(formatSpaceLine(space, result));
  return result;
}

async function syncSpaceSafely(
  ctx: RunContext,
  discovered: DiscoveredSpace
): Promise<SpaceRunResult> {
  try {
    return await syncSpace(ctx, discovered);
  } catch (error) {
    const message = describeGoogleError(error);
    ctx.logger.addError('message_list', discovered.spaceId, message);
    const result = emptySpaceResult(discovered, discovered.readers[0] ?? '');
    result.status = 'failed';
    result.error = message;
    if (!ctx.options.dryRun) {
      const previous = await loadState(ctx.store, discovered.spaceId);
      await saveState(ctx.store, {
        spaceId: discovered.spaceId,
        status: 'failed',
        lastRunId: ctx.runId,
        lastMessagesSyncAt: previous?.lastMessagesSyncAt,
        lastFullListingAt: previous?.lastFullListingAt,
        messageCount: previous?.messageCount ?? 0,
        deletedCount: previous?.deletedCount ?? 0,
        missingCount: previous?.missingCount ?? 0,
        maxCreateTime: previous?.maxCreateTime,
        attachmentsPending: previous?.attachmentsPending ?? 0,
        error: message,
      });
    }
    console.log(
      `✖ ${discovered.raw.displayName || discovered.spaceId}: ${message}`
    );
    return result;
  }
}

// ---------------------------------------------------------------------------
// Totals and reporting

function computeTotals(ctx: RunContext): void {
  const t = ctx.report.totals;
  for (const s of ctx.report.spaces) {
    if (s.status === 'skipped') {
      t.spacesSkipped += 1;
    } else if (s.status === 'failed') {
      t.spacesFailed += 1;
    } else {
      t.spacesExported += 1;
    }
    t.messagesAdded += s.messages.added;
    t.messagesUpdated += s.messages.updated;
    t.messagesDeleted += s.messages.deleted;
    t.messagesMissing += s.messages.missing;
    t.messagesTotal += s.messages.total;
    t.attachmentsDownloaded += s.attachments.downloaded;
    t.attachmentsFailed += s.attachments.failed;
    t.attachmentBytes += s.attachments.bytes;
  }
  const users = Object.values(ctx.users);
  t.usersResolved = users.length;
  t.usersPlaceholder = users.filter((u) => u.isPlaceholder).length;
  ctx.report.errors = ctx.logger.getErrorCount();
  ctx.report.warnings = ctx.logger.getWarningCount();
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

export function printRunSummary(report: RunReport): void {
  const t = report.totals;
  const prefix = report.dryRun ? '[Dry run] ' : '';
  console.log(
    `\n📊 ${prefix}Run ${report.runId} (${report.mode}) — ${report.status}`
  );
  console.log(
    `   Users listed: ${report.subjects.length} (${report.subjects.filter((s) => s.error).length} failed)`
  );
  console.log(
    `   Spaces: ${t.spacesDiscovered} discovered, ${t.spacesExported} ${report.dryRun ? 'would export' : 'exported'}, ${t.spacesSkipped} skipped, ${t.spacesFailed} failed`
  );
  console.log(
    `   Messages: ${t.messagesTotal} in store · +${t.messagesAdded} added · ~${t.messagesUpdated} edited · -${t.messagesDeleted} deleted · ?${t.messagesMissing} missing`
  );
  console.log(
    `   Attachments: ${t.attachmentsDownloaded} downloaded (${formatBytes(t.attachmentBytes)}), ${t.attachmentsFailed} failed`
  );
  console.log(
    `   People: ${t.usersResolved} referenced, ${t.usersPlaceholder} placeholders (deleted/external/bot)`
  );
  if (report.unreachableSpaces.length > 0) {
    console.log(
      `   ⚠️  ${report.unreachableSpaces.length} named space(s) not reachable by the selected users (see unreachable-spaces.json)`
    );
  }
  if (report.errors || report.warnings) {
    console.log(
      `   ${report.errors} error(s), ${report.warnings} warning(s)${report.logPath ? ` → ${report.logPath}` : ''}`
    );
  }
}

// ---------------------------------------------------------------------------
// Entry point

export async function exportWorkspace(
  options: WorkspaceExportOptions
): Promise<RunReport> {
  const logger = new Logger('Workspace export');
  const store = await openStore(options.outputDir);
  const { runId, mode } = chooseRun(store, options);
  const base = { options, store, runId, mode, logger };
  const ctx: RunContext = {
    ...base,
    report: initialReport(base),
    subjectEmails: new Set(),
    users: {},
    attachmentIndex: {},
  };

  console.log(
    `${options.dryRun ? '🧪 Dry run: ' : '📦 '}Workspace export ${runId} (${mode}) → ${options.outputDir}`
  );
  if (!options.dryRun) {
    await recordRunPointer(store, {
      runId,
      startedAt: ctx.report.startedAt,
      status: 'running',
    });
  }

  try {
    const subjects = await listDomainUsers(options.selection);
    if (subjects.length === 0) {
      throw new Error('No active users matched the selection.');
    }
    ctx.subjectEmails = new Set(subjects.map((u) => u.email));

    const discovered = await discoverSpaces(ctx, subjects);
    ctx.report.totals.spacesDiscovered = discovered.size;
    if (options.adminSweep) {
      await adminSweep(ctx, discovered);
    }

    ctx.users = await loadUsers(store);
    ctx.attachmentIndex = await loadAttachmentIndex(store);

    const targets = Array.from(discovered.values()).filter(
      (s) =>
        matchesSpaceFilter(s.raw, options.spaceFilter) &&
        !(options.skipBotDms && s.raw.singleUserBotDm)
    );
    console.log(
      `\n${options.dryRun ? 'Would sync' : 'Syncing'} ${targets.length} space(s):`
    );
    for (const target of targets) {
      // biome-ignore lint/nursery/noAwaitInLoop: spaces are synced one at a time so a crash leaves at most one space partial.
      ctx.report.spaces.push(await syncSpaceSafely(ctx, target));
    }

    computeTotals(ctx);
    ctx.report.status = options.dryRun ? 'dry-run' : 'completed';
  } catch (error) {
    computeTotals(ctx);
    ctx.report.status = 'failed';
    logger.addError('store', 'run', describeGoogleError(error));
    ctx.report.errors = logger.getErrorCount();
    throw error;
  } finally {
    ctx.report.finishedAt = now();
    if (logger.hasIssues()) {
      ctx.report.logPath = await logger.writeLog(
        options.outputDir,
        `${runId}.log`
      );
    }
    await saveRunReport(store, ctx.report);
    if (!options.dryRun) {
      await recordRunPointer(store, {
        runId,
        startedAt: ctx.report.startedAt,
        finishedAt: ctx.report.finishedAt,
        status: ctx.report.status,
      });
    }
    printRunSummary(ctx.report);
  }
  return ctx.report;
}
