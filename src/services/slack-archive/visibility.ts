/**
 * Per-Space public/private decisions for the archive.
 *
 * A public Slack channel shows its whole history to everyone in the
 * workspace, and Google recorded nothing we exported about who could see a
 * Space. So visibility is a reviewed list, not a guess: `channel-visibility`
 * writes every named Space to a CSV with a suggested setting and the reason,
 * a person edits it, and the build follows it exactly. A Space missing from
 * the list is built private, with a warning, so a Space created after the
 * review can never go public by accident.
 *
 * The same list says which channels to archive after the import: `archive`
 * is suggested from the date of the last message and can be overridden.
 * `--archive-all-spaces` overrides it for every Space.
 */
import type { StoredMessage, StoredSpace } from '../../types/export-store';
import { effectiveCreateTime } from './migrated';

export type Visibility = 'public' | 'private';

export interface VisibilityRow {
  spaceId: string;
  name: string;
  source: string;
  members: number;
  messages: number;
  /** Date (YYYY-MM-DD) of the last message, by its real date; '' when empty. */
  lastMessage: string;
  visibility: Visibility;
  /** Archive the channel after the import. Undefined while undecided. */
  archive?: boolean;
  reason: string;
}

// Names that suggest money, people matters, security or leadership.
const SENSITIVE_NAME_REGEX =
  /financ|budget|payroll|salar|\bhr\b|-hr\b|^hr-|hr help|nexonia|invoice|receipt|billing|prvt|private|pastoral|care\b|security|oversight|approval|elder|leadership|board|counsel|confiden|benefit|legal/i;
const SMALL_SPACE_MEMBERS = 2;
const CSV_COLUMNS = [
  'spaceId',
  'name',
  'source',
  'members',
  'messages',
  'last_message',
  'visibility',
  'archive',
  'reason',
] as const;
const REQUIRED_COLUMNS = ['spaceId', 'visibility'];
const NEEDS_QUOTES_REGEX = /[",\n]/;
const QUOTE_REGEX = /"/g;
const LINE_BREAK_REGEX = /\r?\n/;

/** A starting suggestion, always erring private. Pure. */
export function suggestVisibility(
  name: string,
  members: number
): { visibility: Visibility; reason: string } {
  if (SENSITIVE_NAME_REGEX.test(name)) {
    return {
      visibility: 'private',
      reason: 'name suggests finance, HR, security or leadership',
    };
  }
  if (members <= SMALL_SPACE_MEMBERS) {
    return {
      visibility: 'private',
      reason: `only ${members} member(s); effectively a private conversation`,
    };
  }
  return { visibility: 'public', reason: 'general team space' };
}

const CHURCH_TIME_ZONE = 'America/Chicago';

/**
 * How much a Space was used: its live messages and the local date of the
 * last one, by its real date (CloudFuze-migrated messages carry theirs in
 * the text). Pure.
 */
export function spaceActivity(messages: StoredMessage[]): {
  messages: number;
  lastMessage: string;
} {
  const live = messages.filter((m) => !m.isDeleted);
  let latest = '';
  for (const message of live) {
    const time = effectiveCreateTime(message);
    if (time > latest) {
      latest = time;
    }
  }
  const lastMessage = latest
    ? new Date(latest).toLocaleDateString('en-CA', {
        timeZone: CHURCH_TIME_ZONE,
      })
    : '';
  return { messages: live.length, lastMessage };
}

/** Archive a channel whose last message is before the cutoff, or that has none. Pure. */
export function suggestArchive(
  lastMessage: string,
  archiveBefore: string | undefined
): boolean | undefined {
  if (!archiveBefore) {
    return;
  }
  return lastMessage === '' || lastMessage < archiveBefore;
}

export function rowFor(
  space: StoredSpace,
  activity: { messages: number; lastMessage: string },
  previous?: VisibilityRow,
  archiveBefore?: string
): VisibilityRow {
  const members = space.memberships.filter(
    (m) => m.memberType !== 'BOT'
  ).length;
  const suggestion = suggestVisibility(space.displayName, members);
  return {
    spaceId: space.spaceId,
    name: space.displayName,
    source: space.source ?? 'chat-api',
    members,
    messages: activity.messages,
    lastMessage: activity.lastMessage,
    // A decision already on the list is never overwritten.
    visibility: previous?.visibility ?? suggestion.visibility,
    archive:
      previous?.archive ?? suggestArchive(activity.lastMessage, archiveBefore),
    reason: previous?.reason ?? suggestion.reason,
  };
}

function csvCell(value: string | number): string {
  const text = String(value);
  return NEEDS_QUOTES_REGEX.test(text)
    ? `"${text.replace(QUOTE_REGEX, '""')}"`
    : text;
}

function archiveCell(archive: boolean | undefined): string {
  if (archive === undefined) {
    return '';
  }
  return archive ? 'yes' : 'no';
}

/** Private rows first, then by name, so the ones to check sit together. Pure. */
export function toCsv(rows: VisibilityRow[]): string {
  const sorted = [...rows].sort(
    (a, b) =>
      a.visibility.localeCompare(b.visibility) || a.name.localeCompare(b.name)
  );
  const lines = sorted.map((r) =>
    [
      r.spaceId,
      r.name,
      r.source,
      r.members,
      r.messages,
      r.lastMessage,
      r.visibility,
      archiveCell(r.archive),
      r.reason,
    ]
      .map(csvCell)
      .join(',')
  );
  return `${[CSV_COLUMNS.join(','), ...lines].join('\n')}\n`;
}

function parseLine(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quoted && char === '"' && line[i + 1] === '"') {
      cell += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      cells.push(cell);
      cell = '';
    } else {
      cell += char;
    }
  }
  cells.push(cell);
  return cells;
}

function parseArchive(
  value: string | undefined,
  where: string
): boolean | undefined {
  const text = value?.trim().toLowerCase() ?? '';
  if (text === '') {
    return;
  }
  if (text === 'yes' || text === 'no') {
    return text === 'yes';
  }
  throw new Error(`${where}: archive must be yes, no or blank, got "${value}"`);
}

/**
 * Reads the reviewed list by column name, so older lists without the newer
 * columns still load. Rejects anything but public/private. Pure.
 */
export function parseCsv(text: string): VisibilityRow[] {
  const lines = text.split(LINE_BREAK_REGEX).filter((l) => l.trim().length > 0);
  const [header, ...body] = lines;
  const columns = parseLine(header ?? '').map((c) => c.trim());
  const missing = REQUIRED_COLUMNS.filter((c) => !columns.includes(c));
  if (missing.length > 0) {
    throw new Error(`the list has no ${missing.join(' or ')} column`);
  }
  return body.map((line, index) => {
    const cells = parseLine(line);
    const cell = (column: string): string | undefined => {
      const at = columns.indexOf(column);
      return at === -1 ? undefined : cells[at];
    };
    const name = cell('name') ?? '';
    const where = `row ${index + 2} (${name})`;
    const value = cell('visibility')?.trim().toLowerCase();
    if (value !== 'public' && value !== 'private') {
      throw new Error(
        `${where}: visibility must be public or private, got "${cell('visibility')}"`
      );
    }
    return {
      spaceId: cell('spaceId') ?? '',
      name,
      source: cell('source') ?? '',
      members: Number(cell('members') ?? 0),
      messages: Number(cell('messages') ?? 0),
      lastMessage: cell('last_message') ?? '',
      visibility: value,
      archive: parseArchive(cell('archive'), where),
      reason: cell('reason') ?? '',
    };
  });
}
