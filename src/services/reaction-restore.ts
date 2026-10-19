/**
 * Restores real reactions after an import. Slack's importer drops reactions,
 * and Slack only lets a person add their own, so each connected person's
 * token re-adds exactly the reactions they made, in every conversation it
 * can reach (their DMs included).
 *
 * The archive also wrote reactions into each message as a text line (see
 * REACTION_LINE_PREFIX). Once reactions are real, that line is rewritten to
 * name only the people still missing, or removed; only the message's author
 * can edit it, so this happens where the author is connected too.
 */
import type { WebClient } from '@slack/web-api';
import yauzl from 'yauzl';
import type {
  MessageIndexConversation,
  SlackExportMessage,
} from '../types/slack-export';
import { reactionEmoji } from './slack-archive/emoji';
import { REACTION_LINE_PREFIX } from './slack-archive/messages';
import type { Destination } from './slack-destination';

export interface ArchivedReaction {
  /** Conversation folder in the archive (channel name, or DM id). */
  folder: string;
  ts: string;
  /** Parent ts when the message is a thread reply. */
  threadTs?: string;
  /** Edit time the archive gave the message (Google's), if any. */
  editedTs?: string;
  /** Archive user id of the message's author. */
  author?: string;
  text: string;
  reactions: { name: string; users: string[] }[];
}

/** Every message in the ZIP that carries reactions. */
export async function readArchiveReactions(
  zipPath: string
): Promise<ArchivedReaction[]> {
  const zip = await yauzl.openPromise(zipPath);
  const found: ArchivedReaction[] = [];
  try {
    for await (const entry of zip.eachEntry()) {
      const parts = entry.fileName.split('/');
      if (parts.length !== 2 || !parts[1].endsWith('.json')) {
        continue;
      }
      const stream = await zip.openReadStreamPromise(entry);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk as Buffer);
      }
      const messages = JSON.parse(
        Buffer.concat(chunks).toString('utf-8')
      ) as SlackExportMessage[];
      for (const message of messages) {
        if (message.reactions?.length) {
          found.push({
            folder: parts[0],
            ts: message.ts,
            threadTs:
              message.thread_ts && message.thread_ts !== message.ts
                ? message.thread_ts
                : undefined,
            editedTs: message.edited?.ts,
            author: message.user,
            text: message.text,
            reactions: message.reactions.map((r) => ({
              name: r.name,
              users: r.users,
            })),
          });
        }
      }
    }
  } finally {
    zip.close();
  }
  return found;
}

export interface RestoreTask {
  folder: string;
  ts: string;
  name: string;
}

/** The reactions one person made, as tasks. Pure. */
export function tasksFor(
  archived: ArchivedReaction[],
  archiveUserId: string
): RestoreTask[] {
  const tasks: RestoreTask[] = [];
  for (const message of archived) {
    for (const reaction of message.reactions) {
      if (reaction.users.includes(archiveUserId)) {
        tasks.push({
          folder: message.folder,
          ts: message.ts,
          name: reaction.name,
        });
      }
    }
  }
  return tasks;
}

/** The reaction line the archive wrote: always a message's last line. Pure. */
export function footerOf(text: string): string | undefined {
  const last = text.split('\n').at(-1) ?? '';
  return last.startsWith(REACTION_LINE_PREFIX) ? last : undefined;
}

/** One person's one emoji on one message; what the ledger tracks. */
export function pairKey(archiveUserId: string, emoji: string): string {
  return `${archiveUserId} ${emoji}`;
}

/**
 * The reaction line naming only reactions not yet real, or '' when none
 * remain. Tracked per person and emoji, so a failed emoji stays listed even
 * when the same person's other reactions went through. Pure.
 */
export function footerFor(
  reactions: { name: string; users: string[] }[],
  restored: Set<string>,
  nameOf: (archiveUserId: string) => string
): string {
  const remaining = reactions
    .map((r) => ({
      name: r.name,
      users: r.users.filter((u) => !restored.has(pairKey(u, r.name))),
    }))
    .filter((r) => r.users.length > 0);
  if (remaining.length === 0) {
    return '';
  }
  const parts = remaining.map(
    (r) => `${reactionEmoji(r.name)} ${r.users.map(nameOf).join(', ')}`
  );
  return `${REACTION_LINE_PREFIX}${parts.join(' · ')}_`;
}

