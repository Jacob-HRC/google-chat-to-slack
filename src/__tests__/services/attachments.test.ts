import { describe, expect, it } from 'vitest';
import {
  attachmentFileName,
  attachmentKey,
  buildAttachmentRecords,
  syncAttachments,
  uniquePath,
} from '../../services/attachments';
import { chooseExportFormat, isGoogleNativeMime } from '../../services/drive';
import { toStoredMessage } from '../../services/export-store';
import type { AttachmentRecord } from '../../types/export-store';
import { safeFilename } from '../../utils/fs-atomic';
import { Logger } from '../../utils/logger';
import { MSG_PLAIN, MSG_WITH_ATTACHMENTS } from '../fixtures/chat-api';

const NOW = '2026-09-01T00:00:00.000Z';

describe('buildAttachmentRecords', () => {
  it('indexes uploads, Drive attachments, GIFs and Drive links from text', () => {
    const message = toStoredMessage(
      MSG_WITH_ATTACHMENTS,
      'AAAAgeneral',
      'run1',
      NOW
    );
    const records = buildAttachmentRecords(message, { driveLinks: 'metadata' });
    expect(records.map((r) => [r.key, r.kind, r.policy])).toEqual([
      ['AAAAgeneral/msg003.msg003/upload-0', 'UPLOADED_CONTENT', 'download'],
      ['AAAAgeneral/msg003.msg003/drive-1', 'DRIVE_FILE', 'download'],
      ['AAAAgeneral/msg003.msg003/gif-0', 'ATTACHED_GIF', 'download'],
      ['AAAAgeneral/msg003.msg003/link-0', 'DRIVE_LINK', 'metadata'],
    ]);
    expect(records[0]).toMatchObject({
      resourceName: 'CiQAres1',
      contentName: 'flyer.png',
      contentType: 'image/png',
      senderId: MSG_WITH_ATTACHMENTS.sender?.name,
      status: 'pending',
      attempts: 0,
    });
    expect(records[1].driveFileId).toBe('1SHEETID123');
    // The sheet linked in text is already attached, so only the folder becomes a link record.
    expect(records[3].driveFileId).toBe('1FOLDERID');
  });

  it('downloads linked files when asked', () => {
    const message = toStoredMessage(
      MSG_WITH_ATTACHMENTS,
      'AAAAgeneral',
      'run1',
      NOW
    );
    const records = buildAttachmentRecords(message, { driveLinks: 'download' });
    expect(records.find((r) => r.kind === 'DRIVE_LINK')?.policy).toBe(
      'download'
    );
  });

  it('returns nothing for a plain message', () => {
    const message = toStoredMessage(MSG_PLAIN, 'AAAAgeneral', 'run1', NOW);
    expect(buildAttachmentRecords(message, { driveLinks: 'metadata' })).toEqual(
      []
    );
  });
});

describe('attachmentFileName', () => {
  const base = {
    key: attachmentKey('S', 'M', 'upload', 0),
    kind: 'UPLOADED_CONTENT' as const,
    spaceId: 'S',
    messageName: 'spaces/S/messages/M',
    index: 0,
    policy: 'download' as const,
    status: 'pending' as const,
    attempts: 0,
  };

  it('uses the original name and adds an extension from the MIME type when missing', () => {
    expect(
      attachmentFileName({
        ...base,
        contentName: 'flyer.png',
        contentType: 'image/png',
      })
    ).toBe('flyer.png');
    expect(
      attachmentFileName({
        ...base,
        contentName: 'photo',
        contentType: 'image/jpeg',
      })
    ).toBe('photo.jpg');
    expect(
      attachmentFileName({ ...base, contentType: 'application/pdf' })
    ).toBe('uploaded_content-0.pdf');
  });

  it('prefers the Drive name and strips unsafe characters', () => {
    expect(
      attachmentFileName({
        ...base,
        kind: 'DRIVE_FILE',
        contentName: 'ignored',
        drive: {
          id: 'x',
          name: 'Q1/Q2: Budget?.xlsx',
          mimeType:
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          fetchedAt: NOW,
          fetchedBy: 'a@example.com',
        },
      })
    ).toBe('Q1_Q2_ Budget_.xlsx');
  });
});

