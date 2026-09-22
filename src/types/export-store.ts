/**
 * On-disk shapes for the workspace export store written by
 * `export-workspace`. Everything Google returns is kept verbatim in `raw`
 * fields; derived fields exist for convenience and are recomputed on merge.
 *
 * The store is additive. Records are never removed; they are marked instead.
 */
import type { chat_v1 } from 'googleapis';
import type { UserSelection } from '../services/directory';

export const STORE_VERSION = 1;

export type RunStatus = 'running' | 'completed' | 'failed' | 'dry-run';

export interface RunPointer {
  runId: string;
  startedAt: string;
  finishedAt?: string;
  status: RunStatus;
}

export interface StoreManifest {
  version: number;
  createdAt: string;
  lastRun?: RunPointer;
  runs: RunPointer[];
}

export type StoredUserStatus =
  | 'active'
  | 'suspended'
  | 'archived'
  | 'deleted'
  | 'external'
  | 'bot'
  | 'group'
  | 'unknown';

export type UserSource =
  | 'directory'
  | 'membership'
  | 'sender'
  | 'mention'
  | 'reaction';

export interface StoredUser {
  /** Chat resource name, e.g. `users/1234567890`. */
  chatUserId: string;
  directoryId?: string;
  email?: string;
  fullName?: string;
  /** Name from Chat membership or sender payloads, when Google populates it. */
  chatDisplayName?: string;
  status: StoredUserStatus;
  /** True when no directory record exists and the name is synthesized. */
  isPlaceholder: boolean;
  placeholderName?: string;
  orgUnitPath?: string;
  domainId?: string;
  sources: UserSource[];
  firstSeenRun: string;
  lastResolvedAt?: string;
  lastResolvedRun?: string;
  error?: string;
}

export type MemberType = 'HUMAN' | 'BOT' | 'GROUP' | 'UNKNOWN';

export interface StoredMembership {
  name: string;
  chatUserId?: string;
  groupName?: string;
  memberType: MemberType;
  state?: string;
  role?: string;
  affiliation?: string;
  createTime?: string;
  deleteTime?: string;
  raw: chat_v1.Schema$Membership;
}

export interface StoredSpace {
  spaceId: string;
  name: string;
  spaceType: string;
  displayName: string;
  /** Filled after user resolution for DMs and group chats. */
  derivedDisplayName?: string;
  isBotDm: boolean;
  /** Subjects (emails) whose `spaces.list` returned this space. */
  readers: string[];
  /** Subject used for reads in the most recent run. */
  readerSubject: string;
  memberships: StoredMembership[];
  membershipsFetchedAt?: string;
  discoveredAt: string;
  discoveredRun: string;
  lastSeenRun: string;
  lastSeenAt: string;
  raw: chat_v1.Schema$Space;
}

export interface StoredReaction {
  name?: string;
  user: string;
  emoji: {
    unicode?: string;
    customEmoji?: { uid?: string; emojiName?: string };
  };
  raw: chat_v1.Schema$Reaction;
}

export type LinkKind =
  | 'docs'
  | 'sheets'
  | 'slides'
  | 'forms'
  | 'drawings'
  | 'drive'
  | 'drive-folder'
  | 'chat-space'
  | 'meet'
  | 'calendar'
  | 'gmail'
  | 'other';

export interface ExtractedLink {
  url?: string;
  kind: LinkKind;
  driveFileId?: string;
  driveMimeType?: string;
  spaceName?: string;
  source: 'text' | 'annotation';
}

export interface MessageVersion {
  runId: string;
  seenAt: string;
  contentHash: string;
  raw: chat_v1.Schema$Message;
}

export interface StoredMessage {
  name: string;
  messageId: string;
  spaceId: string;
  createTime: string;
  /** Slack-style `seconds.microseconds` derived from createTime. */
  slackTs: string;
  lastUpdateTime?: string;
  senderId?: string;
  senderType?: string;
  threadName?: string;
  threadReply: boolean;
  text: string;
  formattedText?: string;
  mentions: string[];
  links: ExtractedLink[];
  reactions: StoredReaction[];
  reactionsFetchedRun?: string;
  attachmentKeys: string[];
  isDeleted: boolean;
  deletion?: { deleteTime?: string; deletionType?: string };
  contentHash: string;
  raw: chat_v1.Schema$Message;
  /** Earlier versions, newest last. Populated on edits and deletions. */
  history: MessageVersion[];
  firstSeenRun: string;
  firstSeenAt: string;
  lastSeenRun: string;
  lastSeenAt: string;
  /** Set when a full listing no longer returns the message and Google did not report a deletion. */
  missingSince?: string;
}

