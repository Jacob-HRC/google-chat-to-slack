import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ZipFile } from 'yazl';
import type { VaultExportSummary } from '../../services/vault';
import {
  coverageBySpace,
  deltaExportName,
  deltaStartTime,
  planDeltaExports,
} from '../../services/vault-delta';
import { exportsToSync } from '../../services/vault-sync';
import { extractNested, safeEntryPath } from '../../utils/unzip';

function vaultExport(
  id: string,
  status: string,
  createTime: string,
  roomIds: string[]
): VaultExportSummary {
  return { id, name: id, status, createTime, objectNames: [], roomIds };
}

const FIRST = vaultExport('e1', 'COMPLETED', '2026-09-22T12:00:00Z', [
  'AAA',
  'BBB',
]);
const SECOND = vaultExport('e2', 'COMPLETED', '2026-09-23T06:30:00Z', ['BBB']);
const RUNNING = vaultExport('e3', 'IN_PROGRESS', '2026-09-23T15:00:00Z', [
  'CCC',
]);
const FAILED = vaultExport('e4', 'FAILED', '2026-09-23T16:00:00Z', ['DDD']);

describe('vault delta planning', () => {
  it('takes the newest completed export per space', () => {
    const coverage = coverageBySpace([FIRST, SECOND, RUNNING, FAILED]);
    expect(Object.fromEntries(coverage)).toEqual({
      AAA: '2026-09-22T12:00:00Z',
      BBB: '2026-09-23T06:30:00Z',
    });
  });

  it('starts an overlap before the last export, floored to the hour', () => {
    expect(deltaStartTime('2026-09-23T06:30:00Z', 48)).toBe(
      '2026-09-21T06:00:00.000Z'
    );
  });

  it('fetches new spaces in full and skips member-less ones already exported', () => {
    const plan = planDeltaExports(
      ['AAA', 'BBB', 'CCC', 'DDD', 'NEW', 'AAA'],
      [FIRST, SECOND, RUNNING, FAILED],
      { overlapHours: 48 }
    );
    expect(plan.pending).toEqual(['CCC']);
    expect(plan.upToDate).toEqual(['AAA', 'BBB']);
    expect(plan.groups).toEqual([
      { startTime: undefined, spaceIds: ['DDD', 'NEW'] },
    ]);
  });

  it('re-checks exported spaces from their last export when asked', () => {
    const plan = planDeltaExports(['AAA', 'BBB'], [FIRST, SECOND], {
      overlapHours: 48,
      refresh: true,
    });
    expect(plan.groups).toEqual([
      { startTime: '2026-09-20T12:00:00.000Z', spaceIds: ['AAA'] },
      { startTime: '2026-09-21T06:00:00.000Z', spaceIds: ['BBB'] },
    ]);
  });

  it('fills the gap after the last API sync for spaces that lost their members', () => {
    const plan = planDeltaExports(['APISPACE', 'BBB'], [SECOND], {
      overlapHours: 24,
      apiSyncedAt: new Map([
        ['APISPACE', '2026-09-22T15:45:00Z'],
        // An API sync newer than the Vault export wins.
        ['BBB', '2026-09-23T10:10:00Z'],
      ]),
    });
    expect(plan.groups).toEqual([
      { startTime: '2026-09-21T15:00:00.000Z', spaceIds: ['APISPACE'] },
      { startTime: '2026-09-22T10:00:00.000Z', spaceIds: ['BBB'] },
    ]);
  });

  it('names exports so they sort and say what they hold', () => {
    const now = new Date('2026-09-23T17:05:00Z');
    expect(deltaExportName({ spaceIds: [] }, now)).toBe(
      'chat-delta-20260923-1705-full'
    );
    expect(
      deltaExportName(
        { startTime: '2026-09-21T06:00:00.000Z', spaceIds: [] },
        now
      )
    ).toBe('chat-delta-20260923-1705-since-20260921-06');
  });

  it('syncs only completed exports the ledger has not seen, oldest first', () => {
    const pending = exportsToSync([SECOND, RUNNING, FIRST, FAILED], {
      exports: {
        e1: {
          name: 'e1',
          importedAt: '',
          runId: '',
          messagesAdded: 0,
          spaces: 0,
        },
      },
    });
    expect(pending.map((e) => e.id)).toEqual(['e2']);
  });
});

async function writeZip(
  target: string,
  entries: [string, Buffer][]
): Promise<void> {
  const zip = new ZipFile();
  for (const [name, content] of entries) {
    zip.addBuffer(content, name);
  }
  zip.end();
  await pipeline(zip.outputStream, createWriteStream(target));
}

describe('nested unzip', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'gcts-unzip-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('unpacks a Vault-style zip inside a zip', async () => {
    const inner = path.join(dir, 'inner.zip');
    await writeZip(inner, [['export_0.mbox', Buffer.from('From x\n')]]);
    const outer = path.join(dir, 'export-1.zip');
    await writeZip(outer, [['export_0.mbox.zip', await readFile(inner)]]);

    const out = path.join(dir, 'out');
    const files = await extractNested(outer, out);
    expect(files).toEqual([path.join(out, 'export_0.mbox')]);
    expect(await readFile(files[0], 'utf-8')).toBe('From x\n');
    // A second run finds everything in place and rewrites nothing.
    expect(await extractNested(outer, out)).toEqual(files);
  });

  it('refuses entries that climb out of the target directory', () => {
    expect(() => safeEntryPath('/tmp/x', '../etc/passwd')).toThrow('escapes');
    expect(safeEntryPath('/tmp/x', 'a/b.txt')).toBe('/tmp/x/a/b.txt');
  });
});
