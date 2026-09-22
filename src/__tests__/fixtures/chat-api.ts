/**
 * Realistic Google Chat API payloads for unit tests. Shapes follow the
 * Message, Space, Membership and Reaction resources.
 */
import type { chat_v1 } from 'googleapis';

export const SPACE_GENERAL: chat_v1.Schema$Space = {
  name: 'spaces/AAAAgeneral',
  type: 'ROOM',
  displayName: 'general',
  spaceType: 'SPACE',
  spaceThreadingState: 'THREADED_MESSAGES',
  spaceDetails: { description: 'Church-wide announcements' },
  spaceHistoryState: 'HISTORY_ON',
  createTime: '2025-01-31T12:48:10.245613Z',
  membershipCount: { joinedDirectHumanUserCount: 3 },
  spaceUri: 'https://chat.google.com/room/AAAAgeneral?cls=11',
};

export const SPACE_DM: chat_v1.Schema$Space = {
  name: 'spaces/BBBBdm',
  type: 'DM',
  spaceType: 'DIRECT_MESSAGE',
  singleUserBotDm: false,
  spaceThreadingState: 'UNTHREADED_MESSAGES',
  spaceHistoryState: 'HISTORY_ON',
};

export const SPACE_GROUP: chat_v1.Schema$Space = {
  name: 'spaces/CCCCgroup',
  type: 'DM',
  spaceType: 'GROUP_CHAT',
  spaceThreadingState: 'UNTHREADED_MESSAGES',
};

export const SPACE_BOT_DM: chat_v1.Schema$Space = {
  name: 'spaces/DDDDbot',
  type: 'DM',
  spaceType: 'DIRECT_MESSAGE',
  singleUserBotDm: true,
};

export const USER_PASTOR = 'users/100000000000000000001';
export const USER_ADMIN = 'users/100000000000000000002';
export const USER_FORMER = 'users/100000000000000000003';
export const USER_BOT = 'users/200000000000000000009';

export const MEMBERSHIPS_DM: chat_v1.Schema$Membership[] = [
  {
    name: 'spaces/BBBBdm/members/100000000000000000001',
    state: 'JOINED',
    role: 'ROLE_MEMBER',
    member: { name: USER_PASTOR, type: 'HUMAN' },
    createTime: '2025-02-01T08:00:00.000000Z',
  },
  {
    name: 'spaces/BBBBdm/members/100000000000000000003',
    state: 'JOINED',
    role: 'ROLE_MEMBER',
    member: { name: USER_FORMER, type: 'HUMAN' },
    createTime: '2025-02-01T08:00:00.000000Z',
  },
];

export const MEMBERSHIPS_GENERAL: chat_v1.Schema$Membership[] = [
  {
    name: 'spaces/AAAAgeneral/members/100000000000000000001',
    state: 'JOINED',
    role: 'ROLE_MANAGER',
    member: { name: USER_PASTOR, type: 'HUMAN' },
  },
  {
    name: 'spaces/AAAAgeneral/members/100000000000000000002',
    state: 'JOINED',
    role: 'ROLE_MEMBER',
    member: { name: USER_ADMIN, type: 'HUMAN' },
  },
  {
    name: 'spaces/AAAAgeneral/members/200000000000000000009',
    state: 'JOINED',
    role: 'ROLE_MEMBER',
    member: { name: USER_BOT, type: 'BOT' },
  },
  {
    name: 'spaces/AAAAgeneral/members/group1',
    state: 'JOINED',
    role: 'ROLE_MEMBER',
    groupMember: { name: 'groups/staff' },
  },
];

export const MSG_PLAIN: chat_v1.Schema$Message = {
  name: 'spaces/AAAAgeneral/messages/msg001.msg001',
  sender: { name: USER_PASTOR, type: 'HUMAN' },
  createTime: '2025-01-31T12:49:46.637839Z',
  text: 'Hello team from Google land. 👋',
  formattedText: 'Hello team from Google land. 👋',
  argumentText: 'Hello team from Google land. 👋',
  thread: { name: 'spaces/AAAAgeneral/threads/msg001' },
  space: { name: 'spaces/AAAAgeneral' },
  threadReply: false,
};