export type SpaceSyncStatus =
  | 'pending'
  | 'messages-synced'
  | 'complete'
  | 'failed';

export interface SpaceSyncState {
  spaceId: string;
  status: SpaceSyncStatus;
  lastRunId: string;
  lastMessagesSyncAt?: string;
  lastFullListingAt?: string;
  messageCount: number;
  deletedCount: number;
  missingCount: number;
  maxCreateTime?: string;
  attachmentsPending: number;
  error?: string;
}

export type AttachmentKind =
  | 'UPLOADED_CONTENT'
  | 'DRIVE_FILE'
  | 'ATTACHED_GIF'
  | 'DRIVE_LINK';

export type AttachmentStatus =
  | 'pending'
  | 'downloaded'
  | 'exported'
  | 'link-only'
  | 'failed'
  | 'skipped';

export interface DriveFileMetadata {
  id: string;
  name?: string;
  mimeType?: string;
  size?: number;
  md5Checksum?: string;
  createdTime?: string;
  modifiedTime?: string;
  owners?: Array<{ emailAddress?: string; displayName?: string }>;
  lastModifyingUser?: { emailAddress?: string; displayName?: string };
  webViewLink?: string;
  webContentLink?: string;
  iconLink?: string;
  trashed?: boolean;
  shortcutDetails?: { targetId?: string; targetMimeType?: string };
  driveId?: string;
  description?: string;
  fetchedAt: string;
  fetchedBy: string;
}

export interface AttachmentRecord {
  key: string;
  kind: AttachmentKind;
  spaceId: string;
  messageName: string;
  /** Message sender's chat user id, used as a fallback subject for Drive access. */
  senderId?: string;
  index: number;
  contentName?: string;
  contentType?: string;
  downloadUri?: string;
  thumbnailUri?: string;
  resourceName?: string;
  driveFileId?: string;
  drive?: DriveFileMetadata;
  /** Whether to fetch bytes or only metadata (for links in text). */
  policy: 'download' | 'metadata';
  status: AttachmentStatus;
  localPath?: string;
  fileName?: string;
  size?: number;
  sha256?: string;
  md5?: string;
  md5Verified?: boolean;
  exportedAs?: { mimeType: string; extension: string };
  downloadedBy?: string;
  downloadedAt?: string;
  attempts: number;
  error?: string;
  raw?: unknown;
}

export interface SubjectRunResult {
  email: string;
  spacesListed: number;
  error?: string;
}

export interface SpaceRunResult {
  spaceId: string;
  displayName: string;
  spaceType: string;
  readerSubject: string;
  members: number;
  status: 'complete' | 'skipped' | 'failed' | 'dry-run';
  messages: {
    listed: number;
    added: number;
    updated: number;
    deleted: number;
    unchanged: number;
    missing: number;
    reappeared: number;
    total: number;
  };
  reactions: { fetched: number; messagesWithReactions: number };
  attachments: {
    total: number;
    downloaded: number;
    linkOnly: number;
    skipped: number;
    failed: number;
    bytes: number;
  };
  error?: string;
  durationMs: number;
}

export interface UnreachableSpace {
  spaceId: string;
  displayName: string;
  reason: string;
  members?: string[];
}

export interface RunReport {
  runId: string;
  startedAt: string;
  finishedAt?: string;
  status: RunStatus;
  dryRun: boolean;
  mode: 'full' | 'delta-since' | 'resume';
  since?: string;
  selection: UserSelection;
  outputDir: string;
  subjects: SubjectRunResult[];
  spaces: SpaceRunResult[];
  unreachableSpaces: UnreachableSpace[];
  totals: {
    spacesDiscovered: number;
    spacesExported: number;
    spacesSkipped: number;
    spacesFailed: number;
    messagesAdded: number;
    messagesUpdated: number;
    messagesDeleted: number;
    messagesMissing: number;
    messagesTotal: number;
    attachmentsDownloaded: number;
    attachmentsFailed: number;
    attachmentBytes: number;
    usersResolved: number;
    usersPlaceholder: number;
  };
  errors: number;
  warnings: number;
  logPath?: string;
}
