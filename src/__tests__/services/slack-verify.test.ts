import { describe, expect, it } from 'vitest';
import type {
  SlackMember,
  SlackMemberSnapshot,
} from '../../services/slack-archive/slack-members';
import {
  type DestinationDirectory,
  mapArchiveUsers,
  resolveDestination,
} from '../../services/slack-destination';
import {
  compareConversation,
  compareMembers,
} from '../../services/slack-verify';
import type {
  ArchiveUserMapping,
  MessageIndexConversation,
} from '../../types/slack-export';

function member(
  id: string,
  email: string,
  extra: Partial<SlackMember> = {}
): SlackMember {
  return {
    id,
    name: email.split('@')[0],
    realName: email.split('@')[0],
    email,
    deleted: false,
    isBot: false,
    isGuest: false,
    ...extra,
  };
}

function snapshot(members: SlackMember[]): SlackMemberSnapshot {
  return {
    fetchedAt: '2026-09-23T00:00:00Z',
    teamId: 'T1',
    teamName: 'HRC',
    teamDomain: 'hrc',
    members,
  };
}

function mapping(
  slackId: string,
  email: string | undefined,
  importAction: ArchiveUserMapping['importAction'],
  slackMemberId?: string
): ArchiveUserMapping {
  return {
    slackId,
    name: slackId,
    email,
    status: 'active',
    placeholder: false,
    deleted: importAction !== 'merge',
    importAction,
    slackMemberId,
    guest: false,
  };
}

const JACOB = member('UJACOB', 'jacob@hrc.email');
const KEN = member('UKEN', 'ken@hrc.email');
const BEFORE = snapshot([JACOB, KEN]);
const USERS: Record<string, ArchiveUserMapping> = {
  'users/1': mapping('UA1', 'jacob@hrc.email', 'merge', 'UJACOB'),
  'users/2': mapping('UA2', 'ken@hrc.email', 'merge', 'UKEN'),
  'users/3': mapping('UA3', 'pat@hrc.email', 'deactivated'),
  'users/4': mapping('UA4', undefined, 'no-email'),
};

describe('compareMembers', () => {
  it('passes when existing members are untouched and new ones are deactivated', () => {
    const after = snapshot([
      JACOB,
      KEN,
      member('UPAT', 'pat@hrc.email', { deleted: true }),
    ]);
    const report = compareMembers(BEFORE, after, USERS);
    expect(report.changed).toEqual([]);
    expect(report.vanished).toEqual([]);
    expect(report.newActive).toEqual([]);
    expect(report.newDeactivated).toBe(1);
    expect(report.people.every((p) => p.ok)).toBe(true);
    expect(report.people.find((p) => p.archiveId === 'UA3')?.actual).toBe(
      'created-deactivated'
    );
  });

  it('catches an overwritten profile, an active new account and a missed merge', () => {
    const after = snapshot([
      JACOB,
      { ...KEN, realName: 'Kenneth' },
      member('UPAT', 'pat@hrc.email'),
    ]);
    const report = compareMembers(BEFORE, after, USERS);
    expect(report.changed).toEqual([
      {
        id: 'UKEN',
        email: 'ken@hrc.email',
        field: 'realName',
        before: 'ken',
        after: 'Kenneth',
      },
    ]);
    expect(report.newActive.map((m) => m.id)).toEqual(['UPAT']);
    const pat = report.people.find((p) => p.archiveId === 'UA3');
    expect(pat).toMatchObject({ actual: 'created-active', ok: false });
  });

  it('flags a merge that landed on a different account', () => {
    const users = {
      'users/1': mapping('UA1', 'jacob@hrc.email', 'merge', 'UOTHER'),
    };
    const report = compareMembers(BEFORE, BEFORE, users);
    expect(report.people[0]).toMatchObject({ actual: 'merged', ok: false });
  });
});

const DM: MessageIndexConversation = {
  spaceId: 'AAAA',
  kind: 'dm',
  name: 'DARCHIVE01',
  archiveId: 'DARCHIVE01',
  members: ['UA1', 'UA2'],
  messages: [
    { ts: '1.000001' },
    { ts: '2.000001', fileSizes: [10, 20] },
    { ts: '3.000001', threadTs: '1.000001' },
  ],
};

describe('compareConversation', () => {
  it('matches when every ts, thread and file size is present', () => {
    const report = compareConversation(
      DM,
      [
        { ts: '1.000001', fileSizes: [] },
        { ts: '2.000001', fileSizes: [20, 10] },
        { ts: '3.000001', threadTs: '1.000001', fileSizes: [] },
      ],
      'D1'
    );
    expect(report.status).toBe('match');
  });

  it('reports missing messages, broken files, lost threads and extras', () => {
    const report = compareConversation(
      DM,
      [
        { ts: '2.000001', fileSizes: [10, 1234] },
        { ts: '3.000001', fileSizes: [] },
        { ts: '9.000001', fileSizes: [] },
      ],
      'D1'
    );
    expect(report).toMatchObject({
      status: 'mismatch',
      missing: ['1.000001'],
      extra: ['9.000001'],
      unthreaded: ['3.000001'],
    });
    expect(report.fileProblems[0]).toContain('expected sizes 10,20');
  });
});

describe('resolveDestination', () => {
  const after = snapshot([
    JACOB,
    KEN,
    member('UPAT', 'pat@hrc.email', { deleted: true }),
  ]);
  const directory: DestinationDirectory = {
    slackUserIds: mapArchiveUsers(USERS, after),
    botChannels: [
      { id: 'C1', name: 'general-2', isPrivate: false, isMember: false },
      { id: 'G1', name: 'staff', isPrivate: true, isMember: true },
    ],
    userChannels: [],
    userDms: [
      {
        id: 'D1',
        isPrivate: true,
        isMember: true,
        members: ['UKEN', 'UJACOB'],
      },
    ],
    userSelfId: 'UJACOB',
  };

  it('maps archive ids to real accounts by email', () => {
    expect(directory.slackUserIds.get('UA3')).toBe('UPAT');
    expect(directory.slackUserIds.has('UA4')).toBe(false);
  });

  it('finds channels by name and your own DMs by members', () => {
    const channel = (name: string, kind: 'channel' | 'group') =>
      resolveDestination({ ...DM, kind, name, members: [] }, directory);
    expect(channel('general-2', 'channel')).toEqual({
      channelId: 'C1',
      via: 'bot',
      needsJoin: true,
    });
    expect(channel('staff', 'group')).toMatchObject({ channelId: 'G1' });
    expect(channel('secret', 'group').unreachable).toContain('invite');
    expect(resolveDestination(DM, directory)).toEqual({
      channelId: 'D1',
      via: 'user',
    });
  });

  it("never claims to reach someone else's DM", () => {
    const theirs = { ...DM, members: ['UA2', 'UA3'] };
    expect(resolveDestination(theirs, directory).unreachable).toContain(
      "another person's DM"
    );
    const noAddress = { ...DM, members: ['UA1', 'UA4'] };
    expect(resolveDestination(noAddress, directory).unreachable).toContain(
      'no Slack account'
    );
  });
});
