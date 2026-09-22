import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadMessages,
  loadSpace,
  maxCreateTime,
  mergeMessages,
  mergeSpace,
  messageContentHash,
  messageIdFromName,
  openStore,
  recordRunPointer,
  saveMessages,
  saveSpace,
  spaceIdFromName,
  toStoredMembership,
  toStoredMessage,
} from '../../services/export-store';
import { readJsonFile } from '../../utils/fs-atomic';
import {
  MEMBERSHIPS_GENERAL,
  MSG_DELETED_MARKER,
  MSG_EDITED,
  MSG_PLAIN,
  MSG_REPLY_WITH_REACTION,
  MSG_WITH_ATTACHMENTS,
  SPACE_GENERAL,
  USER_PASTOR,
} from '../fixtures/chat-api';

const RUN_1 = {
  runId: 'run1',
  now: '2026-09-01T00:00:00.000Z',
  fetchedIsComplete: true,
};
const RUN_2 = {
  runId: 'run2',
  now: '2026-09-02T00:00:00.000Z',
  fetchedIsComplete: true,
};

describe('identifiers', () => {
  it('extracts ids from resource names', () => {
    expect(spaceIdFromName('spaces/AAAAgeneral')).toBe('AAAAgeneral');
    expect(messageIdFromName('spaces/AAAAgeneral/messages/msg001.msg001')).toBe(
      'msg001.msg001'
    );
  });
});

describe('toStoredMessage', () => {
  it('derives Slack ts, mentions, links and keeps the raw payload', () => {
    const stored = toStoredMessage(
      MSG_REPLY_WITH_REACTION,
      'AAAAgeneral',
      'run1',
      RUN_1.now
    );
    expect(stored.slackTs).toBe('1738330621.276927');
    expect(stored.mentions).toEqual([USER_PASTOR]);
    expect(stored.threadReply).toBe(true);
    expect(stored.threadName).toBe('spaces/AAAAgeneral/threads/msg001');
    expect(stored.raw).toBe(MSG_REPLY_WITH_REACTION);
    expect(stored.isDeleted).toBe(false);

    const withLinks = toStoredMessage(
      MSG_WITH_ATTACHMENTS,
      'AAAAgeneral',
      'run1',
      RUN_1.now
    );
    expect(withLinks.links.map((l) => l.driveFileId)).toEqual([
      '1SHEETID123',
      '1FOLDERID',
    ]);
  });

  it('marks deletion markers as deleted', () => {
    const stored = toStoredMessage(
      MSG_DELETED_MARKER,
      'AAAAgeneral',
      'run1',
      RUN_1.now
    );
    expect(stored.isDeleted).toBe(true);
    expect(stored.deletion).toEqual({
      deleteTime: '2025-02-03T09:00:00.000000Z',
      deletionType: 'CREATOR',
    });
  });
});

describe('messageContentHash', () => {
  it('changes when text or reactions change and ignores unrelated fields', () => {
    const base = messageContentHash(MSG_PLAIN);
    expect(messageContentHash({ ...MSG_PLAIN, argumentText: 'x' })).toBe(base);
    expect(messageContentHash(MSG_EDITED)).not.toBe(base);
    expect(
      messageContentHash({
        ...MSG_PLAIN,
        emojiReactionSummaries: [
          { emoji: { unicode: '👍' }, reactionCount: 1 },
        ],
      })
    ).not.toBe(base);
  });
});

describe('messageContentHash attachments', () => {
  it('ignores rotating signed download URLs but notices a different file', () => {
    const base = messageContentHash(MSG_WITH_ATTACHMENTS);
    const rotated = {
      ...MSG_WITH_ATTACHMENTS,
      attachment: MSG_WITH_ATTACHMENTS.attachment?.map((a) => ({
        ...a,
        downloadUri: 'https://chat.google.com/api/get_attachment_url?x=NEW',
        thumbnailUri:
          'https://chat.google.com/api/get_attachment_url?x=NEW&t=1',
      })),
    };
    expect(messageContentHash(rotated)).toBe(base);
    const replaced = {
      ...MSG_WITH_ATTACHMENTS,
      attachment: MSG_WITH_ATTACHMENTS.attachment?.map((a, i) =>
        i === 0 ? { ...a, attachmentDataRef: { resourceName: 'OTHER' } } : a
      ),
    };
    expect(messageContentHash(replaced)).not.toBe(base);
  });
});

