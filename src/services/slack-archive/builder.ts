/**
 * Reads the workspace export store and assembles an in-memory archive model.
 * No network access; the store is the only input.
 */
import type {
  AttachmentRecord,
  StoredMessage,
  StoredSpace,
  StoredUser,
} from '../../types/export-store';
import type {
  ArchiveConversation,
  ArchiveManifest,
  ArchiveModel,
  ArchiveUserMapping,
  ConversationPlan,
  SlackExportChannel,
  SlackExportDm,
  SlackExportMpim,
  SlackExportTopic,
} from '../../types/slack-export';
import {
  attachmentsFilesDir,
  listStoredSpaceIds,
  loadAttachmentIndex,
  loadMessages,
  loadSpace,
  loadUsers,
  openStore,
} from '../export-store';
import { applyUsersOverlay, type UserOverlay } from '../name-recovery';
import { matchesSpaceFilter } from '../workspace-export';
import {
  type ConversationOptions,
  MPIM_MAX_MEMBERS,
  participantsOf,
  planConversation,
  type SpaceVisibility,
} from './conversations';
import {
  normalizeChannelName,
  prefixedChannelName,
  slackIdFor,
  uniqueName,
} from './ids';
import {
  isMeetingChat,
  type MeetingChatMode,
  meetingHeaderText,
  meetingSeries,
  memberKey,
  mergeDays,
  type PendingMeeting,
  threadUnderHeader,
  tsSet,
} from './meeting-chats';
import {
  type BuiltMessages,
  buildConversationMessages,
  type DeletedPolicy,
  type DriveCopy,
  type FileStrategy,
  type MessageBuildContext,
} from './messages';
import { indexMembersByEmail, type SlackMemberSnapshot } from './slack-members';
import { buildUsers, type UserOverride } from './users';

export interface BuildArchiveOptions {
  storeDir: string;
  teamId: string;
  spaceFilter: string[];
  /** Conversations to leave out, e.g. ones already imported by a pilot. */
  excludeSpaces?: string[];
  skipBotDms: boolean;
  spaceVisibility: SpaceVisibility;
  deletedPolicy: DeletedPolicy;
  fileStrategy: FileStrategy;
  filesBaseUrl?: string;
  overrides: Record<string, UserOverride>;
  firstSeenAfterRun?: string;
  messagesSince?: string;
  /** Prefix for channels recovered from Google Vault. Empty for none. */
  vaultPrefix?: string;
  /**
   * Prefix for every channel made from a Space, e.g. "gchat-old-". DMs,
   * group DMs and channels made from them keep their names.
   */
  spacePrefix?: string;
  /** Archive every channel made from a Space after the import. */
  archiveAllSpaces?: boolean;
  /**
   * Name of a private channel listing every person in the archive. Slack's
   * importer appears to import people through channel membership, so a
   * DM-only archive imports nobody and its DMs are dropped. Unset for none.
   */
  membersChannel?: string;
  /** Domain for synthetic addresses; see BuildUsersOptions. */
  placeholderEmailDomain?: string;
  /** Who already exists in the destination; see slack-members.ts. */
  slackMembers?: SlackMemberSnapshot;
  /** Recovered names and addresses laid over users.json; see recover-names --overlay. */
  usersOverlay?: UserOverlay;
  /** Reviewed public/private list; see visibility.ts. Overrides spaceVisibility. */
  visibilityBySpace?: Map<string, 'public' | 'private'>;
  /** Named Spaces to archive after the import (recorded in the manifest). */
  archivedSpaces?: Set<string>;
  /** Attachments moved to Google Drive, by attachment key; see stage-large-files. */
  driveCopies?: Record<string, DriveCopy>;
  /** What to do with Google Meet chats; see meeting-chats.ts. Default fold. */
  meetingChats?: MeetingChatMode;
}

interface LoadedSpace {
  space: StoredSpace;
  messages: StoredMessage[];
}

