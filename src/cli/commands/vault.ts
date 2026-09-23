import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { CommandModule } from 'yargs';
import {
  type ExportStore,
  loadSpace,
  loadState,
  openStore,
} from '../../services/export-store';
import {
  GOOGLE_AUTH_MODES,
  getGoogleAuthMode,
} from '../../services/google-auth';
import {
  type ChatExportFormat,
  chunkRoomIds,
  countChatMessages,
  createChatExports,
  describeVaultError,
  downloadExportFiles,
  ensureMatter,
  listChatExports,
  listMatters,
  type VaultExportSummary,
} from '../../services/vault';
import {
  type DeltaPlan,
  deltaExportName,
  planDeltaExports,
} from '../../services/vault-delta';
import { syncVaultExports } from '../../services/vault-sync';
import { getDefaultWorkspaceExportDirectory } from '../../utils/data-directory';
import { readJsonFile, writeJsonAtomic } from '../../utils/fs-atomic';
import { Logger } from '../../utils/logger';
import {
  configureForExport,
  EXPORT_RATE_LIMITS,
} from '../../utils/rate-limiting';
import { makeRunId } from '../../utils/timestamps';

const DEFAULT_MATTER_NAME = 'Google Chat to Slack migration';
const DEFAULT_MATTER_DESCRIPTION =
  'Recovers Chat spaces that have no remaining members, for the Slack migration.';

type VaultArgs = {
  action: string;
  input: string;
  space?: string[];
  matter?: string;
  matterName?: string;
  format?: string;
  subject?: string;
  json?: string;
  dest?: string;
  yes?: boolean;
  overlapHours?: number;
  refresh?: boolean;
  dryRun?: boolean;
  force?: boolean;
};

interface UnreachableEntry {
  spaceId: string;
  displayName: string;
  members?: string[];
}

/**
 * Most recent run report that carries an admin-sweep result. Used when
 * unreachable-spaces.json is absent, which happens if the sweep only ever ran
 * in a dry run (dry runs report but do not write).
 */
async function unreachableFromRuns(
  storeDir: string
): Promise<UnreachableEntry[]> {
  const runsDir = path.join(storeDir, 'runs');
  let files: string[];
  try {
    files = (await readdir(runsDir)).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return [];
  }
  for (const file of files.reverse()) {
    // biome-ignore lint/nursery/noAwaitInLoop: newest report first, stop at the first hit.
    const report = await readJsonFile<{
      unreachableSpaces?: UnreachableEntry[];
    }>(path.join(runsDir, file));
    if (report?.unreachableSpaces?.length) {
      return report.unreachableSpaces;
    }
  }
  return [];
}

/** Spaces the admin sweep found that no live account can read. */
async function orphanSpaceIds(
  storeDir: string,
  filter: string[]
): Promise<UnreachableEntry[]> {
  const entries =
    (await readJsonFile<UnreachableEntry[]>(
      path.join(storeDir, 'unreachable-spaces.json')
    )) ?? (await unreachableFromRuns(storeDir));
  const orphans = entries.filter((e) => (e.members ?? []).length === 0);
  if (filter.length === 0) {
    return orphans;
  }
  const wanted = new Set(filter.map((f) => f.replace('spaces/', '')));
  return orphans.filter(
    (e) => wanted.has(e.spaceId) || wanted.has(e.displayName)
  );
}

function printExports(exports: VaultExportSummary[]): void {
  if (exports.length === 0) {
    console.log('   (none)');
    return;
  }
  for (const item of exports) {
    const progress =
      item.totalArtifactCount !== undefined
        ? ` · ${item.exportedArtifactCount ?? 0}/${item.totalArtifactCount} messages`
        : '';
    const size = item.sizeInBytes
      ? ` · ${(item.sizeInBytes / 1024 / 1024).toFixed(1)} MB`
      : '';
    console.log(
      `   ${(item.status ?? 'UNKNOWN').padEnd(12)} ${item.name}${progress}${size}`
    );
    for (const object of item.objectNames) {
      console.log(`      gs://${item.bucketName}/${object}`);
    }
  }
}