describe('mergeMessages', () => {
  it('adds new messages sorted by createTime and flags reaction/attachment work', () => {
    const { messages, diff } = mergeMessages(
      [],
      [MSG_WITH_ATTACHMENTS, MSG_PLAIN, MSG_REPLY_WITH_REACTION],
      'AAAAgeneral',
      RUN_1
    );
    expect(messages.map((m) => m.messageId)).toEqual([
      'msg001.msg001',
      'msg002.msg002',
      'msg003.msg003',
    ]);
    expect(diff).toMatchObject({
      added: 3,
      updated: 0,
      deleted: 0,
      unchanged: 0,
      missing: 0,
    });
    expect(diff.reactionRefresh).toEqual([MSG_REPLY_WITH_REACTION.name]);
    expect(diff.attachmentRefresh).toHaveLength(3);
  });

  it('is idempotent for an unchanged listing', () => {
    const first = mergeMessages(
      [],
      [MSG_PLAIN, MSG_REPLY_WITH_REACTION],
      'AAAAgeneral',
      RUN_1
    );
    first.messages[1].reactionsFetchedRun = 'run1';
    const second = mergeMessages(
      first.messages,
      [MSG_PLAIN, MSG_REPLY_WITH_REACTION],
      'AAAAgeneral',
      RUN_2
    );
    expect(second.diff).toMatchObject({
      added: 0,
      updated: 0,
      deleted: 0,
      unchanged: 2,
      missing: 0,
    });
    expect(second.diff.reactionRefresh).toEqual([]);
    expect(second.messages[0].lastSeenRun).toBe('run2');
    expect(second.messages[0].firstSeenRun).toBe('run1');
  });

  it('refetches reactions for messages that never had them fetched', () => {
    const first = mergeMessages(
      [],
      [MSG_REPLY_WITH_REACTION],
      'AAAAgeneral',
      RUN_1
    );
    const second = mergeMessages(
      first.messages,
      [MSG_REPLY_WITH_REACTION],
      'AAAAgeneral',
      RUN_2
    );
    expect(second.diff.reactionRefresh).toEqual([MSG_REPLY_WITH_REACTION.name]);
  });

  it('treats a stale stored hash as unchanged when the content is identical', () => {
    const first = mergeMessages([], [MSG_PLAIN], 'AAAAgeneral', RUN_1);
    first.messages[0].contentHash = 'hash-from-an-older-algorithm';
    const second = mergeMessages(
      first.messages,
      [MSG_PLAIN],
      'AAAAgeneral',
      RUN_2
    );
    expect(second.diff).toMatchObject({ updated: 0, unchanged: 1 });
    expect(second.messages[0].history).toHaveLength(0);
    expect(second.messages[0].contentHash).toBe(messageContentHash(MSG_PLAIN));
  });

  it('keeps the previous version in history when a message is edited', () => {
    const first = mergeMessages([], [MSG_PLAIN], 'AAAAgeneral', RUN_1);
    const second = mergeMessages(
      first.messages,
      [MSG_EDITED],
      'AAAAgeneral',
      RUN_2
    );
    expect(second.diff.updated).toBe(1);
    const [message] = second.messages;
    expect(message.text).toContain('(edited)');
    expect(message.lastUpdateTime).toBe('2025-02-02T10:00:00.000000Z');
    expect(message.history).toHaveLength(1);
    expect(message.history[0].raw.text).toBe(MSG_PLAIN.text);
    expect(message.history[0].runId).toBe('run1');
    expect(message.firstSeenRun).toBe('run1');
    expect(message.slackTs).toBe('1738327786.637839');
  });

  it('keeps the last known content when Google reports a deletion', () => {
    const first = mergeMessages([], [MSG_PLAIN], 'AAAAgeneral', RUN_1);
    const second = mergeMessages(
      first.messages,
      [MSG_DELETED_MARKER],
      'AAAAgeneral',
      RUN_2
    );
    expect(second.diff.deleted).toBe(1);
    const [message] = second.messages;
    expect(message.isDeleted).toBe(true);
    expect(message.deletion?.deletionType).toBe('CREATOR');
    expect(message.raw.text).toBe(MSG_PLAIN.text);
    expect(message.history).toHaveLength(1);

    const third = mergeMessages(
      second.messages,
      [MSG_DELETED_MARKER],
      'AAAAgeneral',
      {
        ...RUN_2,
        runId: 'run3',
      }
    );
    expect(third.diff).toMatchObject({ deleted: 0, unchanged: 1 });
    expect(third.messages[0].raw.text).toBe(MSG_PLAIN.text);
  });

  it('never drops a message that vanished; it marks it missing and can un-mark it', () => {
    const first = mergeMessages(
      [],
      [MSG_PLAIN, MSG_REPLY_WITH_REACTION],
      'AAAAgeneral',
      RUN_1
    );
    const second = mergeMessages(
      first.messages,
      [MSG_PLAIN],
      'AAAAgeneral',
      RUN_2
    );
    expect(second.diff.missing).toBe(1);
    expect(second.messages).toHaveLength(2);
    const gone = second.messages.find((m) => m.messageId === 'msg002.msg002');
    expect(gone?.missingSince).toBe(RUN_2.now);

    const third = mergeMessages(
      second.messages,
      [MSG_PLAIN, MSG_REPLY_WITH_REACTION],
      'AAAAgeneral',
      { ...RUN_2, runId: 'run3' }
    );
    expect(third.diff.reappeared).toBe(1);
    expect(third.diff.missing).toBe(0);
    expect(third.messages[1].missingSince).toBeUndefined();
  });

  it('does not mark anything missing when the listing was partial (--since)', () => {
    const first = mergeMessages(
      [],
      [MSG_PLAIN, MSG_REPLY_WITH_REACTION],
      'AAAAgeneral',
      RUN_1
    );
    const second = mergeMessages(
      first.messages,
      [MSG_WITH_ATTACHMENTS],
      'AAAAgeneral',
      {
        ...RUN_2,
        fetchedIsComplete: false,
      }
    );
    expect(second.diff).toMatchObject({ added: 1, missing: 0 });
    expect(second.messages).toHaveLength(3);
    expect(second.messages.every((m) => !m.missingSince)).toBe(true);
  });

  it('reports the newest createTime', () => {
    const { messages } = mergeMessages(
      [],
      [MSG_PLAIN, MSG_WITH_ATTACHMENTS],
      'AAAAgeneral',
      RUN_1
    );
    expect(maxCreateTime(messages)).toBe('2025-02-01T08:30:59.984527Z');
    expect(maxCreateTime([])).toBeUndefined();
  });
});