function addReferencedIds(
  { space, messages }: LoadedSpace,
  ids: Set<string>
): void {
  for (const membership of space.memberships) {
    if (membership.chatUserId) {
      ids.add(membership.chatUserId);
    }
  }
  for (const message of messages) {
    if (message.senderId) {
      ids.add(message.senderId);
    }
    for (const mention of message.mentions) {
      ids.add(mention);
    }
    for (const reaction of message.reactions) {
      ids.add(reaction.user);
    }
  }
}

function topic(
  value: string | undefined,
  creator: string,
  created: number
): SlackExportTopic {
  return { value: value ?? '', creator, last_set: value ? created : 0 };
}

function toChannel(plan: ConversationPlan): SlackExportChannel {
  return {
    id: plan.id,
    name: plan.name,
    created: plan.created,
    creator: plan.creator,
    // Always false: the importer skips a channel marked archived (tested
    // 2026-09-28), so archiving happens after the import instead.
    is_archived: false,
    is_general: false,
    members: plan.members,
    topic: topic(plan.topic, plan.creator, plan.created),
    purpose: topic(plan.purpose, plan.creator, plan.created),
  };
}

function toDm(plan: ConversationPlan): SlackExportDm {
  return { id: plan.id, created: plan.created, members: plan.members };
}

function toMpim(plan: ConversationPlan): SlackExportMpim {
  return {
    id: plan.id,
    name: plan.name,
    created: plan.created,
    creator: plan.creator,
    members: plan.members,
    topic: topic(undefined, plan.creator, plan.created),
    purpose: topic(plan.purpose, plan.creator, plan.created),
  };
}

/**
 * Yields included conversations one at a time. The whole store does not fit
 * in memory (raw Google messages are large), so callers must not hold on to
 * `messages` after they are done with a conversation.
 */
async function* eachIncludedSpace(
  storeDir: string,
  options: BuildArchiveOptions
): AsyncGenerator<LoadedSpace> {
  const store = await openStore(storeDir);
  for (const spaceId of await listStoredSpaceIds(store)) {
    // biome-ignore lint/nursery/noAwaitInLoop: spaces are read one at a time to bound memory.
    const space = await loadSpace(store, spaceId);
    if (!(space && matchesSpaceFilter(space.raw, options.spaceFilter))) {
      continue;
    }
    const excluded = options.excludeSpaces ?? [];
    if (excluded.length > 0 && matchesSpaceFilter(space.raw, excluded)) {
      continue;
    }
    const messages = await loadMessages(store, spaceId);
    yield { space, messages };
  }
}

function emptyManifest(options: BuildArchiveOptions): ArchiveManifest {
  return {
    builtAt: new Date().toISOString(),
    storeDir: options.storeDir,
    teamId: options.teamId,
    options: {
      spaceVisibility: options.spaceVisibility,
      deletedPolicy: options.deletedPolicy,
      fileStrategy: options.fileStrategy,
      filesBaseUrl: options.filesBaseUrl,
      skipBotDms: options.skipBotDms,
      firstSeenAfterRun: options.firstSeenAfterRun,
      messagesSince: options.messagesSince,
      spaceFilter: options.spaceFilter,
      excludeSpaces: options.excludeSpaces ?? [],
      spacePrefix: options.spacePrefix || undefined,
      archiveAllSpaces: options.archiveAllSpaces || undefined,
      slackMembersFetchedAt: options.slackMembers?.fetchedAt,
    },
    users: {},
    conversations: {},
    files: {
      strategy: options.fileStrategy,
      uploads: 0,
      hosted: 0,
      linkOnly: 0,
      unavailable: 0,
    },
    totals: {
      users: 0,
      placeholders: 0,
      merge: 0,
      deactivated: 0,
      noEmail: 0,
      guests: 0,
      channels: 0,
      groups: 0,
      dms: 0,
      mpims: 0,
      skippedConversations: 0,
      messages: 0,
      omittedMessages: 0,
    },
    warnings: [],
  };
}

