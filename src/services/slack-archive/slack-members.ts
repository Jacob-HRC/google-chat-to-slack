/**
 * A snapshot of who already exists in the destination Slack workspace.
 *
 * Slack's importer maps archive users to existing members by email. The
 * archive builder needs that list to decide, per person, whether the import
 * will merge into an existing member or create a new one, and to emit the new
 * ones as deactivated so nobody is invited or notified before the migration
 * is announced. The snapshot is fetched once (`slack-members` command) and
 * written to disk, so the archive build itself stays offline.
 */
import type { WebClient } from '@slack/web-api';

export interface SlackMember {
  id: string;
  name: string;
  realName?: string;
  email?: string;
  deleted: boolean;
  isBot: boolean;
  /** Guest accounts. Slack cannot merge imported people into these. */
  isGuest: boolean;
}

export interface SlackMemberSnapshot {
  fetchedAt: string;
  teamId: string;
  teamName: string;
  teamDomain: string;
  members: SlackMember[];
}

/**
 * What the importer's mapping screen should default to for a person, given
 * the snapshot.
 *
 * - merge: an existing member has this email; their messages attach to it.
 * - deactivated: nobody has this email; the account is created deactivated,
 *   so it is not billed, cannot sign in and receives no invitation.
 * - no-email: nothing to map by, so the person is emitted deactivated but
 *   Slack will offer only "Import just their messages", dropping their DMs.
 */
export type ImportAction = 'merge' | 'deactivated' | 'no-email';

export interface ImportDecision {
  action: ImportAction;
  /** The member the email matched, when the action is merge. */
  member?: SlackMember;
  /** Slack forbids merging into guests; flagged so it is handled by hand. */
  guest: boolean;
}

type UsersListPage = Awaited<ReturnType<WebClient['users']['list']>>;
type RawMember = NonNullable<UsersListPage['members']>[number];

function toMember(raw: RawMember): SlackMember | undefined {
  if (!raw.id) {
    return;
  }
  return {
    id: raw.id,
    name: raw.name ?? '',
    realName: raw.real_name ?? raw.profile?.real_name,
    email: raw.profile?.email?.toLowerCase(),
    deleted: raw.deleted ?? false,
    isBot: Boolean(raw.is_bot) || raw.id === 'USLACKBOT',
    isGuest: Boolean(raw.is_restricted || raw.is_ultra_restricted),
  };
}

/** Pages through users.list and team.info. Needs users:read, users:read.email, team:read. */
export async function fetchSlackMembers(
  client: WebClient
): Promise<SlackMemberSnapshot> {
  const team = await client.team.info();
  const members: SlackMember[] = [];
  let cursor: string | undefined;
  do {
    // biome-ignore lint/nursery/noAwaitInLoop: pages are sequential by cursor.
    const page: UsersListPage = await client.users.list({
      limit: 200,
      cursor,
    });
    for (const raw of page.members ?? []) {
      const member = toMember(raw);
      if (member) {
        members.push(member);
      }
    }
    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor);

  return {
    fetchedAt: new Date().toISOString(),
    teamId: team.team?.id ?? '',
    teamName: team.team?.name ?? '',
    teamDomain: team.team?.domain ?? '',
    members,
  };
}

/** Human members keyed by lower-cased email. Bots and members without an address are left out. */
export function indexMembersByEmail(
  snapshot: SlackMemberSnapshot
): Map<string, SlackMember> {
  const index = new Map<string, SlackMember>();
  for (const member of snapshot.members) {
    if (member.isBot || !member.email) {
      continue;
    }
    const key = member.email.toLowerCase();
    const existing = index.get(key);
    // Prefer an active account when two share an address.
    if (!existing || (existing.deleted && !member.deleted)) {
      index.set(key, member);
    }
  }
  return index;
}

/**
 * Decides the import action for one email. Without a snapshot every person
 * with an address is emitted deactivated: the importer still merges anyone
 * whose email matches, and nobody new gets an active, invitable account.
 */
export function decideImportAction(
  email: string | undefined,
  membersByEmail: Map<string, SlackMember> | undefined
): ImportDecision {
  if (!email) {
    return { action: 'no-email', guest: false };
  }
  const member = membersByEmail?.get(email.toLowerCase());
  if (!member) {
    return { action: 'deactivated', guest: false };
  }
  return { action: 'merge', member, guest: member.isGuest };
}

export function summarizeSnapshot(snapshot: SlackMemberSnapshot): {
  active: number;
  deactivated: number;
  bots: number;
  guests: number;
  withoutEmail: number;
} {
  const humans = snapshot.members.filter((m) => !m.isBot);
  return {
    active: humans.filter((m) => !m.deleted).length,
    deactivated: humans.filter((m) => m.deleted).length,
    bots: snapshot.members.length - humans.length,
    guests: humans.filter((m) => m.isGuest).length,
    withoutEmail: humans.filter((m) => !m.email).length,
  };
}