describe('safeFilename', () => {
  it('falls back for empty or dot names and caps length', () => {
    expect(safeFilename('', 'fallback')).toBe('fallback');
    expect(safeFilename('..', 'fallback')).toBe('fallback');
    const long = `${'a'.repeat(200)}.png`;
    const result = safeFilename(long, 'x');
    expect(result.length).toBeLessThanOrEqual(150);
    expect(result.endsWith('.png')).toBe(true);
  });
});

describe('chooseExportFormat', () => {
  it('maps Google-native types to Office or PDF', () => {
    expect(
      chooseExportFormat('application/vnd.google-apps.document', 'office')
        ?.extension
    ).toBe('.docx');
    expect(
      chooseExportFormat('application/vnd.google-apps.spreadsheet', 'office')
        ?.extension
    ).toBe('.xlsx');
    expect(
      chooseExportFormat('application/vnd.google-apps.presentation', 'pdf')
        ?.extension
    ).toBe('.pdf');
    expect(
      chooseExportFormat('application/vnd.google-apps.folder', 'office')
    ).toBeUndefined();
    expect(
      chooseExportFormat('application/vnd.google-apps.form', 'pdf')
    ).toBeUndefined();
    expect(chooseExportFormat('image/png', 'office')).toBeUndefined();
  });

  it('detects native types', () => {
    expect(isGoogleNativeMime('application/vnd.google-apps.document')).toBe(
      true
    );
    expect(isGoogleNativeMime('image/png')).toBe(false);
    expect(isGoogleNativeMime(undefined)).toBe(false);
  });
});

describe('attachment paths', () => {
  it('never lets two different files share a path', () => {
    const claims = new Map([['/f/msg/image.png', 'media/A']]);
    expect(uniquePath('/f/msg/image.png', 'media/B', claims)).toBe(
      '/f/msg/image (2).png'
    );
    claims.set('/f/msg/image (2).png', 'media/B');
    expect(uniquePath('/f/msg/image.png', 'media/C', claims)).toBe(
      '/f/msg/image (3).png'
    );
    // The same file may keep the path it already has.
    expect(uniquePath('/f/msg/image.png', 'media/A', claims)).toBe(
      '/f/msg/image.png'
    );
    expect(uniquePath('/f/msg/Budget', 'drive/X', new Map())).toBe(
      '/f/msg/Budget'
    );
  });
});

describe('syncAttachments saving', () => {
  // The real index runs to hundreds of MB, so a save with no work is costly.
  const message = toStoredMessage(
    MSG_WITH_ATTACHMENTS,
    'AAAAgeneral',
    'run1',
    NOW
  );
  const linkOnly: AttachmentRecord = {
    ...buildAttachmentRecords(message, { driveLinks: 'metadata' })[3],
    status: 'link-only',
  };

  function noReader(): string | undefined {
    return;
  }

  function run(keys: string[]): Promise<number> {
    let saves = 0;
    return syncAttachments({ [linkOnly.key]: linkOnly }, keys, {
      filesDir: '/nonexistent',
      readerSubject: 'reader@example.com',
      subjectForUser: noReader,
      memberSubjects: [],
      driveExportFormat: 'office',
      logger: new Logger('test'),
      save: () => {
        saves += 1;
        return Promise.resolve();
      },
    }).then(() => saves);
  }

  it('does not save when there is nothing to process', async () => {
    expect(await run([])).toBe(0);
    expect(await run(['AAAAgeneral/unknown/upload-0'])).toBe(0);
  });

  it('saves once after processing records', async () => {
    expect(await run([linkOnly.key])).toBe(1);
  });
});
