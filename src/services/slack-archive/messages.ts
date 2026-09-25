/**
 * Turns stored Google messages into Slack export messages for one
 * conversation: unique timestamps, threads, edits, deletions, reactions,
 * mentions, files and Drive links. Pure; no I/O.
 */
import path from 'node:path';
import type { AttachmentRecord, StoredMessage } from '../../types/export-store';
import type {
  ArchiveConversationKind,
  ArchiveUserMapping,
  ConversationPlan,
  FileUploadTask,
  HostedFile,
  SlackExportFile,
  SlackExportMessage,
  SlackExportReaction,
} from '../../types/slack-export';
import {
  compareTimestamps,
  microsToSlackTs,
  slackTsToMicros,
  toSlackTs,
} from '../../utils/timestamps';
import { slackIdFor } from './ids';
import { migratedTime } from './migrated';
import {
  fallbackText,
  messageText,
  reactionShortName,
  type TextContext,
} from './text';

export type DeletedPolicy = 'tombstone' | 'content' | 'omit';
export type FileStrategy = 'manifest' | 'hosted';

export interface MessageBuildOptions {
  deletedPolicy: DeletedPolicy;
  fileStrategy: FileStrategy;
  /** Base URL under which `attachments/files` is served (hosted strategy). */
  filesBaseUrl?: string;
  /** Local `attachments/files` directory, to compute hosted paths. */
  filesRoot: string;
  /** Only include messages first seen after this run (delta archives). */
  firstSeenAfterRun?: string;
  /** Only include messages created after this RFC 3339 time (delta archives). */
  messagesSince?: string;
  /** Attachments moved to Google Drive (stage-large-files), by attachment key. */
  driveCopies?: Record<string, DriveCopy>;
}

export interface DriveCopy {
  name: string;
  size: number;
  webViewLink: string;
}

export interface MessageBuildContext {
  plan: ConversationPlan;
  users: Map<string, ArchiveUserMapping>;
  attachmentIndex: Record<string, AttachmentRecord>;
  options: MessageBuildOptions;
  uploads: FileUploadTask[];
  hostedFiles: HostedFile[];
  warnings: string[];
  fileCounts: { hosted: number; linkOnly: number; unavailable: number };
  /** Large hosted files by the ts of the message they belong to; see INLINE_FILE_MAX_BYTES. */
  largeFiles?: Map<string, SlackExportFile[]>;
}

export interface BuiltMessages {
  days: Record<string, SlackExportMessage[]>;
  count: number;
  omitted: number;
}

export const TOMBSTONE_TEXT = '_This message was deleted in Google Chat._';

/**
 * Largest file the pilot saw Slack's importer accept (62.6 MB). A 104 MB and
 * a 153 MB file were rejected, and Slack dropped their whole messages, text
 * included. Bigger files therefore ride on a companion reply of their own, so
 * a rejection can only ever lose the file, never the message.
 */
export const INLINE_FILE_MAX_BYTES = 62 * 1024 * 1024;
/** Slack refuses any upload over 1 GB, by import or by API. */
export const SLACK_MAX_FILE_BYTES = 1024 * 1024 * 1024;
const TRAILING_SLASHES_REGEX = /\/+$/;

function textContext(ctx: MessageBuildContext): TextContext {
  return {
    slackIdFor: (chatUserId) => ctx.users.get(chatUserId)?.slackId,
    nameFor: (chatUserId) =>
      ctx.users.get(chatUserId)?.name ?? chatUserId.replace('users/', 'user '),
  };
}

function isIncluded(
  message: StoredMessage,
  options: MessageBuildOptions
): boolean {
  if (
    options.firstSeenAfterRun &&
    message.firstSeenRun <= options.firstSeenAfterRun
  ) {
    return false;
  }
  if (
    options.messagesSince &&
    compareTimestamps(message.createTime, options.messagesSince) <= 0
  ) {
    return false;
  }
  if (message.isDeleted && options.deletedPolicy === 'omit') {
    return false;
  }
  return true;
}

/** Slack rejects duplicate ts within a conversation; bump by 1µs when needed. */
export function assignUniqueTs(messages: StoredMessage[]): Map<string, string> {
  const sorted = [...messages].sort((a, b) =>
    compareTimestamps(a.createTime, b.createTime)
  );
  const result = new Map<string, string>();
  let last = -1n;
  for (const message of sorted) {
    let micros = slackTsToMicros(message.slackTs);
    if (micros <= last) {
      micros = last + 1n;
    }
    last = micros;
    result.set(message.name, microsToSlackTs(micros));
  }
  return result;
}

