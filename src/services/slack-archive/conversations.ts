/**
 * Decides what each Google conversation becomes in Slack.
 *
 * - Named Space → private channel (`groups.json`) or public channel.
 * - Two people → DM. Three to nine → group DM (mpim). More → private channel,
 *   since Slack group DMs hold at most nine people.
 * - A DM or group chat where only one person is still identifiable → private
 *   channel `archive-dm-<name>`, because a Slack DM needs two members.
 * - DMs with bots are skipped unless asked for.
 */
import type { StoredMessage, StoredSpace } from '../../types/export-store';
import type {
  ArchiveUserMapping,
  ConversationPlan,
} from '../../types/slack-export';
import { toEpochMicros } from '../../utils/timestamps';
import { mpimName, normalizeChannelName, slackIdFor, uniqueName } from './ids';

export const MPIM_MAX_MEMBERS = 9;

export type SpaceVisibility = 'private' | 'public';

export interface ConversationOptions {
  spaceVisibility: SpaceVisibility;
  skipBotDms: boolean;
  usedNames: Set<string>;
}

export interface ConversationInput {
  space: StoredSpace;
  messages: StoredMessage[];
  users: Map<string, ArchiveUserMapping>;
}

function epochSeconds(rfc3339: string | undefined, fallback: number): number {
  if (!rfc3339) {
    return fallback;
  }
  try {
    return Number(toEpochMicros(rfc3339) / 1_000_000n);
  } catch {
    return fallback;
  }
}

/** Human participants: members plus anyone who wrote, in first-seen order. */
export function participantsOf(
  input: ConversationInput
): Array<{ chatUserId: string; mapping: ArchiveUserMapping }> {
  const seen = new Set<string>();
  const result: Array<{ chatUserId: string; mapping: ArchiveUserMapping }> = [];
  const consider = (chatUserId: string | undefined): void => {
    if (!chatUserId || seen.has(chatUserId)) {
      return;
    }
    const mapping = input.users.get(chatUserId);
    if (!mapping || mapping.status === 'bot') {
      return;
    }
    seen.add(chatUserId);
    result.push({ chatUserId, mapping });
  };
  for (const membership of input.space.memberships) {
    if (membership.memberType === 'HUMAN') {
      consider(membership.chatUserId);
    }
  }
  for (const message of input.messages) {
    if (message.senderType !== 'BOT') {
      consider(message.senderId);
    }
  }
  return result;
}

function creatorOf(
  input: ConversationInput,
  members: Array<{ chatUserId: string; mapping: ArchiveUserMapping }>
): string {
  const manager = input.space.memberships.find(
    (m) => m.role === 'ROLE_MANAGER' && m.chatUserId
  );
  const managerMapping = manager?.chatUserId
    ? input.users.get(manager.chatUserId)
    : undefined;
  if (managerMapping) {
    return managerMapping.slackId;
  }
  return members[0]?.mapping.slackId ?? '';
}

function createdAt(input: ConversationInput): number {
  const first = input.messages[0]?.createTime;
  const fallback = epochSeconds(first, Math.floor(Date.now() / 1000));
  return epochSeconds(input.space.raw.createTime ?? undefined, fallback);
}

function base(
  input: ConversationInput,
  members: Array<{ chatUserId: string; mapping: ArchiveUserMapping }>
): Omit<ConversationPlan, 'kind' | 'id' | 'name'> {
  return {
    spaceId: input.space.spaceId,
    googleName: input.space.name,
    googleDisplayName:
      input.space.derivedDisplayName || input.space.displayName || '',
    spaceType: input.space.spaceType,
    members: members.map((m) => m.mapping.slackId),
    creator: creatorOf(input, members),
    created: createdAt(input),
    purpose: input.space.raw.spaceDetails?.description ?? undefined,
    topic: input.space.raw.spaceDetails?.guidelines ?? undefined,
  };
}

function planNamedSpace(
  input: ConversationInput,
  options: ConversationOptions,
  members: Array<{ chatUserId: string; mapping: ArchiveUserMapping }>
): ConversationPlan {
  const kind = options.spaceVisibility === 'public' ? 'channel' : 'group';
  const name = uniqueName(
    normalizeChannelName(
      input.space.displayName,
      `space-${input.space.spaceId.toLowerCase()}`
    ),
    options.usedNames
  );
  return {
    ...base(input, members),
    kind,
    id: slackIdFor(kind === 'channel' ? 'C' : 'G', input.space.name),
    name,
  };
}

function planOrphanConversation(
  input: ConversationInput,
  options: ConversationOptions,
  members: Array<{ chatUserId: string; mapping: ArchiveUserMapping }>
): ConversationPlan {
  const label = members[0]?.mapping.name ?? input.space.spaceId;
  const name = uniqueName(
    normalizeChannelName(
      `archive-dm-${label}`,
      `archive-dm-${input.space.spaceId.toLowerCase()}`
    ),
    options.usedNames
  );
  return {
    ...base(input, members),
    kind: 'group',
    id: slackIdFor('G', input.space.name),
    name,
    purpose:
      'Archived Google Chat conversation. The other participant no longer has an account, so this could not be imported as a direct message.',
  };
}

function planLargeGroup(
  input: ConversationInput,
  options: ConversationOptions,
  members: Array<{ chatUserId: string; mapping: ArchiveUserMapping }>
): ConversationPlan {
  const label = members
    .slice(0, 4)
    .map((m) => m.mapping.name.split(' ')[0])
    .join('-');
  const name = uniqueName(
    normalizeChannelName(
      `group-${label}`,
      `group-${input.space.spaceId.toLowerCase()}`
    ),
    options.usedNames
  );
  return {
    ...base(input, members),
    kind: 'group',
    id: slackIdFor('G', input.space.name),
    name,
    purpose: `Archived Google Chat group conversation with ${members.length} people (more than Slack allows in a group DM).`,
  };
}

/** Plans one conversation. `skippedReason` is set when it will not be written. */
export function planConversation(
  input: ConversationInput,
  options: ConversationOptions
): ConversationPlan {
  const members = participantsOf(input);
  const { space } = input;

  if (space.spaceType === 'SPACE') {
    return planNamedSpace(input, options, members);
  }

  if (space.isBotDm && options.skipBotDms) {
    return {
      ...base(input, members),
      kind: 'dm',
      id: slackIdFor('D', space.name),
      name: slackIdFor('D', space.name),
      skippedReason:
        'DM with a Chat app or bot (use --include-bot-dms to keep)',
    };
  }

  if (members.length <= 1) {
    return planOrphanConversation(input, options, members);
  }
  if (members.length === 2) {
    const id = slackIdFor('D', space.name);
    return { ...base(input, members), kind: 'dm', id, name: id };
  }
  if (members.length <= MPIM_MAX_MEMBERS) {
    const handles = members.map((m) =>
      normalizeChannelName(m.mapping.name, m.mapping.slackId.toLowerCase())
    );
    return {
      ...base(input, members),
      kind: 'mpim',
      id: slackIdFor('G', space.name),
      name: uniqueName(mpimName(handles), options.usedNames),
    };
  }
  return planLargeGroup(input, options, members);
}
