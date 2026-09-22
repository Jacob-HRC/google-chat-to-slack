import path from 'node:path';
import type { CommandModule } from 'yargs';
import { openStore } from '../../services/export-store';
import {
  importVaultExport,
  type VaultImportReport,
} from '../../services/vault-import/importer';
import { getDefaultWorkspaceExportDirectory } from '../../utils/data-directory';
import { writeJsonAtomic } from '../../utils/fs-atomic';
import { Logger } from '../../utils/logger';
import { makeRunId } from '../../utils/timestamps';

const MBOX_SUFFIX_REGEX = /_\d+\.mbox$/;

type ImportVaultArgs = {
  mbox: string;
  metadata?: string;
  output: string;
  dryRun?: boolean;
  space?: string[];
  allowApiSpaces?: boolean;
  json?: string;
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

function printReport(report: VaultImportReport): void {
  const t = report.totals;
  const prefix = report.dryRun ? '[Dry run] ' : '';
  console.log(`\n📥 ${prefix}Vault import ${report.runId}`);
  console.log(
    `   Spaces: ${t.spaces} imported · ${t.spacesSkipped} skipped (already covered by the Chat API)`
  );
  console.log(
    `   Messages: ${t.messagesAdded} added · ${t.messagesSkippedExisting} already present · ${t.messagesParsed} parsed from ${t.documents} documents`
  );
  if (t.messagesWithoutTimestamp > 0) {
    console.log(
      `   ⚠️  ${t.messagesWithoutTimestamp} message(s) had no rendered timestamp and were skipped`
    );
  }
  console.log(
    `   Attachments: ${t.attachments} (${formatBytes(t.attachmentBytes)})`
  );
  console.log(`   People created from emails: ${t.usersCreated}`);

  const imported = report.spaces
    .filter((s) => !s.skippedReason)
    .sort((a, b) => b.messagesAdded - a.messagesAdded);
  if (imported.length > 0) {
    console.log('\n   Largest imported conversations:');
    for (const space of imported.slice(0, 10)) {
      console.log(
        `     ${(space.roomName || space.spaceId).padEnd(40)} ${String(space.messagesAdded).padStart(5)} messages · ${space.attachments} files · ${space.participants} participants`
      );
    }
  }
  const skipped = report.spaces.filter((s) => s.skippedReason);
  if (skipped.length > 0) {
    console.log(
      `\n   Skipped ${skipped.length}, e.g. ${skipped[0].roomName}: ${skipped[0].skippedReason}`
    );
  }
}

export const importVaultCommand: CommandModule<object, ImportVaultArgs> = {
  command: 'import-vault',
  describe:
    'Fold a Google Vault Chat export into the workspace store. Chat API data always wins; Vault only fills gaps.',
  builder: (yargs) =>
    yargs
      .option('mbox', {
        describe: 'Path to the extracted Vault .mbox file.',
        type: 'string',
        demandOption: true,
      })
      .option('metadata', {
        describe:
          'Path to the export metadata XML. Defaults to the -metadata.xml beside the mbox.',
        type: 'string',
      })
      .option('output', {
        describe: 'Workspace export store to merge into.',
        type: 'string',
        default: getDefaultWorkspaceExportDirectory(),
      })
      .option('dry-run', {
        describe: 'Parse and report without writing to the store.',
        type: 'boolean',
        default: false,
      })
      .option('space', {
        describe: 'Only import these space ids. Repeatable.',
        type: 'string',
        array: true,
      })
      .option('allow-api-spaces', {
        describe:
          'Also import into Spaces that already hold Chat API messages. Off by default because the API copy is higher fidelity.',
        type: 'boolean',
        default: false,
      })
      .option('json', {
        describe: 'Write the report to this JSON file.',
        type: 'string',
      })
      .example(
        '$0 import-vault --mbox data/vault-exports/chat-orphan-spaces/chat-orphan-spaces_0.mbox --dry-run',
        'Parse the export and report what would be added'
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
    const logger = new Logger('Vault import');
    try {
      const mboxPath = path.resolve(argv.mbox);
      const metadataPath = argv.metadata
        ? path.resolve(argv.metadata)
        : mboxPath.replace(MBOX_SUFFIX_REGEX, '-metadata.xml');
      const storeDir = path.resolve(argv.output);
      const store = await openStore(storeDir);

      const report = await importVaultExport(store, {
        mboxPath,
        metadataPath,
        runId: `vault-${makeRunId()}`,
        dryRun: argv.dryRun ?? false,
        allowApiSpaces: argv.allowApiSpaces ?? false,
        spaceFilter: argv.space ?? [],
        logger,
      });

      printReport(report);
      if (argv.json) {
        await writeJsonAtomic(path.resolve(argv.json), report);
        console.log(`\nReport written to ${path.resolve(argv.json)}`);
      }
      if (logger.hasIssues() && !report.dryRun) {
        const logPath = await logger.writeLog(storeDir, `${report.runId}.log`);
        console.log(`Details: ${logPath}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('Vault import failed:', message);
      process.exit(1);
    }
  },
};
