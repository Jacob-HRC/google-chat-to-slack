import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CommandModule } from 'yargs';
import {
  listStoredSpaceIds,
  loadMessages,
  loadSpace,
  openStore,
} from '../../services/export-store';
import { isMeetingChat } from '../../services/slack-archive/meeting-chats';
import {
  parseCsv,
  rowFor,
  spaceActivity,
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
  archiveBefore?: string;
};

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

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
      .option('archive-before', {
        describe:
          'Suggest archiving Spaces whose last message is before this date (YYYY-MM-DD). Only fills rows with no archive decision yet.',
        type: 'string',
      })
      .strict(),
  handler: async (argv) => {
    try {
      if (argv.archiveBefore && !DATE_REGEX.test(argv.archiveBefore)) {
        throw new Error('--archive-before must be a date like 2025-01-01');
      }
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
        const activity = spaceActivity(await loadMessages(store, spaceId));
        rows.push(
          rowFor(space, activity, previous.get(spaceId), argv.archiveBefore)
        );
      }
      await writeFile(filePath, toCsv(rows), 'utf-8');
      const added = rows.filter((r) => !previous.has(r.spaceId)).length;
      const priv = rows.filter((r) => r.visibility === 'private').length;
      console.log(
        `${rows.length} named Spaces · ${rows.length - priv} public · ${priv} private · ${added} new since the last review`
      );
      const archived = rows.filter((r) => r.archive).length;
      const undecided = rows.filter((r) => r.archive === undefined).length;
      console.log(
        `Archive on import: ${archived} yes · ${rows.length - archived - undecided} no · ${undecided} undecided`
      );
      console.log(`Review and edit: ${filePath}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('channel-visibility failed:', message);
      process.exit(1);
    }
  },
};
