/**
 * Maps Chat user ids (`users/<id>`) to Workspace directory records, and
 * synthesizes placeholders for people who no longer exist so their messages
 * are never dropped.
 */
import type {
  StoredUser,
  StoredUserStatus,
  UserSource,
} from '../types/export-store';
import { mapWithConcurrency } from '../utils/concurrency';
import type { DomainUser } from './directory';

const USERS_PREFIX_REGEX = /^users\//;

export interface ChatUserRef {
  chatUserId: string;
  type?: string;
  displayName?: string;
  domainId?: string;
  affiliation?: string;
  sources: Set<UserSource>;
}

export type DirectoryLookup = (
  directoryId: string
) => Promise<DomainUser | undefined>;

export interface ResolveOptions {
  runId: string;
  now: string;
  /** Re-query the directory even for users resolved in earlier runs. */
  refresh?: boolean;
  concurrency?: number;
}

export function directoryIdOf(chatUserId: string): string {
  return chatUserId.replace(USERS_PREFIX_REGEX, '');
}

export function placeholderName(
  chatUserId: string,
  status: StoredUserStatus
): string {
  const suffix = directoryIdOf(chatUserId).slice(-6);
  if (status === 'bot') {
    return `Bot ${suffix}`;
  }
  if (status === 'external') {
    return `External user ${suffix}`;
  }
  if (status === 'group') {
    return `Group ${suffix}`;
  }
  return `Former user ${suffix}`;
}

export function addUserRef(
  refs: Map<string, ChatUserRef>,
  chatUserId: string | undefined,
  source: UserSource,
  extra: Partial<Omit<ChatUserRef, 'chatUserId' | 'sources'>> = {}
): void {
  if (!chatUserId) {
    return;
  }
  const existing = refs.get(chatUserId);
  if (existing) {
    existing.sources.add(source);
    existing.type = existing.type ?? extra.type;
    existing.displayName = existing.displayName ?? extra.displayName;
    existing.domainId = existing.domainId ?? extra.domainId;
    existing.affiliation = existing.affiliation ?? extra.affiliation;
    return;
  }
  refs.set(chatUserId, {
    chatUserId,
    type: extra.type,
    displayName: extra.displayName,
    domainId: extra.domainId,
    affiliation: extra.affiliation,
    sources: new Set([source]),
  });
}

function statusFromDirectory(user: DomainUser): StoredUserStatus {
  if (user.archived) {
    return 'archived';
  }
  if (user.suspended) {
    return 'suspended';
  }
  return 'active';
}

function fromDirectory(
  ref: ChatUserRef,
  user: DomainUser,
  existing: StoredUser | undefined,
  options: ResolveOptions
): StoredUser {
  return {
    chatUserId: ref.chatUserId,
    directoryId: user.id,
    email: user.email,
    fullName: user.fullName,
    chatDisplayName: ref.displayName ?? existing?.chatDisplayName,
    status: statusFromDirectory(user),
    isPlaceholder: false,
    orgUnitPath: user.orgUnitPath,
    domainId: ref.domainId ?? existing?.domainId,
    sources: Array.from(
      new Set([...(existing?.sources ?? []), ...ref.sources, 'directory'])
    ),
    firstSeenRun: existing?.firstSeenRun ?? options.runId,
    lastResolvedAt: options.now,
    lastResolvedRun: options.runId,
  };
}

function asPlaceholder(
  ref: ChatUserRef,
  status: StoredUserStatus,
  existing: StoredUser | undefined,
  options: ResolveOptions,
  error?: string
): StoredUser {
  return {
    chatUserId: ref.chatUserId,
    directoryId: existing?.directoryId ?? directoryIdOf(ref.chatUserId),
    email: existing?.email,
    fullName: existing?.fullName ?? ref.displayName,
    chatDisplayName: ref.displayName ?? existing?.chatDisplayName,
    status,
    isPlaceholder: true,
    placeholderName: ref.displayName ?? placeholderName(ref.chatUserId, status),
    orgUnitPath: existing?.orgUnitPath,
    domainId: ref.domainId ?? existing?.domainId,
    sources: Array.from(
      new Set([...(existing?.sources ?? []), ...ref.sources])
    ),
    firstSeenRun: existing?.firstSeenRun ?? options.runId,
    lastResolvedAt: options.now,
    lastResolvedRun: options.runId,
    error,
  };
}

function needsLookup(
  existing: StoredUser | undefined,
  options: ResolveOptions
): boolean {
  if (!existing || options.refresh) {
    return true;
  }
  return existing.status === 'unknown';
}

async function resolveOne(
  ref: ChatUserRef,
  existing: StoredUser | undefined,
  lookup: DirectoryLookup,
  options: ResolveOptions
): Promise<StoredUser> {
  if (ref.type === 'BOT') {
    return asPlaceholder(ref, 'bot', existing, options);
  }
  if (!needsLookup(existing, options) && existing) {
    return {
      ...existing,
      sources: Array.from(new Set([...existing.sources, ...ref.sources])),
      chatDisplayName: existing.chatDisplayName ?? ref.displayName,
    };
  }
  try {
    const user = await lookup(directoryIdOf(ref.chatUserId));
    if (user) {
      return fromDirectory(ref, user, existing, options);
    }
    const status: StoredUserStatus =
      ref.affiliation === 'EXTERNAL' || ref.affiliation === 'MANAGED_EXTERNAL'
        ? 'external'
        : 'deleted';
    return asPlaceholder(ref, status, existing, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return asPlaceholder(ref, 'unknown', existing, options, message);
  }
}

/**
 * Resolves every referenced Chat user. Already resolved users are reused
 * unless `refresh` is set or their previous lookup failed.
 */
export async function resolveChatUsers(
  refs: Map<string, ChatUserRef>,
  existingUsers: Record<string, StoredUser>,
  lookup: DirectoryLookup,
  options: ResolveOptions
): Promise<Record<string, StoredUser>> {
  const result: Record<string, StoredUser> = { ...existingUsers };
  const list = Array.from(refs.values());
  const resolved = await mapWithConcurrency(
    list,
    options.concurrency ?? 4,
    (ref) => resolveOne(ref, existingUsers[ref.chatUserId], lookup, options)
  );
  for (const user of resolved) {
    result[user.chatUserId] = user;
  }
  return result;
}

/** Best human-readable name for a stored user. */
export function displayNameOf(
  user: StoredUser | undefined,
  chatUserId: string
): string {
  if (!user) {
    return placeholderName(chatUserId, 'unknown');
  }
  return (
    user.fullName ??
    user.chatDisplayName ??
    user.placeholderName ??
    user.email ??
    placeholderName(chatUserId, user.status)
  );
}
