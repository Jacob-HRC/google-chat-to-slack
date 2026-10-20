import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { WebClient } from '@slack/web-api';
import type { CommandModule } from 'yargs';
import {
  type ArchiveOutcome,
  type ArchiveTarget,
  adminListLine,
  archiveAsMember,
  archivePublicChannel,
  archiveTargets,
  type ChannelRef,
  type ConnectedMember,
  channelsByName,
  createdByImport,
  isDeltaBuild,
  planPrivateArchives,
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
 * Archives each private channel with a connected member's token. Returns
 * the ones no connected member can reach (for an admin), and the ones a
 * delta build matched (for a hand check).
 */
async function archivePrivate(
  targets: ArchiveTarget[],
  teamId: string,
  builtAt: string,
  isDelta: boolean,
  dryRun: boolean
): Promise<{ counts: Counts; left: string[]; deltaMatches: string[] }> {
  const people = await connectedArchivers(teamId);
  const held: Array<{ person: ConnectedMember; all: Map<string, ChannelRef> }> =
    [];
  for (const person of people) {
    // biome-ignore lint/nursery/noAwaitInLoop: one person's channel list at a time.
    held.push({ person, all: await privateChannelsOf(person.client) });
  }
  const decisions = planPrivateArchives(
    targets.map((t) => t.name),
    held,
    builtAt,
    new Map(targets.map((t) => [t.name, t.created])),
    isDelta
  );
  const counts: Counts = new Map();
  const left: string[] = [];
  const deltaMatches: string[] = [];
  for (const decision of decisions) {
    let outcome: ArchiveOutcome | 'would-archive';
    if (decision.action !== 'archive') {
      outcome = decision.action;
    } else if (dryRun) {
      outcome = decision.channel.isArchived ? 'already' : 'would-archive';
    } else {
      // biome-ignore lint/nursery/noAwaitInLoop: one channel at a time, inside Slack's rate limits.
      outcome = await archiveAsMember(decision.person.client, decision.channel);
    }
    tally(counts, outcome);
    if (outcome === 'needs-member' || outcome === 'failed') {
      left.push(decision.name);
    } else if (outcome === 'check-delta') {
      deltaMatches.push(decision.name);
    }
    if (outcome === 'not-imported' || outcome === 'failed') {
      console.warn(`   ${outcome}: #${decision.name}`);
    }
  }
  console.log(
    `   ${people.length} connected people can archive private channels`
  );
  return { counts, left, deltaMatches };
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
      if (!existsSync(zipPath)) {
        throw new Error(
          `${zipPath} not found; archive-channels reads each channel's created time from the ZIP`
        );
      }
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
      const { counts, left, deltaMatches } = await archivePrivate(
        targets.filter((t) => t.isPrivate),
        teamId,
        manifest.builtAt,
        isDeltaBuild(manifest),
        dryRun
      );
      console.log(`Private channels: ${summary(counts)}`);
      if (deltaMatches.length > 0) {
        console.warn(
          `   Delta build: ${deltaMatches.length} private channel(s) not archived. A delta reuses the earlier import's name and created time, so each match is likely that older channel. Check where the delta landed and archive by hand: ${deltaMatches.map((n) => `#${n}`).join(', ')}`
        );
      }
      const listPath = sidecarPath(zipPath, 'archive-private.txt');
      const createdOf = new Map(targets.map((t) => [t.name, t.created]));
      await writeFile(
        listPath,
        left
          .map(
            (n) => `${adminListLine(n, manifest.builtAt, createdOf.get(n))}\n`
          )
          .join(''),
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
