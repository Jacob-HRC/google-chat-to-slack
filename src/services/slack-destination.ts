/**
 * Finds where each archived conversation lives in Slack after the import.
 *
 * The archive's own ids mean nothing to Slack, so conversations are found the
 * way a person would find them: channels by name, DMs and group DMs by who is
 * in them. Archive user ids are turned into real Slack ids through the email
 * each person was imported under.
 *
 * Reach is limited by token. The bot sees public channels and private ones it
 * was invited to. A user token sees that person's own DMs and group DMs.
 * Anything else is reported as unreachable, with the reason.
 */
import type { WebClient } from '@slack/web-api';
import type {
  ArchiveUserMapping,
  MessageIndexConversation,
} from '../types/slack-export';
import type { SlackMemberSnapshot } from './slack-archive/slack-members';

export interface Destination {
  channelId?: string;
  /** Which token can read and post there. */
  via?: 'bot' | 'user';
  /** Public channel the bot is not in yet; readable once it joins. */
  needsJoin?: boolean;
  unreachable?: string;
}

export interface SlackConversationRef {
  id: string;
  name?: string;
  isPrivate: boolean;
  isMember: boolean;
  /** Slack user ids, for DMs and group DMs. */
  members?: string[];
}

export interface DestinationDirectory {
  /** Archive user id → real Slack user id. */
  slackUserIds: Map<string, string>;
  botChannels: SlackConversationRef[];
  userChannels: SlackConversationRef[];
  userDms: SlackConversationRef[];
  /** The user token's own Slack id, when a user token is available. */
  userSelfId?: string;
}

/** Archive user id → Slack id, via the email each person was imported under. Pure. */
export function mapArchiveUsers(
  users: Record<string, ArchiveUserMapping>,
  after: SlackMemberSnapshot
): Map<string, string> {
  const byEmail = new Map<string, string>();
  for (const member of after.members) {
    if (member.email && !member.isBot) {
      byEmail.set(member.email.toLowerCase(), member.id);
    }
  }
  const result = new Map<string, string>();
  for (const mapping of Object.values(users)) {
    const id = mapping.email
      ? byEmail.get(mapping.email.toLowerCase())
      : undefined;
    if (id) {
      result.set(mapping.slackId, id);
    }
  }
  return result;
}

function sameMembers(a: string[], b: string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((id) => right.has(id));
}

function channelDestination(
  conversation: MessageIndexConversation,
  directory: DestinationDirectory
): Destination {
  const bot = directory.botChannels.find((c) => c.name === conversation.name);
  if (bot && (bot.isMember || !bot.isPrivate)) {
    return { channelId: bot.id, via: 'bot', needsJoin: !bot.isMember };
  }
  const user = directory.userChannels.find((c) => c.name === conversation.name);
  if (user) {
    return { channelId: user.id, via: 'user' };
  }
  return {
    unreachable:
      conversation.kind === 'group'
        ? 'private channel the bot is not in; invite the Chat Migration app to check it'
        : 'no channel with this name',
  };
}

function directDestination(
  conversation: MessageIndexConversation,
  directory: DestinationDirectory
): Destination {
  const members = conversation.members.map((id) =>
    directory.slackUserIds.get(id)
  );
  if (members.some((id) => !id)) {
    return { unreachable: 'a participant has no Slack account' };
  }
  const slackIds = members as string[];
  if (!(directory.userSelfId && slackIds.includes(directory.userSelfId))) {
    return {
      unreachable:
        "another person's DM; no token can read it (spot-check in the Slack UI)",
    };
  }
  const match = directory.userDms.find(
    (c) => c.members && sameMembers(c.members, slackIds)
  );
  return match
    ? { channelId: match.id, via: 'user' }
    : { unreachable: 'your DM with these people was not found' };
}

/** Pure lookup of one conversation. */
export function resolveDestination(
  conversation: MessageIndexConversation,
  directory: DestinationDirectory
): Destination {
  if (conversation.kind === 'channel' || conversation.kind === 'group') {
    return channelDestination(conversation, directory);
  }
  return directDestination(conversation, directory);
}

type ListPage = Awaited<ReturnType<WebClient['conversations']['list']>>;

async function listConversations(
  client: WebClient,
  types: string
): Promise<SlackConversationRef[]> {
  const result: SlackConversationRef[] = [];
  let cursor: string | undefined;
  do {
    // biome-ignore lint/nursery/noAwaitInLoop: pages are sequential by cursor.
    const page: ListPage = await client.conversations.list({
      types,
      exclude_archived: false,
      limit: 200,
      cursor,
    });
    for (const raw of page.channels ?? []) {
      if (!raw.id) {
        continue;
      }
      result.push({
        id: raw.id,
        name: raw.name,
        isPrivate: Boolean(raw.is_private || raw.is_im || raw.is_mpim),
        isMember: Boolean(raw.is_member || raw.is_im),
        members: raw.is_im && raw.user ? [raw.user] : undefined,
      });
    }
    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return result;
}

async function membersOf(
  client: WebClient,
  channel: string
): Promise<string[]> {
  const members: string[] = [];
  let cursor: string | undefined;
  do {
    // biome-ignore lint/nursery/noAwaitInLoop: pages are sequential by cursor.
    const page = await client.conversations.members({
      channel,
      limit: 200,
      cursor,
    });
    members.push(...(page.members ?? []));
    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return members;
}

/** Reads everything the tokens can see. A handful of list calls, plus one per group DM. */
export async function loadDestinationDirectory(
  bot: WebClient,
  user: WebClient | undefined,
  slackUserIds: Map<string, string>
): Promise<DestinationDirectory> {
  const directory: DestinationDirectory = {
    slackUserIds,
    botChannels: await listConversations(bot, 'public_channel,private_channel'),
    userChannels: [],
    userDms: [],
  };
  if (!user) {
    return directory;
  }
  const self = await user.auth.test();
  directory.userSelfId = self.user_id;
  directory.userChannels = await listConversations(user, 'private_channel');
  const direct = await listConversations(user, 'im,mpim');
  for (const conversation of direct) {
    if (conversation.members && self.user_id) {
      // A DM lists only the other person; add the token's owner.
      conversation.members = [...conversation.members, self.user_id];
    } else {
      // biome-ignore lint/nursery/noAwaitInLoop: one call per group DM, sequential to respect rate limits.
      conversation.members = await membersOf(user, conversation.id);
    }
  }
  directory.userDms = direct;
  return directory;
}