/**
 * Swaps the reaction line at the end of the message's current text for
 * `next` (removing it when ''). Undefined when the last line is not exactly
 * the one expected, which means someone edited the message, or when nothing
 * would change. Everything above the line is left as it is now. Pure.
 */
export function replaceFooter(
  current: string,
  expected: string,
  next: string
): string | undefined {
  const lines = current.split('\n');
  if (lines.at(-1) !== expected) {
    return;
  }
  const body = lines.slice(0, -1);
  const text = next ? [...body, next].join('\n') : body.join('\n');
  return text === current ? undefined : text;
}

export type RestoreOutcome =
  | 'added'
  | 'already'
  | 'unreachable'
  | 'message-gone'
  | 'emoji-missing'
  /** Archived after the import; Slack refuses reactions there for good. */
  | 'archived'
  | 'failed';

/**
 * Slack's error for a channel archived after the import: reactions.add says
 * `is_archived`, chat.update says `is_inactive`. Final, so not a failure.
 */
export function isArchivedChannelError(code: string | undefined): boolean {
  return code === 'is_archived' || code === 'is_inactive';
}

/** Adds one reaction with the reacting person's own token. */
export async function addReaction(
  client: WebClient,
  destination: Destination,
  task: RestoreTask
): Promise<RestoreOutcome> {
  if (!destination.channelId) {
    return 'unreachable';
  }
  try {
    await client.reactions.add({
      channel: destination.channelId,
      timestamp: task.ts,
      name: task.name,
    });
    return 'added';
  } catch (error) {
    const code = (error as { data?: { error?: string } }).data?.error;
    if (code === 'already_reacted') {
      return 'already';
    }
    if (
      code === 'message_not_found' ||
      code === 'channel_not_found' ||
      code === 'not_in_channel'
    ) {
      return 'message-gone';
    }
    if (code === 'invalid_name') {
      return 'emoji-missing';
    }
    if (isArchivedChannelError(code)) {
      return 'archived';
    }
    return 'failed';
  }
}

/** What earlier runs did, so reruns and `--only` batches build on each other. */
export interface RestoredLedger {
  /** The archive build this ledger belongs to (manifest builtAt). */
  builtAt?: string;
  /** `folder:ts` → pairKey(person, emoji) for each reaction now real. */
  restored: Record<string, string[]>;
  /** `folder:ts` → the reaction line last written ('' once removed). */
  footers: Record<string, string>;
}

export function ledgerKey(folder: string, ts: string): string {
  return `${folder}:${ts}`;
}

/** Records one person's one emoji as real. */
export function markRestored(
  ledger: RestoredLedger,
  key: string,
  archiveUserId: string,
  emoji: string
): void {
  const pairs = ledger.restored[key] ?? [];
  const pair = pairKey(archiveUserId, emoji);
  if (!pairs.includes(pair)) {
    pairs.push(pair);
  }
  ledger.restored[key] = pairs;
}

export interface CurrentMessage {
  text: string;
  fileIds: string[];
  /** Edit time Slack has now, if the message was ever edited. */
  editedTs?: string;
}

/**
 * The message as it is in Slack now. Slack refuses to edit a message down to
 * empty text unless the edit names its files, so their ids come along.
 */
export async function fetchMessage(
  client: WebClient,
  channel: string,
  message: Pick<ArchivedReaction, 'ts' | 'threadTs'>
): Promise<CurrentMessage | undefined> {
  const range = { latest: message.ts, oldest: message.ts, inclusive: true };
  const page = message.threadTs
    ? await client.conversations.replies({
        channel,
        ts: message.threadTs,
        ...range,
      })
    : await client.conversations.history({ channel, ...range, limit: 1 });
  const found = page.messages?.find((m) => m.ts === message.ts);
  if (!found) {
    return;
  }
  return {
    text: found.text ?? '',
    fileIds: (found.files ?? []).flatMap((f) => (f.id ? [f.id] : [])),
    editedTs: found.edited?.ts,
  };
}

/** Looks up archive conversations by folder name. Pure. */
export function conversationsByFolder(
  index: MessageIndexConversation[]
): Map<string, MessageIndexConversation> {
  return new Map(index.map((c) => [c.name, c]));
}
