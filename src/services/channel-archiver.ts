/**
 * Archives imported channels after the import. Slack's importer skips a
 * channel the export marks archived, so the build imports every channel
 * active and records the decision in the manifest (archiveAfterImport).
 *
 * Slack only lets a member archive a channel. The bot can join a public
 * channel and archive it; it cannot join a private one, so those are archived
 * with a connected member's token, and any no connected member can reach are
 * listed for a person to archive.
 */
import type { WebClient } from '@slack/web-api';
import yauzl from 'yauzl';
import type { ArchiveManifest } from '../types/slack-export';

export interface ArchiveTarget {
  spaceId: string;
  name: string;
  isPrivate: boolean;
  /** Unix seconds the ZIP gives the channel; Slack keeps it on import. */
  created?: number;
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
  /**
   * Unix seconds. The importer keeps the `created` the ZIP gives the
   * channel (the Space's own creation, often years back), not import time.
   */
  created: number;
}

/**
 * Only a channel the import created may be archived. Names are how imported
 * channels are found, and an older channel with the same name (one the bot
 * could not see at build time, or renamed since) must never be touched.
 * Slack keeps the ZIP's `created` to the second, so when the ZIP gives a
 * time, only a channel with exactly that `created` is the imported one; a
 * namesake made after the build is not. Only when the ZIP gives no time
 * does a channel created after the build count. Pure.
 */
export function createdByImport(
  channel: ChannelRef,
  builtAt: string,
  zipCreated?: number
): boolean {
  if (zipCreated) {
    return channel.created === zipCreated;
  }
  return channel.created * 1000 >= Date.parse(builtAt);
}

/** The channels in `all` the import created, by name. Pure. */
export function importedChannels(
  all: Map<string, ChannelRef>,
  builtAt: string,
  zipCreated: Map<string, number | undefined>
): Map<string, ChannelRef> {
  return new Map(
    [...all].filter(([name, channel]) =>
      createdByImport(channel, builtAt, zipCreated.get(name))
    )
  );
}

/** Channels the manifest marks for archiving, with the ZIP's `created` by name. Pure. */
export function archiveTargets(
  manifest: ArchiveManifest,
  zipCreated: Map<string, number> = new Map()
): ArchiveTarget[] {
  return Object.entries(manifest.conversations)
    .filter(([, c]) => c.archiveAfterImport && !c.skippedReason)
    .map(([spaceId, c]) => ({
      spaceId,
      name: c.name,
      isPrivate: c.kind === 'group',
      created: zipCreated.get(c.name),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

const CHANNEL_LISTS = new Set(['channels.json', 'groups.json']);

/** The `created` of every channel and private channel in the ZIP, by name. */
export async function readArchiveCreated(
  zipPath: string
): Promise<Map<string, number>> {
  const zip = await yauzl.openPromise(zipPath);
  const created = new Map<string, number>();
  try {
    for await (const entry of zip.eachEntry()) {
      if (!CHANNEL_LISTS.has(entry.fileName)) {
        continue;
      }
      const stream = await zip.openReadStreamPromise(entry);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk as Buffer);
      }
      const channels = JSON.parse(
        Buffer.concat(chunks).toString('utf-8')
      ) as Array<{ name?: string; created?: number }>;
      for (const channel of channels) {
        if (channel.name && channel.created) {
          created.set(channel.name, channel.created);
        }
      }
    }
  } finally {
    zip.close();
  }
  return created;
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