function countPeople(
  model: ArchiveModel,
  byChatId: Map<string, ArchiveUserMapping>
): void {
  const totals = model.manifest.totals;
  const seen = new Set<string>();
  for (const mapping of byChatId.values()) {
    if (seen.has(mapping.slackId)) {
      continue;
    }
    seen.add(mapping.slackId);
    totals.users += 1;
    totals.placeholders += mapping.placeholder ? 1 : 0;
    totals.guests += mapping.guest ? 1 : 0;
    switch (mapping.importAction) {
      case 'merge':
        totals.merge += 1;
        break;
      case 'deactivated':
        totals.deactivated += 1;
        break;
      default:
        totals.noEmail += 1;
    }
  }
}

function place(model: ArchiveModel, plan: ConversationPlan): void {
  switch (plan.kind) {
    case 'channel':
      model.channels.push(toChannel(plan));
      model.manifest.totals.channels += 1;
      break;
    case 'group':
      model.groups.push(toChannel(plan));
      model.manifest.totals.groups += 1;
      break;
    case 'dm':
      model.dms.push(toDm(plan));
      model.manifest.totals.dms += 1;
      break;
    default:
      model.mpims.push(toMpim(plan));
      model.manifest.totals.mpims += 1;
  }
}

/**
 * Drops the fields the archive never reads. The index holds the full Google
 * attachment object for every file (tens of thousands), which otherwise sits
 * in memory for the whole build.
 */
function slimAttachmentIndex(
  index: Record<string, AttachmentRecord>
): Record<string, AttachmentRecord> {
  for (const record of Object.values(index)) {
    record.raw = undefined;
    record.thumbnailUri = undefined;
  }
  return index;
}

interface Shared {
  model: ArchiveModel;
  byChatId: Map<string, ArchiveUserMapping>;
  attachmentIndex: Record<string, AttachmentRecord>;
  options: BuildArchiveOptions;
  fileCounts: { hosted: number; linkOnly: number; unavailable: number };
  conversationOptions: ConversationOptions;
}

function messageContext(
  shared: Shared,
  plan: ConversationPlan
): MessageBuildContext {
  const { options, model } = shared;
  return {
    plan,
    users: shared.byChatId,
    attachmentIndex: shared.attachmentIndex,
    options: {
      deletedPolicy: options.deletedPolicy,
      fileStrategy: options.fileStrategy,
      filesBaseUrl: options.filesBaseUrl,
      filesRoot: attachmentsFilesDir(options.storeDir),
      firstSeenAfterRun: options.firstSeenAfterRun,
      messagesSince: options.messagesSince,
      driveCopies: options.driveCopies,
    },
    uploads: model.uploads,
    hostedFiles: model.hostedFiles,
    warnings: model.manifest.warnings,
    fileCounts: shared.fileCounts,
  };
}

function recordSkipped(
  model: ArchiveModel,
  space: StoredSpace,
  messageCount: number,
  reason: string,
  plan?: ConversationPlan
): void {
  model.manifest.totals.skippedConversations += 1;
  model.manifest.conversations[space.spaceId] = {
    kind: plan?.kind ?? 'group',
    id: plan?.id ?? '',
    name: plan?.name ?? space.displayName,
    googleName: space.name,
    spaceType: space.spaceType,
    members: plan?.members ?? [],
    messages: 0,
    omitted: messageCount,
    days: 0,
    skippedReason: reason,
  };
}

function addConversation(
  model: ArchiveModel,
  key: string,
  plan: ConversationPlan,
  built: BuiltMessages
): ArchiveConversation {
  const conversation: ArchiveConversation = {
    plan,
    days: built.days,
    messageCount: built.count,
    omittedCount: built.omitted,
  };
  model.conversations.push(conversation);
  place(model, plan);
  model.manifest.totals.messages += built.count;
  model.manifest.totals.omittedMessages += built.omitted;
  model.manifest.conversations[key] = {
    kind: plan.kind,
    id: plan.id,
    name: plan.name,
    googleName: plan.googleName,
    spaceType: plan.spaceType,
    members: plan.members,
    messages: built.count,
    omitted: built.omitted,
    days: Object.keys(built.days).length,
    ...(plan.archived ? { archiveAfterImport: true } : {}),
  };
  return conversation;
}

