import { describe, expect, it } from 'vitest';
import {
  parseCsv,
  suggestVisibility,
  toCsv,
  type VisibilityRow,
} from '../../services/slack-archive/visibility';

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
        visibility: 'private',
        reason: 'name suggests finance, HR, security or leadership',
      },
      {
        spaceId: 'BBB',
        name: 'staff-all',
        source: 'vault',
        members: 52,
        messages: 3420,
        visibility: 'public',
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
});
