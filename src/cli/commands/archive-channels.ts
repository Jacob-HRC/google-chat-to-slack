import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { WebClient } from '@slack/web-api';
import type { CommandModule } from 'yargs';
import {
  type ArchiveOutcome,
  type ArchiveTarget,
  archiveAsMember,
  archivePublicChannel,
  archiveTargets,
  type ConnectedMember,
  channelsByName,
  pickArchivers,
  privateChannelsOf,
} from '../../services/channel-archiver';
import { getSlackWebClient } from '../../services/slack';
import { sidecarPath } from '../../services/slack-archive/writer';
import { loadRegistry, tokenFor } from '../../services/slack-connect';
import type { ArchiveManifest } from '../../types/slack-export';
import { getDefaultConnectedUsersFile } from '../../utils/data-directory';
import { readJsonFile } from '../../utils/fs-atomic';

type ArchiveChannelsArgs = {
  archive?: string;
  dryRun?: boolean;
};

type Counts = Map<ArchiveOutcome | 'would-archive', number>;

const ARCHIVE_SCOPE = 'groups:write';

function tally(
  counts: Counts,
  outcome: ArchiveOutcome | 'would-archive'
): void {
  counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
}

function summary(counts: Counts): string {
  return [...counts].map(([k, v]) => `${v} ${k}`).join(' · ') || 'none';
}

async function archivePublic(
  targets: ArchiveTarget[],
  dryRun: boolean
): Promise<Counts> {
  const bot = await getSlackWebClient();
  const inSlack = await channelsByName(bot);
  const counts: Counts = new Map();
  for (const target of targets) {
    const channel = inSlack.get(target.name);
    let outcome: ArchiveOutcome | 'would-archive';
    if (!channel) {
      outcome = 'not-found';
    } else if (dryRun) {
      outcome = channel.isArchived ? 'already' : 'would-archive';
    } else {
      // biome-ignore lint/nursery/noAwaitInLoop: one channel at a time, inside Slack's rate limits.
      outcome = await archivePublicChannel(bot, channel);
    }
    tally(counts, outcome);
    if (outcome === 'not-found' || outcome === 'failed') {
      console.warn(`   ${outcome}: #${target.name}`);
    }
  }
  return counts;
}

/**
 * People who approved the app and whose token can archive private channels.
 * Asks Slack for each token's current scopes: an approval recorded before
 * groups:write was added can have gained it since (tokens are per person
 * and app, and grow with each reinstall or approval).
 */
async function connectedArchivers(): Promise<ConnectedMember[]> {
  const registry = await loadRegistry(getDefaultConnectedUsersFile());
  const people: ConnectedMember[] = [];
  for (const person of Object.values(registry)) {
    // biome-ignore lint/nursery/noAwaitInLoop: a keyring read per person.
    const token = await tokenFor(person.slackId);
    if (!token) {
      continue;
    }
    const client = new WebClient(token);
    const check = await client.auth.test();
    if (check.response_metadata?.scopes?.includes(ARCHIVE_SCOPE)) {
      people.push({ slackId: person.slackId, client });
    }
  }
  return people;
}

/** Archives each private channel with a connected member's token; returns the ones left. */
async function archivePrivate(
  targets: ArchiveTarget[],
  dryRun: boolean
): Promise<{ counts: Counts; left: string[] }> {
  const people = await connectedArchivers();
  const membership: Array<{
    person: ConnectedMember;
    channels: Awaited<ReturnType<typeof privateChannelsOf>>;
  }> = [];
  for (const person of people) {
    // biome-ignore lint/nursery/noAwaitInLoop: one person's channel list at a time.
    const channels = await privateChannelsOf(person.client);
    membership.push({ person, channels });
  }
  const names = targets.map((t) => t.name);
  const picked = pickArchivers(names, membership);
  const counts: Counts = new Map();
  const left: string[] = [];
  for (const name of names) {
    const choice = picked.get(name);
    let outcome: ArchiveOutcome | 'would-archive';
    if (!choice) {
      outcome = 'needs-member';
    } else if (dryRun) {
      outcome = choice.channel.isArchived ? 'already' : 'would-archive';
    } else {
      // biome-ignore lint/nursery/noAwaitInLoop: one channel at a time, inside Slack's rate limits.
      outcome = await archiveAsMember(choice.person.client, choice.channel);
    }
    tally(counts, outcome);
    if (outcome === 'needs-member' || outcome === 'failed') {
      left.push(name);
    }
  }
  console.log(
    `   ${people.length} connected people can archive private channels`
  );
  return { counts, left };
}

export const archiveChannelsCommand: CommandModule<
  object,
  ArchiveChannelsArgs
> = {
  command: 'archive-channels',
  describe:
    'After the import: archive the channels the visibility list marked archive=yes. The bot archives public ones; private ones are archived with the token of a member who approved the app (slack-connect). Rerun as more people approve.',
  builder: (yargs) =>
    yargs
      .option('archive', {
        describe: 'The imported ZIP (with its manifest beside it).',
        type: 'string',
      })
      .option('dry-run', {
        describe: 'List what would be archived; change nothing.',
        type: 'boolean',
        default: false,
      })
      .strict(),
  handler: async (argv) => {
    try {
      if (!argv.archive) {
        throw new Error('--archive is required');
      }
      const zipPath = path.resolve(argv.archive);
      const manifest = await readJsonFile<ArchiveManifest>(
        sidecarPath(zipPath, 'archive-manifest.json')
      );
      if (!manifest) {
        throw new Error('archive manifest not found beside the ZIP');
      }
      const targets = archiveTargets(manifest);
      const dryRun = argv.dryRun ?? false;
      const publicCounts = await archivePublic(
        targets.filter((t) => !t.isPrivate),
        dryRun
      );
      console.log(`Public channels: ${summary(publicCounts)}`);
      const { counts, left } = await archivePrivate(
        targets.filter((t) => t.isPrivate),
        dryRun
      );
      console.log(`Private channels: ${summary(counts)}`);
      const listPath = sidecarPath(zipPath, 'archive-private.txt');
      await writeFile(
        listPath,
        left.length ? `${left.join('\n')}\n` : '',
        'utf-8'
      );
      console.log(
        `Private channels no connected member can archive yet: ${left.length} (listed in ${listPath})`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('archive-channels failed:', message);
      process.exit(1);
    }
  },
};