function dayOf(ts: string): string {
  const seconds = Number(ts.split('.')[0]);
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

function buildReactions(
  message: StoredMessage,
  ctx: MessageBuildContext
): SlackExportReaction[] | undefined {
  if (message.reactions.length === 0) {
    return;
  }
  const byName = new Map<string, Set<string>>();
  for (const reaction of message.reactions) {
    const name = reactionShortName(reaction);
    const slackId = ctx.users.get(reaction.user)?.slackId;
    if (!name) {
      ctx.warnings.push(
        `${message.name}: reaction ${reaction.emoji.unicode ?? reaction.emoji.customEmoji?.uid ?? '?'} has no Slack short name and was dropped`
      );
      continue;
    }
    if (!slackId) {
      continue;
    }
    const users = byName.get(name) ?? new Set<string>();
    users.add(slackId);
    byName.set(name, users);
  }
  const reactions = Array.from(byName.entries()).map(([name, users]) => ({
    name,
    users: Array.from(users),
    count: users.size,
  }));
  return reactions.length > 0 ? reactions : undefined;
}

function filetypeOf(record: AttachmentRecord): string {
  const ext = path
    .extname(record.fileName ?? '')
    .replace('.', '')
    .toLowerCase();
  return ext || 'binary';
}

function hostedUrl(
  record: AttachmentRecord,
  options: MessageBuildOptions
): string {
  const relative = path
    .relative(options.filesRoot, record.localPath ?? '')
    .split(path.sep)
    .map(encodeURIComponent)
    .join('/');
  const base = (options.filesBaseUrl ?? '').replace(TRAILING_SLASHES_REGEX, '');
  return `${base}/${relative}`;
}

function toExportFile(
  record: AttachmentRecord,
  ts: string,
  userId: string,
  options: MessageBuildOptions
): SlackExportFile {
  const seconds = Number(ts.split('.')[0]);
  const url = hostedUrl(record, options);
  const name = record.fileName ?? 'file';
  return {
    id: slackIdFor('F', record.key),
    created: seconds,
    timestamp: seconds,
    name,
    title: record.drive?.name ?? record.contentName ?? name,
    mimetype:
      record.exportedAs?.mimeType ??
      record.contentType ??
      'application/octet-stream',
    filetype: filetypeOf(record),
    size: record.size ?? 0,
    mode: 'hosted',
    is_external: false,
    url_private: url,
    url_private_download: url,
    user: userId,
  };
}

function driveLinkText(record: AttachmentRecord): string | undefined {
  const link = record.drive?.webViewLink ?? record.downloadUri;
  if (!link) {
    return;
  }
  const label = record.drive?.name ?? record.contentName ?? 'Google Drive file';
  return `📎 <${link}|${label}>`;
}

interface FileOutcome {
  files: SlackExportFile[];
  extraLines: string[];
}

/** Hosted strategy: inline, on a companion reply, or refused (over 1 GB). */
function placeHostedFile(
  record: AttachmentRecord,
  message: StoredMessage,
  ts: string,
  userId: string,
  ctx: MessageBuildContext,
  outcome: FileOutcome
): void {
  const size = record.size ?? 0;
  if (size > SLACK_MAX_FILE_BYTES) {
    const label = record.drive?.name ?? record.contentName ?? record.fileName;
    const gb = (size / 1024 ** 3).toFixed(1);
    outcome.extraLines.push(
      `_[${label} (${gb} GB) is larger than Slack accepts and was not imported.]_`
    );
    ctx.fileCounts.unavailable += 1;
    ctx.warnings.push(
      `${message.name}: ${label} is ${gb} GB, over Slack's 1 GB limit`
    );
    return;
  }
  const file = toExportFile(record, ts, userId, ctx.options);
  if (size > INLINE_FILE_MAX_BYTES && ctx.largeFiles) {
    ctx.largeFiles.set(ts, [...(ctx.largeFiles.get(ts) ?? []), file]);
  } else {
    outcome.files.push(file);
  }
  ctx.hostedFiles.push({
    url: file.url_private,
    localPath: record.localPath as string,
    fileName: file.name,
    mimeType: file.mimetype,
    size: file.size,
    sha256: record.sha256,
    conversationName: ctx.plan.name,
    ts,
  });
  ctx.fileCounts.hosted += 1;
}

/** Links the Drive copy of a file too large for Slack; false if there is none. */
function linkDriveCopy(
  record: AttachmentRecord,
  ctx: MessageBuildContext,
  outcome: FileOutcome
): boolean {
  const inDrive = ctx.options.driveCopies?.[record.key];
  if (!inDrive) {
    return false;
  }
  const mb = Math.round(inDrive.size / 1024 ** 2);
  outcome.extraLines.push(
    `📎 <${inDrive.webViewLink}|${inDrive.name}> (${mb} MB, too large for Slack; kept in Google Drive)`
  );
  ctx.fileCounts.linkOnly += 1;
  return true;
}

/** Manifest strategy: list the file for the post-import uploader. */
function queueUpload(
  record: AttachmentRecord,
  ts: string,
  threadTs: string | undefined,
  userId: string,
  ctx: MessageBuildContext
): void {
  ctx.uploads.push({
    conversationId: ctx.plan.id,
    conversationName: ctx.plan.name,
    conversationKind: ctx.plan.kind,
    ts,
    threadTs,
    userId,
    attachmentKey: record.key,
    localPath: record.localPath as string,
    fileName: record.fileName ?? 'file',
    title:
      record.drive?.name ?? record.contentName ?? record.fileName ?? 'file',
    mimeType:
      record.exportedAs?.mimeType ??
      record.contentType ??
      'application/octet-stream',
    size: record.size ?? 0,
    sha256: record.sha256,
    driveLink: record.drive?.webViewLink,
  });
}

function handleAttachment(
  record: AttachmentRecord,
  message: StoredMessage,
  ts: string,
  threadTs: string | undefined,
  userId: string,
  ctx: MessageBuildContext,
  outcome: FileOutcome
): void {
  const downloaded =
    (record.status === 'downloaded' || record.status === 'exported') &&
    record.localPath;
  const link = driveLinkText(record);

  if (downloaded && linkDriveCopy(record, ctx, outcome)) {
    return;
  }
  if (downloaded) {
    if (ctx.options.fileStrategy === 'hosted') {
      placeHostedFile(record, message, ts, userId, ctx, outcome);
    } else {
      queueUpload(record, ts, threadTs, userId, ctx);
    }
    if (record.kind === 'DRIVE_FILE' && link) {
      outcome.extraLines.push(link);
    }
    return;
  }

  if (record.status === 'link-only' && link) {
    outcome.extraLines.push(link);
    ctx.fileCounts.linkOnly += 1;
    return;
  }

  if (record.kind === 'DRIVE_LINK') {
    // Links in text are already part of the message body.
    return;
  }

  ctx.fileCounts.unavailable += 1;
  const label = record.drive?.name ?? record.contentName ?? record.key;
  outcome.extraLines.push(
    `_[Attachment unavailable at export time: ${label}]_`
  );
  ctx.warnings.push(
    `${message.name}: attachment ${record.key} is ${record.status}${record.error ? ` (${record.error})` : ''}`
  );
}

function quotedTextFor(
  message: StoredMessage,
  byName: Map<string, StoredMessage>,
  ctx: MessageBuildContext
): string | undefined {
  const quotedName = message.raw.quotedMessageMetadata?.name;
  if (!quotedName) {
    return;
  }
  const quoted = byName.get(quotedName);
  if (!quoted) {
    return;
  }
  const author = quoted.senderId
    ? ctx.users.get(quoted.senderId)?.name
    : undefined;
  const body = messageText(quoted, textContext(ctx)).split('\n')[0];
  return author ? `*${author}:* ${body}` : body;
}

/** Text and files of one message; never leaves it empty (Slack drops those). */
function fillBody(
  result: SlackExportMessage,
  message: StoredMessage,
  byName: Map<string, StoredMessage>,
  userId: string,
  ctx: MessageBuildContext
): void {
  const { ts } = result;
  const quoted = quotedTextFor(message, byName, ctx);
  const lines = [messageText(message, textContext(ctx), quoted)];
  const outcome: FileOutcome = { files: [], extraLines: [] };
  for (const key of message.attachmentKeys) {
    const record = ctx.attachmentIndex[key];
    if (record) {
      handleAttachment(record, message, ts, undefined, userId, ctx, outcome);
    }
  }
  lines.push(...outcome.extraLines);
  result.text = lines.filter((line) => line.length > 0).join('\n');
  if (outcome.files.length > 0) {
    result.files = outcome.files;
  }
  const large = ctx.largeFiles?.get(ts) ?? [];
  if (!result.text && large.length > 0) {
    // The files move to a reply; the message itself must still say something.
    result.text = large
      .map(
        (f) =>
          `📎 ${f.title} (${Math.round(f.size / 1024 ** 2)} MB, in the reply below)`
      )
      .join('\n');
  }
  if (!(result.text || result.files)) {
    result.text = fallbackText(message);
  }
}

function buildOne(
  message: StoredMessage,
  ts: string,
  byName: Map<string, StoredMessage>,
  ctx: MessageBuildContext
): SlackExportMessage {
  const mapping = message.senderId
    ? ctx.users.get(message.senderId)
    : undefined;
  const isBot = message.senderType === 'BOT' || mapping?.status === 'bot';
  const userId = mapping?.slackId ?? ctx.plan.members[0] ?? '';
  const result: SlackExportMessage = {
    type: 'message',
    ts,
    text: '',
  };

  if (isBot) {
    result.subtype = 'bot_message';
    result.username = mapping?.name ?? 'Google Chat app';
  } else {
    result.user = userId;
    if (mapping) {
      result.user_profile = {
        real_name: mapping.name,
        display_name: mapping.name,
        name: mapping.name,
      };
    }
  }

  if (message.isDeleted && ctx.options.deletedPolicy === 'tombstone') {
    result.text = TOMBSTONE_TEXT;
    return result;
  }

  fillBody(result, message, byName, userId, ctx);
  if (message.lastUpdateTime && !message.isDeleted) {
    result.edited = { user: userId, ts: toSlackTs(message.lastUpdateTime) };
  }
  const reactions = buildReactions(message, ctx);
  if (reactions) {
    result.reactions = reactions;
  }
  return result;
}

interface ThreadGroup {
  parent: { stored: StoredMessage; built: SlackExportMessage };
  replies: Array<{ stored: StoredMessage; built: SlackExportMessage }>;
}

function groupThreads(
  items: Array<{ stored: StoredMessage; built: SlackExportMessage }>
): ThreadGroup[] {
  const byThread = new Map<string, ThreadGroup>();
  const groups: ThreadGroup[] = [];
  for (const item of items) {
    const key = item.stored.threadName ?? item.stored.name;
    const existing = byThread.get(key);
    if (!existing) {
      const group = { parent: item, replies: [] };
      byThread.set(key, group);
      groups.push(group);
    } else if (existing.parent.stored.threadReply && !item.stored.threadReply) {
      // The real parent arrived after a reply; swap them.
      existing.replies.unshift(existing.parent);
      existing.parent = item;
    } else {
      existing.replies.push(item);
    }
  }
  return groups;
}

function linkThreads(
  items: Array<{ stored: StoredMessage; built: SlackExportMessage }>,
  uploads: FileUploadTask[]
): void {
  // This conversation's uploads by message ts; scanning every upload in the
  // archive per reply is quadratic and stalls a full-workspace build.
  const uploadsByTs = new Map<string, FileUploadTask[]>();
  for (const upload of uploads) {
    const list = uploadsByTs.get(upload.ts) ?? [];
    list.push(upload);
    uploadsByTs.set(upload.ts, list);
  }
  for (const group of groupThreads(items)) {
    if (group.replies.length === 0) {
      continue;
    }
    const parent = group.parent.built;
    const parentUser = parent.user ?? '';
    parent.thread_ts = parent.ts;
    parent.reply_count = group.replies.length;
    parent.replies = group.replies.map((r) => ({
      user: r.built.user ?? '',
      ts: r.built.ts,
    }));
    const replyUsers = Array.from(
      new Set(group.replies.map((r) => r.built.user).filter(Boolean))
    ) as string[];
    parent.reply_users = replyUsers;
    parent.reply_users_count = replyUsers.length;
    parent.latest_reply = group.replies.at(-1)?.built.ts;
    parent.subscribed = false;
    for (const reply of group.replies) {
      reply.built.thread_ts = parent.ts;
      reply.built.parent_user_id = parentUser;
      // Files posted later must land in the thread, not the channel.
      for (const upload of uploadsByTs.get(reply.built.ts) ?? []) {
        upload.threadTs = parent.ts;
      }
    }
  }
}

/**
 * A message as the archive should see it: for one re-dated by the earlier
 * Slack-to-Google migration, the real time and the text without its
 * "Message Posted" line. Its edit marker only records the migration, so it
 * goes too. Native messages pass through unchanged. Pure.
 */
export function withRealTime(message: StoredMessage): StoredMessage {
  const real = migratedTime(message);
  if (!real) {
    return message;
  }
  return {
    ...message,
    createTime: real.createTime,
    slackTs: toSlackTs(real.createTime),
    text: real.strip(message.text),
    formattedText:
      message.formattedText === undefined
        ? undefined
        : real.strip(message.formattedText),
    lastUpdateTime: undefined,
  };
}

/** A ts after `after` that no message in `taken` holds; registers it. */
function freeTsAfter(after: string, taken: Set<string>): string {
  let micros = slackTsToMicros(after) + 1n;
  while (taken.has(microsToSlackTs(micros))) {
    micros += 1n;
  }
  const ts = microsToSlackTs(micros);
  taken.add(ts);
  return ts;
}

/**
 * Posts each large file as its own reply in the thread of the message it
 * belonged to (starting a thread when there was none). Mutates the thread
 * parents' reply metadata; returns the companion messages.
 */
function attachLargeFiles(
  built: SlackExportMessage[],
  largeFiles: Map<string, SlackExportFile[]>
): SlackExportMessage[] {
  const byTs = new Map(built.map((m) => [m.ts, m]));
  const taken = new Set(byTs.keys());
  const companions: SlackExportMessage[] = [];
  for (const [ts, files] of largeFiles) {
    const owner = byTs.get(ts);
    if (!owner) {
      continue;
    }
    const parentTs =
      owner.thread_ts && owner.thread_ts !== owner.ts
        ? owner.thread_ts
        : owner.ts;
    const parent = byTs.get(parentTs) ?? owner;
    for (const file of files) {
      const reply: SlackExportMessage = {
        type: 'message',
        ts: freeTsAfter(ts, taken),
        user: owner.user,
        user_profile: owner.user_profile,
        text: `📎 ${file.title}`,
        files: [file],
        thread_ts: parentTs,
        parent_user_id: parent.user,
      };
      companions.push(reply);
      parent.thread_ts = parentTs;
      parent.reply_count = (parent.reply_count ?? 0) + 1;
      parent.replies = [
        ...(parent.replies ?? []),
        { user: reply.user ?? '', ts: reply.ts },
      ].sort((a, b) => a.ts.localeCompare(b.ts));
      parent.reply_users = [
        ...new Set([...(parent.reply_users ?? []), reply.user ?? '']),
      ].filter(Boolean);
      parent.reply_users_count = parent.reply_users.length;
      parent.latest_reply = parent.replies.at(-1)?.ts;
    }
  }
  return companions;
}

/** Builds all day files for one conversation. */
export function buildConversationMessages(
  messages: StoredMessage[],
  ctx: MessageBuildContext
): BuiltMessages {
  // Delta cut-offs apply to Google's own times; everything after uses the
  // real time of messages the earlier Slack-to-Google migration re-dated.
  const included = messages
    .filter((m) => isIncluded(m, ctx.options))
    .map(withRealTime);
  const omitted = messages.length - included.length;
  const tsByName = assignUniqueTs(included);
  const firstUpload = ctx.uploads.length;
  const largeFiles = new Map<string, SlackExportFile[]>();
  ctx.largeFiles = largeFiles;
  const byName = new Map(messages.map((m) => [m.name, withRealTime(m)]));
  const items = included
    .sort((a, b) => compareTimestamps(a.createTime, b.createTime))
    .map((stored) => ({
      stored,
      built: buildOne(stored, tsByName.get(stored.name) as string, byName, ctx),
    }));
  linkThreads(items, ctx.uploads.slice(firstUpload));
  const companions = attachLargeFiles(
    items.map((i) => i.built),
    largeFiles
  );

  const days: Record<string, SlackExportMessage[]> = {};
  for (const built of [...items.map((i) => i.built), ...companions]) {
    const day = dayOf(built.ts);
    const bucket = days[day] ?? [];
    bucket.push(built);
    days[day] = bucket;
  }
  for (const bucket of Object.values(days)) {
    bucket.sort((a, b) => a.ts.localeCompare(b.ts));
  }
  return { days, count: items.length + companions.length, omitted };
}

export function kindLabel(kind: ArchiveConversationKind): string {
  switch (kind) {
    case 'channel':
      return 'public channel';
    case 'group':
      return 'private channel';
    case 'dm':
      return 'direct message';
    default:
      return 'group DM';
  }
}
