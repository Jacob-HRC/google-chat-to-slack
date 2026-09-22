/**
 * Shapes of a Slack export archive as consumed by Slack's workspace import
 * (Workspace Settings → Import/Export Data). Field names mirror what Slack
 * itself writes in an export so the importer treats the archive as native.
 * https://slack.com/help/articles/220556107-How-to-read-Slack-data-exports
 */

export interface SlackExportUserProfile {
  real_name: string;
  real_name_normalized: string;
  display_name: string;
  display_name_normalized: string;
  email?: string;
  title?: string;
  team?: string;
}

export interface SlackExportUser {
  id: string;
  team_id: string;
  name: string;
  deleted: boolean;
  real_name: string;
  tz?: string;
  profile: SlackExportUserProfile;
  is_bot: boolean;
  is_app_user: boolean;
  is_admin?: boolean;
  updated?: number;
}

export interface SlackExportTopic {
  value: string;
  creator: string;
  last_set: number;
}

export interface SlackExportChannel {
  id: string;
  name: string;
  created: number;
  creator: string;
  is_archived: boolean;
  is_general: boolean;
  members: string[];
  topic: SlackExportTopic;
  purpose: SlackExportTopic;
}

export interface SlackExportDm {
  id: string;
  created: number;
  members: string[];
}

export interface SlackExportMpim {
  id: string;
  name: string;
  created: number;
  creator: string;
  members: string[];
  topic: SlackExportTopic;
  purpose: SlackExportTopic;
}

export interface SlackExportFile {
  id: string;
  created: number;
  timestamp: number;
  name: string;
  title: string;
  mimetype: string;
  filetype: string;
  pretty_type?: string;
  size: number;
  mode: 'hosted' | 'external';
  is_external: boolean;
  external_type?: string;
  url_private: string;
  url_private_download: string;
  permalink?: string;
  user: string;
}

export interface SlackExportReaction {
  name: string;
  users: string[];
  count: number;
}

export interface SlackExportMessage {
  type: 'message';
  subtype?: string;
  ts: string;
  user?: string;
  username?: string;
  text: string;
  thread_ts?: string;
  parent_user_id?: string;
  reply_count?: number;
  reply_users?: string[];
  reply_users_count?: number;
  latest_reply?: string;
  replies?: Array<{ user: string; ts: string }>;
  subscribed?: boolean;
  reactions?: SlackExportReaction[];
  files?: SlackExportFile[];
  edited?: { user: string; ts: string };
  user_profile?: {
    real_name: string;
    display_name: string;
    name: string;
    is_restricted?: boolean;
    is_ultra_restricted?: boolean;
  };
}

export type ArchiveConversationKind = 'channel' | 'group' | 'dm' | 'mpim';

export interface ConversationPlan {
  kind: ArchiveConversationKind;
  id: string;
  /** Folder and channel name. For DMs this is the id. */
  name: string;
  spaceId: string;
  googleName: string;
  googleDisplayName: string;
  spaceType: string;
  members: string[];
  creator: string;
  created: number;
  purpose?: string;
  topic?: string;
  skippedReason?: string;
}

export interface FileUploadTask {
  conversationId: string;
  conversationName: string;
  conversationKind: ArchiveConversationKind;
  ts: string;
  threadTs?: string;
  userId: string;
  attachmentKey: string;
  localPath: string;
  fileName: string;
  title: string;
  mimeType: string;
  size: number;
  sha256?: string;
  driveLink?: string;
}

export interface ArchiveUserMapping {
  slackId: string;
  name: string;
  email?: string;
  status: string;
  placeholder: boolean;
  deleted: boolean;
}

export interface ArchiveConversationMapping {
  kind: ArchiveConversationKind;
  id: string;
  name: string;
  googleName: string;
  spaceType: string;
  members: string[];
  messages: number;
  omitted: number;
  days: number;
  skippedReason?: string;
}

export interface ArchiveManifest {
  builtAt: string;
  storeDir: string;
  teamId: string;
  options: {
    spaceVisibility: string;
    deletedPolicy: string;
    fileStrategy: string;
    filesBaseUrl?: string;
    skipBotDms: boolean;
    firstSeenAfterRun?: string;
    messagesSince?: string;
    spaceFilter: string[];
  };
  users: Record<string, ArchiveUserMapping>;
  conversations: Record<string, ArchiveConversationMapping>;
  files: {
    strategy: string;
    uploads: number;
    hosted: number;
    linkOnly: number;
    unavailable: number;
  };
  totals: {
    users: number;
    placeholders: number;
    channels: number;
    groups: number;
    dms: number;
    mpims: number;
    skippedConversations: number;
    messages: number;
    omittedMessages: number;
  };
  warnings: string[];
}

export interface ArchiveConversation {
  plan: ConversationPlan;
  days: Record<string, SlackExportMessage[]>;
  messageCount: number;
  omittedCount: number;
}

export interface ArchiveModel {
  users: SlackExportUser[];
  channels: SlackExportChannel[];
  groups: SlackExportChannel[];
  dms: SlackExportDm[];
  mpims: SlackExportMpim[];
  conversations: ArchiveConversation[];
  uploads: FileUploadTask[];
  manifest: ArchiveManifest;
}