/** Manifest key for a conversation that exists only to hold meeting chats. */
const MEETING_HOME_PREFIX = 'meetings:';
/** A fresh object each time: homes must not share one `days` map. */
function emptyBuilt(): BuiltMessages {
  return { days: {}, count: 0, omitted: 0 };
}

/** The DM or group DM these exact people already have, or a new one. */
function directHome(
  shared: Shared,
  meeting: PendingMeeting,
  people: string[]
): ArchiveConversation {
  const key = memberKey(people);
  const existing = shared.model.conversations.find(
    (c) =>
      (c.plan.kind === 'dm' || c.plan.kind === 'mpim') &&
      memberKey(c.plan.members) === key
  );
  if (existing) {
    return existing;
  }
  const asGroupChat: StoredSpace = {
    ...meeting.space,
    spaceType: people.length === 2 ? 'DIRECT_MESSAGE' : 'GROUP_CHAT',
  };
  const plan = planConversation(
    { space: asGroupChat, messages: meeting.messages, users: shared.byChatId },
    shared.conversationOptions
  );
  plan.spaceId = `${MEETING_HOME_PREFIX}${plan.id}`;
  return addConversation(shared.model, plan.spaceId, plan, emptyBuilt());
}

/** One private channel per meeting series, for meetings too big or too small for a DM. */
function seriesHome(
  shared: Shared,
  meeting: PendingMeeting,
  people: string[],
  seriesChannels: Map<string, ArchiveConversation>
): ArchiveConversation {
  const series = meetingSeries(meeting.space.displayName);
  const known = seriesChannels.get(series);
  if (known) {
    // In place: groups.json and the manifest hold this same array.
    for (const person of people) {
      if (!known.plan.members.includes(person)) {
        known.plan.members.push(person);
      }
    }
    return known;
  }
  const plan: ConversationPlan = {
    kind: 'group',
    id: slackIdFor('G', `meeting-series:${series}`),
    name: uniqueName(
      prefixedChannelName(
        shared.conversationOptions.spacePrefix ?? '',
        `mtg-${series}`,
        `mtg-${meeting.space.spaceId.toLowerCase()}`
      ),
      shared.conversationOptions.usedNames
    ),
    spaceId: `${MEETING_HOME_PREFIX}${series}`,
    googleName: meeting.space.name,
    googleDisplayName: series,
    spaceType: 'SPACE',
    // A copy: it grows with each meeting, and the first meeting's own
    // manifest entry keeps just that meeting's people.
    members: [...people],
    creator: people[0] ?? '',
    created:
      Math.floor(Date.parse(meeting.space.raw.createTime ?? '') / 1000) || 0,
    purpose: `Google Meet chats from "${series}", one thread per meeting.`,
    archived: shared.conversationOptions.archiveAllSpaces || undefined,
  };
  const conversation = addConversation(
    shared.model,
    plan.spaceId,
    plan,
    emptyBuilt()
  );
  seriesChannels.set(series, conversation);
  return conversation;
}

/**
 * Files each meeting chat with the conversation its people already have,
 * one thread per meeting. Runs after every other conversation is planned, so
 * a DM is found wherever it sat in the store.
 */
