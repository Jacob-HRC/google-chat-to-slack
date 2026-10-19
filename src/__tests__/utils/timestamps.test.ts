import { describe, expect, it } from 'vitest';
import {
  compareTimestamps,
  makeRunId,
  microsToSlackTs,
  parseRfc3339,
  parseSinceArg,
  slackTsToIso,
  slackTsToMicros,
  toEpochMicros,
  toSlackTs,
} from '../../utils/timestamps';

describe('toSlackTs', () => {
  it('keeps microsecond precision from Google Chat createTime', () => {
    expect(toSlackTs('2025-01-31T12:49:46.637839Z')).toBe('1738327786.637839');
  });

  it('truncates nanoseconds rather than rounding', () => {
    expect(toSlackTs('2025-03-10T15:20:30.123456789Z')).toBe(
      '1741620030.123456'
    );
  });

  it('pads short fractions and handles whole seconds', () => {
    expect(toSlackTs('2025-01-31T12:49:46.5Z')).toBe('1738327786.500000');
    expect(toSlackTs('2025-01-31T12:49:46Z')).toBe('1738327786.000000');
  });

  it('honours timezone offsets', () => {
    expect(toSlackTs('2025-01-31T07:49:46.637839-05:00')).toBe(
      '1738327786.637839'
    );
  });

  it('rejects malformed input', () => {
    expect(() => toSlackTs('yesterday')).toThrow('RFC 3339');
  });
});

describe('round trips', () => {
  it('converts between micros and Slack ts without loss', () => {
    const ts = '1738327786.637839';
    expect(microsToSlackTs(slackTsToMicros(ts))).toBe(ts);
    expect(slackTsToIso(ts)).toBe('2025-01-31T12:49:46.637839Z');
  });

  it('parses into seconds and nanos', () => {
    expect(parseRfc3339('2025-01-31T12:49:46.637839Z')).toEqual({
      epochSeconds: 1_738_327_786,
      nanos: '637839000',
    });
  });

  it('compares at microsecond precision', () => {
    expect(
      compareTimestamps(
        '2025-01-31T12:49:46.637839Z',
        '2025-01-31T12:49:46.637840Z'
      )
    ).toBe(-1);
    expect(
      compareTimestamps(
        '2025-01-31T12:49:46.637839Z',
        '2025-01-31T12:49:46.637839999Z'
      )
    ).toBe(0);
    expect(toEpochMicros('1970-01-01T00:00:01Z')).toBe(1_000_000n);
  });
});

describe('makeRunId', () => {
  it('is compact and sortable', () => {
    expect(makeRunId(new Date('2026-09-22T06:15:00.123Z'))).toBe(
      '20260922T061500Z'
    );
  });
});

describe('parseSinceArg', () => {
  const now = new Date('2026-10-19T12:00:00.000Z');

  it('turns a span into a time before now', () => {
    expect(parseSinceArg('30d', now)).toBe('2026-09-19T12:00:00.000Z');
    expect(parseSinceArg('2w', now)).toBe('2026-10-05T12:00:00.000Z');
    expect(parseSinceArg(' 12h ', now)).toBe('2026-10-19T00:00:00.000Z');
    expect(parseSinceArg('30D', now)).toBe('2026-09-19T12:00:00.000Z');
  });

  it('passes an RFC 3339 time through and rejects anything else', () => {
    expect(parseSinceArg('2026-09-24T12:40:00Z', now)).toBe(
      '2026-09-24T12:40:00Z'
    );
    expect(parseSinceArg('2026-09-24T07:40:00-05:00', now)).toBe(
      '2026-09-24T07:40:00-05:00'
    );
    expect(() => parseSinceArg('0d', now)).toThrow('positive');
    expect(() => parseSinceArg('200000w', now)).toThrow('before 1970');
    expect(() => parseSinceArg('99999999999d', now)).toThrow('before 1970');
    expect(() => parseSinceArg('30 days', now)).toThrow('span like 30d');
    expect(() => parseSinceArg('3m', now)).toThrow('span like 30d');
  });
});
