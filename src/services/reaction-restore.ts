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

/**
 * The message text with its reaction line rewritten to name only people
 * whose reactions were not restored, or without the line when none remain.
 * Returns undefined when nothing would change. Pure.
 */
export function rewriteReactionLine(
  text: string,
  reactions: { name: string; users: string[] }[],
  restored: Set<string>,
  nameOf: (archiveUserId: string) => string
): string | undefined {
  const lines = text.split('\n');
  const index = lines.findIndex((line) =>
    line.startsWith(REACTION_LINE_PREFIX)
  );
  if (index === -1) {
    return;
  }
  const remaining = reactions
    .map((r) => ({
      name: r.name,
      users: r.users.filter((u) => !restored.has(u)),
    }))
    .filter((r) => r.users.length > 0);
  const kept = lines.filter((_, i) => i !== index);
  if (remaining.length > 0) {
    const parts = remaining.map(
      (r) => `${reactionEmoji(r.name)} ${r.users.map(nameOf).join(', ')}`
    );
    kept.splice(index, 0, `${REACTION_LINE_PREFIX}${parts.join(' · ')}_`);
  }
  const next = kept.join('\n');
  return next === text ? undefined : next;
}

export type RestoreOutcome =
  | 'added'
  | 'already'
  | 'unreachable'
  | 'message-gone'
  | 'emoji-missing'
  | 'failed';

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
    return 'failed';
  }
}

/** What earlier runs did, so reruns and `--only` batches build on each other. */
export interface RestoredLedger {
  /** `folder:ts` → archive ids whose reactions are real now. */
  restored: Record<string, string[]>;
  /** `folder:ts` → the text last written to that message. */
  lines: Record<string, string>;
}

export function ledgerKey(folder: string, ts: string): string {
  return `${folder}:${ts}`;
}

/** Adds one person's restored reaction to the ledger. */
export function markRestored(
  ledger: RestoredLedger,
  key: string,
  archiveUserId: string
): void {
  const users = ledger.restored[key] ?? [];
  if (!users.includes(archiveUserId)) {
    users.push(archiveUserId);
  }
  ledger.restored[key] = users;
}

/** Looks up archive conversations by folder name. Pure. */
export function conversationsByFolder(
  index: MessageIndexConversation[]
): Map<string, MessageIndexConversation> {
  return new Map(index.map((c) => [c.name, c]));
}
