/**
 * Structural checks on an archive model before it is written. Slack's
 * importer gives little feedback when an archive is subtly wrong (a message
 * from a user it does not know, a reply whose parent is missing), and an
 * import cannot be edited afterwards, so every rule the importer relies on is
 * checked here first. Pure; no I/O.
 */
import type {
  ArchiveConversation,
  ArchiveModel,
  SlackExportMessage,
} from '../../types/slack-export';

export type IssueLevel = 'error' | 'warning';

export interface ValidationIssue {
  level: IssueLevel;
  /** Conversation folder name, or `users.json` / `channels` for global checks. */
  where: string;
  message: string;
}

const CHANNEL_NAME_REGEX = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const USER_MENTION_REGEX = /<@(U[A-Z0-9]+)>/g;
const DM_MEMBERS = 2;
const MPIM_MIN_MEMBERS = 3;
const MPIM_MAX_MEMBERS = 9;

interface Context {
  userIds: Set<string>;
  issues: ValidationIssue[];
}

function add(
  ctx: Context,
  level: IssueLevel,
  where: string,
  message: string
): void {
  ctx.issues.push({ level, where, message });
}

function checkUsers(model: ArchiveModel, ctx: Context): void {
  const ids = new Set<string>();
  const emails = new Map<string, string>();
  for (const user of model.users) {
    if (ids.has(user.id)) {
      add(ctx, 'error', 'users.json', `duplicate user id ${user.id}`);
    }
    ids.add(user.id);
    const email = user.profile.email?.toLowerCase();
    if (!email) {
      continue;
    }
    const other = emails.get(email);
    if (other) {
      add(
        ctx,
        'error',
        'users.json',
        `${user.id} and ${other} share ${email}; the importer would map both to one account`
      );
    }
    emails.set(email, user.id);
  }
}

function checkChannelNames(
  model: ArchiveModel,
  existing: Set<string>,
  ctx: Context
): void {
  const seen = new Set<string>();
  const named = [...model.channels, ...model.groups, ...model.mpims];
  for (const channel of named) {
    if (!CHANNEL_NAME_REGEX.test(channel.name)) {
      add(ctx, 'error', channel.name, 'invalid Slack channel name');
    }
    if (seen.has(channel.name)) {
      add(ctx, 'error', channel.name, 'channel name used twice in the archive');
    }
    seen.add(channel.name);
    if (existing.has(channel.name)) {
      add(
        ctx,
        'error',
        channel.name,
        'a channel with this name already exists in Slack; the importer would merge into it or refuse'
      );
    }
  }
}

function checkMembers(conversation: ArchiveConversation, ctx: Context): void {
  const { plan } = conversation;
  const members = new Set(plan.members);
  for (const id of members) {
    if (!ctx.userIds.has(id)) {
      add(ctx, 'error', plan.name, `member ${id} is not in users.json`);
    }
  }
  if (plan.kind === 'dm' && members.size !== DM_MEMBERS) {
    add(
      ctx,
      'error',
      plan.name,
      `DM has ${members.size} distinct members; Slack DMs have exactly two`
    );
  }
  if (
    plan.kind === 'mpim' &&
    (members.size < MPIM_MIN_MEMBERS || members.size > MPIM_MAX_MEMBERS)
  ) {
    add(
      ctx,
      'error',
      plan.name,
      `group DM has ${members.size} members; Slack allows ${MPIM_MIN_MEMBERS} to ${MPIM_MAX_MEMBERS}`
    );
  }
}

function referencedUsers(message: SlackExportMessage): string[] {
  const ids: string[] = [];
  if (message.user) {
    ids.push(message.user);
  }
  if (message.parent_user_id) {
    ids.push(message.parent_user_id);
  }
  for (const reaction of message.reactions ?? []) {
    ids.push(...reaction.users);
  }
  for (const file of message.files ?? []) {
    ids.push(file.user);
  }
  for (const match of message.text.matchAll(USER_MENTION_REGEX)) {
    ids.push(match[1]);
  }
  return ids;
}

function checkMessage(
  message: SlackExportMessage,
  day: string,
  where: string,
  ctx: Context
): void {
  const seconds = Number(message.ts.split('.')[0]);
  const actualDay = new Date(seconds * 1000).toISOString().slice(0, 10);
  if (actualDay !== day) {
    add(ctx, 'error', where, `${message.ts} is filed under ${day}`);
  }
  if (message.subtype !== 'bot_message' && !message.user) {
    add(ctx, 'error', where, `${message.ts} has no author`);
  }
  for (const id of referencedUsers(message)) {
    if (!ctx.userIds.has(id)) {
      add(
        ctx,
        'error',
        where,
        `${message.ts} references ${id}, which is not in users.json`
      );
    }
  }
  for (const file of message.files ?? []) {
    if (!file.url_private.startsWith('https://')) {
      add(
        ctx,
        'warning',
        where,
        `${message.ts} file ${file.name} is not served over https`
      );
    }
  }
}

function checkThreads(
  messages: SlackExportMessage[],
  where: string,
  ctx: Context
): void {
  const byTs = new Map(messages.map((m) => [m.ts, m]));
  const replyCounts = new Map<string, number>();
  for (const message of messages) {
    if (!message.thread_ts || message.thread_ts === message.ts) {
      continue;
    }
    const parent = byTs.get(message.thread_ts);
    if (!parent) {
      add(
        ctx,
        'error',
        where,
        `reply ${message.ts} points at missing parent ${message.thread_ts}`
      );
      continue;
    }
    if (parent.thread_ts !== parent.ts) {
      add(
        ctx,
        'error',
        where,
        `parent ${parent.ts} of reply ${message.ts} is not marked as a thread`
      );
    }
    replyCounts.set(parent.ts, (replyCounts.get(parent.ts) ?? 0) + 1);
  }
  for (const [ts, count] of replyCounts) {
    const declared = byTs.get(ts)?.reply_count ?? 0;
    if (declared !== count) {
      add(
        ctx,
        'error',
        where,
        `thread ${ts} declares ${declared} replies but has ${count}`
      );
    }
  }
}

function checkConversation(
  conversation: ArchiveConversation,
  ctx: Context
): void {
  const where = conversation.plan.name;
  checkMembers(conversation, ctx);
  const all: SlackExportMessage[] = [];
  const seenTs = new Set<string>();
  for (const [day, messages] of Object.entries(conversation.days)) {
    for (const message of messages) {
      if (seenTs.has(message.ts)) {
        add(ctx, 'error', where, `duplicate ts ${message.ts}`);
      }
      seenTs.add(message.ts);
      checkMessage(message, day, where, ctx);
      all.push(message);
    }
  }
  if (all.length !== conversation.messageCount) {
    add(
      ctx,
      'error',
      where,
      `holds ${all.length} messages but the manifest says ${conversation.messageCount}`
    );
  }
  checkThreads(all, where, ctx);
}

/**
 * Checks the whole model. `existingChannelNames` is the destination's current
 * channel names, when known, so name collisions surface before the import.
 */
export function validateArchive(
  model: ArchiveModel,
  existingChannelNames: Iterable<string> = []
): ValidationIssue[] {
  const ctx: Context = {
    userIds: new Set(model.users.map((u) => u.id)),
    issues: [],
  };
  checkUsers(model, ctx);
  checkChannelNames(model, new Set(existingChannelNames), ctx);
  for (const conversation of model.conversations) {
    checkConversation(conversation, ctx);
  }
  return ctx.issues;
}
