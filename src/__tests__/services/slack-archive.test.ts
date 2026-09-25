import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mergeSpace } from '../../services/export-store';
import { buildArchiveModel } from '../../services/slack-archive/builder';
import { planConversation } from '../../services/slack-archive/conversations';
import {
  mpimName,
  normalizeChannelName,
  normalizeHandle,
  slackIdFor,
  uniqueName,
} from '../../services/slack-archive/ids';
import { TOMBSTONE_TEXT } from '../../services/slack-archive/messages';
import {
  decideImportAction,
  indexMembersByEmail,
  type SlackMemberSnapshot,
  summarizeSnapshot,
} from '../../services/slack-archive/slack-members';
import {
  convertFormattedText,
  escapeSlackText,
  reactionShortName,
} from '../../services/slack-archive/text';
import {
  buildUsers,
  placeholderEmail,
  realAddress,
} from '../../services/slack-archive/users';
import { validateArchive } from '../../services/slack-archive/validate';
import {
  archiveEntries,
  conversationsAtRisk,
  messageIndex,
  sidecarEntries,
  writeArchive,
} from '../../services/slack-archive/writer';
import type {
  ArchiveModel,
  SlackExportMessage,
} from '../../types/slack-export';
import {
  MEMBERSHIPS_GENERAL,
  SPACE_GENERAL,
  USER_ADMIN,
  USER_BOT,
  USER_FORMER,
  USER_PASTOR,
} from '../fixtures/chat-api';
import {
  createFixtureStore,
  FIXTURE_USERS,
  type FixtureStore,
} from '../helpers/store-fixture';

const USER_ID_REGEX = /^U[0-9A-Z]{10}$/;
const DM_ID_REGEX = /^D/;
const FLYER_PATH_REGEX = /flyer\.png$/;

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

const SLACK_SNAPSHOT: SlackMemberSnapshot = {
  fetchedAt: '2026-09-22T00:00:00.000Z',
  teamId: 'TREAL',
  teamName: 'Example',
  teamDomain: 'example',
  members: [
    {
      id: 'UPASTOR',
      name: 'pastor',
      email: 'Pastor@Example.com',
      deleted: false,
      isBot: false,
      isGuest: false,
    },
    {
      id: 'UGUEST',
      name: 'guest',
      email: 'guest@example.com',
      deleted: false,
      isBot: false,
      isGuest: true,
    },
    {
      id: 'UOLD',
      name: 'old',
      email: 'old@example.com',
      deleted: true,
      isBot: false,
      isGuest: false,
    },
    {
      id: 'UBOT',
      name: 'bot',
      email: 'pastor@example.com',
      deleted: false,
      isBot: true,
      isGuest: false,
    },
  ],
};

describe('slack members', () => {
  const byEmail = indexMembersByEmail(SLACK_SNAPSHOT);

  it('indexes humans by lower-cased email and ignores bots', () => {
    expect(byEmail.get('pastor@example.com')?.id).toBe('UPASTOR');
    expect(byEmail.has('bot')).toBe(false);
    expect(summarizeSnapshot(SLACK_SNAPSHOT)).toEqual({
      active: 2,
      deactivated: 1,
      bots: 1,
      guests: 1,
      withoutEmail: 0,
    });
  });

  it('merges on a matching email, creates everyone else deactivated', () => {
    expect(decideImportAction('PASTOR@example.com', byEmail)).toMatchObject({
      action: 'merge',
      member: { id: 'UPASTOR' },
      guest: false,
    });
    expect(decideImportAction('new@example.com', byEmail)).toEqual({
      action: 'deactivated',
      guest: false,
    });
    expect(decideImportAction(undefined, byEmail)).toEqual({
      action: 'no-email',
      guest: false,
    });
    expect(decideImportAction('guest@example.com', byEmail).guest).toBe(true);
  });

  it('never creates an active account without a snapshot', () => {
    expect(decideImportAction('pastor@example.com', undefined).action).toBe(
      'deactivated'
    );
  });
});

