/**
 * Google Meet creates a chat for every scheduled meeting. Most stay empty
 * (Google never lists those, so they are not in the store); the rest hold a
 * handful of messages each. Imported one-for-one they would become dozens of
 * tiny channels, so the archive offers three treatments:
 *
 * - fold: into the conversation the same people already have. Two people →
 *   their DM, three to nine → their group DM, otherwise one private channel
 *   per meeting series (`mtg-<series>`). Each meeting sits in its own thread
 *   under a one-line header, so it keeps its context without cluttering the
 *   conversation. Nobody gains access to anything: a chat lands only with the
 *   people who were in it.
 * - channels: one private channel per meeting chat, as for any named Space.
 * - discard: leave them out, recorded in the manifest as skipped.
 */
import type { StoredMessage, StoredSpace } from '../../types/export-store';
import type {
  ArchiveConversation,
  SlackExportMessage,
} from '../../types/slack-export';
import { microsToSlackTs, slackTsToMicros } from '../../utils/timestamps';

export type MeetingChatMode = 'fold' | 'channels' | 'discard';

export const MEETING_HEADER_USERNAME = 'Google Meet';

const DATE_SUFFIX_REGEX =
  /\s+-\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+\d{1,2}$/;

/**
 * Meet chats are the only named Spaces Google creates unthreaded; ordinary
 * Spaces have been threaded or in-line threaded for years. Measured on the
 * HRC store: all 69 unthreaded Spaces are meeting chats, and none of the
 * other 277 Spaces is.
 */
export function isMeetingChat(space: StoredSpace): boolean {
  return (
    space.spaceType === 'SPACE' &&
    space.source !== 'vault' &&
    space.raw.spaceThreadingState === 'UNTHREADED_MESSAGES'
  );
}

/** "Sheila/Kelly TouchPoint - Feb 2" → "Sheila/Kelly TouchPoint". Pure. */
export function meetingSeries(displayName: string): string {
  return displayName.replace(DATE_SUFFIX_REGEX, '').trim() || displayName;
}

/** Order-independent key for a set of Slack user ids. Pure. */
export function memberKey(ids: string[]): string {
  return [...new Set(ids)].sort().join(',');
}

/** The header opening a meeting's thread. */
export function meetingHeaderText(space: StoredSpace): string {
  return `📅 ${space.displayName || 'Meeting'} (Google Meet chat)`;
}

function allMessages(
  days: Record<string, SlackExportMessage[]>
): SlackExportMessage[] {
  return Object.values(days).flat();
}

function dayOf(ts: string): string {
  return new Date(Number(ts.split('.')[0]) * 1000).toISOString().slice(0, 10);
}

/**
 * A ts one microsecond before `first` that `taken` does not hold, so the
 * header sorts immediately before the meeting it introduces. Pure.
 */
export function headerTs(first: string, taken: Set<string>): string {
  let micros = slackTsToMicros(first) - 1n;
  while (taken.has(microsToSlackTs(micros))) {
    micros -= 1n;
  }
  return microsToSlackTs(micros);
}

/**
 * Puts a meeting's messages in a thread under a header message. Mutates the
 * messages and returns the header. Pure apart from that.
 */
export function threadUnderHeader(
  messages: SlackExportMessage[],
  text: string,
  taken: Set<string>
): SlackExportMessage | undefined {
  const sorted = [...messages].sort((a, b) => a.ts.localeCompare(b.ts));
  if (sorted.length === 0) {
    return;
  }
  const ts = headerTs(sorted[0].ts, taken);
  for (const message of sorted) {
    message.thread_ts = ts;
    message.parent_user_id = undefined;
    message.reply_count = undefined;
    message.replies = undefined;
    message.reply_users = undefined;
    message.reply_users_count = undefined;
    message.latest_reply = undefined;
  }
  const replyUsers = [
    ...new Set(
      sorted.map((m) => m.user).filter((u): u is string => Boolean(u))
    ),
  ];
  return {
    type: 'message',
    subtype: 'bot_message',
    username: MEETING_HEADER_USERNAME,
    ts,
    text,
    thread_ts: ts,
    reply_count: sorted.length,
    reply_users: replyUsers,
    reply_users_count: replyUsers.length,
    replies: sorted.map((m) => ({ user: m.user ?? '', ts: m.ts })),
    latest_reply: sorted.at(-1)?.ts,
  };
}

/** Adds day buckets into a conversation, keeping each day in ts order. */
export function mergeDays(
  target: ArchiveConversation,
  days: Record<string, SlackExportMessage[]>,
  extra: SlackExportMessage[] = []
): void {
  const incoming = [...allMessages(days), ...extra];
  for (const message of incoming) {
    const day = dayOf(message.ts);
    const bucket = target.days[day] ?? [];
    bucket.push(message);
    target.days[day] = bucket;
  }
  for (const day of new Set(incoming.map((m) => dayOf(m.ts)))) {
    target.days[day].sort((a, b) => a.ts.localeCompare(b.ts));
  }
}

/** Every ts a conversation already holds. */
export function tsSet(conversation: ArchiveConversation): Set<string> {
  return new Set(allMessages(conversation.days).map((m) => m.ts));
}

export interface PendingMeeting {
  space: StoredSpace;
  messages: StoredMessage[];
}
