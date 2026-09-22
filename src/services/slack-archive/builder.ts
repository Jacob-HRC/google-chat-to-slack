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
  ConversationPlan,
  FileUploadTask,
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
import { matchesSpaceFilter } from '../workspace-export';
import {
  type ConversationOptions,
  planConversation,
  type SpaceVisibility,
} from './conversations';
import {
  buildConversationMessages,
  type DeletedPolicy,
  type FileStrategy,
  type MessageBuildContext,
} from './messages';
import { buildUsers, type UserOverride } from './users';

export interface BuildArchiveOptions {
  storeDir: string;
  teamId: string;
  spaceFilter: string[];
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
}

interface LoadedSpace {
  space: StoredSpace;
  messages: StoredMessage[];
}

function referencedChatIds(loaded: LoadedSpace[]): Set<string> {
  const ids = new Set<string>();
  for (const { space, messages } of loaded) {
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
  return ids;
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

async function loadIncludedSpaces(
  storeDir: string,
  options: BuildArchiveOptions
): Promise<LoadedSpace[]> {
  const store = await openStore(storeDir);
  const loaded: LoadedSpace[] = [];
  for (const spaceId of await listStoredSpaceIds(store)) {
    // biome-ignore lint/nursery/noAwaitInLoop: spaces are read one at a time to bound memory.
    const space = await loadSpace(store, spaceId);
    if (!(space && matchesSpaceFilter(space.raw, options.spaceFilter))) {
      continue;
    }
    const messages = await loadMessages(store, spaceId);
    loaded.push({ space, messages });
  }
  return loaded;
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

export async function buildArchiveModel(
  options: BuildArchiveOptions
): Promise<ArchiveModel> {
  const store = await openStore(options.storeDir);
  const allUsers = await loadUsers(store);
  const attachmentIndex: Record<string, AttachmentRecord> =
    await loadAttachmentIndex(store);
  const loaded = await loadIncludedSpaces(options.storeDir, options);

  const ids = referencedChatIds(loaded);
  const people: StoredUser[] = Array.from(ids)
    .map((id) => allUsers[id])
    .filter((u): u is StoredUser => Boolean(u));
  const { users, byChatId } = buildUsers(people, {
    teamId: options.teamId,
    overrides: options.overrides,
  });

  const model: ArchiveModel = {
    users,
    channels: [],
    groups: [],
    dms: [],
    mpims: [],
    conversations: [],
    uploads: [],
    manifest: emptyManifest(options),
  };
  for (const [chatUserId, mapping] of byChatId) {
    model.manifest.users[chatUserId] = mapping;
  }
  model.manifest.totals.users = users.length;
  model.manifest.totals.placeholders = Array.from(byChatId.values()).filter(
    (m) => m.placeholder
  ).length;
  for (const id of ids) {
    if (!allUsers[id]) {
      model.manifest.warnings.push(
        `${id} is referenced but missing from users.json; run export-workspace again`
      );
    }
  }

  const conversationOptions: ConversationOptions = {
    spaceVisibility: options.spaceVisibility,
    skipBotDms: options.skipBotDms,
    usedNames: new Set(),
    vaultPrefix: options.vaultPrefix,
  };
  const uploads: FileUploadTask[] = model.uploads;
  const fileCounts = { hosted: 0, linkOnly: 0, unavailable: 0 };

  for (const { space, messages } of loaded) {
    const plan = planConversation(
      { space, messages, users: byChatId },
      conversationOptions
    );
    if (plan.skippedReason) {
      model.manifest.totals.skippedConversations += 1;
      model.manifest.conversations[space.spaceId] = {
        kind: plan.kind,
        id: plan.id,
        name: plan.name,
        googleName: plan.googleName,
        spaceType: plan.spaceType,
        members: plan.members,
        messages: 0,
        omitted: messages.length,
        days: 0,
        skippedReason: plan.skippedReason,
      };
      continue;
    }
    const ctx: MessageBuildContext = {
      plan,
      users: byChatId,
      attachmentIndex,
      options: {
        deletedPolicy: options.deletedPolicy,
        fileStrategy: options.fileStrategy,
        filesBaseUrl: options.filesBaseUrl,
        filesRoot: attachmentsFilesDir(options.storeDir),
        firstSeenAfterRun: options.firstSeenAfterRun,
        messagesSince: options.messagesSince,
      },
      uploads,
      warnings: model.manifest.warnings,
      fileCounts,
    };
    const built = buildConversationMessages(messages, ctx);
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
    model.manifest.conversations[space.spaceId] = {
      kind: plan.kind,
      id: plan.id,
      name: plan.name,
      googleName: plan.googleName,
      spaceType: plan.spaceType,
      members: plan.members,
      messages: built.count,
      omitted: built.omitted,
      days: Object.keys(built.days).length,
    };
  }

  model.manifest.files = {
    strategy: options.fileStrategy,
    uploads: uploads.length,
    hosted: fileCounts.hosted,
    linkOnly: fileCounts.linkOnly,
    unavailable: fileCounts.unavailable,
  };
  return model;
}
