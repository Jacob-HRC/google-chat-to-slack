/**
 * Checks a finished Slack import against the archive that produced it.
 *
 * Two questions, both answered from the API:
 * - Did the import leave every existing member exactly as it was, and create
 *   every new person deactivated? (The migration is not announced, so an
 *   active new account is a failure, not a detail.)
 * - Is every message where it should be? Compared by ts per conversation,
 *   for every conversation the available tokens can read. A bot cannot read
 *   DMs between other people, so those are reported as unverifiable, never
 *   as passed.
 */
import type { WebClient } from '@slack/web-api';
import type {
  ArchiveUserMapping,
  MessageIndexConversation,
} from '../types/slack-export';
import type {
  SlackMember,
  SlackMemberSnapshot,
} from './slack-archive/slack-members';

const COMPARED_FIELDS = [
  'name',
  'realName',
  'email',
  'deleted',
  'isGuest',
] as const;

export interface MemberChange {
  id: string;
  email?: string;
  field: string;
  before: unknown;
  after: unknown;
}

export interface PersonOutcome {
  archiveId: string;
  name: string;
  email?: string;
  expected: ArchiveUserMapping['importAction'];
  /** What the destination shows now. */
  actual: 'merged' | 'created-deactivated' | 'created-active' | 'absent';
  slackId?: string;
  ok: boolean;
}

export interface MemberReport {
  /** Existing members whose profile or state changed. Must be empty. */
  changed: MemberChange[];
  /** Existing members no longer listed at all. Must be empty. */
  vanished: SlackMember[];
  /** New accounts that can sign in. Must be empty while unannounced. */
  newActive: SlackMember[];
  newDeactivated: number;
  people: PersonOutcome[];
}

function humansById(snapshot: SlackMemberSnapshot): Map<string, SlackMember> {
  return new Map(
    snapshot.members.filter((m) => !m.isBot).map((m) => [m.id, m])
  );
}

function outcomeFor(
  mapping: ArchiveUserMapping,
  archiveId: string,
  before: Map<string, SlackMember>,
  afterByEmail: Map<string, SlackMember>
): PersonOutcome {
  const email = mapping.email?.toLowerCase();
  const member = email ? afterByEmail.get(email) : undefined;
  let actual: PersonOutcome['actual'] = 'absent';
  if (member && before.has(member.id)) {
    actual = 'merged';
  } else if (member) {
    actual = member.deleted ? 'created-deactivated' : 'created-active';
  }
  const expectedActual: Record<string, PersonOutcome['actual']> = {
    merge: 'merged',
    deactivated: 'created-deactivated',
    'no-email': 'absent',
  };
  const mergedIntoExpected =
    mapping.importAction !== 'merge' || member?.id === mapping.slackMemberId;
  return {
    archiveId,
    name: mapping.name,
    email: mapping.email,
    expected: mapping.importAction,
    actual,
    slackId: member?.id,
    ok: actual === expectedActual[mapping.importAction] && mergedIntoExpected,
  };
}

function diffExisting(
  beforeById: Map<string, SlackMember>,
  afterById: Map<string, SlackMember>,
  report: MemberReport
): void {
  for (const [id, old] of beforeById) {
    const now = afterById.get(id);
    if (!now) {
      report.vanished.push(old);
      continue;
    }
    for (const field of COMPARED_FIELDS) {
      if ((old[field] ?? null) !== (now[field] ?? null)) {
        report.changed.push({
          id,
          email: old.email,
          field,
          before: old[field],
          after: now[field],
        });
      }
    }
  }
}

function countNew(
  beforeById: Map<string, SlackMember>,
  afterById: Map<string, SlackMember>,
  report: MemberReport
): void {
  for (const [id, member] of afterById) {
    if (beforeById.has(id)) {
      continue;
    }
    if (member.deleted) {
      report.newDeactivated += 1;
    } else {
      report.newActive.push(member);
    }
  }
}

/** Pure diff of two snapshots, judged against what the archive intended. */
export function compareMembers(
  before: SlackMemberSnapshot,
  after: SlackMemberSnapshot,
  users: Record<string, ArchiveUserMapping>
): MemberReport {
  const beforeById = humansById(before);
  const afterById = humansById(after);
  const report: MemberReport = {
    changed: [],
    vanished: [],
    newActive: [],
    newDeactivated: 0,
    people: [],
  };
  diffExisting(beforeById, afterById, report);
  countNew(beforeById, afterById, report);
  const afterByEmail = new Map<string, SlackMember>();
  for (const member of afterById.values()) {
    if (member.email) {
      afterByEmail.set(member.email.toLowerCase(), member);
    }
  }
  const seen = new Set<string>();
  for (const mapping of Object.values(users)) {
    if (!seen.has(mapping.slackId)) {
      seen.add(mapping.slackId);
      report.people.push(
        outcomeFor(mapping, mapping.slackId, beforeById, afterByEmail)
      );
    }
  }
  return report;
}

/** A message as the Slack API returns it, reduced to what is compared. */
export interface ActualMessage {
  ts: string;
  threadTs?: string;
  fileSizes: number[];
}

