/**
 * Messages brought into Google Chat by the earlier Slack-to-Google migration
 * (CloudFuze, April–May 2024). Google stamped each with the day it was
 * migrated; the real time survives only as a first line in the text:
 *
 *   _*Message Posted : 18 Jan 2023 at 12:49:07*_
 *
 * The line is Central time (America/Chicago). Evidence from the HRC store:
 * its hours peak 9:00–16:00 with a lunch dip at noon, while genuine Google
 * timestamps (UTC) peak five to six hours later; and a screenshot posted
 * "at 06:29:34" shows 6:29 on the phone's clock. About 166,000 messages carry
 * it, a third of the store.
 *
 * The archive uses that time as the message's Slack timestamp and drops the
 * line, since Slack then shows the date itself.
 */
import type { StoredMessage } from '../../types/export-store';

const POSTED_LINE_REGEX =
  /^[_*\s]*Message Posted\s*:\s*(\d{1,2}) ([A-Za-z]{3}) (\d{4}) at (\d{2}):(\d{2}):(\d{2})[_*\s]*(?:\n|$)/;
const MONTHS: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};
const SOURCE_TIME_ZONE = 'America/Chicago';
const FRACTION_REGEX = /\.(\d+)Z$/;

const offsetFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: SOURCE_TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
});

/** The zone's wall-clock reading at an instant, as if it were UTC. */
function wallClockAsUtc(instant: number): number {
  const parts = Object.fromEntries(
    offsetFormat.formatToParts(new Date(instant)).map((p) => [p.type, p.value])
  );
  return Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
}

/** Converts a Central wall-clock time to a UTC instant, DST included. Pure. */
export function centralToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number
): number {
  const wall = Date.UTC(year, month, day, hour, minute, second);
  // Start from the wall time read as UTC, then correct by the zone offset at
  // that instant; a second pass settles times near a DST change.
  let guess = wall;
  for (let i = 0; i < 2; i += 1) {
    guess = wall - (wallClockAsUtc(guess) - guess);
  }
  return guess;
}

export interface MigratedTime {
  /** RFC 3339, UTC, with the original sub-second part kept for ordering. */
  createTime: string;
  /** The text without the "Message Posted" line. */
  strip: (text: string) => string;
}

/** The real time of a migrated message, or undefined for a native one. Pure. */
export function migratedTime(message: StoredMessage): MigratedTime | undefined {
  const source = message.formattedText ?? message.text ?? '';
  const match = POSTED_LINE_REGEX.exec(source);
  if (!match) {
    return;
  }
  const month = MONTHS[match[2].toLowerCase()];
  if (month === undefined) {
    return;
  }
  const instant = centralToUtc(
    Number(match[3]),
    month,
    Number(match[1]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6])
  );
  // Keep Google's sub-second digits: the migration posted messages in order,
  // so they break ties between messages from the same second.
  const fraction = FRACTION_REGEX.exec(message.createTime)?.[1] ?? '000000';
  const iso = new Date(instant).toISOString().replace('.000Z', `.${fraction}Z`);
  return {
    createTime: iso,
    strip: (text: string) => text.replace(POSTED_LINE_REGEX, ''),
  };
}

/** The time the archive should use for a message. Pure. */
export function effectiveCreateTime(message: StoredMessage): string {
  return migratedTime(message)?.createTime ?? message.createTime;
}
