/**
 * Timestamp helpers. Google Chat returns RFC 3339 with up to nine fractional
 * digits; Slack export files use `seconds.microseconds` strings. Conversions
 * here never go through floating point so precision survives.
 */

const RFC3339_REGEX =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;
const SLACK_TS_REGEX = /^(\d+)\.(\d{6})$/;
const RUN_ID_SEPARATORS_REGEX = /[-:]/g;
const RUN_ID_MILLIS_REGEX = /\.\d{3}Z$/;

export interface ParsedTimestamp {
  epochSeconds: number;
  /** Nine-digit nanosecond fraction, zero padded. */
  nanos: string;
}

const RELATIVE_SINCE_REGEX = /^(\d+)([hdw])$/i;
const RELATIVE_UNIT_MS = { h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/**
 * A `--since` value: an RFC 3339 time, or a span before `now` such as `30d`,
 * `2w` or `12h`. Returns an RFC 3339 time. Pure.
 */
export function parseSinceArg(value: string, now: Date): string {
  const trimmed = value.trim();
  const relative = RELATIVE_SINCE_REGEX.exec(trimmed);
  if (relative) {
    const amount = Number(relative[1]);
    if (amount <= 0) {
      throw new Error(`--since span must be positive: ${value}`);
    }
    const unit = relative[2].toLowerCase() as keyof typeof RELATIVE_UNIT_MS;
    const at = new Date(now.getTime() - amount * RELATIVE_UNIT_MS[unit]);
    // Out-of-range spans give an invalid or pre-year-0 date.
    if (Number.isNaN(at.getTime()) || at.getUTCFullYear() < 1970) {
      throw new Error(`--since span reaches before 1970: ${value}`);
    }
    return at.toISOString();
  }
  try {
    parseRfc3339(trimmed);
  } catch {
    throw new Error(
      `--since must be an RFC 3339 time or a span like 30d, 2w or 12h: ${value}`
    );
  }
  return trimmed;
}

export function parseRfc3339(value: string): ParsedTimestamp {
  const match = RFC3339_REGEX.exec(value.trim());
  if (!match) {
    throw new Error(`Not an RFC 3339 timestamp: ${value}`);
  }
  const [, base, fraction = '', offset] = match;
  const millis = Date.parse(`${base}${offset}`);
  if (Number.isNaN(millis)) {
    throw new Error(`Unparseable timestamp: ${value}`);
  }
  return {
    epochSeconds: Math.floor(millis / 1000),
    nanos: fraction.padEnd(9, '0'),
  };
}

/** `2025-01-31T12:49:46.637839Z` → `1738327786.637839` (microseconds, truncated). */
export function toSlackTs(value: string): string {
  const { epochSeconds, nanos } = parseRfc3339(value);
  return `${epochSeconds}.${nanos.slice(0, 6)}`;
}

export function toEpochMicros(value: string): bigint {
  const { epochSeconds, nanos } = parseRfc3339(value);
  return BigInt(epochSeconds) * 1_000_000n + BigInt(nanos.slice(0, 6));
}

export function slackTsToMicros(ts: string): bigint {
  const match = SLACK_TS_REGEX.exec(ts);
  if (!match) {
    throw new Error(`Not a Slack ts: ${ts}`);
  }
  return BigInt(match[1]) * 1_000_000n + BigInt(match[2]);
}

export function microsToSlackTs(micros: bigint): string {
  const seconds = micros / 1_000_000n;
  const fraction = micros % 1_000_000n;
  return `${seconds}.${fraction.toString().padStart(6, '0')}`;
}

export function slackTsToIso(ts: string): string {
  const micros = slackTsToMicros(ts);
  const millis = Number(micros / 1000n);
  const microsPart = (micros % 1_000_000n).toString().padStart(6, '0');
  return `${new Date(millis).toISOString().slice(0, 19)}.${microsPart}Z`;
}

/** Compares two RFC 3339 timestamps at microsecond precision. */
export function compareTimestamps(a: string, b: string): number {
  const ma = toEpochMicros(a);
  const mb = toEpochMicros(b);
  if (ma < mb) {
    return -1;
  }
  if (ma > mb) {
    return 1;
  }
  return 0;
}

/** Compact, sortable run identifier, e.g. `20260922T061500Z`. */
export function makeRunId(date = new Date()): string {
  return date
    .toISOString()
    .replace(RUN_ID_SEPARATORS_REGEX, '')
    .replace(RUN_ID_MILLIS_REGEX, 'Z');
}