function foldMeetings(shared: Shared, meetings: PendingMeeting[]): void {
  const { model } = shared;
  const seriesChannels = new Map<string, ArchiveConversation>();
  const ordered = [...meetings].sort((a, b) =>
    (a.space.raw.createTime ?? '').localeCompare(b.space.raw.createTime ?? '')
  );
  for (const meeting of ordered) {
    const people = participantsOf({
      space: meeting.space,
      messages: meeting.messages,
      users: shared.byChatId,
    }).map((p) => p.mapping.slackId);
    const home =
      people.length >= 2 && people.length <= MPIM_MAX_MEMBERS
        ? directHome(shared, meeting, people)
        : seriesHome(shared, meeting, people, seriesChannels);
    const firstUpload = model.uploads.length;
    const built = buildConversationMessages(
      meeting.messages,
      messageContext(shared, home.plan)
    );
    const header = threadUnderHeader(
      Object.values(built.days).flat(),
      meetingHeaderText(meeting.space),
      tsSet(home)
    );
    for (const upload of model.uploads.slice(firstUpload)) {
      upload.threadTs = header?.ts;
    }
    mergeDays(home, built.days, header ? [header] : []);
    const added = built.count + (header ? 1 : 0);
    home.messageCount += added;
    home.omittedCount += built.omitted;
    model.manifest.totals.messages += added;
    model.manifest.totals.omittedMessages += built.omitted;
    const homeEntry = model.manifest.conversations[home.plan.spaceId];
    if (homeEntry) {
      homeEntry.messages = home.messageCount;
      homeEntry.days = Object.keys(home.days).length;
      homeEntry.members = home.plan.members;
    }
    model.manifest.conversations[meeting.space.spaceId] = {
      kind: home.plan.kind,
      id: home.plan.id,
      name: home.plan.name,
      googleName: meeting.space.name,
      spaceType: meeting.space.spaceType,
      members: people,
      messages: built.count,
      omitted: built.omitted,
      days: 0,
      mergedInto: home.plan.name,
    };
  }
}

function warnAboutInputs(
  model: ArchiveModel,
  options: BuildArchiveOptions,
  ids: Set<string>,
  allUsers: Record<string, StoredUser>
): void {
  if (!options.slackMembers) {
    model.manifest.warnings.push(
      'No Slack member snapshot given (--slack-members); everyone is emitted deactivated and merges into existing members cannot be checked'
    );
  }
  for (const id of ids) {
    if (!allUsers[id]) {
      model.manifest.warnings.push(
        `${id} is referenced but missing from users.json; run export-workspace again`
      );
    }
  }
}

export const MEMBERS_CHANNEL_TEXT =
  'This channel lists everyone brought over from Google Chat, so Slack imports each of them along with their direct messages. It holds no conversation and can be archived after the import.';

/** A private channel whose members are every person in the archive. */
function addMembersChannel(
  model: ArchiveModel,
  name: string,
  usedNames: Set<string>
): void {
  const members = [...new Set(model.users.map((u) => u.id))];
  const creator =
    Object.values(model.manifest.users).find((u) => u.importAction === 'merge')
      ?.slackId ??
    members[0] ??
    '';
  const created = Math.floor(Date.now() / 1000);
  const plan: ConversationPlan = {
    kind: 'group',
    id: slackIdFor('G', `members-channel:${name}`),
    name: uniqueName(
      normalizeChannelName(name, 'chat-import-members'),
      usedNames
    ),
    spaceId: 'members-channel',
    googleName: '',
    googleDisplayName: name,
    spaceType: 'SPACE',
    members,
    creator,
    created,
    purpose: MEMBERS_CHANNEL_TEXT,
  };
  const ts = `${created}.000001`;
  addConversation(model, 'members-channel', plan, {
    days: {
      [new Date(created * 1000).toISOString().slice(0, 10)]: [
        {
          type: 'message',
          subtype: 'bot_message',
          username: 'Google Chat import',
          ts,
          text: MEMBERS_CHANNEL_TEXT,
        },
      ],
    },
    count: 1,
    omitted: 0,
  });
}

function warnAboutUnlisted(model: ArchiveModel, unlisted: string[]): void {
  if (unlisted.length > 0) {
    model.manifest.warnings.push(
      `${unlisted.length} Space(s) are not on the visibility list and were made private: ${unlisted.slice(0, 10).join(', ')}`
    );
  }
}