describe('guest addresses', () => {
  it('recovers the address behind a Google guest account', () => {
    expect(realAddress('will.howard_live.com@hrc.email.guest.google')).toBe(
      'will.howard@live.com'
    );
    expect(realAddress('a_b_gmail.com@x.guest.google')).toBe('a_b@gmail.com');
    expect(realAddress('pat@hrc.email')).toBe('pat@hrc.email');
    expect(realAddress(undefined)).toBeUndefined();
  });
});

describe('users', () => {
  it('emits email and name only, merges known members, creates the rest deactivated', () => {
    const { users, byChatId } = buildUsers(Object.values(FIXTURE_USERS), {
      teamId: 'T1',
      overrides: {
        [USER_FORMER]: { name: 'Fran Former', email: 'fran@old.example.com' },
      },
      slackMembersByEmail: indexMembersByEmail(SLACK_SNAPSHOT),
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
    expect(byChatId.get(USER_PASTOR)).toMatchObject({
      importAction: 'merge',
      slackMemberId: 'UPASTOR',
    });
    expect(Object.keys(pastor?.profile ?? {}).sort()).toEqual([
      'display_name',
      'display_name_normalized',
      'email',
      'real_name',
      'real_name_normalized',
      'team',
    ]);
    // Active in Google but not yet in Slack: created deactivated, never invited.
    expect(byChatId.get(USER_ADMIN)).toMatchObject({
      deleted: true,
      importAction: 'deactivated',
    });
    const former = users.find(
      (u) => u.id === byChatId.get(USER_FORMER)?.slackId
    );
    expect(former).toMatchObject({
      deleted: true,
      real_name: 'Fran Former',
      name: 'fran',
      profile: { email: 'fran@old.example.com' },
    });
    // Bots never need an account: their messages carry a username, not a user id.
    expect(users.some((u) => u.is_bot)).toBe(false);
    expect(byChatId.has(USER_BOT)).toBe(false);
  });

  it('emits everyone deactivated when no snapshot is given', () => {
    const { users, byChatId } = buildUsers(Object.values(FIXTURE_USERS), {
      teamId: 'T1',
      overrides: {},
    });
    expect(users.every((u) => u.deleted)).toBe(true);
    expect(byChatId.get(USER_PASTOR)?.importAction).toBe('deactivated');
    expect(byChatId.get(USER_FORMER)?.importAction).toBe('no-email');
  });

  it('keeps a merge into an already deactivated member deactivated', () => {
    const { byChatId } = buildUsers(Object.values(FIXTURE_USERS), {
      teamId: 'T1',
      overrides: { [USER_ADMIN]: { email: 'old@example.com' } },
      slackMembersByEmail: indexMembersByEmail(SLACK_SNAPSHOT),
    });
    expect(byChatId.get(USER_ADMIN)).toMatchObject({
      importAction: 'merge',
      slackMemberId: 'UOLD',
      deleted: true,
    });
  });

  it('mints a stand-in address only for people who have none', () => {
    const { users, byChatId } = buildUsers(Object.values(FIXTURE_USERS), {
      teamId: 'T1',
      overrides: {},
      placeholderEmailDomain: 'archive.example.com',
    });
    const former = users.find(
      (u) => u.id === byChatId.get(USER_FORMER)?.slackId
    );
    expect(former?.profile.email).toBe(
      'chat-import-0000000003@archive.example.com'
    );
    // Someone who already has an address keeps it.
    const pastor = users.find(
      (u) => u.id === byChatId.get(USER_PASTOR)?.slackId
    );
    expect(pastor?.profile.email).toBe('pastor@example.com');
  });

  it('leaves people without an address when no domain is given', () => {
    const { users, byChatId } = buildUsers(Object.values(FIXTURE_USERS), {
      teamId: 'T1',
      overrides: {},
    });
    const former = users.find(
      (u) => u.id === byChatId.get(USER_FORMER)?.slackId
    );
    expect(former?.profile.email).toBeUndefined();
  });

  it('builds the same stand-in address every time', () => {
    expect(placeholderEmail('users/100000000000000000003', 'x.com')).toBe(
      placeholderEmail('users/100000000000000000003', 'x.com')
    );
    expect(placeholderEmail('users/1', '@x.com')).toBe('chat-import-1@x.com');
  });
});

describe('Vault-recovered spaces', () => {
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
  const users = new Map([
    [
      USER_PASTOR,
      {
        slackId: 'U1',
        name: 'Pat Pastor',
        status: 'active',
        placeholder: false,
        deleted: false,
        importAction: 'merge' as const,
        guest: false,
      },
    ],
  ]);

  it('states the reduced fidelity in the channel purpose', () => {
    const plan = planConversation(
      { space: vaultSpace, messages: [], users },
      { spaceVisibility: 'private', skipBotDms: true, usedNames: new Set() }
    );
    expect(plan.purpose).toContain('Recovered from Google Vault');
    expect(plan.purpose).toContain('Threads, reactions, edits and exact times');
    // The space's own description is kept alongside the note.
    expect(plan.purpose).toContain('Church-wide announcements');
  });

  it('leaves an API-sourced space unlabelled', () => {
    const apiSpace = { ...vaultSpace, source: undefined };
    const plan = planConversation(
      { space: apiSpace, messages: [], users },
      { spaceVisibility: 'private', skipBotDms: true, usedNames: new Set() }
    );
    expect(plan.purpose).toBe('Church-wide announcements');
  });

  it('applies the optional prefix only to Vault channels', () => {
    const plan = planConversation(
      { space: vaultSpace, messages: [], users },
      {
        spaceVisibility: 'private',
        skipBotDms: true,
        usedNames: new Set(),
        vaultPrefix: 'archive-',
      }
    );
    expect(plan.name).toBe('archive-general');

    const apiPlan = planConversation(
      { space: { ...vaultSpace, source: undefined }, messages: [], users },
      {
        spaceVisibility: 'private',
        skipBotDms: true,
        usedNames: new Set(),
        vaultPrefix: 'archive-',
      }
    );
    expect(apiPlan.name).toBe('general');
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
      slackMembers: SLACK_SNAPSHOT,
    });
  });

  afterAll(async () => {
    await rm(fixture.dir, { recursive: true, force: true });
  });

  it('reports who merges, who is created deactivated, and the DMs at risk', () => {
    expect(model.manifest.totals).toMatchObject({
      merge: 1,
      deactivated: 2,
      noEmail: 1,
      guests: 0,
    });
    expect(model.manifest.options.slackMembersFetchedAt).toBe(
      SLACK_SNAPSHOT.fetchedAt
    );
    const atRisk = conversationsAtRisk(model);
    expect(atRisk.length).toBeGreaterThan(0);
    expect(atRisk.every((c) => c.unmapped.length > 0)).toBe(true);
    expect(
      model.manifest.warnings.some((w) => w.includes('--slack-members'))
    ).toBe(false);
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
    expect(hosted.hostedFiles.map((f) => f.url)).toEqual(
      files?.map((f) => f.url_private)
    );
    expect(hosted.hostedFiles[0].localPath).toMatch(FLYER_PATH_REGEX);
    expect(sidecarEntries(hosted).map((e) => e.path)).toEqual([
      'archive-manifest.json',
      'message-index.json',
      'hosted-files.json',
    ]);
    const hostedIndex = messageIndex(hosted).find((c) => c.name === 'general');
    expect(
      hostedIndex?.messages.find((m) => m.fileSizes)?.fileSizes
    ).toHaveLength(2);
  });

  it('validates clean, and catches what the importer would choke on', () => {
    expect(validateArchive(model).filter((i) => i.level === 'error')).toEqual(
      []
    );

    const broken = structuredClone(model);
    const general = broken.conversations.find((c) => c.plan.name === 'general');
    const messages = Object.values(general?.days ?? {}).flat();
    messages[0].user = 'UNOBODY0000';
    const reply = messages.find((m) => m.thread_ts && m.thread_ts !== m.ts);
    if (reply) {
      reply.thread_ts = '1.000000';
    }
    broken.users.push({ ...broken.users[0], id: 'UCOPY000000' });
    const errors = validateArchive(broken, ['general']).map((i) => i.message);
    expect(errors.some((e) => e.includes('UNOBODY0000'))).toBe(true);
    expect(errors.some((e) => e.includes('missing parent'))).toBe(true);
    expect(errors.some((e) => e.includes('share'))).toBe(true);
    expect(errors.some((e) => e.includes('already exists in Slack'))).toBe(
      true
    );
  });

  it('can list every person in a members channel, so DM-only people import', async () => {
    const withMembers = await buildArchiveModel({
      storeDir: fixture.dir,
      teamId: 'T1',
      spaceFilter: [],
      skipBotDms: true,
      spaceVisibility: 'private',
      deletedPolicy: 'tombstone',
      fileStrategy: 'manifest',
      overrides: {},
      slackMembers: SLACK_SNAPSHOT,
      membersChannel: 'chat-import-members',
    });
    const channel = withMembers.groups.find(
      (g) => g.name === 'chat-import-members'
    );
    expect(channel?.members.sort()).toEqual(
      withMembers.users.map((u) => u.id).sort()
    );
    expect(
      validateArchive(withMembers).filter((i) => i.level === 'error')
    ).toEqual([]);
  });

  it('leaves out excluded conversations', async () => {
    const without = await buildArchiveModel({
      storeDir: fixture.dir,
      teamId: 'T1',
      spaceFilter: [],
      excludeSpaces: ['general'],
      skipBotDms: true,
      spaceVisibility: 'private',
      deletedPolicy: 'tombstone',
      fileStrategy: 'manifest',
      overrides: {},
      slackMembers: SLACK_SNAPSHOT,
    });
    expect(without.conversations.map((c) => c.plan.name)).not.toContain(
      'general'
    );
    expect(without.conversations.length).toBe(model.conversations.length - 1);
  });

  it('never reuses the name of a channel that already exists in Slack', async () => {
    const renamed = await buildArchiveModel({
      storeDir: fixture.dir,
      teamId: 'T1',
      spaceFilter: [],
      skipBotDms: true,
      spaceVisibility: 'private',
      deletedPolicy: 'tombstone',
      fileStrategy: 'manifest',
      overrides: {},
      slackMembers: {
        ...SLACK_SNAPSHOT,
        channels: [
          { id: 'C1', name: 'general', isPrivate: false, isArchived: false },
        ],
      },
    });
    const names = renamed.groups.map((g) => g.name);
    expect(names).toContain('general-2');
    expect(names).not.toContain('general');
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
    expect(paths).not.toContain('files-to-upload.json');
    expect(paths).not.toContain('archive-manifest.json');
    expect(sidecarEntries(model).map((e) => e.path)).toEqual([
      'archive-manifest.json',
      'message-index.json',
      'members-before.json',
      'files-to-upload.json',
    ]);

    const out = path.join(fixture.dir, 'out');
    const result = await writeArchive(model, {
      zipPath: path.join(out, 'archive.zip'),
      unpackedDir: path.join(out, 'unpacked'),
    });
    expect(result.entries).toBe(entries.length);
    expect(result.sidecars).toEqual([
      path.join(out, 'archive.archive-manifest.json'),
      path.join(out, 'archive.message-index.json'),
      path.join(out, 'archive.members-before.json'),
      path.join(out, 'archive.files-to-upload.json'),
    ]);
    const index = messageIndex(model);
    const indexed = index.reduce((sum, c) => sum + c.messages.length, 0);
    expect(indexed).toBe(model.manifest.totals.messages);
    const replies = index.flatMap((c) => c.messages).filter((m) => m.threadTs);
    expect(replies.length).toBeGreaterThan(0);
    const manifest = JSON.parse(await readFile(result.sidecars[0], 'utf-8'));
    expect(manifest.totals.messages).toBe(model.manifest.totals.messages);
    expect((await stat(path.join(out, 'archive.zip'))).size).toBeGreaterThan(0);
    const users = JSON.parse(
      await readFile(path.join(out, 'unpacked', 'users.json'), 'utf-8')
    );
    expect(users).toHaveLength(model.users.length);
  });
});
