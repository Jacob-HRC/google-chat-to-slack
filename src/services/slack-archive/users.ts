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
}

export interface BuiltUsers {
  users: SlackExportUser[];
  /**
   * Every chat user id, including ones merged away, maps to the Slack user of
   * the person they actually are. One human is never two Slack accounts.
   */
  byChatId: Map<string, ArchiveUserMapping>;
}

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
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
    if (person.status === 'group') {
      continue;
    }
    if (person.aliasOf) {
      // The same human under another record; resolved once everyone is built.
      merged.push([person.chatUserId, person.aliasOf]);
      continue;
    }
    const override = options.overrides[person.chatUserId] ?? {};
    const name = override.name ?? displayNameOf(person, person.chatUserId);
    const email = override.email ?? person.email;
    const slackId = slackIdFor('U', person.chatUserId);
    const deleted = isDeactivatedInSlack(person);
    const handle = handleFor(email, name, person.chatUserId, used);
    const isBot = person.status === 'bot';

    users.push({
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
      is_bot: isBot,
      is_app_user: false,
    });
    byChatId.set(person.chatUserId, {
      slackId,
      name,
      email,
      status: person.status,
      placeholder: person.isPlaceholder || Boolean(override.name),
      deleted,
    });
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
