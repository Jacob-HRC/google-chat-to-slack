import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildArchiveModel } from '../../services/slack-archive/builder';
import {
  mpimName,
  normalizeChannelName,
  normalizeHandle,
  slackIdFor,
  uniqueName,
} from '../../services/slack-archive/ids';
import { TOMBSTONE_TEXT } from '../../services/slack-archive/messages';
import {
  convertFormattedText,
  escapeSlackText,
  reactionShortName,
} from '../../services/slack-archive/text';
import { buildUsers } from '../../services/slack-archive/users';
import {
  archiveEntries,
  writeArchive,
} from '../../services/slack-archive/writer';
import type {
  ArchiveModel,
  SlackExportMessage,
} from '../../types/slack-export';
import { USER_ADMIN, USER_FORMER, USER_PASTOR } from '../fixtures/chat-api';
import {
  createFixtureStore,
  FIXTURE_USERS,
  type FixtureStore,
} from '../helpers/store-fixture';

const USER_ID_REGEX = /^U[0-9A-Z]{10}$/;
const DM_ID_REGEX = /^D/;

describe('ids', () => {
  it('produces stable Slack-shaped ids', () => {
    const id = slackIdFor('U', 'users/1');
    expect(id).toMatch(USER_ID_REGEX);
    expect(slackIdFor('U', 'users/1')).toBe(id);
    expect(slackIdFor('U', 'users/2')).not.toBe(id);
    expect(slackIdFor('D', 'users/1')).toMatch(DM_ID_REGEX);
  });

  it('normalises channel names and keeps them unique', () => {
    expect(normalizeChannelName('Dept: Media & Inspo!', 'x')).toBe(
      'dept-media-inspo'
    );
    expect(normalizeChannelName('   ', 'fallback')).toBe('fallback');
    expect(normalizeChannelName('a'.repeat(100), 'x')).toHaveLength(80);
    const used = new Set<string>();
    expect(uniqueName('general', used)).toBe('general');
    expect(uniqueName('general', used)).toBe('general-2');
    expect(uniqueName('general', used)).toBe('general-3');
  });

  it('names group DMs and handles like Slack', () => {
    expect(mpimName(['pat', 'alex', 'ken'])).toBe('mpdm-alex--ken--pat-1');
    expect(normalizeHandle('Pat Pastor', 'x')).toBe('pat.pastor');
    expect(normalizeHandle('pastor@example.com'.split('@')[0], 'x')).toBe(
      'pastor'
    );
  });
});

