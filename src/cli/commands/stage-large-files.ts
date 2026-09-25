import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { CommandModule } from 'yargs';
import {
  loadAttachmentIndex,
  loadSpace,
  loadUsers,
  openStore,
} from '../../services/export-store';
import {
  audienceFor,
  DRIVE_FOLDER_NAME,
  DRIVE_THRESHOLD_BYTES,
  ensureFolder,
  type LargeFileLedger,
  selectLargeFiles,
  shareFile,
  stageFile,
} from '../../services/large-files';
import { parseCsv } from '../../services/slack-archive/visibility';
import {
  getDefaultChannelVisibilityFile,
  getDefaultLargeFilesLedger,
  getDefaultWorkspaceExportDirectory,
} from '../../utils/data-directory';
import { readJsonFile, writeJsonAtomic } from '../../utils/fs-atomic';

type StageArgs = {
  input: string;
  ledger?: string;
  channelVisibility?: string;
  domain: string;
  share?: boolean;
  dryRun?: boolean;
  limit?: number;
  subject?: string;
  sharedDrive?: string;
};

const GB = 1024 ** 3;

async function publicSpaces(file: string): Promise<Set<string>> {
  try {
    const rows = parseCsv(await readFile(file, 'utf-8'));
    return new Set(
      rows.filter((r) => r.visibility === 'public').map((r) => r.spaceId)
    );
  } catch {
    return new Set();
  }
}

export const stageLargeFilesCommand: CommandModule<object, StageArgs> = {
  command: 'stage-large-files',
  describe:
    "Upload attachments too large for Slack's importer to a private Google Drive folder, once per distinct file. --share later grants access (no notification emails). build-slack-archive --large-files links to them.",
  builder: (yargs) =>
    yargs
      .option('input', {
        describe: 'Workspace export store.',
        type: 'string',
        default: getDefaultWorkspaceExportDirectory(),
      })
      .option('ledger', {
        describe:
          'Where uploads are recorded. Defaults to data/slack/large-files.json.',
        type: 'string',
      })
      .option('channel-visibility', {
        describe:
          'Reviewed visibility list; files in public channels are shared with the domain.',
        type: 'string',
      })
      .option('domain', {
        describe:
          'Domain for files from public channels, and for active participants.',
        type: 'string',
        default: 'hrc.email',
      })
      .option('share', {
        describe:
          'Grant access now (silently). Run only once the migration may be visible to staff.',
        type: 'boolean',
        default: false,
      })
      .option('dry-run', {
        describe: 'Report what would be uploaded; upload nothing.',
        type: 'boolean',
        default: false,
      })
      .option('limit', {
        describe: 'Stop after this many files (for a trial).',
        type: 'number',
      })
      .option('subject', {
        describe:
          'Admin who uploads (and owns, in My Drive). Defaults to the configured admin.',
        type: 'string',
      })
      .option('shared-drive', {
        describe:
          "Shared Drive id to hold the folder instead of the admin's My Drive. Every member of it can open every file. Needs the full drive scope.",
        type: 'string',
      })
      .strict(),
  handler: async (argv) => {
    try {
      const store = await openStore(path.resolve(argv.input));
      const ledgerPath = path.resolve(
        argv.ledger ?? getDefaultLargeFilesLedger()
      );
      const ledger = (await readJsonFile<LargeFileLedger>(ledgerPath)) ?? {};
      const files = selectLargeFiles(await loadAttachmentIndex(store));
      const users = await loadUsers(store);
      const publicSet = await publicSpaces(
        path.resolve(
          argv.channelVisibility ?? getDefaultChannelVisibilityFile()
        )
      );
      const participants = new Map<string, string[]>();
      for (const spaceId of new Set(files.flatMap((f) => f.spaceIds))) {
        // biome-ignore lint/nursery/noAwaitInLoop: a few hundred small reads.
        const space = await loadSpace(store, spaceId);
        participants.set(
          spaceId,
          (space?.memberships ?? [])
            .map((m) => (m.chatUserId ? users[m.chatUserId] : undefined))
            .filter(
              (u) =>
                u?.status === 'active' && u.email?.endsWith(`@${argv.domain}`)
            )
            .map((u) => u?.email as string)
        );
      }
      const total = files.reduce((n, f) => n + f.size, 0);
      const pending = files.filter((f) => !ledger[f.sha256]);
      console.log(
        `${files.length} distinct file(s) over ${DRIVE_THRESHOLD_BYTES / 1024 ** 2} MB, ${(total / GB).toFixed(1)} GB · ${pending.length} not yet in Drive (${(pending.reduce((n, f) => n + f.size, 0) / GB).toFixed(1)} GB)`
      );
      if (argv.dryRun) {
        return;
      }
      const target = { subject: argv.subject, sharedDriveId: argv.sharedDrive };
      const folderId = await ensureFolder(target);
      console.log(
        `Drive folder: "${DRIVE_FOLDER_NAME}" (${folderId}), private until --share.`
      );
      let done = 0;
      for (const file of pending.slice(0, argv.limit ?? pending.length)) {
        const started = Date.now();
        // biome-ignore lint/nursery/noAwaitInLoop: uploads go one at a time.
        const staged = await stageFile(file, folderId, target);
        ledger[file.sha256] = {
          fileId: staged.id,
          webViewLink: staged.webViewLink,
          name: file.name,
          size: file.size,
          keys: file.keys,
          audience: audienceFor(
            file.spaceIds,
            (id) => publicSet.has(id),
            (id) => participants.get(id) ?? [],
            argv.domain
          ),
        };
        await writeJsonAtomic(ledgerPath, ledger);
        done += 1;
        console.log(
          `   ↑ ${file.name} (${(file.size / 1024 ** 2).toFixed(0)} MB) in ${Math.round((Date.now() - started) / 1000)} s · ${done}/${pending.length}`
        );
      }
      if (argv.share) {
        const unshared = Object.values(ledger).filter((s) => !s.sharedAt);
        for (const staged of unshared) {
          // biome-ignore lint/nursery/noAwaitInLoop: permissions one file at a time.
          await shareFile(staged.fileId, staged.audience, target);
          staged.sharedAt = new Date().toISOString();
          await writeJsonAtomic(ledgerPath, ledger);
        }
        console.log(
          `Shared ${unshared.length} file(s) without notification emails.`
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('stage-large-files failed:', message);
      process.exit(1);
    }
  },
};
