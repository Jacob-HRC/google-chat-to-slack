/**
 * Builds a small but realistic workspace export store on disk from the
 * Chat API fixtures: a named Space with files, reactions, a mention and an
 * edited message; a DM with a former staff member; a three-person group
 * chat; and a bot DM.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { chat_v1 } from 'googleapis';
import { buildAttachmentRecords } from '../../services/attachments';
import {
  attachmentsFilesDir,
  mergeMessages,
  mergeSpace,
  openStore,
  saveAttachmentIndex,
  saveMessages,
  saveSpace,
  saveState,
  saveUsers,
  spaceIdFromName,
} from '../../services/export-store';
import type {
  AttachmentRecord,
  StoredMessage,
  StoredUser,
} from '../../types/export-store';
import { digestFile } from '../../utils/fs-atomic';
import {
  MEMBERSHIPS_DM,
  MEMBERSHIPS_GENERAL,
  MSG_EDITED,
  MSG_FROM_FORMER_USER,
  MSG_PLAIN,
  MSG_REPLY_WITH_REACTION,
  MSG_WITH_ATTACHMENTS,
  REACTIONS_MSG002,
  SPACE_BOT_DM,
  SPACE_DM,
  SPACE_GENERAL,
  SPACE_GROUP,
  USER_ADMIN,
  USER_BOT,
  USER_FORMER,
  USER_PASTOR,
} from '../fixtures/chat-api';

export const FIXTURE_NOW = '2026-09-01T00:00:00.000Z';
export const FIXTURE_RUN = 'run1';

export const FIXTURE_USERS: Record<string, StoredUser> = {
  [USER_PASTOR]: {
    chatUserId: USER_PASTOR,
    directoryId: '100000000000000000001',
    email: 'pastor@example.com',
    fullName: 'Pat Pastor',
    status: 'active',
    isPlaceholder: false,
    sources: ['membership', 'sender', 'directory'],
    firstSeenRun: FIXTURE_RUN,
  },
  [USER_ADMIN]: {
    chatUserId: USER_ADMIN,
    directoryId: '100000000000000000002',
    email: 'admin@example.com',
    fullName: 'Alex Admin',
    status: 'suspended',
    isPlaceholder: false,
    sources: ['membership', 'sender', 'directory'],
    firstSeenRun: FIXTURE_RUN,
  },
  [USER_FORMER]: {
    chatUserId: USER_FORMER,
    directoryId: '100000000000000000003',
    status: 'deleted',
    isPlaceholder: true,
    placeholderName: 'Former user 000003',
    sources: ['membership', 'sender', 'reaction'],
    firstSeenRun: FIXTURE_RUN,
  },
  [USER_BOT]: {
    chatUserId: USER_BOT,
    status: 'bot',
    isPlaceholder: true,
    placeholderName: 'Bot 000009',
    sources: ['membership'],
    firstSeenRun: FIXTURE_RUN,
  },
};

const USER_KEN = 'users/100000000000000000004';

const MSG_GROUP_1: chat_v1.Schema$Message = {
  name: 'spaces/CCCCgroup/messages/g001.g001',
  sender: { name: USER_PASTOR, type: 'HUMAN' },
  createTime: '2025-04-01T09:00:00.000000Z',
  text: 'Lunch?',
  space: { name: 'spaces/CCCCgroup' },
  thread: { name: 'spaces/CCCCgroup/threads/g001' },
};

const MSG_GROUP_2: chat_v1.Schema$Message = {
  name: 'spaces/CCCCgroup/messages/g002.g002',
  sender: { name: USER_KEN, type: 'HUMAN' },
  createTime: '2025-04-01T09:00:00.000000Z',
  text: 'Yes & see <https://drive.google.com/file/d/1FILEID/view|notes>',
  formattedText:
    'Yes & see <https://drive.google.com/file/d/1FILEID/view|notes>',
  space: { name: 'spaces/CCCCgroup' },
  thread: { name: 'spaces/CCCCgroup/threads/g002' },
};

const MSG_DM_REPLY: chat_v1.Schema$Message = {
  name: 'spaces/BBBBdm/messages/dm002.dm002',
  sender: { name: USER_PASTOR, type: 'HUMAN' },
  createTime: '2025-03-10T15:25:00.000000Z',
  text: 'Sure',
  space: { name: 'spaces/BBBBdm' },
  thread: { name: 'spaces/BBBBdm/threads/dm002' },
};

const MSG_DM_DELETED: chat_v1.Schema$Message = {
  name: 'spaces/BBBBdm/messages/dm003.dm003',
  sender: { name: USER_FORMER, type: 'HUMAN' },
  createTime: '2025-03-10T15:30:00.000000Z',
  text: 'Never mind',
  space: { name: 'spaces/BBBBdm' },
  thread: { name: 'spaces/BBBBdm/threads/dm003' },
};

const MSG_DM_DELETED_MARKER: chat_v1.Schema$Message = {
  name: 'spaces/BBBBdm/messages/dm003.dm003',
  createTime: '2025-03-10T15:30:00.000000Z',
  deleteTime: '2025-03-11T08:00:00.000000Z',
  deletionMetadata: { deletionType: 'CREATOR' },
  space: { name: 'spaces/BBBBdm' },
};

const MSG_BOT_DM: chat_v1.Schema$Message = {
  name: 'spaces/DDDDbot/messages/b001.b001',
  sender: { name: USER_BOT, type: 'BOT' },
  createTime: '2025-05-01T10:00:00.000000Z',
  text: 'Your file was shared.',
  space: { name: 'spaces/DDDDbot' },
};

export interface FixtureStore {
  dir: string;
  users: Record<string, StoredUser>;
  attachmentIndex: Record<string, AttachmentRecord>;
  messagesBySpace: Record<string, StoredMessage[]>;
}

function merge(
  spaceName: string,
  fetched: chat_v1.Schema$Message[]
): StoredMessage[] {
  return mergeMessages([], fetched, spaceIdFromName(spaceName), {
    runId: FIXTURE_RUN,
    now: FIXTURE_NOW,
    fetchedIsComplete: true,
  }).messages;
}

export async function createFixtureStore(dir: string): Promise<FixtureStore> {
  const store = await openStore(dir);
  const users: Record<string, StoredUser> = {
    ...FIXTURE_USERS,
    [USER_KEN]: {
      chatUserId: USER_KEN,
      directoryId: '100000000000000000004',
      email: 'ken@example.com',
      fullName: 'Ken Kicker',
      status: 'active',
      isPlaceholder: false,
      sources: ['membership', 'sender', 'directory'],
      firstSeenRun: FIXTURE_RUN,
    },
  };
  const index: Record<string, AttachmentRecord> = {};
  const messagesBySpace: Record<string, StoredMessage[]> = {};

  const indexAttachments = (messages: StoredMessage[]): void => {
    for (const message of messages) {
      for (const record of buildAttachmentRecords(message, {
        driveLinks: 'metadata',
      })) {
        index[record.key] = record;
        message.attachmentKeys.push(record.key);
      }
    }
  };

  // Named space: plain (later edited), reply with reaction + mention, attachments.
  const generalFirst = merge(SPACE_GENERAL.name as string, [
    MSG_PLAIN,
    MSG_REPLY_WITH_REACTION,
    MSG_WITH_ATTACHMENTS,
  ]);
  const general = mergeMessages(
    generalFirst,
    [MSG_EDITED, MSG_REPLY_WITH_REACTION, MSG_WITH_ATTACHMENTS],
    'AAAAgeneral',
    { runId: 'run2', now: '2026-09-02T00:00:00.000Z', fetchedIsComplete: true }
  ).messages;
  const withReaction = general.find(
    (m) => m.name === MSG_REPLY_WITH_REACTION.name
  ) as StoredMessage;
  withReaction.reactions = REACTIONS_MSG002.map((raw) => ({
    name: raw.name ?? undefined,
    user: raw.user?.name ?? '',
    emoji: { unicode: raw.emoji?.unicode ?? undefined },
    raw,
  }));
  withReaction.reactionsFetchedRun = FIXTURE_RUN;
  indexAttachments(general);

  const filesDir = attachmentsFilesDir(dir);
  const pngPath = path.join(
    filesDir,
    'AAAAgeneral',
    'msg003.msg003',
    'flyer.png'
  );
  await mkdir(path.dirname(pngPath), { recursive: true });
  await writeFile(pngPath, 'PNGDATA');
  const pngDigest = await digestFile(pngPath);
  index['AAAAgeneral/msg003.msg003/upload-0'] = {
    ...index['AAAAgeneral/msg003.msg003/upload-0'],
    status: 'downloaded',
    fileName: 'flyer.png',
    localPath: pngPath,
    size: pngDigest.size,
    sha256: pngDigest.sha256,
  };
  const docxPath = path.join(
    filesDir,
    'AAAAgeneral',
    'msg003.msg003',
    'Budget 2026.xlsx'
  );
  await writeFile(docxPath, 'XLSX');
  index['AAAAgeneral/msg003.msg003/drive-1'] = {
    ...index['AAAAgeneral/msg003.msg003/drive-1'],
    status: 'exported',
    fileName: 'Budget 2026.xlsx',
    localPath: docxPath,
    size: 4,
    exportedAs: {
      mimeType:
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      extension: '.xlsx',
    },
    drive: {
      id: '1SHEETID123',
      name: 'Budget 2026',
      mimeType: 'application/vnd.google-apps.spreadsheet',
      webViewLink: 'https://docs.google.com/spreadsheets/d/1SHEETID123/edit',
      fetchedAt: FIXTURE_NOW,
      fetchedBy: 'pastor@example.com',
    },
  };
  index['AAAAgeneral/msg003.msg003/gif-0'] = {
    ...index['AAAAgeneral/msg003.msg003/gif-0'],
    status: 'failed',
    attempts: 3,
    error: 'HTTP 404',
  };
  index['AAAAgeneral/msg003.msg003/link-0'] = {
    ...index['AAAAgeneral/msg003.msg003/link-0'],
    status: 'link-only',
    drive: {
      id: '1FOLDERID',
      name: 'Shared folder',
      mimeType: 'application/vnd.google-apps.folder',
      webViewLink: 'https://drive.google.com/drive/folders/1FOLDERID',
      fetchedAt: FIXTURE_NOW,
      fetchedBy: 'pastor@example.com',
    },
  };

  // DM with a former staff member: their message, a reply, a deleted message.
  const dmFirst = merge(SPACE_DM.name as string, [
    MSG_FROM_FORMER_USER,
    MSG_DM_REPLY,
    MSG_DM_DELETED,
  ]);
  const dm = mergeMessages(
    dmFirst,
    [MSG_FROM_FORMER_USER, MSG_DM_REPLY, MSG_DM_DELETED_MARKER],
    'BBBBdm',
    { runId: 'run2', now: '2026-09-02T00:00:00.000Z', fetchedIsComplete: true }
  ).messages;

  // Group chat with three people and two messages at the same microsecond.
  const group = merge(SPACE_GROUP.name as string, [MSG_GROUP_1, MSG_GROUP_2]);
  const groupMemberships: chat_v1.Schema$Membership[] = [
    USER_PASTOR,
    USER_KEN,
    USER_ADMIN,
  ].map((id) => ({
    name: `spaces/CCCCgroup/members/${id.split('/')[1]}`,
    state: 'JOINED',
    role: 'ROLE_MEMBER',
    member: { name: id, type: 'HUMAN' },
  }));

  const bot = merge(SPACE_BOT_DM.name as string, [MSG_BOT_DM]);

  const spaces: Array<{
    raw: chat_v1.Schema$Space;
    memberships: chat_v1.Schema$Membership[];
    messages: StoredMessage[];
    derived?: string;
  }> = [
    { raw: SPACE_GENERAL, memberships: MEMBERSHIPS_GENERAL, messages: general },
    {
      raw: SPACE_DM,
      memberships: [MEMBERSHIPS_DM[0]],
      messages: dm,
      derived: 'Former user 000003, Pat Pastor',
    },
    {
      raw: SPACE_GROUP,
      memberships: groupMemberships,
      messages: group,
      derived: 'Alex Admin, Ken Kicker, Pat Pastor',
    },
    {
      raw: SPACE_BOT_DM,
      memberships: [
        {
          name: 'spaces/DDDDbot/members/bot',
          state: 'JOINED',
          member: { name: USER_BOT, type: 'BOT' },
        },
        MEMBERSHIPS_DM[0],
      ],
      messages: bot,
    },
  ];

  for (const entry of spaces) {
    const space = mergeSpace(undefined, {
      raw: entry.raw,
      readers: ['pastor@example.com'],
      readerSubject: 'pastor@example.com',
      memberships: entry.memberships,
      runId: FIXTURE_RUN,
      now: FIXTURE_NOW,
    });
    space.derivedDisplayName = entry.derived ?? space.displayName;
    // biome-ignore lint/nursery/noAwaitInLoop: fixture setup, sequential is fine.
    await saveSpace(store, space);
    await saveMessages(store, space.spaceId, entry.messages);
    await saveState(store, {
      spaceId: space.spaceId,
      status: 'complete',
      lastRunId: FIXTURE_RUN,
      messageCount: entry.messages.length,
      deletedCount: entry.messages.filter((m) => m.isDeleted).length,
      missingCount: 0,
      attachmentsPending: 0,
    });
    messagesBySpace[space.spaceId] = entry.messages;
  }
  await saveUsers(store, users);
  await saveAttachmentIndex(store, index);
  return { dir, users, attachmentIndex: index, messagesBySpace };
}
