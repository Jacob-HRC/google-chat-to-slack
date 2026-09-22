import { describe, expect, it } from 'vitest';
import type { DomainUser } from '../../services/directory';
import {
  addUserRef,
  type ChatUserRef,
  directoryIdOf,
  displayNameOf,
  placeholderName,
  resolveChatUsers,
} from '../../services/user-resolver';
import type { StoredUser } from '../../types/export-store';
import {
  USER_ADMIN,
  USER_BOT,
  USER_FORMER,
  USER_PASTOR,
} from '../fixtures/chat-api';

const directory: Record<string, DomainUser> = {
  '100000000000000000001': {
    id: '100000000000000000001',
    email: 'pastor@example.com',
    fullName: 'Pat Pastor',
    suspended: false,
    archived: false,
    orgUnitPath: '/Staff',
  },
  '100000000000000000002': {
    id: '100000000000000000002',
    email: 'admin@example.com',
    fullName: 'Alex Admin',
    suspended: true,
    archived: false,
    orgUnitPath: '/Staff',
  },
};

const lookup = (id: string): Promise<DomainUser | undefined> => {
  if (id === 'boom') {
    return Promise.reject(new Error('Directory unavailable'));
  }
  return Promise.resolve(directory[id]);
};

const options = { runId: 'run1', now: '2026-09-01T00:00:00.000Z' };

function refs(
  ...entries: [string, Partial<ChatUserRef>][]
): Map<string, ChatUserRef> {
  const map = new Map<string, ChatUserRef>();
  for (const [id, extra] of entries) {
    addUserRef(map, id, 'sender', extra);
  }
  return map;
}

describe('addUserRef', () => {
  it('merges sources and fills gaps without overwriting', () => {
    const map = new Map<string, ChatUserRef>();
    addUserRef(map, USER_PASTOR, 'sender', { type: 'HUMAN' });
    addUserRef(map, USER_PASTOR, 'mention', { displayName: 'Pat' });
    addUserRef(map, undefined, 'reaction');
    expect(map.size).toBe(1);
    const ref = map.get(USER_PASTOR);
    expect(Array.from(ref?.sources ?? [])).toEqual(['sender', 'mention']);
    expect(ref?.displayName).toBe('Pat');
  });
});

describe('resolveChatUsers', () => {
  it('resolves active and suspended users from the directory', async () => {
    const users = await resolveChatUsers(
      refs([USER_PASTOR, { type: 'HUMAN' }], [USER_ADMIN, { type: 'HUMAN' }]),
      {},
      lookup,
      options
    );
    expect(users[USER_PASTOR]).toMatchObject({
      email: 'pastor@example.com',
      fullName: 'Pat Pastor',
      status: 'active',
      isPlaceholder: false,
      directoryId: '100000000000000000001',
    });
    expect(users[USER_ADMIN].status).toBe('suspended');
    expect(users[USER_PASTOR].sources).toEqual(['sender', 'directory']);
  });

  it('creates a placeholder for deleted users and keeps their chat display name', async () => {
    const users = await resolveChatUsers(
      refs([USER_FORMER, { type: 'HUMAN', displayName: 'Fran Former' }]),
      {},
      lookup,
      options
    );
    expect(users[USER_FORMER]).toMatchObject({
      status: 'deleted',
      isPlaceholder: true,
      placeholderName: 'Fran Former',
      directoryId: '100000000000000000003',
    });
  });

  it('ignores Google\'s generic "Deleted User" label so placeholders stay distinct', async () => {
    const users = await resolveChatUsers(
      refs([USER_FORMER, { type: 'HUMAN', displayName: 'Deleted User' }]),
      {},
      lookup,
      options
    );
    expect(users[USER_FORMER].placeholderName).toBe('Former user 000003');
    expect(users[USER_FORMER].fullName).toBeUndefined();
    expect(users[USER_FORMER].chatDisplayName).toBe('Deleted User');
  });

  it('labels bots and external users without a directory lookup', async () => {
    const users = await resolveChatUsers(
      refs(
        [USER_BOT, { type: 'BOT' }],
        [
          'users/300000000000000000005',
          { type: 'HUMAN', affiliation: 'EXTERNAL' },
        ]
      ),
      {},
      lookup,
      options
    );
    expect(users[USER_BOT]).toMatchObject({
      status: 'bot',
      isPlaceholder: true,
    });
    expect(users[USER_BOT].placeholderName).toBe('Bot 000009');
    expect(users['users/300000000000000000005']).toMatchObject({
      status: 'external',
      placeholderName: 'External user 000005',
    });
  });

  it('records lookup failures as unknown and retries them next time', async () => {
    const first = await resolveChatUsers(
      refs(['users/boom', {}]),
      {},
      lookup,
      options
    );
    expect(first['users/boom']).toMatchObject({
      status: 'unknown',
      error: 'Directory unavailable',
    });

    const fixedLookup = (): Promise<DomainUser> =>
      Promise.resolve(directory['100000000000000000001']);
    const second = await resolveChatUsers(
      refs(['users/boom', {}]),
      first,
      fixedLookup,
      {
        ...options,
        runId: 'run2',
      }
    );
    expect(second['users/boom'].status).toBe('active');
  });

  it('reuses previously resolved users unless refresh is requested', async () => {
    let calls = 0;
    const counting = (id: string): Promise<DomainUser | undefined> => {
      calls += 1;
      return Promise.resolve(directory[id]);
    };
    const existing: Record<string, StoredUser> = {
      [USER_PASTOR]: {
        chatUserId: USER_PASTOR,
        email: 'old@example.com',
        fullName: 'Old Name',
        status: 'active',
        isPlaceholder: false,
        sources: ['sender'],
        firstSeenRun: 'run0',
      },
    };
    const kept = await resolveChatUsers(
      refs([USER_PASTOR, {}]),
      existing,
      counting,
      options
    );
    expect(calls).toBe(0);
    expect(kept[USER_PASTOR].fullName).toBe('Old Name');

    const refreshed = await resolveChatUsers(
      refs([USER_PASTOR, {}]),
      existing,
      counting,
      {
        ...options,
        refresh: true,
      }
    );
    expect(calls).toBe(1);
    expect(refreshed[USER_PASTOR].fullName).toBe('Pat Pastor');
    expect(refreshed[USER_PASTOR].firstSeenRun).toBe('run0');
  });
});

describe('names', () => {
  it('builds placeholder names from the id suffix', () => {
    expect(placeholderName(USER_FORMER, 'deleted')).toBe('Former user 000003');
    expect(directoryIdOf(USER_FORMER)).toBe('100000000000000000003');
  });

  it('picks the best available display name', () => {
    expect(displayNameOf(undefined, USER_FORMER)).toBe('Former user 000003');
    expect(
      displayNameOf(
        {
          chatUserId: USER_FORMER,
          status: 'deleted',
          isPlaceholder: true,
          placeholderName: 'Fran Former',
          sources: [],
          firstSeenRun: 'r',
        },
        USER_FORMER
      )
    ).toBe('Fran Former');
  });
});
