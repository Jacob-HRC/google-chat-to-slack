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
 */
import type { StoredSpace } from '../../types/export-store';

export type Visibility = 'public' | 'private';

export interface VisibilityRow {
  spaceId: string;
  name: string;
  source: string;
  members: number;
  messages: number;
  visibility: Visibility;
  reason: string;
}

// Names that suggest money, people matters, security or leadership.
const SENSITIVE_NAME_REGEX =
  /financ|budget|payroll|salar|\bhr\b|-hr\b|^hr-|hr help|nexonia|invoice|receipt|billing|prvt|private|pastoral|care\b|security|oversight|approval|elder|leadership|board|counsel|confiden|benefit|legal/i;
const SMALL_SPACE_MEMBERS = 2;
const CSV_HEADER = 'spaceId,name,source,members,messages,visibility,reason';
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

export function rowFor(
  space: StoredSpace,
  messages: number,
  previous?: VisibilityRow
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
    messages,
    // A decision already on the list is never overwritten.
    visibility: previous?.visibility ?? suggestion.visibility,
    reason: previous?.reason ?? suggestion.reason,
  };
}

function csvCell(value: string | number): string {
  const text = String(value);
  return NEEDS_QUOTES_REGEX.test(text)
    ? `"${text.replace(QUOTE_REGEX, '""')}"`
    : text;
}

/** Private rows first, then by name, so the ones to check sit together. Pure. */
export function toCsv(rows: VisibilityRow[]): string {
  const sorted = [...rows].sort(
    (a, b) =>
      a.visibility.localeCompare(b.visibility) || a.name.localeCompare(b.name)
  );
  const lines = sorted.map((r) =>
    [r.spaceId, r.name, r.source, r.members, r.messages, r.visibility, r.reason]
      .map(csvCell)
      .join(',')
  );
  return `${[CSV_HEADER, ...lines].join('\n')}\n`;
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

/** Reads the reviewed list. Rejects anything but public/private. Pure. */
export function parseCsv(text: string): VisibilityRow[] {
  const lines = text.split(LINE_BREAK_REGEX).filter((l) => l.trim().length > 0);
  const [header, ...body] = lines;
  if (header?.trim() !== CSV_HEADER) {
    throw new Error(`unexpected header; expected "${CSV_HEADER}"`);
  }
  return body.map((line, index) => {
    const [spaceId, name, source, members, messages, visibility, reason] =
      parseLine(line);
    const value = visibility?.trim().toLowerCase();
    if (value !== 'public' && value !== 'private') {
      throw new Error(
        `row ${index + 2} (${name}): visibility must be public or private, got "${visibility}"`
      );
    }
    return {
      spaceId,
      name,
      source,
      members: Number(members),
      messages: Number(messages),
      visibility: value,
      reason: reason ?? '',
    };
  });
}