describe('Chat API superseding Vault records', () => {
  it('replaces a Vault-sourced message with the API copy instead of duplicating it', () => {
    const vaultCopy = {
      ...toStoredMessage(MSG_PLAIN, 'AAAAgeneral', 'vault-run', RUN_1.now),
      // Vault renders the bare id and only second precision.
      name: 'spaces/AAAAgeneral/messages/msg001',
      messageId: 'msg001',
      source: 'vault' as const,
      createTime: '2025-01-31T12:49:46.000000Z',
      slackTs: '1738327786.000000',
    };
    const { messages, diff } = mergeMessages(
      [vaultCopy],
      [MSG_PLAIN],
      'AAAAgeneral',
      RUN_1
    );
    expect(messages).toHaveLength(1);
    expect(diff).toMatchObject({ added: 1, updated: 0 });
    const [message] = messages;
    expect(message.source).toBeUndefined();
    expect(message.name).toBe(MSG_PLAIN.name);
    expect(message.createTime).toBe('2025-01-31T12:49:46.637839Z');
    expect(message.history).toEqual([]);
  });

  it('leaves a Vault message alone when the API never returns it', () => {
    const vaultOnly = {
      ...toStoredMessage(MSG_PLAIN, 'AAAAgeneral', 'vault-run', RUN_1.now),
      name: 'spaces/AAAAgeneral/messages/vaultonly',
      messageId: 'vaultonly',
      source: 'vault' as const,
    };
    const { messages, diff } = mergeMessages(
      [vaultOnly],
      [MSG_PLAIN],
      'AAAAgeneral',
      { ...RUN_1, fetchedIsComplete: false }
    );
    expect(messages).toHaveLength(2);
    expect(diff.missing).toBe(0);
    expect(messages.some((m) => m.source === 'vault')).toBe(true);
  });
});

