import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildAttachmentRecords } from '../../services/attachments';
import {
  attachmentsFilesDir,
  mergeMessages,
  mergeSpace,
  openStore,
  saveAttachmentIndex,
  saveMessages,
  saveSpace,
} from '../../services/export-store';
import { verifyExportStore } from '../../services/export-verify';
import type { AttachmentRecord } from '../../types/export-store';
import { digestFile } from '../../utils/fs-atomic';
import { Logger } from '../../utils/logger';
import {
  MEMBERSHIPS_GENERAL,
  MSG_PLAIN,
  MSG_WITH_ATTACHMENTS,
  SPACE_GENERAL,
} from '../fixtures/chat-api';

const NOW = '2026-09-01T00:00:00.000Z';

describe('verifyExportStore (offline)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'gcts-verify-'));
    const store = await openStore(dir);
    await saveSpace(
      store,
      mergeSpace(undefined, {
        raw: SPACE_GENERAL,
        readers: ['a@example.com'],
        readerSubject: 'a@example.com',
        memberships: MEMBERSHIPS_GENERAL,
        runId: 'run1',
        now: NOW,
      })
    );
    const { messages } = mergeMessages(
      [],
      [MSG_PLAIN, MSG_WITH_ATTACHMENTS],
      'AAAAgeneral',
      { runId: 'run1', now: NOW, fetchedIsComplete: true }
    );
    const index: Record<string, AttachmentRecord> = {};
    for (const message of messages) {
      for (const record of buildAttachmentRecords(message, {
        driveLinks: 'metadata',
      })) {
        index[record.key] = record;
        message.attachmentKeys.push(record.key);
      }
    }
    const filePath = path.join(attachmentsFilesDir(dir), 'flyer.png');
    await writeFile(filePath, 'PNG', { encoding: 'utf-8', flag: 'w' }).catch(
      async () => {
        const { mkdir } = await import('node:fs/promises');
        await mkdir(path.dirname(filePath), { recursive: true });
        await writeFile(filePath, 'PNG');
      }
    );
    const digest = await digestFile(filePath);
    index['AAAAgeneral/msg003.msg003/upload-0'] = {
      ...index['AAAAgeneral/msg003.msg003/upload-0'],
      status: 'downloaded',
      localPath: filePath,
      sha256: digest.sha256,
      size: digest.size,
    };
    index['AAAAgeneral/msg003.msg003/drive-1'] = {
      ...index['AAAAgeneral/msg003.msg003/drive-1'],
      status: 'failed',
      attempts: 3,
      error: 'File not found',
    };
    index['AAAAgeneral/msg003.msg003/link-0'] = {
      ...index['AAAAgeneral/msg003.msg003/link-0'],
      status: 'link-only',
    };
    await saveMessages(store, 'AAAAgeneral', messages);
    await saveAttachmentIndex(store, index);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reports failed and pending records and includes attachments when filtering by display name', async () => {
    const report = await verifyExportStore(
      { outputDir: dir, live: false, files: true, spaceFilter: ['general'] },
      new Logger('Verify')
    );
    expect(report.spaces).toHaveLength(1);
    expect(report.spaces[0].stored).toEqual({
      total: 2,
      deleted: 0,
      missing: 0,
      active: 2,
    });
    expect(report.attachments).toMatchObject({
      records: 4,
      verified: 1,
      linkOnly: 1,
      pending: 1,
      failed: 1,
      missingFile: 0,
      hashMismatch: 0,
    });
    expect(report.attachments.issues[0]).toContain('File not found');
    expect(report.ok).toBe(false);
  });

  it('excludes everything when the filter matches no space', async () => {
    const report = await verifyExportStore(
      { outputDir: dir, live: false, files: false, spaceFilter: ['nope'] },
      new Logger('Verify')
    );
    expect(report.spaces).toHaveLength(0);
    expect(report.attachments.records).toBe(0);
  });
});
