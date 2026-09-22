import { type admin_directory_v1, google } from 'googleapis';
import { config } from '../config';
import { withGoogleDirectoryRateLimit } from '../utils/rate-limiting';
import { getGoogleAuthClient } from './google-auth';

/** The subset of a Directory user this tool needs. */
export interface DomainUser {
  /** Directory user ID; matches the numeric part of Chat's `users/<id>`. */
  id: string;
  email: string;
  fullName: string;
  suspended: boolean;
  archived: boolean;
  orgUnitPath: string;
}

export interface UserSelection {
  /** Lower-cased primary emails. Empty means "everyone in scope". */
  emails: string[];
  /** Org unit path such as `/Staff`. Matches the unit and everything below it. */
  orgUnit?: string;
  /** Keep suspended and archived users in the result. */
  includeSuspended: boolean;
}

export interface UserSelectionInput {
  users?: string | string[];
  orgUnit?: string;
  includeSuspended?: boolean;
}

export interface UserSelectionEnv {
  GOOGLE_EXPORT_USERS?: string;
  GOOGLE_EXPORT_ORG_UNIT?: string;
}

const WHITESPACE_REGEX = /\s/;
const SINGLE_QUOTE_REGEX = /'/g;

const USER_FIELDS =
  'id,primaryEmail,name/fullName,suspended,archived,orgUnitPath';
const LIST_FIELDS = `nextPageToken,users(${USER_FIELDS})`;
const MAX_RESULTS = 500;

export function parseUserList(value?: string | string[]): string[] {
  if (!value) {
    return [];
  }
  const raw = Array.isArray(value) ? value : [value];
  const emails = raw
    .flatMap((entry) => entry.split(','))
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  return Array.from(new Set(emails));
}

export function normalizeOrgUnitPath(orgUnit: string): string {
  const trimmed = orgUnit.trim();
  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  if (withLeadingSlash.length > 1 && withLeadingSlash.endsWith('/')) {
    return withLeadingSlash.slice(0, -1);
  }
  return withLeadingSlash;
}

/** True when `userPath` is `orgUnit` or a descendant of it. */
export function isInOrgUnit(userPath: string, orgUnit: string): boolean {
  const target = normalizeOrgUnitPath(orgUnit);
  const actual = normalizeOrgUnitPath(userPath || '/');
  if (target === '/') {
    return true;
  }
  return actual === target || actual.startsWith(`${target}/`);
}

/**
 * Merges CLI flags with config. Flags win. Emails and org unit combine with
 * AND: an explicit user list is still restricted to the org unit if one is set.
 */
export function resolveUserSelection(
  input: UserSelectionInput,
  env: UserSelectionEnv = config
): UserSelection {
  const cliEmails = parseUserList(input.users);
  const emails =
    cliEmails.length > 0 ? cliEmails : parseUserList(env.GOOGLE_EXPORT_USERS);
  const orgUnitRaw = input.orgUnit ?? env.GOOGLE_EXPORT_ORG_UNIT;
  const orgUnit = orgUnitRaw ? normalizeOrgUnitPath(orgUnitRaw) : undefined;

  return {
    emails,
    orgUnit,
    includeSuspended: input.includeSuspended ?? false,
  };
}

function quoteQueryValue(value: string): string {
  return WHITESPACE_REGEX.test(value)
    ? `'${value.replace(SINGLE_QUOTE_REGEX, "\\'")}'`
    : value;
}

/**
 * Builds the `query` for `users.list`. `orgUnitPath=` matches the unit and
 * its descendants; clauses separated by spaces are ANDed.
 * https://developers.google.com/workspace/admin/directory/v1/guides/search-users
 */
export function buildUserQuery(selection: UserSelection): string | undefined {
  const clauses: string[] = [];
  if (selection.orgUnit && selection.orgUnit !== '/') {
    clauses.push(`orgUnitPath=${quoteQueryValue(selection.orgUnit)}`);
  }
  if (!selection.includeSuspended) {
    clauses.push('isSuspended=false');
  }
  return clauses.length > 0 ? clauses.join(' ') : undefined;
}

export function toDomainUser(user: admin_directory_v1.Schema$User): DomainUser {
  return {
    id: user.id ?? '',
    email: (user.primaryEmail ?? '').toLowerCase(),
    fullName: user.name?.fullName ?? user.primaryEmail ?? '',
    suspended: user.suspended ?? false,
    archived: user.archived ?? false,
    orgUnitPath: user.orgUnitPath ?? '/',
  };
}

/** Applies a selection to an already fetched user list. Pure. */
export function selectUsers(
  users: DomainUser[],
  selection: UserSelection
): DomainUser[] {
  const wanted = new Set(selection.emails);
  return users
    .filter((user) => wanted.size === 0 || wanted.has(user.email))
    .filter(
      (user) =>
        !selection.orgUnit || isInOrgUnit(user.orgUnitPath, selection.orgUnit)
    )
    .filter(
      (user) => selection.includeSuspended || !(user.suspended || user.archived)
    )
    .sort((a, b) => a.email.localeCompare(b.email));
}

async function getDirectoryClient(): Promise<admin_directory_v1.Admin> {
  const auth = await getGoogleAuthClient();
  return google.admin({ version: 'directory_v1', auth });
}

/** Fetches a single user by email or ID. Returns undefined on 404. */
export async function getDomainUser(
  userKey: string
): Promise<DomainUser | undefined> {
  const admin = await getDirectoryClient();
  try {
    const result = await withGoogleDirectoryRateLimit(() =>
      admin.users.get({ userKey, fields: USER_FIELDS })
    );
    return toDomainUser(result.data);
  } catch (error) {
    const status = (error as { response?: { status?: number } }).response
      ?.status;
    if (status === 404) {
      return;
    }
    throw error;
  }
}

async function listAllDomainUsers(query?: string): Promise<DomainUser[]> {
  const admin = await getDirectoryClient();
  const users: DomainUser[] = [];
  let pageToken: string | undefined;

  do {
    // biome-ignore lint/nursery/noAwaitInLoop: Directory API pagination is sequential.
    const result = await withGoogleDirectoryRateLimit(() =>
      admin.users.list({
        customer: 'my_customer',
        maxResults: MAX_RESULTS,
        orderBy: 'email',
        query,
        pageToken,
        fields: LIST_FIELDS,
      })
    );
    for (const user of result.data.users ?? []) {
      users.push(toDomainUser(user));
    }
    pageToken = result.data.nextPageToken ?? undefined;
  } while (pageToken);

  return users;
}

async function fetchUsersByEmail(emails: string[]): Promise<DomainUser[]> {
  const results = await Promise.all(
    emails.map(async (email) => ({ email, user: await getDomainUser(email) }))
  );
  const missing = results.filter((r) => !r.user).map((r) => r.email);
  if (missing.length > 0) {
    throw new Error(
      `These users were not found in the Google Workspace directory: ${missing.join(', ')}`
    );
  }
  return results.map((r) => r.user as DomainUser);
}

/**
 * Enumerates Workspace users matching the selection. An explicit email list
 * is fetched user by user; otherwise the whole customer is paged with a
 * server-side query for org unit and suspension state. The selection is
 * applied again client-side so both paths behave identically.
 */
export async function listDomainUsers(
  selection: UserSelection
): Promise<DomainUser[]> {
  const users =
    selection.emails.length > 0
      ? await fetchUsersByEmail(selection.emails)
      : await listAllDomainUsers(buildUserQuery(selection));
  return selectUsers(users, selection);
}
