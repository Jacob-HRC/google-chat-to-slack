import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkSpacePrefix } from '../../cli/commands/build-slack-archive';
import { mergeSpace } from '../../services/export-store';
import {
  type BuildArchiveOptions,
  buildArchiveModel,
} from '../../services/slack-archive/builder';
import {
  type ConversationInput,
  type ConversationOptions,
  planConversation,
} from '../../services/slack-archive/conversations';
import { prefixedChannelName } from '../../services/slack-archive/ids';
import { validateArchive } from '../../services/slack-archive/validate';
import type {
  ArchiveModel,
  ArchiveUserMapping,
} from '../../types/slack-export';
import {
  MEMBERSHIPS_GENERAL,
  SPACE_GENERAL,
  USER_PASTOR,
} from '../fixtures/chat-api';
import {
  createFixtureStore,
  type FixtureStore,
} from '../helpers/store-fixture';

const PREFIX = 'gchat-old-';

function person(id: string): ArchiveUserMapping {
  return {
    slackId: `U${id.toUpperCase()}`,
    name: `${id} person`,
    status: 'active',
    placeholder: false,
    deleted: false,
    importAction: 'merge',
    guest: false,
  } as ArchiveUserMapping;
}

/** A DM or group chat with these people, as planConversation sees it. */
function groupChat(ids: string[]): ConversationInput {
  return {
    space: {
      spaceId: `CHAT${ids.length}`,
      name: `spaces/CHAT${ids.length}`,
      spaceType: 'GROUP_CHAT',
      displayName: '',
      memberships: ids.map((id) => ({
        chatUserId: `users/${id}`,
        memberType: 'HUMAN',
      })),
      raw: {},
    },
    messages: [],
    users: new Map(ids.map((id) => [`users/${id}`, person(id)])),
  } as unknown as ConversationInput;
}

const OPTIONS: ConversationOptions = {
  spaceVisibility: 'private',
  skipBotDms: true,
  usedNames: new Set(),
  spacePrefix: PREFIX,
  archiveAllSpaces: true,
};

describe('prefixedChannelName', () => {
  it('puts the prefix in front of the normalised name', () => {
    expect(prefixedChannelName(PREFIX, 'Worship Team!', 'x')).toBe(
      'gchat-old-worship-team'
    );
    expect(prefixedChannelName('', 'Worship Team', 'x')).toBe('worship-team');
  });

  it('uses the fallback when the name normalises to nothing', () => {
    expect(prefixedChannelName(PREFIX, '日本語', 'space-abc')).toBe(
      'gchat-old-space-abc'
    );
  });

  it('stays within Slack’s 80 characters', () => {
    const name = prefixedChannelName(PREFIX, 'a'.repeat(100), 'x');
    expect(name).toHaveLength(80);
    expect(name.startsWith(PREFIX)).toBe(true);
  });
});

describe('checkSpacePrefix', () => {
  it('accepts a prefix that ends in a separator', () => {
    expect(checkSpacePrefix('gchat-old-')).toBe(PREFIX);
    expect(checkSpacePrefix('old_')).toBe('old_');
    expect(checkSpacePrefix('')).toBeUndefined();
    expect(checkSpacePrefix(undefined)).toBeUndefined();
  });

  it('rejects one Slack would mangle or run into the name', () => {
    for (const bad of ['gchat-old', 'Gchat-old-', '-old-', 'old prefix-']) {
      expect(() => checkSpacePrefix(bad)).toThrow('--space-prefix');
    }
    expect(() => checkSpacePrefix(`${'a'.repeat(40)}-`)).toThrow('at most 40');
  });
});

