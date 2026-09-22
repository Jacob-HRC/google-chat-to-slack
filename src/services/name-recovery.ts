/**
 * Recovers real names, and where possible emails, for people whose Google
 * accounts are gone.
 *
 * The Directory API knows nothing about a deleted account, so those senders
 * land in the store as placeholders like `Former user 297491`. Three sources
 * still carry their identity:
 *
 * 1. `sender.displayName` on stored Chat API messages, when Google populated it.
 * 2. `USER_MENTION` annotations, whose `startIndex`/`length` point at the
 *    `@Name` span inside the plain `text` of the message that mentioned them.
 * 3. Google Vault, which records participant *emails* for the spaces it
 *    exported. Those join back to a name by the shape of the address.
 *
 * Nothing here overwrites a name the Directory supplied.
 */
import type { StoredMessage, StoredUser } from '../types/export-store';
import { isGenericDisplayName } from './user-resolver';

const AT_PREFIX = /^@+/;
const NON_NAME = /[^\p{L}\p{N}'\- ]/gu;
const SPACES = /\s+/g;
const EMAIL_SEPARATORS = /[._\-+]+/g;
const EMAIL_SHAPED = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type NameConfidence = 'high' | 'medium';

export interface NameEvidence {
  chatUserId: string;
  /** Candidate name → weighted score. */
  candidates: Map<string, number>;
  fromDisplayName: boolean;
  mentionCount: number;
}

export interface RecoveredName {
  chatUserId: string;
  name: string;
  confidence: NameConfidence;
  /** Other spellings seen, e.g. a maiden name, most frequent first. */
  alternates: string[];
  fromDisplayName: boolean;
  mentionCount: number;
  /** Email matched from Vault participants, when the match was unambiguous. */
  email?: string;
  emailMatch?: 'full-name' | 'first-name';
}

/** `sender.displayName` is Google's own field, so it outweighs scraped text. */
const DISPLAY_NAME_WEIGHT = 5;
const MENTION_WEIGHT = 1;

export function cleanName(raw: string): string {
  const trimmed = raw.trim();
  // External people are often identified by address alone; keep it intact
  // rather than mangling it into "someone gmail com".
  if (EMAIL_SHAPED.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  return trimmed
    .replace(AT_PREFIX, '')
    .replace(NON_NAME, ' ')
    .replace(SPACES, ' ')
    .trim();
}

/** Lower-cased, punctuation-free form used only for comparing two names. */
export function normalizeForMatch(value: string): string {
  return cleanName(value).toLowerCase();
}

/** `jenny.fuksa@hrc.email` → `jenny fuksa`. */
export function nameFromEmail(email: string): string {
  return email
    .split('@')[0]
    .replace(EMAIL_SEPARATORS, ' ')
    .replace(SPACES, ' ')
    .trim()
    .toLowerCase();
}

function addCandidate(
  evidence: NameEvidence,
  raw: string | undefined,
  weight: number
): void {
  const name = cleanName(raw ?? '');
  // A single token is usually a truncated fragment, not a person's name.
  if (!name || name.length < 3) {
    return;
  }
  // Google substitutes "Deleted User" for these accounts, which is exactly the
  // label this command exists to replace.
  if (isGenericDisplayName(name)) {
    return;
  }
  evidence.candidates.set(name, (evidence.candidates.get(name) ?? 0) + weight);
}

function evidenceFor(
  byUser: Map<string, NameEvidence>,
  chatUserId: string
): NameEvidence {
  const existing = byUser.get(chatUserId);
  if (existing) {
    return existing;
  }
  const created: NameEvidence = {
    chatUserId,
    candidates: new Map(),
    fromDisplayName: false,
    mentionCount: 0,
  };
  byUser.set(chatUserId, created);
  return created;
}

/**
 * Gathers naming evidence from one message. Vault-sourced messages are
 * ignored: they carry emails rather than ids, so they cannot name an id.
 */
interface MentionAnnotation {
  type?: string;
  startIndex?: number;
  length?: number;
  userMention?: { user?: { name?: string; displayName?: string } };
}

interface RawMessage {
  text?: string;
  sender?: { name?: string; displayName?: string };
  annotations?: MentionAnnotation[];
}

function collectFromSender(
  byUser: Map<string, NameEvidence>,
  sender: RawMessage['sender']
): void {
  if (!(sender?.name && sender.displayName)) {
    return;
  }
  const evidence = evidenceFor(byUser, sender.name);
  if (!isGenericDisplayName(sender.displayName)) {
    evidence.fromDisplayName = true;
  }
  addCandidate(evidence, sender.displayName, DISPLAY_NAME_WEIGHT);
}

function collectFromMention(
  byUser: Map<string, NameEvidence>,
  annotation: MentionAnnotation,
  text: string
): void {
  if (annotation.type !== 'USER_MENTION') {
    return;
  }
  const user = annotation.userMention?.user;
  if (!user?.name) {
    return;
  }
  const evidence = evidenceFor(byUser, user.name);
  evidence.mentionCount += 1;
  if (user.displayName) {
    if (!isGenericDisplayName(user.displayName)) {
      evidence.fromDisplayName = true;
    }
    addCandidate(evidence, user.displayName, DISPLAY_NAME_WEIGHT);
  }
  const { startIndex, length } = annotation;
  if (startIndex !== undefined && length !== undefined) {
    addCandidate(
      evidence,
      text.slice(startIndex, startIndex + length),
      MENTION_WEIGHT
    );
  }
}

/**
 * Gathers naming evidence from one message. Vault-sourced messages are
 * ignored: they carry emails rather than ids, so they cannot name an id.
 */
export function collectFromMessage(
  byUser: Map<string, NameEvidence>,
  message: StoredMessage
): void {
  if (message.source === 'vault') {
    return;
  }
  const raw = message.raw as RawMessage;
  collectFromSender(byUser, raw.sender);
  const text = raw.text ?? '';
  for (const annotation of raw.annotations ?? []) {
    collectFromMention(byUser, annotation, text);
  }
}

/**
 * Picks the best name for one person. Scraped spans are occasionally shifted
 * by a character, so the winner is chosen by weight and the rest kept as
 * alternates rather than discarded.
 */
export function chooseName(evidence: NameEvidence): RecoveredName | undefined {
  const ranked = [...evidence.candidates.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
  );
  if (ranked.length === 0) {
    return;
  }
  const [name, score] = ranked[0];
  const runnerUp = ranked[1]?.[1] ?? 0;
  // Google's own field, or a clear winner among scraped spans.
  const confidence: NameConfidence =
    evidence.fromDisplayName || score >= runnerUp * 2 ? 'high' : 'medium';
  return {
    chatUserId: evidence.chatUserId,
    name,
    confidence,
    alternates: ranked.slice(1).map(([alternate]) => alternate),
    fromDisplayName: evidence.fromDisplayName,
    mentionCount: evidence.mentionCount,
  };
}

export interface EmailCandidate {
  email: string;
  /** True when the address already belongs to a known, named person. */
  claimed: boolean;
}

/**
 * Attaches an email to a recovered name using Vault's participant addresses.
 *
 * A full-name address (`jenny.fuksa@`) is matched outright. A first-name
 * address (`james@`) is only accepted when exactly one recovered person has
 * that first name and exactly one address matches, since `james@` would
 * otherwise be guesswork between two people called James.
 */
export function matchEmails(
  names: RecoveredName[],
  emails: readonly EmailCandidate[]
): RecoveredName[] {
  const available = emails.filter((candidate) => !candidate.claimed);
  const byFullName = new Map<string, string[]>();
  const byFirstName = new Map<string, string[]>();
  for (const candidate of available) {
    const derived = nameFromEmail(candidate.email);
    const full = byFullName.get(derived) ?? [];
    full.push(candidate.email);
    byFullName.set(derived, full);
    const first = derived.split(' ')[0];
    const list = byFirstName.get(first) ?? [];
    list.push(candidate.email);
    byFirstName.set(first, list);
  }

  const firstNameCounts = new Map<string, number>();
  for (const recovered of names) {
    const first = normalizeForMatch(recovered.name).split(' ')[0];
    firstNameCounts.set(first, (firstNameCounts.get(first) ?? 0) + 1);
  }

  return names.map((recovered) => {
    const normalized = normalizeForMatch(recovered.name);
    const alternates = recovered.alternates.map(normalizeForMatch);
    const forms = [normalized, ...alternates];
    for (const [position, form] of forms.entries()) {
      const exact = byFullName.get(form);
      if (exact?.length !== 1) {
        continue;
      }
      if (position === 0) {
        return { ...recovered, email: exact[0], emailMatch: 'full-name' };
      }
      // The address spells an alternate, which is the person's current name
      // (a marriage, usually). Promote it and keep the old spelling.
      const promoted = recovered.alternates[position - 1];
      return {
        ...recovered,
        name: promoted,
        alternates: [
          recovered.name,
          ...recovered.alternates.filter((a) => a !== promoted),
        ],
        email: exact[0],
        emailMatch: 'full-name',
      };
    }
    const first = normalized.split(' ')[0];
    const byFirst = byFirstName.get(first);
    if (
      byFirst?.length === 1 &&
      firstNameCounts.get(first) === 1 &&
      nameFromEmail(byFirst[0]) === first
    ) {
      return { ...recovered, email: byFirst[0], emailMatch: 'first-name' };
    }
    return recovered;
  });
}

export interface UserAlias {
  /** The record to retire. */
  chatUserId: string;
  /** The record to keep. */
  canonical: string;
  reason: string;
}

export interface RecoveryPlan {
  aliases: UserAlias[];
  recovered: RecoveredName[];
  /** Placeholders no source could name. */
  unresolved: string[];
  /** Things a person should look at before these names are kept. */
  warnings: string[];
}

/**
 * Flags the two cases worth a human glance: one name claimed by several
 * accounts, and an address that matches an alternate spelling rather than the
 * chosen one, which usually means the person changed their name.
 */
export function reviewWarnings(recovered: RecoveredName[]): string[] {
  const warnings: string[] = [];
  const byName = new Map<string, RecoveredName[]>();
  for (const person of recovered) {
    const key = normalizeForMatch(person.name);
    const list = byName.get(key) ?? [];
    list.push(person);
    byName.set(key, list);
  }
  for (const [, people] of byName) {
    if (people.length > 1) {
      warnings.push(
        `${people[0].name} is claimed by ${people.length} accounts (${people
          .map((p) => p.chatUserId.replace('users/', '').slice(-6))
          .join(
            ', '
          )}). They may be the same person with two accounts, or two people.`
      );
    }
  }
  for (const person of recovered) {
    if (!person.email) {
      continue;
    }
    const derived = nameFromEmail(person.email);
    const matchesChosen = derived === normalizeForMatch(person.name);
    const matchingAlternate = person.alternates.find(
      (alternate) => normalizeForMatch(alternate) === derived
    );
    if (!matchesChosen && matchingAlternate) {
      warnings.push(
        `${person.name} was matched to ${person.email}, which spells "${matchingAlternate}". That is probably the later name; pick whichever you want shown.`
      );
    }
  }
  return warnings;
}

/** True when this person still needs a name. */
export function needsName(user: StoredUser | undefined): boolean {
  if (!user) {
    return true;
  }
  if (!user.isPlaceholder) {
    return false;
  }
  return user.status === 'deleted' || user.status === 'unknown';
}

/**
 * Finds records that are the same human twice.
 *
 * A Vault import creates a record keyed by email for anyone it cannot match,
 * while the Chat API knows the same person by user id. Once an email has been
 * recovered for the API record, the two provably describe one person, so the
 * email-keyed one is retired in favour of the id-keyed one, which is what
 * messages actually reference.
 */
export function planAliases(
  recovered: readonly RecoveredName[],
  users: Record<string, StoredUser>,
  manual: Record<string, string> = {}
): UserAlias[] {
  const aliases: UserAlias[] = [];
  const emailToVaultId = new Map<string, string>();
  for (const user of Object.values(users)) {
    if (user.source === 'vault' && user.email) {
      emailToVaultId.set(user.email.toLowerCase(), user.chatUserId);
    }
  }

  for (const person of recovered) {
    if (!person.email) {
      continue;
    }
    const vaultId = emailToVaultId.get(person.email.toLowerCase());
    if (vaultId && vaultId !== person.chatUserId) {
      aliases.push({
        chatUserId: vaultId,
        canonical: person.chatUserId,
        reason: `same person as ${person.name}, who the Chat API knows by id and Vault knew only by ${person.email}`,
      });
    }
  }

  for (const [chatUserId, canonical] of Object.entries(manual)) {
    if (chatUserId === canonical) {
      continue;
    }
    aliases.push({
      chatUserId,
      canonical,
      reason: 'merged by hand',
    });
  }
  return aliases;
}

/** Follows an alias chain to the record that should actually be used. */
export function resolveAlias(
  users: Record<string, StoredUser>,
  chatUserId: string,
  seen = new Set<string>()
): string {
  const user = users[chatUserId];
  if (!user?.aliasOf || seen.has(chatUserId)) {
    return chatUserId;
  }
  seen.add(chatUserId);
  return resolveAlias(users, user.aliasOf, seen);
}

/** Builds the plan: who can be named, from what, and with which email. */
export function buildRecoveryPlan(
  evidenceByUser: Map<string, NameEvidence>,
  users: Record<string, StoredUser>,
  vaultEmails: readonly EmailCandidate[],
  manualAliases: Record<string, string> = {}
): RecoveryPlan {
  const targets = Object.values(users).filter((user) => needsName(user));
  const recovered: RecoveredName[] = [];
  const unresolved: string[] = [];

  for (const user of targets) {
    const evidence = evidenceByUser.get(user.chatUserId);
    const choice = evidence ? chooseName(evidence) : undefined;
    if (choice) {
      recovered.push(choice);
    } else {
      unresolved.push(user.chatUserId);
    }
  }
  const withEmails = matchEmails(recovered, vaultEmails);
  const aliases = planAliases(withEmails, users, manualAliases);
  const aliased = new Set(aliases.map((alias) => alias.chatUserId));
  return {
    aliases,
    recovered: withEmails,
    unresolved,
    // A record that is about to be merged away needs no name of its own.
    warnings: reviewWarnings(
      withEmails.filter((person) => !aliased.has(person.chatUserId))
    ),
  };
}

/** Applies a plan to the user records, leaving directory-named people alone. */
export function applyRecovery(
  users: Record<string, StoredUser>,
  plan: RecoveryPlan,
  runId: string
): { users: Record<string, StoredUser>; updated: number; aliased: number } {
  const next = { ...users };
  let updated = 0;
  for (const alias of plan.aliases) {
    const user = next[alias.chatUserId];
    const canonical = next[alias.canonical];
    if (!(user && canonical)) {
      continue;
    }
    next[alias.chatUserId] = { ...user, aliasOf: alias.canonical };
    // Keep whichever address the merged record carried.
    if (!canonical.email && user.email) {
      next[alias.canonical] = { ...canonical, email: user.email };
    }
  }
  for (const recovered of plan.recovered) {
    const user = next[recovered.chatUserId];
    if (!needsName(user)) {
      continue;
    }
    next[recovered.chatUserId] = {
      ...user,
      fullName: recovered.name,
      placeholderName: recovered.name,
      email: user.email ?? recovered.email,
      lastResolvedRun: runId,
      lastResolvedAt: new Date().toISOString(),
    };
    updated += 1;
  }
  return { users: next, updated, aliased: plan.aliases.length };
}