describe('text', () => {
  const ctx = {
    slackIdFor: (id: string) => (id === USER_PASTOR ? 'U0PASTOR' : undefined),
    nameFor: (id: string) => (id === USER_FORMER ? 'Former user 000003' : id),
  };

  it('escapes bare markup characters', () => {
    expect(escapeSlackText('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d');
  });

  it('converts mentions, keeps links, escapes labels and bullets', () => {
    expect(
      convertFormattedText(
        `Hi <users/${USER_PASTOR.split('/')[1]}> and <users/${USER_FORMER.split('/')[1]}>, see <https://docs.google.com/document/d/X/edit|Q&A doc>\n* first\n- second`,
        ctx
      )
    ).toBe(
      'Hi <@U0PASTOR> and @Former user 000003, see <https://docs.google.com/document/d/X/edit|Q&amp;A doc>\n• first\n• second'
    );
  });

  it('leaves Google markup that Slack shares untouched', () => {
    expect(convertFormattedText('*bold* _it_ ~s~ `c` ```block```', ctx)).toBe(
      '*bold* _it_ ~s~ `c` ```block```'
    );
  });

  it('maps reactions to Slack short names', () => {
    const raw = {};
    expect(
      reactionShortName({ user: 'u', emoji: { unicode: '👋' }, raw })
    ).toBe('wave');
    expect(
      reactionShortName({ user: 'u', emoji: { unicode: '🙏🏽' }, raw })
    ).toBe('pray');
    expect(
      reactionShortName({
        user: 'u',
        emoji: { customEmoji: { uid: '1', emojiName: ':church:' } },
        raw,
      })
    ).toBe('church');
    expect(reactionShortName({ user: 'u', emoji: {}, raw })).toBeUndefined();
  });
});

describe('users', () => {
  it('emits email and name only, marks non-active people deactivated, applies overrides', () => {
    const { users, byChatId } = buildUsers(Object.values(FIXTURE_USERS), {
      teamId: 'T1',
      overrides: {
        [USER_FORMER]: { name: 'Fran Former', email: 'fran@old.example.com' },
      },
    });
    const pastor = users.find(
      (u) => u.id === byChatId.get(USER_PASTOR)?.slackId
    );
    expect(pastor).toMatchObject({
      name: 'pastor',
      deleted: false,
      real_name: 'Pat Pastor',
      profile: { email: 'pastor@example.com', real_name: 'Pat Pastor' },
      is_bot: false,
    });
    expect(Object.keys(pastor?.profile ?? {}).sort()).toEqual([
      'display_name',
      'display_name_normalized',
      'email',
      'real_name',
      'real_name_normalized',
      'team',
    ]);
    expect(byChatId.get(USER_ADMIN)?.deleted).toBe(true);
    const former = users.find(
      (u) => u.id === byChatId.get(USER_FORMER)?.slackId
    );
    expect(former).toMatchObject({
      deleted: true,
      real_name: 'Fran Former',
      name: 'fran',
      profile: { email: 'fran@old.example.com' },
    });
    expect(users.find((u) => u.is_bot)?.deleted).toBe(true);
  });
});

describe('archive from a fixture store', () => {
  let fixture: FixtureStore;
  let model: ArchiveModel;

  beforeAll(async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gcts-archive-'));
    fixture = await createFixtureStore(dir);
    model = await buildArchiveModel({
      storeDir: dir,
      teamId: 'T1',
      spaceFilter: [],
      skipBotDms: true,
      spaceVisibility: 'private',
      deletedPolicy: 'tombstone',
      fileStrategy: 'manifest',
      overrides: {},
    });
  });

  afterAll(async () => {
    await rm(fixture.dir, { recursive: true, force: true });
  });

  function messagesOf(name: string): SlackExportMessage[] {
    const conversation = model.conversations.find((c) => c.plan.name === name);
    if (!conversation) {
      throw new Error(`no conversation ${name}`);
    }
    return Object.keys(conversation.days)
      .sort()
      .flatMap((day) => conversation.days[day]);
  }

  it('places conversations by type and skips bot DMs', () => {
    expect(model.groups.map((g) => g.name)).toEqual(['general']);
    expect(model.channels).toEqual([]);
    expect(model.dms).toHaveLength(1);
    expect(model.mpims.map((m) => m.name)).toEqual([
      'mpdm-alex-admin--ken-kicker--pat-pastor-1',
    ]);
    expect(model.manifest.totals.skippedConversations).toBe(1);
    const skipped = Object.values(model.manifest.conversations).find(
      (c) => c.skippedReason
    );
    expect(skipped?.skippedReason).toContain('bot');
  });

  it('builds the DM between the active person and the former member', () => {
    const dm = model.dms[0];
    const pastorId = model.manifest.users[USER_PASTOR].slackId;
    const formerId = model.manifest.users[USER_FORMER].slackId;
    expect(dm.members.sort()).toEqual([pastorId, formerId].sort());
    const messages = messagesOf(dm.id);
    expect(messages.map((m) => m.user)).toEqual([formerId, pastorId, formerId]);
    expect(messages[0].ts).toBe('1741620030.123456');
    expect(messages[2].text).toBe(TOMBSTONE_TEXT);
    const formerUser = model.users.find((u) => u.id === formerId);
    expect(formerUser?.deleted).toBe(true);
    expect(formerUser?.real_name).toBe('Former user 000003');
  });

  it('keeps original timestamps, threads, edits, reactions and mentions', () => {
    const messages = messagesOf('general');
    expect(messages).toHaveLength(3);
    const [parent, reply, files] = messages;
    expect(parent.ts).toBe('1738327786.637839');
    expect(parent.text).toContain('(edited)');
    expect(parent.edited).toEqual({
      user: model.manifest.users[USER_PASTOR].slackId,
      ts: '1738490400.000000',
    });
    expect(parent.thread_ts).toBe(parent.ts);
    expect(parent.reply_count).toBe(1);
    expect(parent.replies).toEqual([{ user: reply.user, ts: reply.ts }]);
    expect(reply.thread_ts).toBe(parent.ts);
    expect(reply.parent_user_id).toBe(parent.user);
    expect(reply.text).toBe(
      `Welcome <@${model.manifest.users[USER_PASTOR].slackId}>!`
    );
    expect(reply.reactions).toEqual([
      {
        name: 'wave',
        users: [
          model.manifest.users[USER_PASTOR].slackId,
          model.manifest.users[USER_FORMER].slackId,
        ],
        count: 2,
      },
    ]);
    expect(files.thread_ts).toBeUndefined();
  });

  it('queues downloaded files for upload and keeps Drive links in the text', () => {
    const files = messagesOf('general')[2];
    expect(files.files).toBeUndefined();
    expect(files.text).toContain(
      '📎 <https://docs.google.com/spreadsheets/d/1SHEETID123/edit|Budget 2026>'
    );
    expect(files.text).toContain(
      '📎 <https://drive.google.com/drive/folders/1FOLDERID|Shared folder>'
    );
    expect(files.text).toContain('_[Attachment unavailable at export time:');
    expect(model.uploads.map((u) => u.fileName).sort()).toEqual([
      'Budget 2026.xlsx',
      'flyer.png',
    ]);
    expect(model.uploads[0]).toMatchObject({
      conversationName: 'general',
      conversationKind: 'group',
      ts: files.ts,
    });
    expect(model.manifest.files).toMatchObject({
      strategy: 'manifest',
      uploads: 2,
      linkOnly: 1,
      unavailable: 1,
    });
  });

  it('separates two messages that share a microsecond and escapes text', () => {
    const [first, second] = messagesOf(
      'mpdm-alex-admin--ken-kicker--pat-pastor-1'
    );
    expect(first.ts).toBe('1743498000.000000');
    expect(second.ts).toBe('1743498000.000001');
    expect(second.text).toBe(
      'Yes &amp; see <https://drive.google.com/file/d/1FILEID/view|notes>'
    );
  });

  it('honours the deleted and delta options', async () => {
    const omit = await buildArchiveModel({
      storeDir: fixture.dir,
      teamId: 'T1',
      spaceFilter: ['BBBBdm'],
      skipBotDms: true,
      spaceVisibility: 'public',
      deletedPolicy: 'omit',
      fileStrategy: 'manifest',
      overrides: {},
    });
    expect(omit.manifest.totals.messages).toBe(2);
    expect(omit.manifest.totals.omittedMessages).toBe(1);

    const content = await buildArchiveModel({
      storeDir: fixture.dir,
      teamId: 'T1',
      spaceFilter: ['BBBBdm'],
      skipBotDms: true,
      spaceVisibility: 'public',
      deletedPolicy: 'content',
      fileStrategy: 'manifest',
      overrides: {},
    });
    const texts = Object.values(content.conversations[0].days)
      .flat()
      .map((m) => m.text);
    expect(texts).toContain('Never mind');

    const delta = await buildArchiveModel({
      storeDir: fixture.dir,
      teamId: 'T1',
      spaceFilter: ['general'],
      skipBotDms: true,
      spaceVisibility: 'public',
      deletedPolicy: 'tombstone',
      fileStrategy: 'manifest',
      overrides: {},
      messagesSince: '2025-01-31T13:00:00Z',
    });
    expect(delta.channels).toHaveLength(1);
    expect(delta.manifest.totals.messages).toBe(2);
  });

  it('references hosted files by URL when asked', async () => {
    const hosted = await buildArchiveModel({
      storeDir: fixture.dir,
      teamId: 'T1',
      spaceFilter: ['general'],
      skipBotDms: true,
      spaceVisibility: 'private',
      deletedPolicy: 'tombstone',
      fileStrategy: 'hosted',
      filesBaseUrl: 'https://files.example.com/chat/',
      overrides: {},
    });
    const files = Object.values(hosted.conversations[0].days).flat()[2].files;
    expect(files?.map((f) => f.url_private)).toEqual([
      'https://files.example.com/chat/AAAAgeneral/msg003.msg003/flyer.png',
      'https://files.example.com/chat/AAAAgeneral/msg003.msg003/Budget%202026.xlsx',
    ]);
    expect(files?.[0]).toMatchObject({
      mode: 'hosted',
      mimetype: 'image/png',
      filetype: 'png',
    });
    expect(hosted.uploads).toEqual([]);
  });

  it('writes a ZIP and an unpacked copy with the expected entries', async () => {
    const entries = archiveEntries(model);
    const paths = entries.map((e) => e.path);
    expect(paths.slice(0, 6)).toEqual([
      'users.json',
      'channels.json',
      'groups.json',
      'dms.json',
      'mpims.json',
      'integration_logs.json',
    ]);
    expect(paths).toContain('general/2025-01-31.json');
    expect(paths).toContain('general/2025-02-01.json');
    expect(paths).toContain(`${model.dms[0].id}/2025-03-10.json`);
    expect(paths).toContain('files-to-upload.json');
    expect(paths.at(-2)).toBe('archive-manifest.json');

    const out = path.join(fixture.dir, 'out');
    const result = await writeArchive(model, {
      zipPath: path.join(out, 'archive.zip'),
      unpackedDir: path.join(out, 'unpacked'),
    });
    expect(result.entries).toBe(entries.length);
    expect((await stat(path.join(out, 'archive.zip'))).size).toBeGreaterThan(0);
    const users = JSON.parse(
      await readFile(path.join(out, 'unpacked', 'users.json'), 'utf-8')
    );
    expect(users).toHaveLength(model.users.length);
  });
});