export const MSG_REPLY_WITH_REACTION: chat_v1.Schema$Message = {
  name: 'spaces/AAAAgeneral/messages/msg002.msg002',
  sender: { name: USER_ADMIN, type: 'HUMAN' },
  createTime: '2025-01-31T13:37:01.276927Z',
  text: 'Welcome @Pat Pastor!',
  formattedText: 'Welcome <users/100000000000000000001>!',
  thread: { name: 'spaces/AAAAgeneral/threads/msg001' },
  threadReply: true,
  space: { name: 'spaces/AAAAgeneral' },
  emojiReactionSummaries: [{ emoji: { unicode: '👋' }, reactionCount: 2 }],
  annotations: [
    {
      type: 'USER_MENTION',
      startIndex: 8,
      length: 11,
      userMention: {
        user: { name: USER_PASTOR, type: 'HUMAN' },
        type: 'MENTION',
      },
    },
  ],
};

export const MSG_WITH_ATTACHMENTS: chat_v1.Schema$Message = {
  name: 'spaces/AAAAgeneral/messages/msg003.msg003',
  sender: { name: USER_PASTOR, type: 'HUMAN' },
  createTime: '2025-02-01T08:30:59.984527Z',
  text: 'Budget and the flyer: https://docs.google.com/spreadsheets/d/1SHEETID123/edit#gid=0 and https://drive.google.com/drive/folders/1FOLDERID',
  space: { name: 'spaces/AAAAgeneral' },
  thread: { name: 'spaces/AAAAgeneral/threads/msg003' },
  attachment: [
    {
      name: 'spaces/AAAAgeneral/messages/msg003.msg003/attachments/AAA1',
      contentName: 'flyer.png',
      contentType: 'image/png',
      source: 'UPLOADED_CONTENT',
      attachmentDataRef: { resourceName: 'CiQAres1' },
      downloadUri: 'https://chat.google.com/api/get_attachment_url?x=1',
      thumbnailUri: 'https://chat.google.com/api/get_attachment_url?x=1&t=1',
    },
    {
      name: 'spaces/AAAAgeneral/messages/msg003.msg003/attachments/AAA2',
      contentName: 'Budget 2026',
      contentType: 'application/vnd.google-apps.spreadsheet',
      source: 'DRIVE_FILE',
      driveDataRef: { driveFileId: '1SHEETID123' },
    },
  ],
  attachedGifs: [{ uri: 'https://media.tenor.com/abc/tenor.gif' }],
  annotations: [
    {
      type: 'RICH_LINK',
      startIndex: 22,
      length: 60,
      richLinkMetadata: {
        uri: 'https://docs.google.com/spreadsheets/d/1SHEETID123/edit#gid=0',
        richLinkType: 'DRIVE_FILE',
        driveLinkData: {
          driveDataRef: { driveFileId: '1SHEETID123' },
          mimeType: 'application/vnd.google-apps.spreadsheet',
        },
      },
    },
  ],
};

export const MSG_EDITED: chat_v1.Schema$Message = {
  ...MSG_PLAIN,
  text: 'Hello team from Google land. 👋 (edited)',
  formattedText: 'Hello team from Google land. 👋 (edited)',
  lastUpdateTime: '2025-02-02T10:00:00.000000Z',
};

export const MSG_DELETED_MARKER: chat_v1.Schema$Message = {
  name: 'spaces/AAAAgeneral/messages/msg001.msg001',
  createTime: '2025-01-31T12:49:46.637839Z',
  deleteTime: '2025-02-03T09:00:00.000000Z',
  deletionMetadata: { deletionType: 'CREATOR' },
  space: { name: 'spaces/AAAAgeneral' },
};

export const MSG_FROM_FORMER_USER: chat_v1.Schema$Message = {
  name: 'spaces/BBBBdm/messages/dm001.dm001',
  sender: { name: USER_FORMER, type: 'HUMAN' },
  createTime: '2025-03-10T15:20:30.123456789Z',
  text: 'Can you cover Sunday?',
  space: { name: 'spaces/BBBBdm' },
  thread: { name: 'spaces/BBBBdm/threads/dm001' },
};

export const REACTIONS_MSG002: chat_v1.Schema$Reaction[] = [
  {
    name: 'spaces/AAAAgeneral/messages/msg002.msg002/reactions/r1',
    user: { name: USER_PASTOR, type: 'HUMAN' },
    emoji: { unicode: '👋' },
  },
  {
    name: 'spaces/AAAAgeneral/messages/msg002.msg002/reactions/r2',
    user: { name: USER_FORMER, type: 'HUMAN' },
    emoji: { unicode: '👋' },
  },
];
