import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { chat_v1 } from 'googleapis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type BuildArchiveOptions,
  buildArchiveModel,
} from '../../services/slack-archive/builder';
import type { MeetingChatMode } from '../../services/slack-archive/meeting-chats';
import {
  headerTs,
  meetingSeries,
  memberKey,
} from '../../services/slack-archive/meeting-chats';
import { validateArchive } from '../../services/slack-archive/validate';
import type { ArchiveModel } from '../../types/slack-export';
import { USER_ADMIN, USER_PASTOR } from '../fixtures/chat-api';
import {
  addFixtureSpace,
  createFixtureStore,
  USER_KEN,
} from '../helpers/store-fixture';

function meeting(
  id: string,
  name: string,
  created: string
): chat_v1.Schema$Space {
  return {
    name: `spaces/${id}`,
    displayName: name,
    spaceType: 'SPACE',
    spaceThreadingState: 'UNTHREADED_MESSAGES',
    createTime: created,
    spaceUri: `https://chat.google.com/room/${id}?cls=11`,
  };
}

function message(
  spaceId: string,
  id: string,
  sender: string,
  time: string,
  text: string
): chat_v1.Schema$Message {
  return {
    name: `spaces/${spaceId}/messages/${id}.${id}`,
    sender: { name: sender, type: 'HUMAN' },
    createTime: time,
    text,
    formattedText: text,
    thread: { name: `spaces/${spaceId}/threads/${id}` },
  };
}

describe('meeting chats', () => {
  let dir: string;

  beforeAll(async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'gcts-meet-'));
    await createFixtureStore(base);
    dir = `${base}-copy`;
    await cp(base, dir, { recursive: true });
    await rm(base, { recursive: true, force: true });
    // Same three people as the fixture's group chat.
    await addFixtureSpace(
      dir,
      meeting(
        'MEET0sync',
        'Pastor/Ken/Admin Sync - Feb 2',
        '2025-02-02T15:00:00Z'
      ),
      [USER_PASTOR, USER_KEN, USER_ADMIN],
      [
        message(
          'MEET0sync',
          'm1',
          USER_PASTOR,
          '2025-02-02T15:01:00.000001Z',
          'agenda?'
        ),
        message(
          'MEET0sync',
          'm2',
          USER_KEN,
          '2025-02-02T15:02:00.000001Z',
          'budget first'
        ),
      ]
    );
    // Two people with no DM yet.
    await addFixtureSpace(
      dir,
      meeting('MEET0oneone', 'Pastor/Ken 1:1 - Apr 1', '2025-04-01T15:00:00Z'),
      [USER_PASTOR, USER_KEN],
      [
        message(
          'MEET0oneone',
          'm3',
          USER_KEN,
          '2025-04-01T15:05:00.000001Z',
          'notes'
        ),
      ]
    );
    // One person, a recurring series.
    for (const [id, day] of [
      ['MEET0staffa', 'Mar 3'],
      ['MEET0staffb', 'Mar 10'],
    ]) {
      // biome-ignore lint/nursery/noAwaitInLoop: fixture setup.
      await addFixtureSpace(
        dir,
        meeting(
          id,
          `Staff meeting - ${day}`,
          `2025-03-${day === 'Mar 3' ? '03' : '10'}T15:00:00Z`
        ),
        [USER_PASTOR],
        [
          message(
            id,
            `x${id}`,
            USER_PASTOR,
            `2025-03-${day === 'Mar 3' ? '03' : '10'}T15:10:00.000001Z`,
            'link to slides'
          ),
        ]
      );
    }
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const build = (meetingChats: MeetingChatMode): Promise<ArchiveModel> => {
    const options: BuildArchiveOptions = {
      storeDir: dir,
      teamId: 'T1',
      spaceFilter: [],
      skipBotDms: true,
      spaceVisibility: 'private',
      deletedPolicy: 'tombstone',
      fileStrategy: 'manifest',
      overrides: {},
      meetingChats,
    };
    return buildArchiveModel(options);
  };

  it('names series and keys member sets', () => {
    expect(meetingSeries('Sheila/Kelly TouchPoint - Feb 2')).toBe(
      'Sheila/Kelly TouchPoint'
    );
    expect(meetingSeries('No date here')).toBe('No date here');
    expect(memberKey(['b', 'a', 'b'])).toBe('a,b');
    expect(headerTs('100.000005', new Set(['100.000004']))).toBe('100.000003');
  });

  it('fold: files each meeting with its people, one thread per meeting', async () => {
    const model = await build('fold');
    expect(validateArchive(model).filter((i) => i.level === 'error')).toEqual(
      []
    );

    const group = model.conversations.find((c) => c.plan.kind === 'mpim');
    const messages = Object.values(group?.days ?? {}).flat();
    const header = messages.find((m) => m.username === 'Google Meet');
    expect(header?.text).toBe(
      '📅 Pastor/Ken/Admin Sync - Feb 2 (Google Meet chat)'
    );
    expect(header?.reply_count).toBe(2);
    const replies = messages.filter(
      (m) => m.thread_ts === header?.ts && m.ts !== header?.ts
    );
    expect(replies.map((m) => m.text)).toEqual(['agenda?', 'budget first']);

    const series = model.conversations.find(
      (c) => c.plan.name === 'mtg-staff-meeting'
    );
    const seriesHeaders = Object.values(series?.days ?? {})
      .flat()
      .filter((m) => m.username === 'Google Meet');
    expect(seriesHeaders).toHaveLength(2);

    const oneOnOne = model.conversations.filter((c) => c.plan.kind === 'dm');
    expect(oneOnOne.some((c) => c.messageCount === 2)).toBe(true);
    expect(model.manifest.conversations.MEET0sync.mergedInto).toBe(
      group?.plan.name
    );
  });

  it('channels: one private channel per meeting', async () => {
    const model = await build('channels');
    const names = model.groups.map((g) => g.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'pastor-ken-admin-sync-feb-2',
        'pastor-ken-1-1-apr-1',
        'staff-meeting-mar-3',
        'staff-meeting-mar-10',
      ])
    );
  });

  it('discard: leaves them out and says so', async () => {
    const folded = await build('fold');
    const model = await build('discard');
    expect(model.manifest.conversations.MEET0sync.skippedReason).toContain(
      'Google Meet chat'
    );
    expect(model.manifest.totals.messages).toBe(
      folded.manifest.totals.messages - 4 - 5
    );
  });
});
