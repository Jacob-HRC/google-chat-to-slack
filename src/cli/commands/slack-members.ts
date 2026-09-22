import path from 'node:path';
import type { CommandModule } from 'yargs';
import { getSlackWebClient } from '../../services/slack';
import {
  fetchSlackMembers,
  summarizeSnapshot,
} from '../../services/slack-archive/slack-members';
import { getDefaultSlackMembersFile } from '../../utils/data-directory';
import { writeJsonAtomic } from '../../utils/fs-atomic';

type SlackMembersArgs = {
  output: string;
  json?: boolean;
};

export const slackMembersCommand: CommandModule<object, SlackMembersArgs> = {
  command: 'slack-members',
  describe:
    'Snapshot who already exists in the destination Slack workspace, so build-slack-archive can tell merges from new deactivated accounts. Read-only.',
  builder: (yargs) =>
    yargs
      .option('output', {
        describe: 'Where to write the snapshot.',
        type: 'string',
        default: getDefaultSlackMembersFile(),
      })
      .option('json', {
        describe: 'Print the snapshot summary as JSON.',
        type: 'boolean',
        default: false,
      })
      .strict(),
  handler: async (argv) => {
    try {
      const client = await getSlackWebClient();
      const snapshot = await fetchSlackMembers(client);
      const outputPath = path.resolve(argv.output);
      await writeJsonAtomic(outputPath, snapshot);
      const summary = summarizeSnapshot(snapshot);
      if (argv.json) {
        console.log(
          JSON.stringify(
            {
              team: snapshot.teamName,
              teamId: snapshot.teamId,
              fetchedAt: snapshot.fetchedAt,
              ...summary,
              output: outputPath,
            },
            null,
            2
          )
        );
        return;
      }
      console.log(
        `${snapshot.teamName} (${snapshot.teamId}): ${summary.active} active · ${summary.deactivated} deactivated · ${summary.guests} guests · ${summary.bots} bots · ${summary.withoutEmail} humans without an email`
      );
      console.log(`Wrote ${outputPath}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('Slack member snapshot failed:', message);
      process.exit(1);
    }
  },
};