async function runProbe(
  argv: VaultArgs,
  storeDir: string,
  subject?: string
): Promise<void> {
  const orphans = await orphanSpaceIds(storeDir, argv.space ?? []);
  console.log(
    `Spaces with no remaining members (from the admin sweep): ${orphans.length}`
  );
  if (orphans.length === 0) {
    console.log(
      'Nothing to recover. Run "export-workspace --admin-sweep" first if you expected results.'
    );
    return;
  }
  console.log(
    `Vault requests needed: ${chunkRoomIds(orphans.map((o) => o.spaceId)).length} (max 500 spaces each)\n`
  );

  const { matter, created } = await ensureMatter(
    argv.matterName ?? DEFAULT_MATTER_NAME,
    DEFAULT_MATTER_DESCRIPTION,
    subject
  );
  console.log(
    `Matter: ${matter.name} (${matter.matterId})${created ? ' — created' : ' — reused'}\n`
  );

  const results = await countChatMessages(
    matter.matterId,
    orphans.map((o) => o.spaceId),
    subject
  );
  let total = 0;
  for (const result of results) {
    if (result.error) {
      console.log(`❌ ${result.roomIds.length} space(s): ${result.error}`);
      continue;
    }
    total += result.totalCount ?? 0;
    console.log(
      `✔ ${result.roomIds.length} space(s): ${result.totalCount ?? 'count not reported'} message(s)`
    );
    console.log(`   raw: ${JSON.stringify(result.raw)}`);
  }
  console.log(`\nTotal messages Vault reports for these spaces: ${total}`);
  console.log(
    `Next: googletoslack vault export --matter ${matter.matterId} to start the export.`
  );
  if (argv.json) {
    await writeJsonAtomic(path.resolve(argv.json), {
      matter,
      orphans,
      results,
    });
    console.log(`Report written to ${path.resolve(argv.json)}`);
  }
}

async function runExport(
  argv: VaultArgs,
  storeDir: string,
  subject?: string
): Promise<void> {
  const orphans = await orphanSpaceIds(storeDir, argv.space ?? []);
  if (orphans.length === 0) {
    console.log('No spaces to export.');
    return;
  }
  const { matter } = argv.matter
    ? { matter: { matterId: argv.matter, name: argv.matter } }
    : await ensureMatter(
        argv.matterName ?? DEFAULT_MATTER_NAME,
        DEFAULT_MATTER_DESCRIPTION,
        subject
      );

  const format = (argv.format ?? 'MBOX').toUpperCase() as ChatExportFormat;
  console.log(
    `Starting ${chunkRoomIds(orphans.map((o) => o.spaceId)).length} Vault export(s) for ${orphans.length} space(s) as ${format} in matter ${matter.matterId}.`
  );
  const created = await createChatExports(
    matter.matterId,
    orphans.map((o) => o.spaceId),
    'chat-orphan-spaces',
    format,
    subject
  );
  printExports(created);
  console.log(
    `\nVault processes exports in the background. Check with:\n  googletoslack vault status --matter ${matter.matterId}`
  );
}

async function runStatus(argv: VaultArgs, subject?: string): Promise<void> {
  const matterId =
    argv.matter ??
    (
      await ensureMatter(
        argv.matterName ?? DEFAULT_MATTER_NAME,
        DEFAULT_MATTER_DESCRIPTION,
        subject
      )
    ).matter.matterId;
  const exports = await listChatExports(matterId, subject);
  console.log(`Exports in matter ${matterId}:`);
  printExports(exports);
  const done = exports.filter((e) => e.status === 'COMPLETED');
  if (done.length > 0) {
    console.log(
      '\nCompleted exports can be downloaded from the Vault console (Exports tab), or from the Cloud Storage objects listed above.'
    );
  }
}

async function runDownload(argv: VaultArgs, subject?: string): Promise<void> {
  if (!argv.matter) {
    throw new Error('--matter <matterId> is required for download.');
  }
  const destDir = path.resolve(argv.dest ?? 'data/vault-exports');
  const exports = (await listChatExports(argv.matter, subject)).filter(
    (e) => e.status === 'COMPLETED'
  );
  if (exports.length === 0) {
    console.log('No completed exports to download yet.');
    return;
  }
  for (const item of exports) {
    console.log(`Downloading ${item.name}...`);
    // biome-ignore lint/nursery/noAwaitInLoop: one export at a time.
    const files = await downloadExportFiles(
      item,
      path.join(destDir, item.name),
      subject
    );
    for (const file of files) {
      console.log(
        `   ${file.localPath} (${(file.bytes / 1024 / 1024).toFixed(1)} MB)`
      );
    }
  }
}

async function resolveMatterId(
  argv: VaultArgs,
  subject?: string
): Promise<string> {
  if (argv.matter) {
    return argv.matter;
  }
  const { matter } = await ensureMatter(
    argv.matterName ?? DEFAULT_MATTER_NAME,
    DEFAULT_MATTER_DESCRIPTION,
    subject
  );
  return matter.matterId;
}

