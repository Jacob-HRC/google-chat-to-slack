import { describe, expect, it } from 'vitest';
import { toStoredMessage } from '../../services/export-store';
import {
  buildConversationMessages,
  INLINE_FILE_MAX_BYTES,
  type MessageBuildContext,
  SLACK_MAX_FILE_BYTES,
} from '../../services/slack-archive/messages';
import { fallbackText } from '../../services/slack-archive/text';
import { validateArchive } from '../../services/slack-archive/validate';
import type { AttachmentRecord } from '../../types/export-store';
import type {
  ArchiveModel,
  ArchiveUserMapping,
} from '../../types/slack-export';

const USER: ArchiveUserMapping = {
  slackId: 'UAAAAAAAAA1',
  name: 'Pat',
  email: 'pat@hrc.email',
  status: 'active',
  placeholder: false,
  deleted: false,
  importAction: 'merge',
  guest: false,
};

function stored(id: string, time: string, extra: Record<string, unknown> = {}) {
  return toStoredMessage(
    {
      name: `spaces/S/messages/${id}.${id}`,
      sender: { name: 'users/1', type: 'HUMAN' },
      createTime: time,
      text: '',
      ...extra,
    },
    'S',
    'r1',
    '2026-09-25T00:00:00Z'
  );
}

function record(key: string, size: number, name: string): AttachmentRecord {
  return {
    key,
    kind: 'UPLOADED_CONTENT',
    spaceId: 'S',
    messageName: 'spaces/S/messages/m1.m1',
    index: 0,
    status: 'downloaded',
    attempts: 1,
    policy: 'download',
    fileName: name,
    contentName: name,
    contentType: 'application/pdf',
    localPath: `/files/S/m1.m1/${name}`,
    size,
    sha256: 'x',
  } as AttachmentRecord;
}

describe('messages Slack would drop', () => {
  it('turns a bare Google Meet link card into text', () => {
    const meet = stored('m0', '2025-01-01T10:00:00.000001Z', {
      annotations: [
        {
          type: 'RICH_LINK',
          richLinkMetadata: {
            uri: 'https://meet.google.com/ipo-siwt-zjw?hs=146',
            richLinkType: 'MEET_SPACE',
          },
        },
      ],
    });
    expect(fallbackText(meet)).toBe(
      '📹 Google Meet: <https://meet.google.com/ipo-siwt-zjw?hs=146|meet.google.com/ipo-siwt-zjw>'
    );
    expect(fallbackText(stored('m9', '2025-01-01T10:00:00.000001Z'))).toContain(
      'no text or file'
    );
  });

  it('moves a large file onto a companion reply, and refuses files over 1 GB', () => {
    const message = stored('m1', '2025-01-01T10:00:00.000001Z', {
      text: 'drawings attached',
    });
    message.attachmentKeys = ['big', 'small', 'huge'];
    const index = {
      big: record('big', INLINE_FILE_MAX_BYTES + 1, 'Drawings.pdf'),
      small: record('small', 1000, 'note.txt'),
      huge: record('huge', SLACK_MAX_FILE_BYTES + 1, 'Conference.mp4'),
    };
    const ctx: MessageBuildContext = {
      plan: {
        kind: 'dm',
        id: 'D1',
        name: 'D1',
        spaceId: 'S',
        googleName: 'spaces/S',
        googleDisplayName: '',
        spaceType: 'DIRECT_MESSAGE',
        members: ['UAAAAAAAAA1', 'UAAAAAAAAA2'],
        creator: 'UAAAAAAAAA1',
        created: 0,
      },
      users: new Map([['users/1', USER]]),
      attachmentIndex: index,
      options: {
        deletedPolicy: 'tombstone',
        fileStrategy: 'hosted',
        filesBaseUrl: 'https://files.example.com/k',
        filesRoot: '/files',
      },
      uploads: [],
      hostedFiles: [],
      warnings: [],
      fileCounts: { hosted: 0, linkOnly: 0, unavailable: 0 },
    };
    const built = buildConversationMessages([message], ctx);
    const all = Object.values(built.days).flat();
    expect(built.count).toBe(2);
    const [original, companion] = all;
    expect(original.text).toContain('drawings attached');
    expect(original.text).toContain('Conference.mp4');
    expect(original.files?.map((f) => f.name)).toEqual(['note.txt']);
    expect(original.reply_count).toBe(1);
    expect(companion).toMatchObject({
      thread_ts: original.ts,
      user: 'UAAAAAAAAA1',
      text: '📎 Drawings.pdf',
    });
    expect(companion.files?.[0].name).toBe('Drawings.pdf');

    const model = {
      users: [
        { id: 'UAAAAAAAAA1', profile: {} },
        { id: 'UAAAAAAAAA2', profile: {} },
      ],
      channels: [],
      groups: [],
      dms: [],
      mpims: [],
      conversations: [
        {
          plan: ctx.plan,
          days: built.days,
          messageCount: built.count,
          omittedCount: 0,
        },
      ],
    } as unknown as ArchiveModel;
    expect(validateArchive(model).filter((i) => i.level === 'error')).toEqual(
      []
    );
  });
});
