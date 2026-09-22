import { describe, expect, it } from 'vitest';
import {
  buildUserQuery,
  type DomainUser,
  isInOrgUnit,
  normalizeOrgUnitPath,
  parseUserList,
  resolveUserSelection,
  selectUsers,
  toDomainUser,
} from '../../services/directory';

const users: DomainUser[] = [
  {
    id: '1',
    email: 'pastor@example.com',
    fullName: 'Pat Pastor',
    suspended: false,
    archived: false,
    orgUnitPath: '/Staff/Pastoral',
  },
  {
    id: '2',
    email: 'admin@example.com',
    fullName: 'Alex Admin',
    suspended: false,
    archived: false,
    orgUnitPath: '/Staff',
  },
  {
    id: '3',
    email: 'former@example.com',
    fullName: 'Fran Former',
    suspended: true,
    archived: false,
    orgUnitPath: '/Staff',
  },
  {
    id: '4',
    email: 'archived@example.com',
    fullName: 'Archie Archived',
    suspended: false,
    archived: true,
    orgUnitPath: '/Volunteers',
  },
  {
    id: '5',
    email: 'volunteer@example.com',
    fullName: 'Val Volunteer',
    suspended: false,
    archived: false,
    orgUnitPath: '/Volunteers',
  },
];

describe('parseUserList', () => {
  it('splits commas and repeated flags, trims, lower-cases and dedupes', () => {
    expect(
      parseUserList(['A@Example.com, b@example.com', ' b@example.com ', ''])
    ).toEqual(['a@example.com', 'b@example.com']);
  });

  it('returns an empty list for missing input', () => {
    expect(parseUserList(undefined)).toEqual([]);
    expect(parseUserList('')).toEqual([]);
  });
});

describe('normalizeOrgUnitPath / isInOrgUnit', () => {
  it('adds a leading slash and strips a trailing one', () => {
    expect(normalizeOrgUnitPath('Staff/')).toBe('/Staff');
    expect(normalizeOrgUnitPath('/')).toBe('/');
    expect(normalizeOrgUnitPath(' /Staff/Pastoral ')).toBe('/Staff/Pastoral');
  });

  it('matches the unit itself and descendants only', () => {
    expect(isInOrgUnit('/Staff', '/Staff')).toBe(true);
    expect(isInOrgUnit('/Staff/Pastoral', '/Staff')).toBe(true);
    expect(isInOrgUnit('/Staffing', '/Staff')).toBe(false);
    expect(isInOrgUnit('/Volunteers', '/Staff')).toBe(false);
    expect(isInOrgUnit('/Anything', '/')).toBe(true);
  });
});

describe('resolveUserSelection', () => {
  it('prefers CLI flags over environment values', () => {
    const selection = resolveUserSelection(
      { users: ['cli@example.com'], orgUnit: 'Cli' },
      { GOOGLE_EXPORT_USERS: 'env@example.com', GOOGLE_EXPORT_ORG_UNIT: '/Env' }
    );
    expect(selection).toEqual({
      emails: ['cli@example.com'],
      orgUnit: '/Cli',
      includeSuspended: false,
    });
  });

  it('falls back to environment values', () => {
    const selection = resolveUserSelection(
      {},
      { GOOGLE_EXPORT_USERS: 'a@example.com,b@example.com' }
    );
    expect(selection.emails).toEqual(['a@example.com', 'b@example.com']);
    expect(selection.orgUnit).toBeUndefined();
  });

  it('defaults to everyone, active only', () => {
    expect(resolveUserSelection({}, {})).toEqual({
      emails: [],
      orgUnit: undefined,
      includeSuspended: false,
    });
  });
});

describe('buildUserQuery', () => {
  it('filters suspended users by default', () => {
    expect(buildUserQuery({ emails: [], includeSuspended: false })).toBe(
      'isSuspended=false'
    );
  });

  it('adds the org unit and quotes paths with spaces', () => {
    expect(
      buildUserQuery({ emails: [], orgUnit: '/Staff', includeSuspended: false })
    ).toBe('orgUnitPath=/Staff isSuspended=false');
    expect(
      buildUserQuery({
        emails: [],
        orgUnit: '/Church Staff',
        includeSuspended: true,
      })
    ).toBe("orgUnitPath='/Church Staff'");
  });

  it('omits the root org unit and returns undefined when unfiltered', () => {
    expect(
      buildUserQuery({ emails: [], orgUnit: '/', includeSuspended: true })
    ).toBeUndefined();
  });
});

describe('selectUsers', () => {
  it('drops suspended and archived users by default', () => {
    const result = selectUsers(users, { emails: [], includeSuspended: false });
    expect(result.map((u) => u.email)).toEqual([
      'admin@example.com',
      'pastor@example.com',
      'volunteer@example.com',
    ]);
  });

  it('keeps suspended and archived users when asked', () => {
    const result = selectUsers(users, { emails: [], includeSuspended: true });
    expect(result).toHaveLength(5);
  });

  it('restricts to an org unit subtree', () => {
    const result = selectUsers(users, {
      emails: [],
      orgUnit: '/Staff',
      includeSuspended: false,
    });
    expect(result.map((u) => u.email)).toEqual([
      'admin@example.com',
      'pastor@example.com',
    ]);
  });

  it('applies an explicit email list and the org unit together', () => {
    const result = selectUsers(users, {
      emails: ['pastor@example.com', 'volunteer@example.com'],
      orgUnit: '/Staff',
      includeSuspended: false,
    });
    expect(result.map((u) => u.email)).toEqual(['pastor@example.com']);
  });
});

describe('toDomainUser', () => {
  it('maps Directory fields and fills defaults', () => {
    expect(
      toDomainUser({
        id: '42',
        primaryEmail: 'Someone@Example.com',
        name: { fullName: 'Some One' },
        suspended: true,
      })
    ).toEqual({
      id: '42',
      email: 'someone@example.com',
      fullName: 'Some One',
      suspended: true,
      archived: false,
      orgUnitPath: '/',
    });
  });

  it('falls back to the email when the name is missing', () => {
    expect(toDomainUser({ primaryEmail: 'x@example.com' }).fullName).toBe(
      'x@example.com'
    );
  });
});