function printDeltaPlan(
  plan: DeltaPlan,
  targets: UnreachableEntry[],
  matterId: string,
  now: Date
): void {
  const names = new Map(targets.map((t) => [t.spaceId, t.displayName]));
  console.log(
    `${targets.length} member-less space(s); ${plan.coveredUntil.size} already exported at least once in matter ${matterId}.`
  );
  if (plan.upToDate.length > 0) {
    console.log(
      `   ${plan.upToDate.length} space(s) already exported with no members left, so nothing new can arrive (--refresh checks anyway).`
    );
  }
  if (plan.pending.length > 0) {
    console.log(
      `   ${plan.pending.length} space(s) left out: an export for them is still running.`
    );
  }
  for (const group of plan.groups) {
    const scope = group.startTime
      ? `messages since ${group.startTime}`
      : 'full history (never exported)';
    console.log(
      `\n   ${deltaExportName(group, now)}: ${group.spaceIds.length} space(s), ${scope}`
    );
    for (const id of group.spaceIds.slice(0, 5)) {
      console.log(`      ${id}  ${names.get(id) ?? ''}`);
    }
    if (group.spaceIds.length > 5) {
      console.log(`      … and ${group.spaceIds.length - 5} more`);
    }
  }
}

/**
 * Last Chat API sync for member-less spaces the store already holds from the
 * API: messages sent after it, before the last member left, exist only in
 * Vault now.
 */
async function apiSyncTimes(
  storeDir: string,
  targets: UnreachableEntry[]
): Promise<Map<string, string>> {
  const store = await openStore(storeDir);
  const times = new Map<string, string>();
  for (const { spaceId } of targets) {
    // biome-ignore lint/nursery/noAwaitInLoop: a few hundred small reads.
    const space = await loadSpace(store, spaceId);
    if (!space || (space.source ?? 'chat-api') !== 'chat-api') {
      continue;
    }
    const state = await loadState(store, spaceId);
    if (state?.lastMessagesSyncAt) {
      times.set(spaceId, state.lastMessagesSyncAt);
    }
  }
  return times;
}

/**
 * Exports only what earlier exports in the matter did not cover: full history
 * for spaces never exported, messages since the last export (less an overlap)
 * for the rest.
 */
async function runDelta(
  argv: VaultArgs,
  storeDir: string,
  subject?: string
): Promise<void> {
  const targets = await orphanSpaceIds(storeDir, argv.space ?? []);
  if (targets.length === 0) {
    console.log('No member-less spaces to export.');
    return;
  }
  const matterId = await resolveMatterId(argv, subject);
  const history = await listChatExports(matterId, subject);
  const plan = planDeltaExports(
    targets.map((t) => t.spaceId),
    history,
    {
      overlapHours: argv.overlapHours ?? 48,
      apiSyncedAt: await apiSyncTimes(storeDir, targets),
      refresh: argv.refresh ?? false,
    }
  );
  const now = new Date();
  printDeltaPlan(plan, targets, matterId, now);
  if (argv.dryRun || plan.groups.length === 0) {
    if (argv.dryRun) {
      console.log('\n[Dry run] No exports created.');
    }
    return;
  }
  const format = (argv.format ?? 'MBOX').toUpperCase() as ChatExportFormat;
  for (const group of plan.groups) {
    // biome-ignore lint/nursery/noAwaitInLoop: one export request at a time.
    const created = await createChatExports(
      matterId,
      group.spaceIds,
      deltaExportName(group, now),
      format,
      subject,
      group.startTime
    );
    printExports(created);
  }
  console.log(
    `\nWhen they complete (vault status), bring them in with:\n  googletoslack vault sync --matter ${matterId}`
  );
}

/** A crashed export also leaves "running"; --force covers that case. */
async function exportIsRunning(storeDir: string): Promise<boolean> {
  const manifest = await readJsonFile<{ lastRun?: { status?: string } }>(
    path.join(storeDir, 'manifest.json')
  );
  return manifest?.lastRun?.status === 'running';
}

async function runSync(
  argv: VaultArgs,
  store: ExportStore,
  subject?: string
): Promise<void> {
  if (!(argv.dryRun || argv.force) && (await exportIsRunning(store.rootDir))) {
    throw new Error(
      'export-workspace is running and writes the same users.json and attachment index. Wait for it, or pass --force if it is not really running.'
    );
  }
  const logger = new Logger('Vault sync');
  const destDir = path.resolve(argv.dest ?? 'data/vault-exports');
  const runId = `vault-${makeRunId()}`;
  const synced = await syncVaultExports(store, {
    matterId: await resolveMatterId(argv, subject),
    destDir,
    ledgerPath: path.join(destDir, 'imported.json'),
    runId,
    dryRun: argv.dryRun ?? false,
    subject,
    logger,
  });
  if (synced.length === 0) {
    console.log('Nothing new: every completed export is already imported.');
    return;
  }
  for (const { export: item, mboxes, reports } of synced) {
    const added = reports.reduce((n, r) => n + r.totals.messagesAdded, 0);
    const existing = reports.reduce(
      (n, r) => n + r.totals.messagesSkippedExisting,
      0
    );
    console.log(
      `${argv.dryRun ? '[Dry run] ' : ''}${item.name}: ${mboxes.length} mbox file(s) · +${added} new message(s) · ${existing} already stored`
    );
  }
  if (logger.hasIssues() && !argv.dryRun) {
    console.log(
      `Details: ${await logger.writeLog(store.rootDir, `${runId}.log`)}`
    );
  }
}