export interface ConversationReport {
  name: string;
  kind: string;
  slackId?: string;
  status: 'match' | 'mismatch' | 'unverifiable' | 'not-found';
  reason?: string;
  expected: number;
  found: number;
  missing: string[];
  extra: string[];
  /** Messages whose files are absent or differ in size from the archive. */
  fileProblems: string[];
  /** Replies that arrived outside their thread. */
  unthreaded: string[];
  /** Full counts; the lists above hold at most LIST_SHOWN examples each. */
  counts: {
    missing: number;
    extra: number;
    fileProblems: number;
    unthreaded: number;
    /** Images whose size Slack changed on import (re-encoded, metadata stripped). Expected. */
    imagesReencoded: number;
  };
}

const LIST_SHOWN = 20;

/**
 * Files of one message: undefined when they match, 'reencoded' when only
 * images differ in size (Slack re-processes images on import), otherwise a
 * description of the problem. Pure.
 */
export function compareFiles(
  expected: MessageIndexConversation['messages'][number],
  found: ActualMessage
): string | undefined {
  const want = expected.fileSizes ?? [];
  if (want.length === 0) {
    return;
  }
  if (found.fileSizes.length !== want.length) {
    return `expected ${want.length} file(s), found ${found.fileSizes.length}`;
  }
  const sortedWant = [...want].sort((a, b) => a - b).join(',');
  const sortedGot = [...found.fileSizes].sort((a, b) => a - b).join(',');
  if (sortedWant === sortedGot) {
    return;
  }
  // Re-encoding changes a size, never empties a file.
  const allImages =
    (expected.fileTypes ?? []).length === want.length &&
    (expected.fileTypes ?? []).every((t) => t.startsWith('image/')) &&
    found.fileSizes.every((size) => size > 0);
  return allImages
    ? 'reencoded'
    : `expected sizes ${sortedWant}, found ${sortedGot}`;
}

/** Pure comparison of one conversation. */
export function compareConversation(
  expected: MessageIndexConversation,
  actual: ActualMessage[],
  slackId: string
): ConversationReport {
  const actualByTs = new Map(actual.map((m) => [m.ts, m]));
  const expectedTs = new Set(expected.messages.map((m) => m.ts));
  const missing: string[] = [];
  const fileProblems: string[] = [];
  const unthreaded: string[] = [];
  let imagesReencoded = 0;
  for (const message of expected.messages) {
    const found = actualByTs.get(message.ts);
    if (!found) {
      missing.push(message.ts);
      continue;
    }
    if (message.threadTs && found.threadTs !== message.threadTs) {
      unthreaded.push(message.ts);
    }
    const verdict = compareFiles(message, found);
    if (verdict === 'reencoded') {
      imagesReencoded += 1;
    } else if (verdict) {
      fileProblems.push(`${message.ts}: ${verdict}`);
    }
  }
  const extra = actual.filter((m) => !expectedTs.has(m.ts)).map((m) => m.ts);
  const clean =
    missing.length === 0 &&
    fileProblems.length === 0 &&
    unthreaded.length === 0;
  return {
    name: expected.name,
    kind: expected.kind,
    slackId,
    status: clean ? 'match' : 'mismatch',
    expected: expected.messages.length,
    found: actual.length,
    missing: missing.slice(0, LIST_SHOWN),
    extra: extra.slice(0, LIST_SHOWN),
    fileProblems: fileProblems.slice(0, LIST_SHOWN),
    unthreaded: unthreaded.slice(0, LIST_SHOWN),
    counts: {
      missing: missing.length,
      extra: extra.length,
      fileProblems: fileProblems.length,
      unthreaded: unthreaded.length,
      imagesReencoded,
    },
  };
}

type HistoryPage = Awaited<ReturnType<WebClient['conversations']['history']>>;
type RawMessage = NonNullable<HistoryPage['messages']>[number];

function toActual(raw: RawMessage): ActualMessage | undefined {
  if (!raw.ts) {
    return;
  }
  return {
    ts: raw.ts,
    threadTs:
      raw.thread_ts && raw.thread_ts !== raw.ts ? raw.thread_ts : undefined,
    fileSizes: (raw.files ?? []).map((f) => f.size ?? 0),
  };
}

async function fetchReplies(
  client: WebClient,
  channel: string,
  parent: string,
  into: ActualMessage[]
): Promise<void> {
  let cursor: string | undefined;
  do {
    // biome-ignore lint/nursery/noAwaitInLoop: pages are sequential by cursor.
    const page = await client.conversations.replies({
      channel,
      ts: parent,
      limit: 200,
      cursor,
    });
    for (const raw of page.messages ?? []) {
      // The parent comes back first on every page; it is already counted.
      const message = raw.ts === parent ? undefined : toActual(raw);
      if (message) {
        into.push(message);
      }
    }
    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor);
}

/** Every message in a conversation, thread replies included. */
export async function fetchConversation(
  client: WebClient,
  channel: string
): Promise<ActualMessage[]> {
  const messages: ActualMessage[] = [];
  const threadParents: string[] = [];
  let cursor: string | undefined;
  do {
    // biome-ignore lint/nursery/noAwaitInLoop: pages are sequential by cursor.
    const page: HistoryPage = await client.conversations.history({
      channel,
      limit: 200,
      cursor,
    });
    for (const raw of page.messages ?? []) {
      const message = toActual(raw);
      if (message) {
        messages.push(message);
      }
      if (raw.ts && (raw.reply_count ?? 0) > 0) {
        threadParents.push(raw.ts);
      }
    }
    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor);

  for (const parent of threadParents) {
    // biome-ignore lint/nursery/noAwaitInLoop: one thread at a time, inside Slack's rate limits.
    await fetchReplies(client, channel, parent, messages);
  }
  return messages;
}