describe('Space prefix scope', () => {
  const vaultSpace = {
    ...mergeSpace(undefined, {
      raw: SPACE_GENERAL,
      readers: [],
      readerSubject: 'google-vault',
      memberships: MEMBERSHIPS_GENERAL,
      runId: 'vault-run',
      now: '2026-09-01T00:00:00.000Z',
    }),
    source: 'vault' as const,
  };
  const users = new Map([[USER_PASTOR, person('pastor')]]);

  it('names Vault Spaces like any other Space, ahead of any Vault prefix', () => {
    const plan = planConversation(
      { space: vaultSpace, messages: [], users },
      { ...OPTIONS, usedNames: new Set() }
    );
    expect(plan.name).toBe('gchat-old-general');
    expect(plan.archived).toBe(true);
    expect(plan.purpose).toContain('Recovered from Google Vault');

    const both = planConversation(
      { space: vaultSpace, messages: [], users },
      { ...OPTIONS, usedNames: new Set(), vaultPrefix: 'archive-' }
    );
    expect(both.name).toBe('gchat-old-archive-general');
  });

  it('leaves channels made from DMs and group chats alone', () => {
    const orphan = planConversation(groupChat(['ann']), {
      ...OPTIONS,
      usedNames: new Set(),
    });
    expect(orphan.kind).toBe('group');
    expect(orphan.name).toBe('archive-dm-ann-person');
    expect(orphan.archived).toBeUndefined();

    const ids = 'abcdefghijk'.split('');
    const large = planConversation(groupChat(ids), {
      ...OPTIONS,
      usedNames: new Set(),
    });
    expect(large.kind).toBe('group');
    expect(large.name).toBe('group-a-b-c-d');
    expect(large.archived).toBeUndefined();
  });
});

describe('archive built with a Space prefix', () => {
  let fixture: FixtureStore;
  let model: ArchiveModel;

  const options = (dir: string): BuildArchiveOptions => ({
    storeDir: dir,
    teamId: 'T1',
    spaceFilter: [],
    skipBotDms: true,
    spaceVisibility: 'private',
    deletedPolicy: 'tombstone',
    fileStrategy: 'manifest',
    overrides: {},
    membersChannel: 'chat-import-members',
    spacePrefix: PREFIX,
    archiveAllSpaces: true,
  });

  beforeAll(async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gcts-prefix-'));
    fixture = await createFixtureStore(dir);
    model = await buildArchiveModel(options(dir));
  });

  afterAll(async () => {
    await rm(fixture.dir, { recursive: true, force: true });
  });

  it('prefixes Space channels only', () => {
    expect(model.groups.map((g) => g.name).sort()).toEqual([
      'chat-import-members',
      'gchat-old-general',
    ]);
    expect(model.mpims.map((m) => m.name)).toEqual([
      'mpdm-alex-admin--ken-kicker--pat-pastor-1',
    ]);
    expect(model.dms).toHaveLength(1);
    expect(model.manifest.options.spacePrefix).toBe(PREFIX);
    expect(model.manifest.options.archiveAllSpaces).toBe(true);
    expect(validateArchive(model).filter((i) => i.level === 'error')).toEqual(
      []
    );
  });

  it('archives every Space after the import and nothing else', () => {
    const toArchive = Object.values(model.manifest.conversations)
      .filter((c) => c.archiveAfterImport)
      .map((c) => c.name);
    expect(toArchive).toEqual(['gchat-old-general']);
    // The importer skips archived channels, so the ZIP never says so.
    expect(model.groups.every((g) => g.is_archived === false)).toBe(true);
  });

  it('keeps the Space’s current members', async () => {
    const plain = await buildArchiveModel({
      ...options(fixture.dir),
      spacePrefix: undefined,
      archiveAllSpaces: undefined,
    });
    const membersOf = (m: ArchiveModel, name: string): string[] =>
      [...(m.groups.find((g) => g.name === name)?.members ?? [])].sort();
    expect(membersOf(model, 'gchat-old-general')).toEqual(
      membersOf(plain, 'general')
    );
    expect(membersOf(model, 'gchat-old-general').length).toBeGreaterThan(0);
  });

  it('still avoids a name already taken in Slack', async () => {
    const taken = await buildArchiveModel({
      ...options(fixture.dir),
      slackMembers: {
        fetchedAt: '2026-10-01T00:00:00.000Z',
        members: [],
        channels: [
          {
            id: 'C1',
            name: 'gchat-old-general',
            isPrivate: false,
            isArchived: false,
          },
        ],
      } as unknown as BuildArchiveOptions['slackMembers'],
    });
    expect(taken.groups.map((g) => g.name)).toContain('gchat-old-general-2');
  });
});
