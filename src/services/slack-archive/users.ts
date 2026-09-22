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

  for (const person of sorted) {
    if (person.status === 'group') {
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

  return { users, byChatId };
}
