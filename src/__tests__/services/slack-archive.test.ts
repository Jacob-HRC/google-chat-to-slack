import {
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { chat_v1 } from 'googleapis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  isDeltaBuild,
  mergeTargets,
  readArchiveCreated,
} from '../../services/channel-archiver';
import {
  loadMessages,
  mergeSpace,
  openStore,
  saveAttachmentIndex,
  saveMessages,
  saveUsers,
} from '../../services/export-store';
import { buildArchiveModel } from '../../services/slack-archive/builder';
import { planConversation } from '../../services/slack-archive/conversations';
import {
  mpimName,
  normalizeChannelName,
  normalizeHandle,
  slackIdFor,
  uniqueName,
} from '../../services/slack-archive/ids';
import {
  type ImportedRecord,
  loadImportedRecord,
} from '../../services/slack-archive/imported';
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
  addFixtureSpace,
  createFixtureStore,
  FIXTURE_USERS,
  type FixtureStore,
  USER_KEN,
} from '../helpers/store-fixture';

const USER_ID_REGEX = /^U[0-9A-Z]{10}$/;
const DM_ID_REGEX = /^D/;
const FLYER_PATH_REGEX = /flyer\.png$/;
const OUTSIDE_STORE_REGEX = /is outside .* would contain "\.\."/;

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

  it('escapes names written as plain mentions, and writes @all as text', () => {
    // As in a --plain-mentions build: no one resolves to a Slack id.
    const plain = {
      slackIdFor: (id: string) => (id === 'users/none' ? 'U0' : undefined),
      nameFor: () => 'Jennifer & Lauren <camp>',
    };
    expect(
      convertFormattedText(
        `Hi <users/${USER_PASTOR.split('/')[1]}> and <users/all>`,
        plain
      )
    ).toBe('Hi @Jennifer &amp; Lauren &lt;camp&gt; and @all');
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
    ).toBe('pray::skin-tone-4');
    // Slack's names, not GitHub's: these differ between the two.
    const cases: [string, string][] = [
      ['🧐', 'face_with_monocle'],
      ['🤣', 'rolling_on_the_floor_laughing'],
      ['❤️', 'heart'],
      ['❤', 'heart'],
      ['👍', '+1'],
      ['👍🏿', '+1::skin-tone-6'],
      ['🤍', 'white_heart'],
      ['🙂‍↕️', 'head_shaking_vertically'],
      // Mixed tones have no Slack name: kept as the character.
      ['👨🏻‍❤️‍👨🏿', '👨🏻‍❤️‍👨🏿'],
      // Too new for Slack's list: kept as the character, not dropped.
      ['\u{1FAEA}', '\u{1FAEA}'],
    ];
    for (const [unicode, name] of cases) {
      expect(reactionShortName({ user: 'u', emoji: { unicode }, raw })).toBe(
        name
      );
    }
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

  it('marks a Space for archiving after the import, never in the ZIP', async () => {
    expect(model.groups[0].is_archived).toBe(false);
    const archived = await buildArchiveModel({
      storeDir: fixture.dir,
      teamId: 'T1',
      spaceFilter: ['general'],
      skipBotDms: true,
      spaceVisibility: 'private',
      deletedPolicy: 'tombstone',
      fileStrategy: 'manifest',
      overrides: {},
      visibilityBySpace: new Map([['AAAAgeneral', 'public']]),
      archivedSpaces: new Set(['AAAAgeneral']),
    });
    // Slack's importer skips channels marked archived, so the ZIP never
    // says so; the manifest carries the decision for archive-channels.
    expect(archived.channels.map((c) => [c.name, c.is_archived])).toEqual([
      ['general', false],
    ]);
    expect(archived.manifest.conversations.AAAAgeneral.archiveAfterImport).toBe(
      true
    );
    expect(model.manifest.conversations.AAAAgeneral.archiveAfterImport).toBe(
      undefined
    );
  });

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
      `Welcome <@${model.manifest.users[USER_PASTOR].slackId}>!\n_Reactions: :wave: Pat Pastor, Former user 000003_`
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

  it('writes mentions as plain names when asked, so nobody is notified', async () => {
    const plain = await buildArchiveModel({
      storeDir: fixture.dir,
      teamId: 'T1',
      spaceFilter: ['general'],
      skipBotDms: true,
      spaceVisibility: 'private',
      deletedPolicy: 'tombstone',
      fileStrategy: 'manifest',
      overrides: {},
      plainMentions: true,
    });
    const reply = Object.values(plain.conversations[0].days).flat()[1];
    expect(reply.text).toBe(
      'Welcome @Pat Pastor!\n_Reactions: :wave: Pat Pastor, Former user 000003_'
    );
    expect(plain.manifest.options.plainMentions).toBe(true);
    expect(validateArchive(plain).filter((i) => i.level === 'error')).toEqual(
      []
    );
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

  it('refuses to host a file recorded outside the store it builds from', async () => {
    // Same store reached through another path, as from a second checkout
    // whose data/ is a symlink: the recorded paths no longer sit under it.
    const elsewhere = await mkdtemp(path.join(tmpdir(), 'gcts-elsewhere-'));
    const linked = path.join(elsewhere, 'workspace');
    await symlink(fixture.dir, linked);
    try {
      await expect(
        buildArchiveModel({
          storeDir: linked,
          teamId: 'T1',
          spaceFilter: ['general'],
          skipBotDms: true,
          spaceVisibility: 'private',
          deletedPolicy: 'tombstone',
          fileStrategy: 'hosted',
          filesBaseUrl: 'https://files.example.com/chat/',
          overrides: {},
        })
      ).rejects.toThrow(OUTSIDE_STORE_REGEX);
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
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
    const early = structuredClone(model);
    const earlyGeneral = early.conversations.find(
      (c) => c.plan.name === 'general'
    );
    const earlyReply = Object.values(earlyGeneral?.days ?? {})
      .flat()
      .find((m) => m.thread_ts && m.thread_ts !== m.ts);
    if (earlyReply) {
      earlyReply.ts = '1.000001';
    }
    expect(
      validateArchive(early).some((i) =>
        i.message.includes('dated before its parent')
      )
    ).toBe(true);
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
    // archive-channels reads each channel's created back from the ZIP.
    expect(
      Object.fromEntries(
        await readArchiveCreated(path.join(out, 'archive.zip'))
      )
    ).toEqual(
      Object.fromEntries(
        [...model.channels, ...model.groups].map((c) => [c.name, c.created])
      )
    );
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

describe('app posts', () => {
  const APP_SPACE = 'spaces/EEEEapps';
  const APP_DM = 'spaces/EEEEappdm';
  const channelOf = (built: ArchiveModel) =>
    built.conversations.find((c) => c.plan.kind === 'group');
  let dir: string;
  let model: ArchiveModel;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'gcts-apps-'));
    const fixture = await createFixtureStore(dir);
    // The app's registration and Chat display names differ, as for the
    // budget app in the real store.
    await saveUsers(await openStore(dir), {
      ...fixture.users,
      [USER_BOT]: {
        ...fixture.users[USER_BOT],
        fullName: 'Budget System',
        chatDisplayName: 'Data Monitoring',
      },
    });
    const post = (
      id: string,
      createTime: string,
      text: string,
      attachment?: chat_v1.Schema$Attachment[]
    ): chat_v1.Schema$Message => ({
      name: `${APP_SPACE}/messages/${id}.${id}`,
      sender: { name: USER_BOT, type: 'BOT' },
      createTime,
      text,
      space: { name: APP_SPACE },
      thread: { name: `${APP_SPACE}/threads/${id}` },
      attachment,
    });
    await addFixtureSpace(
      dir,
      {
        name: APP_SPACE,
        displayName: 'Budget Confirmations',
        spaceType: 'SPACE',
        createTime: '2025-09-01T00:00:00Z',
      },
      [USER_PASTOR],
      [
        post('a1', '2025-09-29T10:57:17.000001Z', 'System ready.'),
        post('a2', '2025-09-29T11:01:45.000001Z', 'Budget confirmed', [
          {
            name: `${APP_SPACE}/messages/a2.a2/attachments/F1`,
            contentName: 'Budget Review.xlsx',
            contentType:
              'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            source: 'UPLOADED_CONTENT',
            attachmentDataRef: { resourceName: 'CiQAapp1' },
          },
        ]),
        // Its attachment never downloaded, so it carries no file.
        post('a3', '2025-09-29T11:05:00.000001Z', 'Nothing to fetch', [
          {
            name: `${APP_SPACE}/messages/a3.a3/attachments/F3`,
            contentName: 'Gone.pdf',
            contentType: 'application/pdf',
            source: 'UPLOADED_CONTENT',
            attachmentDataRef: { resourceName: 'CiQAapp3' },
          },
        ]),
      ],
      fixture.attachmentIndex
    );
    // A DM, where Slack keeps only messages from its two people.
    const dmPost = post('d1', '2025-10-02T09:00:00.000001Z', 'Notes attached', [
      {
        name: `${APP_SPACE}/messages/d1.d1/attachments/F2`,
        contentName: 'Notes.docx',
        contentType:
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        source: 'UPLOADED_CONTENT',
        attachmentDataRef: { resourceName: 'CiQAapp2' },
      },
    ]);
    await addFixtureSpace(
      dir,
      {
        name: APP_DM,
        spaceType: 'DIRECT_MESSAGE',
        createTime: '2025-10-01T00:00:00Z',
      },
      [USER_PASTOR, USER_KEN],
      [
        {
          ...post('d0', '2025-10-01T09:00:00.000001Z', 'Reminder: notes due'),
          name: `${APP_DM}/messages/d0.d0`,
          space: { name: APP_DM },
          thread: { name: `${APP_DM}/threads/d0` },
        },
        {
          ...dmPost,
          name: `${APP_DM}/messages/d1.d1`,
          space: { name: APP_DM },
          thread: { name: `${APP_DM}/threads/d1` },
          attachment: dmPost.attachment?.map((a) => ({
            ...a,
            name: `${APP_DM}/messages/d1.d1/attachments/F2`,
          })),
        },
      ],
      fixture.attachmentIndex
    );
    // The two file posts downloaded; the third one's attachment didn't.
    for (const [key, record] of Object.entries(fixture.attachmentIndex)) {
      if (key.includes('/a2.a2/') || key.includes('/d1.d1/')) {
        const localPath = path.join(dir, `${record.contentName}`);
        // biome-ignore lint/nursery/noAwaitInLoop: fixture setup.
        await writeFile(localPath, 'DATA');
        fixture.attachmentIndex[key] = {
          ...record,
          status: 'downloaded',
          localPath,
          size: 4,
        };
      }
    }
    await saveAttachmentIndex(await openStore(dir), fixture.attachmentIndex);
    model = await buildArchiveModel({
      storeDir: dir,
      teamId: 'T1',
      spaceFilter: ['EEEEapps', 'EEEEappdm'],
      skipBotDms: true,
      spaceVisibility: 'private',
      deletedPolicy: 'tombstone',
      fileStrategy: 'manifest',
      overrides: {},
      placeholderEmailDomain: 'chat-archive.example.com',
    });
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('names app posts as Google Chat showed the app', () => {
    const [ready] = Object.values(channelOf(model)?.days ?? {}).flat();
    expect(ready).toMatchObject({
      subtype: 'bot_message',
      username: 'Data Monitoring',
      text: 'System ready.',
    });
    expect(ready.user).toBeUndefined();
  });

  it("posts an app's files from a deactivated account named after it, so Slack keeps them", () => {
    const conversation = channelOf(model);
    const withFile = Object.values(conversation?.days ?? {}).flat()[1];
    const account = model.users.find((u) => u.real_name === 'Data Monitoring');
    expect(account).toMatchObject({ deleted: true, is_bot: false });
    expect(account?.profile.email).toBe(
      placeholderEmail(USER_BOT, 'chat-archive.example.com')
    );
    expect(withFile.subtype).toBeUndefined();
    expect(withFile.user).toBe(account?.id);
    expect(withFile.text).toContain('Budget confirmed');
    expect(conversation?.plan.members).toContain(account?.id);
    expect(model.groups[0].members).toContain(account?.id);
    expect(model.manifest.users[USER_BOT]).toMatchObject({
      name: 'Data Monitoring',
      status: 'bot',
      importAction: 'deactivated',
    });
    expect(validateArchive(model).filter((i) => i.level === 'error')).toEqual(
      []
    );
  });

  it("has a DM's own person carry an app's file post, named first, since Slack drops anyone else's", () => {
    const dm = model.conversations.find((c) => c.plan.kind === 'dm');
    const [reminder, carried] = Object.values(dm?.days ?? {}).flat();
    // A text-only app post too: Slack keeps only the DM's two people's.
    expect(reminder).toMatchObject({
      user: dm?.plan.members[0],
      text: '*Data Monitoring:* Reminder: notes due',
    });
    expect(reminder.subtype).toBeUndefined();
    expect(dm?.plan.members).toHaveLength(2);
    expect(carried.user).toBe(dm?.plan.members[0]);
    expect(carried.subtype).toBeUndefined();
    expect(carried.user_profile).toBeUndefined();
    expect(carried.text.startsWith('*Data Monitoring:* Notes attached')).toBe(
      true
    );
  });

  it('keeps an app post whose attachment never downloaded as an app post', () => {
    const gone = Object.values(channelOf(model)?.days ?? {})
      .flat()
      .find((m) => m.text.startsWith('Nothing to fetch'));
    expect(gone).toMatchObject({
      subtype: 'bot_message',
      username: 'Data Monitoring',
    });
  });

  it('names a mentioned app as Google Chat showed it', async () => {
    const MENTION_SPACE = 'spaces/EEEEmention';
    await addFixtureSpace(
      dir,
      {
        name: MENTION_SPACE,
        displayName: 'Thanks',
        spaceType: 'SPACE',
        createTime: '2025-09-01T00:00:00Z',
      },
      [USER_PASTOR],
      [
        {
          name: `${MENTION_SPACE}/messages/h1.h1`,
          sender: { name: USER_PASTOR, type: 'HUMAN' },
          createTime: '2025-09-29T10:58:00.000001Z',
          text: 'Thanks @Data Monitoring',
          formattedText: `Thanks <${USER_BOT}>`,
          annotations: [
            {
              type: 'USER_MENTION',
              startIndex: 7,
              length: 16,
              userMention: {
                user: { name: USER_BOT, type: 'BOT' },
                type: 'MENTION',
              },
            },
          ],
          space: { name: MENTION_SPACE },
          thread: { name: `${MENTION_SPACE}/threads/h1` },
        },
      ]
    );
    // Here the app posted no file, so it has no account to mention.
    const mentioned = await buildArchiveModel({
      storeDir: dir,
      teamId: 'T1',
      spaceFilter: ['EEEEmention'],
      skipBotDms: true,
      spaceVisibility: 'private',
      deletedPolicy: 'tombstone',
      fileStrategy: 'manifest',
      overrides: {},
    });
    const [thanks] = Object.values(mentioned.conversations[0].days).flat();
    expect(thanks.text).toBe('Thanks @Data Monitoring');
  });

  it('makes no account for an app that never posted a file', async () => {
    const plain = await buildArchiveModel({
      storeDir: dir,
      teamId: 'T1',
      spaceFilter: ['DDDDbot'],
      skipBotDms: false,
      spaceVisibility: 'private',
      deletedPolicy: 'tombstone',
      fileStrategy: 'manifest',
      overrides: {},
      placeholderEmailDomain: 'chat-archive.example.com',
    });
    expect(plain.users.some((u) => u.real_name === 'Data Monitoring')).toBe(
      false
    );
    const [post] = Object.values(plain.conversations[0].days).flat();
    expect(post).toMatchObject({
      subtype: 'bot_message',
      username: 'Data Monitoring',
    });
  });
});

describe('supplement to an earlier import', () => {
  let dir: string;
  const GENERAL = 'AAAAgeneral';
  const roster = (names: string[]): SlackMemberSnapshot => ({
    ...SLACK_SNAPSHOT,
    channels: names.map((name, i) => ({
      id: `C${i}`,
      name,
      isPrivate: false,
      isArchived: true,
    })),
  });
  const build = (
    spaceVisibility: 'public' | 'private',
    imported?: ImportedRecord
  ): Promise<ArchiveModel> =>
    buildArchiveModel({
      storeDir: dir,
      teamId: 'T1',
      spaceFilter: [],
      skipBotDms: true,
      spaceVisibility,
      deletedPolicy: 'tombstone',
      fileStrategy: 'manifest',
      overrides: {},
      placeholderEmailDomain: 'chat-archive.example.com',
      membersChannel: 'chat-import-members',
      // After the import, its channels are in Slack (and archived).
      slackMembers: imported
        ? roster(['general', 'chat-import-members'])
        : SLACK_SNAPSHOT,
      imported,
    });
  const recordOf = (
    full: ArchiveModel,
    reinclude: string[]
  ): ImportedRecord => ({
    storeLastRun: 'run2',
    conversations: full.manifest.conversations,
    users: new Set(Object.keys(full.manifest.users)),
    reinclude: new Set(reinclude),
  });
  let lostTs: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'gcts-supplement-'));
    await createFixtureStore(dir);
    const store = await openStore(dir);
    const messages = await loadMessages(store, GENERAL);
    lostTs = messages[0].slackTs;
    // One message stored after the import's build.
    await saveMessages(store, GENERAL, [
      ...messages,
      {
        ...messages[0],
        name: `spaces/${GENERAL}/messages/new1.new1`,
        messageId: 'new1.new1',
        threadName: `spaces/${GENERAL}/threads/new1`,
        createTime: '2026-11-05T09:00:00.000001Z',
        slackTs: '1793869200.000001',
        text: 'Posted after the import',
        formattedText: 'Posted after the import',
        lastUpdateTime: undefined,
        reactions: [],
        attachmentKeys: [],
        firstSeenRun: 'run3',
      },
    ]);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('merges a public channel under its imported name, with only what the import lacks', async () => {
    const full = await build('public');
    expect(full.channels.map((c) => c.name)).toContain('general');
    const supplement = await build('public', recordOf(full, [lostTs]));

    // Only the channel with something new; nobody new, so no members channel.
    expect(supplement.conversations.map((c) => c.plan.name)).toEqual([
      'general',
    ]);
    const [general] = supplement.conversations;
    expect(general.plan.mergeInto).toBe(true);
    expect(
      Object.values(general.days)
        .flat()
        .map((m) => m.ts)
        .sort()
    ).toEqual([lostTs, '1793869200.000001'].sort());
    expect(supplement.manifest.conversations[GENERAL]).toMatchObject({
      name: 'general',
      mergesInto: true,
    });
    expect(supplement.manifest.options.excludeImported).toBe('run2');
    expect(supplement.manifest.totals).toMatchObject({ dms: 0, mpims: 0 });
    expect(supplement.manifest.conversations.BBBBdm?.skippedReason).toBe(
      'nothing new since the earlier import'
    );
    // Merging into the existing channel is the point, not a clash.
    expect(
      validateArchive(supplement, ['general', 'chat-import-members']).filter(
        (i) => i.level === 'error'
      )
    ).toEqual([]);
    expect(isDeltaBuild(supplement.manifest)).toBe(false);
    expect(mergeTargets(supplement.manifest).map((t) => t.name)).toEqual([
      'general',
    ]);
  });

  it('gives a private channel a new name beside the imported one', async () => {
    const full = await build('private');
    expect(full.groups.map((g) => g.name)).toContain('general');
    // Re-add the message with files, as if Slack had lost it.
    const store = await openStore(dir);
    const withFiles = (await loadMessages(store, GENERAL)).find(
      (m) => m.attachmentKeys.length > 0
    );
    const supplement = await build(
      'private',
      recordOf(full, [withFiles?.slackTs ?? ''])
    );
    const [general] = supplement.conversations;
    expect(general.plan.name).toBe('general-2');
    expect(general.plan.mergeInto).toBeUndefined();
    expect(
      Object.values(general.days)
        .flat()
        .map((m) => m.ts)
    ).toContain('1793869200.000001');
    // Its files go to the new channel, not the name planning first gave.
    expect(supplement.uploads.length).toBeGreaterThan(0);
    expect(new Set(supplement.uploads.map((u) => u.conversationName))).toEqual(
      new Set(['general-2'])
    );
  });

  it("sends a merged channel's files to the channel it merges into", async () => {
    const full = await build('public');
    // Re-add the message with files, as if Slack had lost it.
    const withFiles = (await loadMessages(await openStore(dir), GENERAL)).find(
      (m) => m.attachmentKeys.length > 0
    );
    const supplement = await build(
      'public',
      recordOf(full, [withFiles?.slackTs ?? ''])
    );
    // Planning first names it general-2 (the roster lists general).
    expect(supplement.uploads.length).toBeGreaterThan(0);
    expect(new Set(supplement.uploads.map((u) => u.conversationName))).toEqual(
      new Set(['general'])
    );
  });

  it('reads a frozen import record', async () => {
    const recordDir = await mkdtemp(path.join(tmpdir(), 'gcts-record-'));
    const full = await build('public');
    await writeFile(
      path.join(recordDir, 'import-record.json'),
      JSON.stringify({ storeLastRun: { runId: 'run2', status: 'complete' } })
    );
    await writeFile(
      path.join(recordDir, 'hrc-full.archive-manifest.json'),
      JSON.stringify(full.manifest)
    );
    await writeFile(
      path.join(recordDir, 'lost-messages.json'),
      JSON.stringify([{ conversationName: 'general', ts: lostTs }])
    );
    const record = await loadImportedRecord(recordDir);
    expect(record.storeLastRun).toBe('run2');
    expect(record.reinclude).toEqual(new Set([lostTs]));
    expect(record.conversations[GENERAL]?.name).toBe('general');
    expect(record.users.size).toBe(Object.keys(full.manifest.users).length);
    await rm(recordDir, { recursive: true, force: true });
  });
});
