import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CommandModule } from 'yargs';
import {
  type ArchiveOutcome,
  archivePublicChannel,
  archiveTargets,
  channelsByName,
} from '../../services/channel-archiver';
import { getSlackWebClient } from '../../services/slack';
import { sidecarPath } from '../../services/slack-archive/writer';
import type { ArchiveManifest } from '../../types/slack-export';
import { readJsonFile } from '../../utils/fs-atomic';

type ArchiveChannelsArgs = {
  archive?: string;
  dryRun?: boolean;
};

export const archiveChannelsCommand: CommandModule<
  object,
  ArchiveChannelsArgs
> = {
  command: 'archive-channels',
  describe:
    'After the import: archive the channels the visibility list marked archive=yes. Public ones are archived by the bot; private ones are listed for an admin, since the bot cannot join them.',
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
      const privateOnes = targets.filter((t) => t.isPrivate);
      const publicOnes = targets.filter((t) => !t.isPrivate);
      const bot = await getSlackWebClient();
      const inSlack = await channelsByName(bot);
      const counts = new Map<ArchiveOutcome | 'would-archive', number>();
      for (const target of publicOnes) {
        const channel = inSlack.get(target.name);
        let outcome: ArchiveOutcome | 'would-archive';
        if (!channel) {
          outcome = 'not-found';
        } else if (argv.dryRun) {
          outcome = channel.isArchived ? 'already' : 'would-archive';
        } else {
          // biome-ignore lint/nursery/noAwaitInLoop: one channel at a time, inside Slack's rate limits.
          outcome = await archivePublicChannel(bot, channel);
        }
        counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
        if (outcome === 'not-found' || outcome === 'failed') {
          console.warn(`   ${outcome}: #${target.name}`);
        }
      }
      console.log(
        `Public channels: ${[...counts].map(([k, v]) => `${v} ${k}`).join(' · ') || 'none to archive'}`
      );
      const listPath = sidecarPath(zipPath, 'archive-private.txt');
      await writeFile(
        listPath,
        `${privateOnes.map((t) => t.name).join('\n')}\n`,
        'utf-8'
      );
      console.log(
        `Private channels for an admin to archive: ${privateOnes.length} (listed in ${listPath})`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('archive-channels failed:', message);
      process.exit(1);
    }
  },
};