async function runMatters(subject?: string): Promise<void> {
  const matters = await listMatters(subject);
  console.log(`Open Vault matters: ${matters.length}`);
  for (const matter of matters) {
    console.log(`   ${matter.matterId}  ${matter.name}`);
  }
}

export const vaultCommand: CommandModule<object, VaultArgs> = {
  command: 'vault <action>',
  describe:
    'Use Google Vault to reach Chat spaces that have no remaining members (probe | export | delta | status | download | sync | matters).',
  builder: (yargs) =>
    yargs
      .positional('action', {
        describe:
          'probe: check what Vault can reach. export: start exports. delta: export only what earlier exports missed. status: check progress. download: fetch completed exports. sync: download, unpack and import every completed export not yet imported. matters: list matters.',
        type: 'string',
        choices: [
          'probe',
          'export',
          'delta',
          'status',
          'download',
          'sync',
          'matters',
        ],
        demandOption: true,
      })
      .option('input', {
        describe:
          'Workspace export store (source of the unreachable space list).',
        type: 'string',
        default: getDefaultWorkspaceExportDirectory(),
      })
      .option('space', {
        describe: 'Restrict to these space ids or display names. Repeatable.',
        type: 'string',
        array: true,
      })
      .option('matter', {
        describe: 'Existing Vault matter id to use.',
        type: 'string',
      })
      .option('matter-name', {
        describe: 'Name of the matter to find or create.',
        type: 'string',
        default: DEFAULT_MATTER_NAME,
      })
      .option('format', {
        describe: 'Export format.',
        type: 'string',
        choices: ['MBOX', 'PST'],
        default: 'MBOX',
      })
      .option('subject', {
        describe:
          'Workspace user to act as. Must hold Vault privileges. Defaults to the configured admin.',
        type: 'string',
      })
      .option('json', {
        describe: 'Write the probe report to this JSON file.',
        type: 'string',
      })
      .option('dest', {
        describe: 'Directory for downloaded exports.',
        type: 'string',
        default: 'data/vault-exports',
      })
      .option('overlap-hours', {
        describe:
          'delta: re-fetch this many hours before the last export, to catch messages Vault indexed late. Duplicates are skipped on import.',
        type: 'number',
        default: 48,
      })
      .option('refresh', {
        describe:
          'delta: also re-check member-less spaces already exported from Vault.',
        type: 'boolean',
        default: false,
      })
      .option('dry-run', {
        describe:
          'delta: show the plan without creating exports. sync: import nothing.',
        type: 'boolean',
        default: false,
      })
      .option('force', {
        describe:
          'sync: run even though the store says an export is running (use only if it crashed).',
        type: 'boolean',
        default: false,
      })
      .example(
        '$0 vault delta --dry-run',
        'Show which spaces need exporting and from when'
      )
      .example('$0 vault sync', 'Download, unpack and import finished exports')
      .example(
        '$0 vault probe',
        'Count what Vault holds for member-less spaces'
      )
      .example(
        '$0 vault export --matter 1234abcd',
        'Start MBOX exports for those spaces'
      )
      .example('$0 vault status --matter 1234abcd', 'Check export progress')
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
          'Vault access requires service account auth. Run "login google --service-account <key.json> --subject <admin@domain>".'
        );
        process.exit(1);
      }
      const storeDir = path.resolve(argv.input);
      const store = await openStore(storeDir);
      const subject = argv.subject;

      switch (argv.action) {
        case 'probe':
          await runProbe(argv, storeDir, subject);
          break;
        case 'export':
          await runExport(argv, storeDir, subject);
          break;
        case 'delta':
          await runDelta(argv, storeDir, subject);
          break;
        case 'status':
          await runStatus(argv, subject);
          break;
        case 'sync':
          await runSync(argv, store, subject);
          break;
        case 'download':
          await runDownload(argv, subject);
          break;
        default:
          await runMatters(subject);
      }
    } catch (error) {
      console.error('Vault command failed:', describeVaultError(error));
      process.exit(1);
    }
  },
};
