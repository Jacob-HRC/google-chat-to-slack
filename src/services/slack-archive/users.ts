/**
 * users.json for the archive. Every referenced person gets a row so the
 * importer's mapping step can match them by email to existing members.
 * People without a directory record are emitted as deactivated placeholders.
 * Rows deliberately carry nothing beyond name and email, so merging into an
 * existing member cannot overwrite profile details.
 */
import type { StoredUser } from '../../types/export-store';
import type {
  ArchiveUserMapping,
  SlackExportUser,
} from '../../types/slack-export';
import { displayNameOf } from '../user-resolver';
import { normalizeHandle, slackIdFor } from './ids';

export interface UserOverride {
  name?: string;
  email?: string;
}

export interface BuildUsersOptions {
  teamId: string;
  overrides: Record<string, UserOverride>;
  /**
   * Domain used to mint an address for someone who has none.
   *
   * Slack maps people by email and will only import a DM when every
   * participant is imported, so a person with no address silently takes their
   * conversations down with them. A synthetic address on a domain you control
   * keeps those conversations while making the account obviously a stand-in.
   * Leave unset to emit no address at all.
   */
  placeholderEmailDomain?: string;
}

export interface BuiltUsers {
  users: SlackExportUser[];
  /**
   * Every chat user id, including ones merged away, maps to the Slack user of
   * the person they actually are. One human is never two Slack accounts.
   */
  byChatId: Map<string, ArchiveUserMapping>;
}

const LEADING_AT = /^@+/;
const MULTI_SPACE = /\s+/g;

function normalizeName(value: string): string {
  return value.toLowerCase().replace(MULTI_SPACE, ' ').trim();
}

function handleFor(
  email: string | undefined,
  name: string,
  chatUserId: string,
  used: Set<string>
): string {
  const seed = email ? email.split('@')[0] : name;
  const base = normalizeHandle(seed, `user-${chatUserId.slice(-6)}`);
  let candidate = base;
  let counter = 2;
  while (used.has(candidate)) {
    candidate = `${base.slice(0, 18)}-${counter}`;
    counter += 1;
  }
  used.add(candidate);
  return candidate;
}

export function isDeactivatedInSlack(user: StoredUser): boolean {
  return user.status !== 'active';
}

/**
 * Bots never need a Slack account: their messages are written with the
 * `bot_message` subtype and a `username`, not a user id.
 */
export function needsSlackAccount(user: StoredUser): boolean {
  return user.status !== 'bot' && user.status !== 'group';
}

/** Obviously a stand-in, and stable across builds. */
export function placeholderEmail(chatUserId: string, domain: string): string {
  const suffix = chatUserId.replace('users/', '').slice(-10).toLowerCase();
  return `chat-import-${suffix}@${domain.replace(LEADING_AT, '')}`;
}

interface BuiltRow {
  user: SlackExportUser;
  mapping: ArchiveUserMapping;
}

function buildRow(
  person: StoredUser,
  options: BuildUsersOptions,
  used: Set<string>
): BuiltRow {
  const override = options.overrides[person.chatUserId] ?? {};
  const name = override.name ?? displayNameOf(person, person.chatUserId);
  const email =
    override.email ??
    person.email ??
    (options.placeholderEmailDomain
      ? placeholderEmail(person.chatUserId, options.placeholderEmailDomain)
      : undefined);
  const slackId = slackIdFor('U', person.chatUserId);
  const deleted = isDeactivatedInSlack(person);
  const handle = handleFor(email, name, person.chatUserId, used);

  return {
    user: {
      id: slackId,
      team_id: options.teamId,
      name: handle,
      deleted,
      real_name: name,
      profile: {
        real_name: name,
        real_name_normalized: normalizeName(name),
        display_name: name,
        display_name_normalized: normalizeName(name),
        email,
        team: options.teamId,
      },
      is_bot: false,
      is_app_user: false,
    },
    mapping: {
      slackId,
      name,
      email,
      status: person.status,
      placeholder: person.isPlaceholder || Boolean(override.name),
      deleted,
    },
  };
}

/** Builds Slack user rows for the given people, in a stable order. */
export function buildUsers(
  people: StoredUser[],
  options: BuildUsersOptions
): BuiltUsers {
  const used = new Set<string>();
  const users: SlackExportUser[] = [];
  const byChatId = new Map<string, ArchiveUserMapping>();
  const sorted = [...people].sort((a, b) =>
    a.chatUserId.localeCompare(b.chatUserId)
  );
  const byId = new Map(people.map((person) => [person.chatUserId, person]));
  const merged: [string, string][] = [];

  for (const person of sorted) {
    if (!needsSlackAccount(person)) {
      continue;
    }
    if (person.aliasOf) {
      // The same human under another record; resolved once everyone is built.
      merged.push([person.chatUserId, person.aliasOf]);
      continue;
    }
    const row = buildRow(person, options, used);
    users.push(row.user);
    byChatId.set(person.chatUserId, row.mapping);
  }

  // Point every merged record at the surviving person's Slack user.
  for (const [chatUserId, aliasOf] of merged) {
    let target = aliasOf;
    const seen = new Set<string>([chatUserId]);
    while (!(byChatId.has(target) || seen.has(target))) {
      seen.add(target);
      const next = byId.get(target)?.aliasOf;
      if (!next) {
        break;
      }
      target = next;
    }
    const mapping = byChatId.get(target);
    if (mapping) {
      byChatId.set(chatUserId, mapping);
    }
  }
  return { users, byChatId };
}