describe('mergeSpace and memberships', () => {
  it('classifies members and accumulates readers across runs', () => {
    const first = mergeSpace(undefined, {
      raw: SPACE_GENERAL,
      readers: ['a@example.com'],
      readerSubject: 'a@example.com',
      memberships: MEMBERSHIPS_GENERAL,
      runId: 'run1',
      now: RUN_1.now,
    });
    expect(first.spaceId).toBe('AAAAgeneral');
    expect(first.memberships.map((m) => m.memberType)).toEqual([
      'HUMAN',
      'HUMAN',
      'BOT',
      'GROUP',
    ]);
    expect(first.memberships[3].groupName).toBe('groups/staff');

    const second = mergeSpace(first, {
      raw: SPACE_GENERAL,
      readers: ['b@example.com'],
      readerSubject: 'b@example.com',
      runId: 'run2',
      now: RUN_2.now,
    });
    expect(second.readers).toEqual(['a@example.com', 'b@example.com']);
    expect(second.memberships).toHaveLength(4);
    expect(second.discoveredRun).toBe('run1');
    expect(second.lastSeenRun).toBe('run2');
  });

  it('maps membership fields', () => {
    expect(toStoredMembership(MEMBERSHIPS_GENERAL[0])).toMatchObject({
      chatUserId: USER_PASTOR,
      memberType: 'HUMAN',
      role: 'ROLE_MANAGER',
      state: 'JOINED',
    });
  });
});

describe('persistence', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'gcts-store-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates a manifest, round-trips spaces and messages, and records runs', async () => {
    const store = await openStore(dir);
    expect(store.manifest.version).toBe(1);

    const space = mergeSpace(undefined, {
      raw: SPACE_GENERAL,
      readers: ['a@example.com'],
      readerSubject: 'a@example.com',
      memberships: MEMBERSHIPS_GENERAL,
      runId: 'run1',
      now: RUN_1.now,
    });
    await saveSpace(store, space);
    const { messages } = mergeMessages([], [MSG_PLAIN], 'AAAAgeneral', RUN_1);
    await saveMessages(store, 'AAAAgeneral', messages);

    expect(await loadSpace(store, 'AAAAgeneral')).toEqual(space);
    expect(await loadMessages(store, 'AAAAgeneral')).toEqual(messages);
    expect(await loadMessages(store, 'nope')).toEqual([]);

    await recordRunPointer(store, {
      runId: 'run1',
      startedAt: RUN_1.now,
      status: 'running',
    });
    await recordRunPointer(store, {
      runId: 'run1',
      startedAt: RUN_1.now,
      finishedAt: RUN_2.now,
      status: 'completed',
    });
    const reopened = await openStore(dir);
    expect(reopened.manifest.runs).toHaveLength(1);
    expect(reopened.manifest.lastRun?.status).toBe('completed');
  });

  it('refuses to overwrite a corrupt file silently', async () => {
    const file = path.join(dir, 'broken.json');
    await writeFile(file, '{not json', 'utf-8');
    await expect(readJsonFile(file)).rejects.toThrow('copy was saved');
    const backups = (await import('node:fs/promises')).readdir(dir);
    expect(
      (await backups).some((f) => f.startsWith('broken.json.corrupt-'))
    ).toBe(true);
    expect(await readFile(file, 'utf-8')).toBe('{not json');
  });
});
