import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { WebClient } from '@slack/web-api';
import { describe, expect, it } from 'vitest';
import yazl from 'yazl';
import {
  archiveAsMember,
  archivePublicChannel,
  archiveTargets,
  type ConnectedMember,
  createdByImport,
  pickArchivers,
  readArchiveCreated,
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

  it('knows an imported channel by the created time the ZIP gave it', () => {
    // Slack keeps the ZIP's created (the Space's, years back) on import.
    const builtAt = '2026-10-19T14:50:03.573Z';
    const zipCreated = 1_663_698_678;
    const channel = (created: number) => ({
      id: 'G1',
      isArchived: false,
      created,
    });
    expect(createdByImport(channel(zipCreated), builtAt, zipCreated)).toBe(
      true
    );
    expect(createdByImport(channel(zipCreated), builtAt)).toBe(false);
    expect(createdByImport(channel(zipCreated - 1), builtAt, zipCreated)).toBe(
      false
    );
    expect(createdByImport(channel(0), builtAt, 0)).toBe(false);
  });

  it('reads the created time of every channel in the ZIP', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'archiver-'));
    const zipPath = path.join(dir, 'a.zip');
    const zip = new yazl.ZipFile();
    zip.addBuffer(
      Buffer.from(JSON.stringify([{ name: 'gchat-old-team', created: 100 }])),
      'channels.json'
    );
    zip.addBuffer(
      Buffer.from(
        JSON.stringify([
          { name: 'gchat-old-finance', created: 200 },
          { name: 'no-time' },
        ])
      ),
      'groups.json'
    );
    zip.addBuffer(
      Buffer.from(JSON.stringify([{ name: 'gchat-old-team', created: 999 }])),
      'gchat-old-team/channels.json'
    );
    zip.end();
    await pipeline(zip.outputStream, createWriteStream(zipPath));
    const created = await readArchiveCreated(zipPath);
    expect([...created]).toEqual([
      ['gchat-old-team', 100],
      ['gchat-old-finance', 200],
    ]);
    expect(
      archiveTargets(
        {
          conversations: {
            A: conversation('gchat-old-team', 'channel', {
              archiveAfterImport: true,
            }),
          },
        } as unknown as ArchiveManifest,
        created
      )
    ).toEqual([
      { spaceId: 'A', name: 'gchat-old-team', isPrivate: false, created: 100 },
    ]);
    await rm(dir, { recursive: true, force: true });
  });
});
