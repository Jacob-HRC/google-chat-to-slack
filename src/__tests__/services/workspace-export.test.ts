import { describe, expect, it } from 'vitest';
import { mergeMessages, mergeSpace } from '../../services/export-store';
import {
  chooseReaderSubject,
  collectUserRefs,
  dedupeDiscoveredSpaces,
  deriveSpaceName,
  isInactiveSince,
  listingCutoff,
  matchesSpaceFilter,
  toStoredReaction,
} from '../../services/workspace-export';
import type {
  SpaceSyncState,
  StoredSpace,
  StoredUser,
} from '../../types/export-store';
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

describe('isInactiveSince', () => {
  const since = '2026-09-24T12:40:00Z';
  const counts = { joinedDirectHumanUserCount: 3, joinedGroupCount: 0 };
  const listed = {
    ...SPACE_GENERAL,
    lastActiveTime: '2026-09-01T10:00:00.123456Z',
    membershipCount: counts,
  };
  const existing = {
    ...mergeSpace(undefined, {
      raw: { ...SPACE_GENERAL, membershipCount: { ...counts } },
      readers: ['pastor@example.com'],
      readerSubject: 'pastor@example.com',
      memberships: MEMBERSHIPS_GENERAL,
      runId: 'run1',
      now: '2026-09-24T00:00:00.000Z',
    }),
  } as StoredSpace;
  const complete = {
    status: 'complete',
    lastFullListingAt: '2026-09-24T21:49:00.000Z',
    maxCreateTime: '2026-09-01T10:00:00.123456Z',
  } as SpaceSyncState;
  const check = (
    overrides: Partial<Parameters<typeof isInactiveSince>[0]>
  ): boolean =>
    isInactiveSince({
      raw: listed,
      existing,
      state: complete,
      since,
      hasRetryableAttachments: false,
      ...overrides,
    });

  it('skips a stored conversation with no activity and the same members', () => {
    expect(check({})).toBe(true);
    // The listing filter is createTime > since, so activity exactly at the
    // cutoff has nothing to list.
    expect(check({ raw: { ...listed, lastActiveTime: since } })).toBe(true);
    // Offsets compare by instant: 07:40-05:00 is 12:40Z.
    expect(
      check({
        raw: { ...listed, lastActiveTime: '2026-09-24T07:39:00-05:00' },
      })
    ).toBe(true);
  });

  it('syncs anything that may have changed or is not safely stored', () => {
    expect(
      check({ raw: { ...listed, lastActiveTime: '2026-10-01T09:00:00Z' } })
    ).toBe(false);
    expect(check({ raw: { ...listed, lastActiveTime: undefined } })).toBe(
      false
    );
    expect(
      check({
        raw: {
          ...listed,
          membershipCount: { ...counts, joinedDirectHumanUserCount: 4 },
        },
      })
    ).toBe(false);
    expect(check({ raw: { ...listed, membershipCount: undefined } })).toBe(
      false
    );
    expect(
      check({
        raw: { ...listed, membershipCount: { ...counts, joinedGroupCount: 1 } },
      })
    ).toBe(false);
    expect(
      check({ raw: { ...listed, lastActiveTime: '2026-09-24T07:41:00-05:00' } })
    ).toBe(false);
    expect(check({ existing: undefined })).toBe(false);
    // Members never fetched: the count can't be trusted.
    expect(check({ existing: { ...existing, memberships: [] } })).toBe(false);
    expect(check({ hasRetryableAttachments: true })).toBe(false);
    // Never listed in full: a since run stored only part of its history.
    expect(
      check({ state: { ...complete, lastFullListingAt: undefined } })
    ).toBe(false);
    // Stored messages inside the window are re-listed for edits and deletions.
    expect(
      check({ state: { ...complete, maxCreateTime: '2026-10-01T00:00:00Z' } })
    ).toBe(false);
    expect(check({ existing: { ...existing, source: 'vault' } })).toBe(false);
    expect(check({ state: undefined })).toBe(false);
    expect(
      check({ state: { status: 'messages-synced' } as SpaceSyncState })
    ).toBe(false);
  });
});

describe('listingCutoff', () => {
  const since = '2026-09-24T12:40:00Z';
  const state = (patch: Partial<SpaceSyncState>): SpaceSyncState =>
    ({
      status: 'complete',
      lastFullListingAt: '2026-09-01T00:00:00.000Z',
      ...patch,
    }) as SpaceSyncState;

  it('lists everything without a cutoff or a full listing on record', () => {
    expect(listingCutoff(undefined, state({}))).toBeUndefined();
    expect(
      listingCutoff(since, state({ lastFullListingAt: undefined }))
    ).toBeUndefined();
  });

  it('uses the cutoff when the last listing came after it', () => {
    expect(
      listingCutoff(
        since,
        state({ lastMessagesSyncAt: '2026-10-19T14:00:00Z' })
      )
    ).toBe(since);
  });

  it('starts an hour before the last listing when that came before the cutoff', () => {
    expect(
      listingCutoff(
        since,
        state({ lastMessagesSyncAt: '2026-08-01T10:00:00Z' })
      )
    ).toBe('2026-08-01T09:00:00.000Z');
    // Older states may only have the full-listing time.
    expect(listingCutoff(since, state({}))).toBe('2026-08-31T23:00:00.000Z');
  });
});
