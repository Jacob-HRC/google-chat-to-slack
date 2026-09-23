/**
 * Brings every completed Vault export in a matter into the store, once.
 *
 * For each completed export not yet in the ledger: download its objects,
 * unpack the nested ZIPs, and fold each mbox in with the Vault importer. The
 * importer skips message ids it already holds, so overlapping delta exports
 * and repeated runs add nothing twice. An export is written to the ledger
 * only after every mbox in it imported cleanly.
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { readJsonFile, writeJsonAtomic } from '../utils/fs-atomic';
import type { Logger } from '../utils/logger';
import { extractNested } from '../utils/unzip';
import type { ExportStore } from './export-store';
import {
  downloadExportFiles,
  listChatExports,
  type VaultExportSummary,
} from './vault';
import { DELTA_EXPORT_PREFIX } from './vault-delta';
import {
  importVaultExport,
  type VaultImportReport,
} from './vault-import/importer';

export interface LedgerEntry {
  name: string;
  importedAt: string;
  runId: string;
  messagesAdded: number;
  spaces: number;
}

export interface VaultLedger {
  /** Keyed by Vault export id. */
  exports: Record<string, LedgerEntry>;
}

export interface VaultSyncOptions {
  matterId: string;
  destDir: string;
  ledgerPath: string;
  runId: string;
  dryRun: boolean;
  subject?: string;
  logger: Logger;
}

export interface SyncedExport {
  export: VaultExportSummary;
  mboxes: string[];
  reports: VaultImportReport[];
}

const MBOX_SUFFIX = '.mbox';
const METADATA_SUFFIX = '-metadata.xml';

/** Completed exports the ledger does not list yet. Pure. */
export function exportsToSync(
  exports: VaultExportSummary[],
  ledger: VaultLedger
): VaultExportSummary[] {
  return exports
    .filter((e) => e.status === 'COMPLETED' && !ledger.exports[e.id])
    .sort((a, b) => (a.createTime ?? '').localeCompare(b.createTime ?? ''));
}

export async function loadLedger(ledgerPath: string): Promise<VaultLedger> {
  return (await readJsonFile<VaultLedger>(ledgerPath)) ?? { exports: {} };
}

async function unpack(
  item: VaultExportSummary,
  dir: string,
  subject?: string
): Promise<{ mboxes: string[]; metadata?: string }> {
  const downloaded = await downloadExportFiles(item, dir, subject);
  for (const file of downloaded) {
    if (file.localPath.endsWith('.zip')) {
      // biome-ignore lint/nursery/noAwaitInLoop: one archive at a time bounds disk use.
      await extractNested(file.localPath, dir);
    }
  }
  const names = await readdir(dir);
  const mboxes = names
    .filter((n) => n.endsWith(MBOX_SUFFIX))
    .sort()
    .map((n) => path.join(dir, n));
  const metadata = names.find((n) => n.endsWith(METADATA_SUFFIX));
  return { mboxes, metadata: metadata ? path.join(dir, metadata) : undefined };
}

/** Downloads, unpacks and imports every completed export not yet imported. */
export async function syncVaultExports(
  store: ExportStore,
  options: VaultSyncOptions
): Promise<SyncedExport[]> {
  const ledger = await loadLedger(options.ledgerPath);
  const pending = exportsToSync(
    await listChatExports(options.matterId, options.subject),
    ledger
  );
  const synced: SyncedExport[] = [];
  for (const item of pending) {
    const dir = path.join(options.destDir, item.name);
    // biome-ignore lint/nursery/noAwaitInLoop: exports are processed in creation order.
    const { mboxes, metadata } = await unpack(item, dir, options.subject);
    if (!metadata) {
      throw new Error(
        `${item.name}: no *${METADATA_SUFFIX} among the downloaded files in ${dir}`
      );
    }
    const reports: VaultImportReport[] = [];
    for (const mboxPath of mboxes) {
      reports.push(
        // biome-ignore lint/nursery/noAwaitInLoop: each import writes the store; they must not overlap.
        await importVaultExport(store, {
          mboxPath,
          metadataPath: metadata,
          runId: options.runId,
          dryRun: options.dryRun,
          // A delta may cover a space the Chat API exported before its last
          // member left. Message ids already stored are never replaced, so
          // this only adds what arrived after the last API sync.
          allowApiSpaces: item.name.startsWith(DELTA_EXPORT_PREFIX),
          spaceFilter: [],
          logger: options.logger,
        })
      );
    }
    synced.push({ export: item, mboxes, reports });
    if (!options.dryRun) {
      ledger.exports[item.id] = {
        name: item.name,
        importedAt: new Date().toISOString(),
        runId: options.runId,
        messagesAdded: reports.reduce((n, r) => n + r.totals.messagesAdded, 0),
        spaces: new Set(
          reports.flatMap((r) =>
            r.spaces.filter((s) => !s.skippedReason).map((s) => s.spaceId)
          )
        ).size,
      };
      await writeJsonAtomic(options.ledgerPath, ledger);
    }
  }
  return synced;
}
