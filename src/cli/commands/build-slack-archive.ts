import path from 'node:path';
import type { CommandModule } from 'yargs';
import {
  type BuildArchiveOptions,
  buildArchiveModel,
} from '../../services/slack-archive/builder';
import type { SpaceVisibility } from '../../services/slack-archive/conversations';
import type {
  DeletedPolicy,
  FileStrategy,
} from '../../services/slack-archive/messages';
import type { UserOverride } from '../../services/slack-archive/users';
import {
  printArchiveReport,
  writeArchive,
} from '../../services/slack-archive/writer';
import type { ArchiveModel } from '../../types/slack-export';
import {
  getDefaultSlackArchiveDirectory,
  getDefaultWorkspaceExportDirectory,
} from '../../utils/data-directory';
import { readJsonFile } from '../../utils/fs-atomic';
import { makeRunId, parseRfc3339 } from '../../utils/timestamps';

type BuildArgs = {
  input: string;
  output?: string;
  unpacked?: string;
  dryRun?: boolean;
  space?: string[];
  includeBotDms?: boolean;
  spaceVisibility?: string;
  deleted?: string;
  files?: string;
  filesBaseUrl?: string;
  userOverrides?: string;
  firstSeenAfter?: string;
  messagesSince?: string;
  teamId?: string;
};

async function toBuildOptions(argv: BuildArgs): Promise<BuildArchiveOptions> {
  if (argv.files === 'hosted' && !argv.filesBaseUrl) {
    throw new Error('--files hosted requires --files-base-url');
  }
  if (argv.messagesSince) {
    parseRfc3339(argv.messagesSince);
  }
  const overrides = argv.userOverrides
    ? ((await readJsonFile<Record<string, UserOverride>>(
        path.resolve(argv.userOverrides)
      )) ?? {})
    : {};
  return {
    storeDir: path.resolve(argv.input),
    teamId: argv.teamId ?? 'T0GCHAT0001',
    spaceFilter: argv.space ?? [],
    skipBotDms: !argv.includeBotDms,
    spaceVisibility: (argv.spaceVisibility ?? 'private') as SpaceVisibility,
    deletedPolicy: (argv.deleted ?? 'tombstone') as DeletedPolicy,
    fileStrategy: (argv.files ?? 'manifest') as FileStrategy,
    filesBaseUrl: argv.filesBaseUrl,
    overrides,
    firstSeenAfterRun: argv.firstSeenAfter,
    messagesSince: argv.messagesSince,
  };
}

async function writeOutputs(
  model: ArchiveModel,
  argv: BuildArgs
): Promise<void> {
  const zipPath = path.resolve(
    argv.output ??
      path.join(getDefaultSlackArchiveDirectory(), `${makeRunId()}.zip`)
  );
  const result = await writeArchive(model, {
    zipPath,
    unpackedDir: argv.unpacked ? path.resolve(argv.unpacked) : undefined,
  });
  console.log(`\nWrote ${result.entries} entries to ${result.zipPath}`);
  if (result.unpackedDir) {
    console.log(`Unpacked copy: ${result.unpackedDir}`);
  }
  if (
    model.manifest.files.strategy === 'manifest' &&
    model.uploads.length > 0
  ) {
    console.log(
      `${model.uploads.length} file(s) listed in files-to-upload.json for the post-import uploader.`
    );
  }
}

export const buildSlackArchiveCommand: CommandModule<object, BuildArgs> = {
  command: 'build-slack-archive',
  describe:
    'Turn the workspace export store into a Slack import ZIP (channels, DMs, group DMs, users, per-day messages). Reads the store only.',
  builder: (yargs) =>
    yargs
      .option('input', {
        describe: 'Workspace export store directory.',
        type: 'string',
        default: getDefaultWorkspaceExportDirectory(),
      })
      .option('output', {
        describe:
          'ZIP path to write. Defaults to data/slack-archive/<timestamp>.zip.',
        type: 'string',
      })
      .option('unpacked', {
        describe: 'Also write the archive as plain files into this directory.',
        type: 'string',
      })
      .option('dry-run', {
        describe: 'Build and report; write nothing.',
        type: 'boolean',
        default: false,
      })
      .option('space', {
        describe:
          'Only these conversations (id, spaces/<id> or display name). Repeatable.',
        type: 'string',
        array: true,
      })
      .option('include-bot-dms', {
        describe: 'Include DMs with Chat apps and bots.',
        type: 'boolean',
        default: false,
      })
      .option('space-visibility', {
        describe: 'Import named Spaces as private or public Slack channels.',
        type: 'string',
        choices: ['private', 'public'],
        default: 'private',
      })
      .option('deleted', {
        describe:
          'Messages deleted in Google Chat: tombstone (placeholder text), content (last known text), omit.',
        type: 'string',
        choices: ['tombstone', 'content', 'omit'],
        default: 'tombstone',
      })
      .option('files', {
        describe:
          'manifest: list files in files-to-upload.json for the post-import uploader. hosted: reference them by URL under --files-base-url so Slack fetches them on import.',
        type: 'string',
        choices: ['manifest', 'hosted'],
        default: 'manifest',
      })
      .option('files-base-url', {
        describe:
          "Base URL serving the store's attachments/files directory (hosted strategy).",
        type: 'string',
      })
      .option('user-overrides', {
        describe:
          'JSON file mapping Google user ids (users/<id>) to { "name", "email" } for placeholders.',
        type: 'string',
      })
      .option('first-seen-after', {
        describe:
          'Delta archive: only messages first stored after this export run id.',
        type: 'string',
      })
      .option('messages-since', {
        describe:
          'Delta archive: only messages created after this RFC 3339 time.',
        type: 'string',
      })
      .option('team-id', {
        describe: 'Team id written into users.json.',
        type: 'string',
        default: 'T0GCHAT0001',
      })
      .example(
        '$0 build-slack-archive --dry-run',
        'Report what the archive would contain'
      )
      .example(
        '$0 build-slack-archive --space general --unpacked ./archive-check',
        'One Space, ZIP plus readable copy'
      )
      .strict()
      .fail((msg, err, yargsInstance) => {
        if (msg) {
          console.error(`Error: ${msg}`);
          console.error('');
          yargsInstance.showHelp();
        } else if (err) {
          console.error(`Error: ${err.message}`);
        }
        process.exit(1);
      }),
  handler: async (argv) => {
    try {
      const options = await toBuildOptions(argv);
      const model = await buildArchiveModel(options);
      printArchiveReport(model, argv.dryRun ?? false);
      if (argv.dryRun) {
        return;
      }
      await writeOutputs(model, argv);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('Archive build failed:', message);
      process.exit(1);
    }
  },
};
