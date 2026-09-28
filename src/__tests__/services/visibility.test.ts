import { describe, expect, it } from 'vitest';
import { toStoredMessage } from '../../services/export-store';
import {
  parseCsv,
  spaceActivity,
  suggestArchive,
  suggestVisibility,
  toCsv,
  type VisibilityRow,
} from '../../services/slack-archive/visibility';

function message(id: string, createTime: string, text = 'hi') {
  return toStoredMessage(
    {
      name: `spaces/S/messages/${id}.${id}`,
      sender: { name: 'users/1', type: 'HUMAN' },
      createTime,
      text,
    },
    'S',
    'r1',
    '2026-09-25T00:00:00Z'
  );
}

describe('channel visibility', () => {
  it('suggests private for money, people and small spaces', () => {
    expect(suggestVisibility('int-finance', 3).visibility).toBe('private');
    expect(suggestVisibility('BUDGETS 2026', 26).visibility).toBe('private');
    expect(suggestVisibility('dept-hr', 4).visibility).toBe('private');
    expect(suggestVisibility('HR Help', 5).visibility).toBe('private');
    expect(suggestVisibility('nexonia-invoices-ken', 4).visibility).toBe(
      'private'
    );
    expect(suggestVisibility('Kathryn', 2).visibility).toBe('private');
    expect(suggestVisibility('staff-all', 52).visibility).toBe('public');
    expect(suggestVisibility('team-sunday-hrc', 12).visibility).toBe('public');
    // "hrc" is the church, not HR.
    expect(suggestVisibility('HRC Announcements', 12).visibility).toBe(
      'public'
    );
  });

  it('round-trips through CSV, quotes and all', () => {
    const rows: VisibilityRow[] = [
      {
        spaceId: 'AAA',
        name: 'Finance, "internal"',
        source: 'chat-api',
        members: 3,
        messages: 10,
        lastMessage: '2023-05-01',
        visibility: 'private',
        archive: true,
        reason: 'name suggests finance, HR, security or leadership',
      },
      {
        spaceId: 'BBB',
        name: 'staff-all',
        source: 'vault',
        members: 52,
        messages: 3420,
        lastMessage: '2026-09-20',
        visibility: 'public',
        archive: false,
        reason: 'general team space',
      },
    ];
    expect(parseCsv(toCsv(rows))).toEqual(rows);
  });

  it('refuses anything but public or private', () => {
    const csv =
      'spaceId,name,source,members,messages,visibility,reason\nAAA,x,chat-api,1,1,maybe,\n';
    expect(() => parseCsv(csv)).toThrow('public or private');
  });

  it('still reads a list written before the archive columns existed', () => {
    const csv =
      'spaceId,name,source,members,messages,visibility,reason\nAAA,x,chat-api,1,1,private,small\n';
    expect(parseCsv(csv)).toEqual([
      {
        spaceId: 'AAA',
        name: 'x',
        source: 'chat-api',
        members: 1,
        messages: 1,
        lastMessage: '',
        visibility: 'private',
        archive: undefined,
        reason: 'small',
      },
    ]);
  });

  it('refuses an archive value other than yes, no or blank', () => {
    const csv =
      'spaceId,name,visibility,archive\nAAA,x,private,maybe\nBBB,y,public,\n';
    expect(() => parseCsv(csv)).toThrow('yes, no or blank');
  });

  it('suggests archiving quiet and empty Spaces only when given a cutoff', () => {
    expect(suggestArchive('2024-12-31', '2025-01-01')).toBe(true);
    expect(suggestArchive('2025-01-01', '2025-01-01')).toBe(false);
    expect(suggestArchive('', '2025-01-01')).toBe(true);
    expect(suggestArchive('2020-01-01', undefined)).toBeUndefined();
  });

  it('dates the last message by its real date, in Central time, skipping deleted ones', () => {
    const deleted = {
      ...message('d', '2026-09-01T12:00:00Z'),
      isDeleted: true,
    };
    // CloudFuze re-dated this one to 2024; it was really sent in Jan 2023.
    const migrated = message(
      'm',
      '2024-04-12T15:26:01Z',
      '_*Message Posted : 18 Jan 2023 at 12:49:07*_\nold news'
    );
    // 03:30 UTC on 2 Mar is still 1 Mar in Texas.
    const late = message('l', '2023-03-02T03:30:00Z');
    expect(spaceActivity([deleted, migrated, late])).toEqual({
      messages: 2,
      lastMessage: '2023-03-01',
    });
    expect(spaceActivity([])).toEqual({ messages: 0, lastMessage: '' });
  });
});
