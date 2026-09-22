import path from 'node:path';
import type { CommandModule } from 'yargs';
import {
  printVerifyReport,
  verifyExportStore,
} from '../../services/export-verify';
import { getDefaultWorkspaceExportDirectory } from '../../utils/data-directory';
import { writeJsonAtomic } from '../../utils/fs-atomic';
import { Logger } from '../../utils/logger';
import {
  configureForExport,
  EXPORT_RATE_LIMITS,
} from '../../utils/rate-limiting';

type VerifyArgs = {
  export?: boolean;
  output: string;
  live?: boolean;
  files?: boolean;
  space?: string[];
  json?: string;
};

export const verifyCommand: CommandModule<object, VerifyArgs> = {
  command: 'verify',
  describe:
    'Check the workspace export store: completeness against Google and integrity of downloaded files.',
  builder: (yargs) =>
    yargs
      .option('export', {
        describe: 'Verify the export store (default).',
        type: 'boolean',
        default: true,
      })
      .option('output', {
        describe: 'Store directory to verify.',
        type: 'string',
        default: getDefaultWorkspaceExportDirectory(),
      })
      .option('live', {
        describe:
          'Re-list every space from Google and compare message sets. Use --no-live for an offline check.',
        type: 'boolean',
        default: true,
      })
      .option('files', {
        describe:
          'Hash every downloaded attachment. Use --no-files to only check existence.',
        type: 'boolean',
        default: true,
      })
      .option('space', {
        describe: 'Only verify these spaces (id or display name). Repeatable.',
        type: 'string',
        array: true,
      })
      .option('json', {
        describe: 'Also write the report to this JSON file.',
        type: 'string',
      })
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
    const logger = new Logger('Verify');
    try {
      const report = await verifyExportStore(
        {
          outputDir: path.resolve(argv.output),
          live: argv.live ?? true,
          files: argv.files ?? true,
          spaceFilter: argv.space ?? [],
        },
        logger
      );
      printVerifyReport(report);
      if (argv.json) {
        await writeJsonAtomic(path.resolve(argv.json), report);
        console.log(`Report written to ${path.resolve(argv.json)}`);
      }
      if (logger.hasIssues()) {
        const logPath = await logger.writeLog(
          path.resolve(argv.output),
          'verify.log'
        );
        console.log(`Details: ${logPath}`);
      }
      process.exit(report.ok ? 0 : 1);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('Verification failed:', message);
      process.exit(1);
    }
  },
};
