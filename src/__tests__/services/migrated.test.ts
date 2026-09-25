import { describe, expect, it } from 'vitest';
import { toStoredMessage } from '../../services/export-store';
import { withRealTime } from '../../services/slack-archive/messages';
import {
  centralToUtc,
  effectiveCreateTime,
  migratedTime,
} from '../../services/slack-archive/migrated';

function stored(text: string, createTime = '2024-04-12T15:26:01.123456Z') {
  return toStoredMessage(
    {
      name: 'spaces/S/messages/m1.m1',
      sender: { name: 'users/1', type: 'HUMAN' },
      createTime,
      text,
      formattedText: text,
    },
    'S',
    'r1',
    '2026-09-25T00:00:00Z'
  );
}

describe('messages re-dated by the earlier Slack-to-Google migration', () => {
  it('reads Central time, daylight saving included', () => {
    // 18 Sep 2023 06:29:34 CDT (UTC-5)
    expect(new Date(centralToUtc(2023, 8, 18, 6, 29, 34)).toISOString()).toBe(
      '2023-09-18T11:29:34.000Z'
    );
    // 18 Jan 2023 12:49:07 CST (UTC-6)
    expect(new Date(centralToUtc(2023, 0, 18, 12, 49, 7)).toISOString()).toBe(
      '2023-01-18T18:49:07.000Z'
    );
  });

  it('uses the posted time and drops the line from the text', () => {
    const message = stored(
      '_*Message Posted : 18 Sep 2023 at 06:29:34*_\nHaha it is just a script'
    );
    expect(migratedTime(message)?.createTime).toBe(
      '2023-09-18T11:29:34.123456Z'
    );
    const real = withRealTime({
      ...message,
      lastUpdateTime: '2024-04-12T15:26:02Z',
    });
    expect(real.createTime).toBe('2023-09-18T11:29:34.123456Z');
    expect(real.slackTs).toBe('1695036574.123456');
    expect(real.text).toBe('Haha it is just a script');
    expect(real.formattedText).toBe('Haha it is just a script');
    expect(real.lastUpdateTime).toBeUndefined();
  });

  it('handles a posted line with nothing after it, and leaves native messages alone', () => {
    expect(
      withRealTime(stored('_*Message Posted : 4 Mar 2024 at 15:38:53*_\n')).text
    ).toBe('');
    const native = stored(
      'Message Posted : is just words here',
      '2025-01-01T00:00:00Z'
    );
    expect(effectiveCreateTime(native)).toBe('2025-01-01T00:00:00Z');
    expect(withRealTime(native)).toBe(native);
  });
});
