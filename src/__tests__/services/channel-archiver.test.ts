import type { WebClient } from '@slack/web-api';
import { describe, expect, it } from 'vitest';
import {
  archiveAsMember,
  archivePublicChannel,
  archiveTargets,
  type ConnectedMember,
  createdByImport,
  pickArchivers,
} from '../../services/channel-archiver';
import type {
  ArchiveConversationMapping,
  ArchiveManifest,
} from '../../types/slack-export';

function conversation(
  name: string,
  kind: ArchiveConversationMapping['kind'],
  extra: Partial<ArchiveConversationMapping> = {}
): ArchiveConversationMapping {
  return {
    kind,
    id: `X${name}`,
    name,
    googleName: `spaces/${name}`,
    spaceType: 'SPACE',
    members: [],
    messages: 1,
    omitted: 0,
    days: 1,
    ...extra,
  };
}

describe('archive-channels', () => {
  it('picks only channels marked for archiving, and says which are private', () => {
    const manifest = {
      conversations: {
        A: conversation('old-team', 'channel', { archiveAfterImport: true }),
        B: conversation('old-finance', 'group', { archiveAfterImport: true }),
        C: conversation('staff-all', 'channel'),
        D: conversation('gone', 'group', {
          archiveAfterImport: true,
          skippedReason: 'empty',
        }),
      },
    } as unknown as ArchiveManifest;
    expect(archiveTargets(manifest)).toEqual([
      { spaceId: 'B', name: 'old-finance', isPrivate: true },
      { spaceId: 'A', name: 'old-team', isPrivate: false },
    ]);
  });

  it('joins before archiving and treats already-archived as done', async () => {
    const calls: string[] = [];
    let archiveError: string | undefined;
    const bot = {
      conversations: {
        join: ({ channel }: { channel: string }) => {
          calls.push(`join:${channel}`);
          return Promise.resolve({ ok: true });
        },
        archive: ({ channel }: { channel: string }) => {
          calls.push(`archive:${channel}`);
          return archiveError
            ? Promise.reject({ data: { error: archiveError } })
            : Promise.resolve({ ok: true });
        },
      },
    } as unknown as WebClient;
    expect(
      await archivePublicChannel(bot, {
        id: 'C1',
        isArchived: false,
        created: 0,
      })
    ).toBe('archived');
    expect(calls).toEqual(['join:C1', 'archive:C1']);
    expect(
      await archivePublicChannel(bot, {
        id: 'C2',
        isArchived: true,
        created: 0,
      })
    ).toBe('already');
    archiveError = 'already_archived';
    expect(
      await archivePublicChannel(bot, {
        id: 'C3',
        isArchived: false,
        created: 0,
      })
    ).toBe('already');
    archiveError = 'missing_scope';
    expect(
      await archivePublicChannel(bot, {
        id: 'C4',
        isArchived: false,
        created: 0,
      })
    ).toBe('failed');
  });

  it('picks the first connected member of each private channel', () => {
    const ken = { slackId: 'U_KEN' } as ConnectedMember;
    const amy = { slackId: 'U_AMY' } as ConnectedMember;
    const picked = pickArchivers(
      ['old-finance', 'old-hr', 'nobody-here'],
      [
        {
          person: ken,
          channels: new Map([
            ['old-finance', { id: 'G1', isArchived: false, created: 0 }],
          ]),
        },
        {
          person: amy,
          channels: new Map([
            ['old-finance', { id: 'G1', isArchived: false, created: 0 }],
            ['old-hr', { id: 'G2', isArchived: true, created: 0 }],
          ]),
        },
      ]
    );
    expect(
      [...picked].map(([name, c]) => [name, c.person.slackId, c.channel.id])
    ).toEqual([
      ['old-finance', 'U_KEN', 'G1'],
      ['old-hr', 'U_AMY', 'G2'],
    ]);
  });

  it("archives with the member's token without joining", async () => {
    const calls: string[] = [];
    const member = {
      conversations: {
        archive: ({ channel }: { channel: string }) => {
          calls.push(`archive:${channel}`);
          return Promise.resolve({ ok: true });
        },
      },
    } as unknown as WebClient;
    expect(
      await archiveAsMember(member, { id: 'G1', isArchived: false, created: 0 })
    ).toBe('archived');
    expect(
      await archiveAsMember(member, { id: 'G2', isArchived: true, created: 0 })
    ).toBe('already');
    expect(calls).toEqual(['archive:G1']);
  });

  it('archives only channels the import created, never an older namesake', () => {
    const builtAt = '2026-10-01T12:00:00.000Z';
    const at = (iso: string) => ({
      id: 'C1',
      isArchived: false,
      created: Date.parse(iso) / 1000,
    });
    expect(createdByImport(at('2026-10-01T13:00:00Z'), builtAt)).toBe(true);
    expect(createdByImport(at('2026-10-01T12:00:00Z'), builtAt)).toBe(true);
    expect(createdByImport(at('2024-05-01T00:00:00Z'), builtAt)).toBe(false);
  });
});
