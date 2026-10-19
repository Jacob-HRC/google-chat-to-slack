import path from 'node:path';
import type { CommandModule } from 'yargs';
import type { DriveLinkPolicy } from '../../services/attachments';
import { resolveUserSelection } from '../../services/directory';
import type { DriveExportPreference } from '../../services/drive';
import {
  GOOGLE_AUTH_MODES,
  getGoogleAuthMode,
} from '../../services/google-auth';
import { exportWorkspace } from '../../services/workspace-export';
import { getDefaultWorkspaceExportDirectory } from '../../utils/data-directory';
import {
  configureForExport,
  EXPORT_RATE_LIMITS,
} from '../../utils/rate-limiting';
import { parseSinceArg } from '../../utils/timestamps';

type ExportWorkspaceArgs = {
  output: string;
  user?: string[];
  orgUnit?: string;
  space?: string[];
  dryRun?: boolean;
  since?: string;
  resume?: boolean;
  skipInactive?: boolean;
  skipBotDms?: boolean;
  driveLinks?: string;
  driveExportFormat?: string;
  skipAttachments?: boolean;
  adminSweep?: boolean;
  concurrency?: number;
  refreshUsers?: boolean;
};

/** `--since` as an RFC 3339 time, printed when it was given as a span. */
function resolveSince(value: string | undefined): string | undefined {
  if (!value) {
    return;
  }
  const since = parseSinceArg(value, new Date());
  if (since !== value.trim()) {
    console.log(`--since ${value} → ${since}`);
  }
  return since;
}

export const exportWorkspaceCommand: CommandModule<
  object,
  ExportWorkspaceArgs
> = {
  command: 'export-workspace',
  describe:
    "Export every selected user's spaces, group chats and DMs into an additive store (service account auth). Safe to re-run: later runs are deltas.",
  builder: (yargs) =>
    yargs
      .option('output', {
        describe:
          'Store directory. Never deleted or truncated; re-runs merge into it.',
        type: 'string',
        default: getDefaultWorkspaceExportDirectory(),
      })
      .option('user', {
        describe:
          'Only impersonate these users (repeat or comma-separate). Overrides GOOGLE_EXPORT_USERS.',
        type: 'string',
        array: true,
      })
      .option('org-unit', {
        describe: 'Only impersonate users in this org unit and below.',
        type: 'string',
      })
      .option('space', {
        describe:
          'Only sync these spaces (id, spaces/<id> or display name). Repeatable.',
        type: 'string',
        array: true,
      })
      .option('dry-run', {
        describe:
          'List users, spaces, members and messages and report what would change, without writing to the store or downloading files.',
        type: 'boolean',
        default: false,
      })
      .option('since', {
        describe:
          "RFC 3339 time, or a span back from now such as 30d, 2w or 12h. List messages created after it (or after a conversation's own last listing, if that was earlier): new messages, plus edits, deletions and reaction changes on those. Older messages are not re-checked.",
        type: 'string',
      })
      .option('resume', {
        describe:
          'Continue the last run if it was interrupted. A --since run keeps its own cutoff; passing a different --since overrides it, with a warning.',
        type: 'boolean',
        default: false,
      })
      .option('skip-inactive', {
        describe:
          'With --since: leave alone conversations Google reports no activity in since then and whose member count is unchanged. --no-skip-inactive lists every conversation.',
        type: 'boolean',
        default: true,
      })
      .option('skip-bot-dms', {
        describe: 'Skip DMs with Chat apps and bots.',
        type: 'boolean',
        default: false,
      })
      .option('drive-links', {
        describe:
          'For Drive/Docs/Sheets links inside message text: record metadata only, or also download a copy.',
        type: 'string',
        choices: ['metadata', 'download'],
        default: 'metadata',
      })
      .option('drive-export-format', {
        describe:
          'How Google-native files are saved: office (docx/xlsx/pptx) or pdf. The original link is always kept.',
        type: 'string',
        choices: ['office', 'pdf'],
        default: 'office',
      })
      .option('skip-attachments', {
        describe: 'Index attachments but do not download them yet.',
        type: 'boolean',
        default: false,
      })
      .option('admin-sweep', {
        describe:
          'Use admin space search to report named spaces no selected user can read. Needs chat.admin.spaces.readonly.',
        type: 'boolean',
        default: true,
      })
      .option('concurrency', {
        describe: 'Parallel space listings during discovery.',
        type: 'number',
        default: 3,
      })
      .option('refresh-users', {
        describe:
          'Re-query the directory for everyone referenced in the conversations this run syncs. With --since, add --no-skip-inactive to reach every conversation.',
        type: 'boolean',
        default: false,
      })
      .example('$0 export-workspace --dry-run', 'Preview the whole workspace')
      .example(
        '$0 export-workspace --user a@example.com --user b@example.com --space general',
        'Pilot: two users and one space'
      )
      .example(
        '$0 export-workspace',
        'Full export, or a delta if the store exists'
      )
      .example(
        '$0 export-workspace --since 2026-09-01T00:00:00Z',
        'Fast delta for new messages only'
      )
      .example(
        '$0 export-workspace --since 30d',
        'Re-check the last 30 days of every active conversation'
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
    configureForExport(EXPORT_RATE_LIMITS);

    try {
      const mode = await getGoogleAuthMode();
      if (mode !== GOOGLE_AUTH_MODES.SERVICE_ACCOUNT) {
        console.error(
          'export-workspace requires service account auth. Run "login google --service-account <key.json> --subject <admin@domain>".'
        );
        process.exit(1);
      }
      const since = resolveSince(argv.since);

      const report = await exportWorkspace({
        outputDir: path.resolve(argv.output),
        selection: resolveUserSelection({
          users: argv.user,
          orgUnit: argv.orgUnit,
        }),
        dryRun: argv.dryRun ?? false,
        since,
        resume: argv.resume ?? false,
        skipInactive: argv.skipInactive ?? true,
        spaceFilter: argv.space ?? [],
        skipBotDms: argv.skipBotDms ?? false,
        driveLinks: (argv.driveLinks ?? 'metadata') as DriveLinkPolicy,
        driveExportFormat: (argv.driveExportFormat ??
          'office') as DriveExportPreference,
        skipAttachments: argv.skipAttachments ?? false,
        adminSweep: argv.adminSweep ?? true,
        concurrency: Math.max(1, argv.concurrency ?? 3),
        refreshUsers: argv.refreshUsers ?? false,
      });

      if (report.status === 'failed') {
        process.exit(1);
      }
      if (report.errors > 0) {
        console.log(
          '\nCompleted with errors. Re-run export-workspace to retry failed items; nothing already stored is lost.'
        );
        process.exit(2);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('Export failed:', message);
      process.exit(1);
    }
  },
};