export async function buildArchiveModel(
  options: BuildArchiveOptions
): Promise<ArchiveModel> {
  const store = await openStore(options.storeDir);
  const allUsers = applyUsersOverlay(
    await loadUsers(store),
    options.usersOverlay ?? {}
  );
  const attachmentIndex = slimAttachmentIndex(await loadAttachmentIndex(store));
  // First pass: who is referenced. Users must be known before any message
  // can be built, and holding every conversation at once exhausts the heap.
  const ids = new Set<string>();
  for await (const loaded of eachIncludedSpace(options.storeDir, options)) {
    addReferencedIds(loaded, ids);
  }
  const people: StoredUser[] = Array.from(ids)
    .map((id) => allUsers[id])
    .filter((u): u is StoredUser => Boolean(u));
  const { users, byChatId } = buildUsers(people, {
    teamId: options.teamId,
    overrides: options.overrides,
    placeholderEmailDomain: options.placeholderEmailDomain,
    slackMembersByEmail: options.slackMembers
      ? indexMembersByEmail(options.slackMembers)
      : undefined,
  });

  const model: ArchiveModel = {
    users,
    channels: [],
    groups: [],
    dms: [],
    mpims: [],
    conversations: [],
    uploads: [],
    hostedFiles: [],
    manifest: emptyManifest(options),
    memberSnapshot: options.slackMembers,
  };
  for (const [chatUserId, mapping] of byChatId) {
    model.manifest.users[chatUserId] = mapping;
  }
  countPeople(model, byChatId);
  warnAboutInputs(model, options, ids, allUsers);

  const shared: Shared = {
    model,
    byChatId,
    attachmentIndex,
    options,
    fileCounts: { hosted: 0, linkOnly: 0, unavailable: 0 },
    conversationOptions: {
      spaceVisibility: options.spaceVisibility,
      skipBotDms: options.skipBotDms,
      // Existing channel names are taken, so archive history never lands in an
      // unrelated channel that happens to share a name (e.g. #general).
      usedNames: new Set(options.slackMembers?.channels?.map((c) => c.name)),
      vaultPrefix: options.vaultPrefix,
      spacePrefix: options.spacePrefix,
      archiveAllSpaces: options.archiveAllSpaces,
      visibilityBySpace: options.visibilityBySpace,
      archivedSpaces: options.archivedSpaces,
      unlisted: [],
    },
  };
  const meetingMode = options.meetingChats ?? 'fold';
  const meetings: PendingMeeting[] = [];

  for await (const { space, messages } of eachIncludedSpace(
    options.storeDir,
    options
  )) {
    if (meetingMode !== 'channels' && isMeetingChat(space)) {
      if (meetingMode === 'discard') {
        recordSkipped(
          model,
          space,
          messages.length,
          'Google Meet chat (--meeting-chats discard)'
        );
      } else {
        meetings.push({ space, messages });
      }
      continue;
    }
    const plan = planConversation(
      { space, messages, users: byChatId },
      shared.conversationOptions
    );
    if (plan.skippedReason) {
      recordSkipped(model, space, messages.length, plan.skippedReason, plan);
      continue;
    }
    const built = buildConversationMessages(
      messages,
      messageContext(shared, plan)
    );
    addConversation(model, space.spaceId, plan, built);
  }
  foldMeetings(shared, meetings);
  warnAboutUnlisted(model, shared.conversationOptions.unlisted ?? []);
  if (options.membersChannel) {
    addMembersChannel(
      model,
      options.membersChannel,
      shared.conversationOptions.usedNames
    );
  }

  const { fileCounts } = shared;
  const uploads = model.uploads;
  model.manifest.files = {
    strategy: options.fileStrategy,
    uploads: uploads.length,
    hosted: fileCounts.hosted,
    linkOnly: fileCounts.linkOnly,
    unavailable: fileCounts.unavailable,
  };
  return model;
}
