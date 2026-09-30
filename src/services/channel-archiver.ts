/**
 * Archives imported channels after the import. Slack's importer skips a
 * channel the export marks archived, so the build imports every channel
 * active and records the decision in the manifest (archiveAfterImport).
 *
 * Slack only lets a member archive a channel. The bot can join a public
 * channel and archive it; it cannot join a private one, so those are listed
 * for a person to archive.
 */
import type { WebClient } from '@slack/web-api';
import type { ArchiveManifest } from '../types/slack-export';

export interface ArchiveTarget {
  spaceId: string;
  name: string;
  isPrivate: boolean;
}

export type ArchiveOutcome =
  | 'archived'
  | 'already'
  | 'not-found'
  | 'not-imported'
  | 'needs-member'
  | 'failed';

export interface ChannelRef {
  id: string;
  isArchived: boolean;
  /** Unix seconds. The importer creates channels at import time. */
  created: number;
}

/**
 * Only a channel the import created may be archived. Names are how imported
 * channels are found, and an older channel with the same name (one the bot
 * could not see at build time, or renamed since) must never be touched. Pure.
 */
export function createdByImport(channel: ChannelRef, builtAt: string): boolean {
  return channel.created * 1000 >= Date.parse(builtAt);
}

/** Channels the manifest marks for archiving. Pure. */
export function archiveTargets(manifest: ArchiveManifest): ArchiveTarget[] {
  return Object.entries(manifest.conversations)
    .filter(([, c]) => c.archiveAfterImport && !c.skippedReason)
    .map(([spaceId, c]) => ({
      spaceId,
      name: c.name,
      isPrivate: c.kind === 'group',
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Slack channels the bot can see, by name. */
export async function channelsByName(
  bot: WebClient
): Promise<Map<string, ChannelRef>> {
  const byName = new Map<string, ChannelRef>();
  let cursor: string | undefined;
  do {
    // biome-ignore lint/nursery/noAwaitInLoop: pagination is sequential.
    const page = await bot.conversations.list({
      types: 'public_channel',
      exclude_archived: false,
      limit: 1000,
      cursor,
    });
    for (const channel of page.channels ?? []) {
      if (channel.id && channel.name) {
        byName.set(channel.name, {
          id: channel.id,
          isArchived: Boolean(channel.is_archived),
          created: channel.created ?? 0,
        });
      }
    }
    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return byName;
}

function errorCode(error: unknown): string | undefined {
  return (error as { data?: { error?: string } }).data?.error;
}

/** Joins a public channel and archives it. */
export async function archivePublicChannel(
  bot: WebClient,
  channel: ChannelRef
): Promise<ArchiveOutcome> {
  if (channel.isArchived) {
    return 'already';
  }
  try {
    await bot.conversations.join({ channel: channel.id });
    await bot.conversations.archive({ channel: channel.id });
    return 'archived';
  } catch (error) {
    return errorCode(error) === 'already_archived' ? 'already' : 'failed';
  }
}

export interface ConnectedMember {
  slackId: string;
  client: WebClient;
}

/** Private channels one person is in, by name. */
export async function privateChannelsOf(
  client: WebClient
): Promise<Map<string, ChannelRef>> {
  const byName = new Map<string, ChannelRef>();
  let cursor: string | undefined;
  do {
    // biome-ignore lint/nursery/noAwaitInLoop: pagination is sequential.
    const page = await client.users.conversations({
      types: 'private_channel',
      exclude_archived: false,
      limit: 1000,
      cursor,
    });
    for (const channel of page.channels ?? []) {
      if (channel.id && channel.name) {
        byName.set(channel.name, {
          id: channel.id,
          isArchived: Boolean(channel.is_archived),
          created: channel.created ?? 0,
        });
      }
    }
    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return byName;
}

/**
 * For each private channel, the first connected person who is in it. Slack
 * credits the archive to them ("… archived this channel"). Pure.
 */
export function pickArchivers(
  names: string[],
  membership: Array<{
    person: ConnectedMember;
    channels: Map<string, ChannelRef>;
  }>
): Map<string, { person: ConnectedMember; channel: ChannelRef }> {
  const picked = new Map<
    string,
    { person: ConnectedMember; channel: ChannelRef }
  >();
  for (const name of names) {
    const found = membership.find((m) => m.channels.has(name));
    const channel = found?.channels.get(name);
    if (found && channel) {
      picked.set(name, { person: found.person, channel });
    }
  }
  return picked;
}

/** Archives a private channel with a member's own token. */
export async function archiveAsMember(
  client: WebClient,
  channel: ChannelRef
): Promise<ArchiveOutcome> {
  if (channel.isArchived) {
    return 'already';
  }
  try {
    await client.conversations.archive({ channel: channel.id });
    return 'archived';
  } catch (error) {
    return errorCode(error) === 'already_archived' ? 'already' : 'failed';
  }
}
