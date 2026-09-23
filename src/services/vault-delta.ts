/**
 * Plans Vault exports that fetch only what earlier exports did not.
 *
 * The matter itself is the record of what has been exported: every export
 * keeps its query (space ids, start time) and its creation time. A space is
 * covered up to the creation time of the newest completed export that
 * included it, so the next export for it only needs messages after that.
 *
 * A generous overlap is cheap insurance. Vault groups messages into 24-hour
 * documents and indexes new messages with some delay, and the importer skips
 * any message id it already holds, so re-fetching a day or two costs a little
 * bandwidth and nothing else.
 */
import type { VaultExportSummary } from './vault';

export interface DeltaGroup {
  /** RFC 3339; absent for spaces never exported, which get full history. */
  startTime?: string;
  spaceIds: string[];
}

export interface DeltaPlan {
  groups: DeltaGroup[];
  /** Spaces with an export still running; left out so they are not fetched twice. */
  pending: string[];
  /**
   * Exported before and holding only Vault data. A space with no members
   * cannot receive messages, so there is nothing new to fetch unless
   * `refresh` asks to check anyway.
   */
  upToDate: string[];
  /** When each covered space was last exported, for the report. */
  coveredUntil: Map<string, string>;
}

const HOUR_MS = 3_600_000;
/** Delta exports may add to spaces the Chat API also covers; see vault-sync. */
export const DELTA_EXPORT_PREFIX = 'chat-delta-';
const DATE_PUNCTUATION_REGEX = /[-:]/g;

/** Newest completed export time per space. Pure. */
export function coverageBySpace(
  history: VaultExportSummary[]
): Map<string, string> {
  const coverage = new Map<string, string>();
  for (const item of history) {
    if (item.status !== 'COMPLETED' || !item.createTime) {
      continue;
    }
    for (const spaceId of item.roomIds) {
      const previous = coverage.get(spaceId);
      if (!previous || previous < item.createTime) {
        coverage.set(spaceId, item.createTime);
      }
    }
  }
  return coverage;
}

/** Spaces in an export that has not finished (or failed without a result). */
function pendingSpaces(history: VaultExportSummary[]): Set<string> {
  const pending = new Set<string>();
  for (const item of history) {
    if (item.status === 'IN_PROGRESS') {
      for (const spaceId of item.roomIds) {
        pending.add(spaceId);
      }
    }
  }
  return pending;
}

/** `coveredUntil - overlap`, floored to the hour so nearby cutoffs share one export. */
export function deltaStartTime(
  coveredUntil: string,
  overlapHours: number
): string {
  const cutoff = Date.parse(coveredUntil) - overlapHours * HOUR_MS;
  return new Date(Math.floor(cutoff / HOUR_MS) * HOUR_MS).toISOString();
}

export interface DeltaOptions {
  overlapHours: number;
  /**
   * Last Chat API sync per space, for spaces the store already holds from the
   * API. Those only need what arrived between that sync and the moment the
   * last member left.
   */
  apiSyncedAt?: Map<string, string>;
  /** Re-check Vault-only spaces that were already exported. */
  refresh?: boolean;
}

function laterOf(
  a: string | undefined,
  b: string | undefined
): string | undefined {
  if (!(a && b)) {
    return a ?? b;
  }
  return a > b ? a : b;
}

/** Groups target spaces into the fewest exports that fetch only new messages. Pure. */
export function planDeltaExports(
  targets: string[],
  history: VaultExportSummary[],
  options: DeltaOptions
): DeltaPlan {
  const coveredUntil = coverageBySpace(history);
  const inFlight = pendingSpaces(history);
  const byStart = new Map<string, string[]>();
  const pending: string[] = [];
  const upToDate: string[] = [];
  for (const spaceId of new Set(targets)) {
    if (inFlight.has(spaceId)) {
      pending.push(spaceId);
      continue;
    }
    const apiSync = options.apiSyncedAt?.get(spaceId);
    const vaultCovered = coveredUntil.get(spaceId);
    if (vaultCovered && !apiSync && !options.refresh) {
      upToDate.push(spaceId);
      continue;
    }
    const covered = laterOf(vaultCovered, apiSync);
    const key = covered ? deltaStartTime(covered, options.overlapHours) : '';
    const list = byStart.get(key) ?? [];
    list.push(spaceId);
    byStart.set(key, list);
  }
  const groups = [...byStart.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([start, spaceIds]) => ({
      startTime: start || undefined,
      spaceIds: spaceIds.sort(),
    }));
  return {
    groups,
    pending: pending.sort(),
    upToDate: upToDate.sort(),
    coveredUntil,
  };
}

/** A readable, Vault-safe export name for one group. */
export function deltaExportName(group: DeltaGroup, now: Date): string {
  const compact = (iso: string, length: number): string =>
    iso.slice(0, length).replace(DATE_PUNCTUATION_REGEX, '').replace('T', '-');
  const stamp = compact(now.toISOString(), 16);
  const scope = group.startTime
    ? `since-${compact(group.startTime, 13)}`
    : 'full';
  return `${DELTA_EXPORT_PREFIX}${stamp}-${scope}`;
}
