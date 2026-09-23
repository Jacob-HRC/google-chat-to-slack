import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CommandModule } from 'yargs';
import {
  listStoredSpaceIds,
  loadSpace,
  loadState,
  openStore,
} from '../../services/export-store';
import { isMeetingChat } from '../../services/slack-archive/meeting-chats';
import {
  parseCsv,
  rowFor,
  toCsv,
  type VisibilityRow,
} from '../../services/slack-archive/visibility';
import {
  getDefaultChannelVisibilityFile,
  getDefaultWorkspaceExportDirectory,
} from '../../utils/data-directory';

type ChannelVisibilityArgs = {
  input: string;
  output?: string;
};

async function readPrevious(
  filePath: string
): Promise<Map<string, VisibilityRow>> {
  try {
    const rows = parseCsv(await readFile(filePath, 'utf-8'));
    return new Map(rows.map((r) => [r.spaceId, r]));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return new Map();
    }
    throw error;
  }
}

export const channelVisibilityCommand: CommandModule<
  object,
  ChannelVisibilityArgs
> = {
  command: 'channel-visibility',
  describe:
    'Write every named Space to a CSV with a suggested public/private setting, for review. Decisions already in the file are kept; new Spaces are added. build-slack-archive --channel-visibility follows it.',
  builder: (yargs) =>
    yargs
      .option('input', {
        describe: 'Workspace export store.',
        type: 'string',
        default: getDefaultWorkspaceExportDirectory(),
      })
      .option('output', {
        describe:
          'The review list. Defaults to data/slack/channel-visibility.csv.',
        type: 'string',
      })
      .strict(),
  handler: async (argv) => {
    try {
      const store = await openStore(path.resolve(argv.input));
      const filePath = path.resolve(
        argv.output ?? getDefaultChannelVisibilityFile()
      );
      const previous = await readPrevious(filePath);
      const rows: VisibilityRow[] = [];
      for (const spaceId of await listStoredSpaceIds(store)) {
        // biome-ignore lint/nursery/noAwaitInLoop: small reads, one Space at a time.
        const space = await loadSpace(store, spaceId);
        if (!space || space.spaceType !== 'SPACE' || isMeetingChat(space)) {
          continue;
        }
        const state = await loadState(store, spaceId);
        rows.push(
          rowFor(space, state?.messageCount ?? 0, previous.get(spaceId))
        );
      }
      await writeFile(filePath, toCsv(rows), 'utf-8');
      const added = rows.filter((r) => !previous.has(r.spaceId)).length;
      const priv = rows.filter((r) => r.visibility === 'private').length;
      console.log(
        `${rows.length} named Spaces · ${rows.length - priv} public · ${priv} private · ${added} new since the last review`
      );
      console.log(`Review and edit: ${filePath}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('channel-visibility failed:', message);
      process.exit(1);
    }
  },
};
