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
  createdByImport,
  deltaPrivateWarning,
  importedChannels,
  pickArchivers,
  privateChannelsOf,
  readArchiveCreated,
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
  bot: WebClient,
  targets: ArchiveTarget[],
  builtAt: string,
  dryRun: boolean
): Promise<Counts> {
  const inSlack = await channelsByName(bot);
  const counts: Counts = new Map();
  for (const target of targets) {
    const channel = inSlack.get(target.name);
    let outcome: ArchiveOutcome | 'would-archive';
    if (!channel) {
      outcome = 'not-found';
    } else if (!createdByImport(channel, builtAt, target.created)) {
      outcome = 'not-imported';
    } else if (dryRun) {
      outcome = channel.isArchived ? 'already' : 'would-archive';
    } else {
      // biome-ignore lint/nursery/noAwaitInLoop: one channel at a time, inside Slack's rate limits.
      outcome = await archivePublicChannel(bot, channel);
    }
    tally(counts, outcome);
    if (
      outcome === 'not-found' ||
      outcome === 'not-imported' ||
      outcome === 'failed'
    ) {
      console.warn(`   ${outcome}: #${target.name}`);
    }
  }
  return counts;
}

/**
 * People who approved the app and whose token can archive private channels
 * in this workspace. Asks Slack for each token's current scopes: an approval
 * recorded before groups:write was added can have gained it since (tokens
 * are per person and app, and grow with each approval). A token that fails
 * or belongs elsewhere is reported and skipped.
 */
async function connectedArchivers(teamId: string): Promise<ConnectedMember[]> {
  const registry = await loadRegistry(getDefaultConnectedUsersFile());
  const people: ConnectedMember[] = [];
  for (const person of Object.values(registry)) {
    // biome-ignore lint/nursery/noAwaitInLoop: a keyring read and a check per person.
    const member = await archiverFor(person.slackId, teamId);
    if (member) {
      people.push(member);
    }
  }
  return people;
}

async function archiverFor(
  slackId: string,
  teamId: string
): Promise<ConnectedMember | undefined> {
  const token = await tokenFor(slackId);
  if (!token) {
    return;
  }
  const client = new WebClient(token);
  try {
    const check = await client.auth.test();
    if (check.team_id !== teamId || check.user_id !== slackId) {
      console.warn(`   skipped ${slackId}: token is for another account`);
      return;
    }
    return check.response_metadata?.scopes?.includes(ARCHIVE_SCOPE)
      ? { slackId, client }
      : undefined;
  } catch (error) {
    const code = (error as { data?: { error?: string } }).data?.error;
    console.warn(`   skipped ${slackId}: ${code ?? String(error)}`);
    return;
  }
}

type Membership = Array<{
  person: ConnectedMember;
  channels: Awaited<ReturnType<typeof privateChannelsOf>>;
}>;

/**
 * The imported private channels each connected person is in, and the target
 * names someone holds whose created doesn't match (not the import's).
 */
async function importedMembership(
  people: ConnectedMember[],
  builtAt: string,
  zipCreated: Map<string, number | undefined>
): Promise<{ membership: Membership; mismatched: Set<string> }> {
  const membership: Membership = [];
  const mismatched = new Set<string>();
  for (const person of people) {
    // biome-ignore lint/nursery/noAwaitInLoop: one person's channel list at a time.
    const all = await privateChannelsOf(person.client);
    // Never a pre-existing channel that shares a name with an imported one.
    const channels = importedChannels(all, builtAt, zipCreated);
    for (const name of all.keys()) {
      if (zipCreated.has(name) && !channels.has(name)) {
        mismatched.add(name);
      }
    }
    membership.push({ person, channels });
  }
  return { membership, mismatched };
}

/**
 * Archives each private channel with a connected member's token; returns
 * the ones left and the ones matched to a Slack channel.
 */
async function archivePrivate(
  targets: ArchiveTarget[],
  teamId: string,
  builtAt: string,
  dryRun: boolean
): Promise<{ counts: Counts; left: string[]; matched: string[] }> {
  const people = await connectedArchivers(teamId);
  const zipCreated = new Map(targets.map((t) => [t.name, t.created]));
  const { membership, mismatched } = await importedMembership(
    people,
    builtAt,
    zipCreated
  );
  const names = targets.map((t) => t.name);
  const picked = pickArchivers(names, membership);
  const counts: Counts = new Map();
  const left: string[] = [];
  const matched: string[] = [];
  for (const name of names) {
    const choice = picked.get(name);
    let outcome: ArchiveOutcome | 'would-archive';
    if (!choice) {
      outcome = mismatched.has(name) ? 'not-imported' : 'needs-member';
    } else if (dryRun) {
      outcome = choice.channel.isArchived ? 'already' : 'would-archive';
    } else {
      // biome-ignore lint/nursery/noAwaitInLoop: one channel at a time, inside Slack's rate limits.
      outcome = await archiveAsMember(choice.person.client, choice.channel);
    }
    tally(counts, outcome);
    if (!choice || outcome === 'failed') {
      left.push(name);
    }
    if (choice) {
      matched.push(name);
    }
    if (outcome === 'not-imported' || outcome === 'failed') {
      console.warn(`   ${outcome}: #${name}`);
    }
  }
  console.log(
    `   ${people.length} connected people can archive private channels`
  );
  return { counts, left, matched };
}

export const archiveChannelsCommand: CommandModule<
  object,
  ArchiveChannelsArgs
> = {
  command: 'archive-channels',
  describe:
    "After the import: archive the channels the manifest marks for archiving (the visibility list's archive column, or every Space when built with build-slack-archive --archive-all-spaces). The bot archives public ones; private ones are archived with the token of a member who approved the app (slack-connect). Rerun as more people approve.",
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
      const targets = archiveTargets(
        manifest,
        await readArchiveCreated(zipPath)
      );
      const dryRun = argv.dryRun ?? false;
      const bot = await getSlackWebClient();
      const teamId = (await bot.auth.test()).team_id ?? '';
      const publicCounts = await archivePublic(
        bot,
        targets.filter((t) => !t.isPrivate),
        manifest.builtAt,
        dryRun
      );
      console.log(`Public channels: ${summary(publicCounts)}`);
      const { counts, left, matched } = await archivePrivate(
        targets.filter((t) => t.isPrivate),
        teamId,
        manifest.builtAt,
        dryRun
      );
      console.log(`Private channels: ${summary(counts)}`);
      const deltaWarning = deltaPrivateWarning(manifest, matched);
      if (deltaWarning) {
        console.warn(deltaWarning);
      }
      const listPath = sidecarPath(zipPath, 'archive-private.txt');
      await writeFile(
        listPath,
        left.length ? `${left.join('\n')}\n` : '',
        'utf-8'
      );
      console.log(
        `Private channels no connected member can archive yet: ${left.length} (listed in ${listPath})`
      );
      const failed =
        (publicCounts.get('failed') ?? 0) + (counts.get('failed') ?? 0);
      if (failed > 0) {
        console.error(
          `${failed} channel(s) failed to archive; rerun to retry.`
        );
        process.exit(1);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('archive-channels failed:', message);
      process.exit(1);
    }
  },
};
