import { describe, expect, it } from 'vitest';
import { mergeMessages, mergeSpace } from '../../services/export-store';
import {
  chooseReaderSubject,
  collectUserRefs,
  dedupeDiscoveredSpaces,
  deriveSpaceName,
  matchesSpaceFilter,
  toStoredReaction,
} from '../../services/workspace-export';
import type { StoredUser } from '../../types/export-store';
import {
  MEMBERSHIPS_DM,
  MEMBERSHIPS_GENERAL,
  MSG_FROM_FORMER_USER,
  REACTIONS_MSG002,
  SPACE_BOT_DM,
  SPACE_DM,
  SPACE_GENERAL,
  SPACE_GROUP,
  USER_FORMER,
  USER_PASTOR,
} from '../fixtures/chat-api';

describe('dedupeDiscoveredSpaces', () => {
  it('exports each space once and remembers every user who can read it', () => {
    const map = dedupeDiscoveredSpaces([
      {
        subject: 'pastor@example.com',
        spaces: [SPACE_GENERAL, SPACE_DM, SPACE_BOT_DM],
      },
      { subject: 'admin@example.com', spaces: [SPACE_GENERAL, SPACE_GROUP] },
      { subject: 'former@example.com', spaces: [SPACE_DM] },
    ]);
    expect(Array.from(map.keys())).toEqual([
      'AAAAgeneral',
      'BBBBdm',
      'DDDDbot',
      'CCCCgroup',
    ]);
    expect(map.get('AAAAgeneral')?.readers).toEqual([
      'pastor@example.com',
      'admin@example.com',
    ]);
    expect(map.get('BBBBdm')?.readers).toEqual([
      'pastor@example.com',
      'former@example.com',
    ]);
    expect(map.get('CCCCgroup')?.readers).toEqual(['admin@example.com']);
  });

  it('ignores spaces without a name', () => {
    expect(dedupeDiscoveredSpaces([{ subject: 'a', spaces: [{}] }]).size).toBe(
      0
    );
  });
});

describe('chooseReaderSubject', () => {
  it('keeps the previous reader when still available, else the first', () => {
    expect(chooseReaderSubject(['a', 'b'], 'b')).toBe('b');
    expect(chooseReaderSubject(['a', 'b'], 'c')).toBe('a');
    expect(chooseReaderSubject(['a', 'b'])).toBe('a');
  });
});

describe('matchesSpaceFilter', () => {
  it('matches by id, resource name or display name, case-insensitively', () => {
    expect(matchesSpaceFilter(SPACE_GENERAL, [])).toBe(true);
    expect(matchesSpaceFilter(SPACE_GENERAL, ['General'])).toBe(true);
    expect(matchesSpaceFilter(SPACE_GENERAL, ['AAAAgeneral'])).toBe(true);
    expect(matchesSpaceFilter(SPACE_GENERAL, ['spaces/AAAAgeneral'])).toBe(
      true
    );
    expect(matchesSpaceFilter(SPACE_GENERAL, ['other'])).toBe(false);
    // DMs have no display name; an empty filter value must not match them.
    expect(matchesSpaceFilter(SPACE_DM, [''])).toBe(false);
    expect(matchesSpaceFilter(SPACE_DM, ['BBBBdm'])).toBe(true);
  });
});

describe('toStoredReaction', () => {
  it('captures the user and emoji', () => {
    expect(toStoredReaction(REACTIONS_MSG002[0])).toMatchObject({
      user: USER_PASTOR,
      emoji: { unicode: '👋' },
    });
    expect(
      toStoredReaction({
        user: { name: USER_PASTOR },
        emoji: { customEmoji: { uid: 'u1', emojiName: ':church:' } },
      }).emoji.customEmoji
    ).toEqual({ uid: 'u1', emojiName: ':church:' });
  });
});

describe('collectUserRefs and deriveSpaceName', () => {
  const now = '2026-09-01T00:00:00.000Z';
  const dm = mergeSpace(undefined, {
    raw: SPACE_DM,
    readers: ['pastor@example.com'],
    readerSubject: 'pastor@example.com',
    memberships: MEMBERSHIPS_DM,
    runId: 'run1',
    now,
  });
  const general = mergeSpace(undefined, {
    raw: SPACE_GENERAL,
    readers: ['pastor@example.com'],
    readerSubject: 'pastor@example.com',
    memberships: MEMBERSHIPS_GENERAL,
    runId: 'run1',
    now,
  });

  it('collects members (not groups), senders, mentions and reactors', () => {
    const refs = new Map();
    collectUserRefs(refs, general, []);
    expect(Array.from(refs.keys())).toEqual([
      'users/100000000000000000001',
      'users/100000000000000000002',
      'users/200000000000000000009',
    ]);
    expect(refs.get('users/200000000000000000009').type).toBe('BOT');
  });

  it('names DMs after their human members and keeps titles for named spaces', () => {
    const users: Record<string, StoredUser> = {
      [USER_PASTOR]: {
        chatUserId: USER_PASTOR,
        fullName: 'Pat Pastor',
        status: 'active',
        isPlaceholder: false,
        sources: [],
        firstSeenRun: 'run1',
      },
      [USER_FORMER]: {
        chatUserId: USER_FORMER,
        status: 'deleted',
        isPlaceholder: true,
        placeholderName: 'Former user 000003',
        sources: [],
        firstSeenRun: 'run1',
      },
    };
    expect(deriveSpaceName(dm, users)).toBe('Former user 000003, Pat Pastor');
    expect(deriveSpaceName(general, users)).toBe('general');
  });

  it('includes senders whose membership is gone (deleted accounts)', () => {
    const soloDm = mergeSpace(undefined, {
      raw: SPACE_DM,
      readers: ['pastor@example.com'],
      readerSubject: 'pastor@example.com',
      memberships: [MEMBERSHIPS_DM[0]],
      runId: 'run1',
      now,
    });
    const users: Record<string, StoredUser> = {
      [USER_PASTOR]: {
        chatUserId: USER_PASTOR,
        fullName: 'Pat Pastor',
        status: 'active',
        isPlaceholder: false,
        sources: [],
        firstSeenRun: 'run1',
      },
    };
    const messages = mergeMessages([], [MSG_FROM_FORMER_USER], 'BBBBdm', {
      runId: 'run1',
      now,
      fetchedIsComplete: true,
    }).messages;
    expect(deriveSpaceName(soloDm, users)).toBe('Pat Pastor');
    expect(deriveSpaceName(soloDm, users, messages)).toBe(
      'Former user 000003, Pat Pastor'
    );
  });
});
