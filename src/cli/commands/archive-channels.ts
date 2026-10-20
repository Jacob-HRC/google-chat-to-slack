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

/**
 * Archives each private channel with a connected member's token; returns
 * the ones left and the ones found already archived.
 */
async function archivePrivate(
  targets: ArchiveTarget[],
  teamId: string,
  builtAt: string,
  dryRun: boolean
): Promise<{ counts: Counts; left: string[]; already: string[] }> {
  const people = await connectedArchivers(teamId);
  const zipCreated = new Map(targets.map((t) => [t.name, t.created]));
  const membership: Array<{
    person: ConnectedMember;
    channels: Awaited<ReturnType<typeof privateChannelsOf>>;
  }> = [];
  for (const person of people) {
    // biome-ignore lint/nursery/noAwaitInLoop: one person's channel list at a time.
    const all = await privateChannelsOf(person.client);
    // Never a pre-existing channel that shares a name with an imported one.
    membership.push({
      person,
      channels: importedChannels(all, builtAt, zipCreated),
    });
  }
  const names = targets.map((t) => t.name);
  const picked = pickArchivers(names, membership);
  const counts: Counts = new Map();
  const left: string[] = [];
  const already: string[] = [];
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
    } else if (outcome === 'already') {
      already.push(name);
    }
  }
  console.log(
    `   ${people.length} connected people can archive private channels`
  );
  return { counts, left, already };
}

/**
 * A delta reuses a private Space's name and created time, but can't land in
 * the full import's archived channel, so "already archived" may be that old
 * channel and not this delta's. Says which to check by hand.
 */
function warnDeltaAlready(manifest: ArchiveManifest, already: string[]): void {
  const isDelta = Boolean(
    manifest.options.messagesSince || manifest.options.firstSeenAfterRun
  );
  if (isDelta && already.length > 0) {
    console.warn(
      `   ${already.length} private channel(s) were already archived. This is a delta build, so that may be the earlier import's channel; check by hand where the delta landed: ${already.map((n) => `#${n}`).join(', ')}`
    );
  }
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
      const { counts, left, already } = await archivePrivate(
        targets.filter((t) => t.isPrivate),
        teamId,
        manifest.builtAt,
        dryRun
      );
      console.log(`Private channels: ${summary(counts)}`);
      warnDeltaAlready(manifest, already);
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
