import { describe, expect, it } from 'vitest';
import {
  applyRecovery,
  buildRecoveryPlan,
  chooseName,
  cleanName,
  collectFromMessage,
  type EmailCandidate,
  matchEmails,
  type NameEvidence,
  nameFromEmail,
  needsName,
  planAliases,
  type RecoveredName,
  resolveAlias,
  reviewWarnings,
} from '../../services/name-recovery';
import type { StoredMessage, StoredUser } from '../../types/export-store';

const DELETED = 'users/100000000000000000003';
const ACTIVE = 'users/100000000000000000001';

function message(
  raw: Record<string, unknown>,
  source?: 'vault'
): StoredMessage {
  return {
    name: 'spaces/S/messages/m',
    source,
    messageId: 'm',
    spaceId: 'S',
    createTime: '2025-01-01T00:00:00.000000Z',
    slackTs: '1735689600.000000',
    threadReply: false,
    text: (raw.text as string) ?? '',
    mentions: [],
    links: [],
    reactions: [],
    attachmentKeys: [],
    isDeleted: false,
    contentHash: 'h',
    raw,
    history: [],
    firstSeenRun: 'r',
    firstSeenAt: '2026-01-01T00:00:00.000Z',
    lastSeenRun: 'r',
    lastSeenAt: '2026-01-01T00:00:00.000Z',
  } as StoredMessage;
}

function placeholder(chatUserId: string): StoredUser {
  return {
    chatUserId,
    status: 'deleted',
    isPlaceholder: true,
    placeholderName: 'Former user 000003',
    sources: ['sender'],
    firstSeenRun: 'r',
  };
}

describe('cleanName and nameFromEmail', () => {
  it('strips the mention marker and stray punctuation', () => {
    expect(cleanName('@Jenny  Fuksa ')).toBe('Jenny Fuksa');
    expect(cleanName('@María García-López')).toBe('María García-López');
    expect(cleanName("@O'Brien, Sean")).toBe("O'Brien Sean");
  });

  it('derives a comparable name from an address', () => {
    expect(nameFromEmail('jenny.fuksa@hrc.email')).toBe('jenny fuksa');
    expect(nameFromEmail('James@HRC.email')).toBe('james');
    expect(nameFromEmail('mary_jo-smith@x.com')).toBe('mary jo smith');
  });
});

describe('collectFromMessage', () => {
  it('reads a name from the sender display name', () => {
    const evidence = new Map<string, NameEvidence>();
    collectFromMessage(
      evidence,
      message({ sender: { name: DELETED, displayName: 'Jenny Fuksa' } })
    );
    expect(chooseName(evidence.get(DELETED) as NameEvidence)).toMatchObject({
      name: 'Jenny Fuksa',
      confidence: 'high',
      fromDisplayName: true,
    });
  });

  it('reads a name from the mention span inside the plain text', () => {
    const evidence = new Map<string, NameEvidence>();
    collectFromMessage(
      evidence,
      message({
        text: 'thanks @Jenny Munoz for this',
        annotations: [
          {
            type: 'USER_MENTION',
            startIndex: 7,
            length: 12,
            userMention: { user: { name: DELETED } },
          },
        ],
      })
    );
    const chosen = chooseName(evidence.get(DELETED) as NameEvidence);
    expect(chosen?.name).toBe('Jenny Munoz');
    expect(chosen?.mentionCount).toBe(1);
    expect(chosen?.fromDisplayName).toBe(false);
  });

  it('ignores Vault-sourced messages, which carry no user ids', () => {
    const evidence = new Map<string, NameEvidence>();
    collectFromMessage(
      evidence,
      message(
        { sender: { name: DELETED, displayName: 'Jenny Fuksa' } },
        'vault'
      )
    );
    expect(evidence.size).toBe(0);
  });

  it('refuses Google\u2019s generic "Deleted User" label', () => {
    const evidence = new Map<string, NameEvidence>();
    collectFromMessage(
      evidence,
      message({ sender: { name: DELETED, displayName: 'Deleted User' } })
    );
    collectFromMessage(
      evidence,
      message({
        text: 'thanks @Jenny Fuksa',
        annotations: [
          {
            type: 'USER_MENTION',
            startIndex: 7,
            length: 12,
            userMention: { user: { name: DELETED } },
          },
        ],
      })
    );
    const chosen = chooseName(evidence.get(DELETED) as NameEvidence);
    expect(chosen?.name).toBe('Jenny Fuksa');
    expect(chosen?.alternates).toEqual([]);
    expect(chosen?.fromDisplayName).toBe(false);
  });

  it('keeps an address intact when that is all the identity there is', () => {
    const evidence = new Map<string, NameEvidence>();
    collectFromMessage(
      evidence,
      message({
        sender: { name: DELETED, displayName: 'AmaraBrock22@gmail.com' },
      })
    );
    expect(chooseName(evidence.get(DELETED) as NameEvidence)?.name).toBe(
      'amarabrock22@gmail.com'
    );
  });

  it('ignores annotations that are not user mentions', () => {
    const evidence = new Map<string, NameEvidence>();
    collectFromMessage(
      evidence,
      message({
        text: 'see the doc',
        annotations: [{ type: 'RICH_LINK', startIndex: 0, length: 3 }],
      })
    );
    expect(evidence.size).toBe(0);
  });
});

describe('chooseName', () => {
  function evidenceOf(
    candidates: [string, number][],
    fromDisplayName = false
  ): NameEvidence {
    return {
      chatUserId: DELETED,
      candidates: new Map(candidates),
      fromDisplayName,
      mentionCount: 0,
    };
  }

  it('prefers the most weighted spelling and keeps the rest as alternates', () => {
    const chosen = chooseName(
      evidenceOf([
        ['Jenny Munoz', 101],
        ['Jenny Fuksa', 53],
      ])
    );
    expect(chosen?.name).toBe('Jenny Munoz');
    expect(chosen?.alternates).toEqual(['Jenny Fuksa']);
  });

  it('marks a close call as medium confidence', () => {
    expect(
      chooseName(
        evidenceOf([
          ['Zach Gryder', 10],
          ['h Gryder tha', 9],
        ])
      )?.confidence
    ).toBe('medium');
  });

  it('trusts Google’s own field even against a frequent scrape', () => {
    const chosen = chooseName(
      evidenceOf(
        [
          ['Savannah Emert', 5],
          ['avannah Emert I', 4],
        ],
        true
      )
    );
    expect(chosen?.confidence).toBe('high');
    expect(chosen?.name).toBe('Savannah Emert');
  });

  it('returns nothing when there is no evidence', () => {
    expect(chooseName(evidenceOf([]))).toBeUndefined();
  });
});

describe('matchEmails', () => {
  const named = (name: string, alternates: string[] = []): RecoveredName => ({
    chatUserId: `users/${name}`,
    name,
    confidence: 'high',
    alternates,
    fromDisplayName: true,
    mentionCount: 0,
  });
  const free = (email: string): EmailCandidate => ({ email, claimed: false });

  it('matches an address built from the full name', () => {
    const [result] = matchEmails(
      [named('Jenny Fuksa')],
      [free('jenny.fuksa@hrc.email'), free('other@hrc.email')]
    );
    expect(result.email).toBe('jenny.fuksa@hrc.email');
    expect(result.emailMatch).toBe('full-name');
  });

  it('promotes the spelling the address uses, keeping the old one', () => {
    const [result] = matchEmails(
      [named('Jenny Munoz', ['Jenny Fuksa'])],
      [free('jenny.fuksa@hrc.email')]
    );
    expect(result.email).toBe('jenny.fuksa@hrc.email');
    expect(result.name).toBe('Jenny Fuksa');
    expect(result.alternates).toEqual(['Jenny Munoz']);
  });

  it('accepts a first-name address only when it is unambiguous', () => {
    const [result] = matchEmails(
      [named('James Barefield')],
      [free('james@hrc.email')]
    );
    expect(result.email).toBe('james@hrc.email');
    expect(result.emailMatch).toBe('first-name');
  });

  it('refuses a first-name address when two people share the first name', () => {
    const results = matchEmails(
      [named('James Barefield'), named('James Cooper')],
      [free('james@hrc.email')]
    );
    expect(results.every((r) => r.email === undefined)).toBe(true);
  });

  it('never takes an address that belongs to a known person', () => {
    const [result] = matchEmails(
      [named('Jenny Fuksa')],
      [{ email: 'jenny.fuksa@hrc.email', claimed: true }]
    );
    expect(result.email).toBeUndefined();
  });
});

describe('buildRecoveryPlan and applyRecovery', () => {
  const users: Record<string, StoredUser> = {
    [DELETED]: placeholder(DELETED),
    'users/unknowable': placeholder('users/unknowable'),
    [ACTIVE]: {
      chatUserId: ACTIVE,
      email: 'pat@hrc.email',
      fullName: 'Pat Pastor',
      status: 'active',
      isPlaceholder: false,
      sources: ['directory'],
      firstSeenRun: 'r',
    },
  };

  it('names only the people who need it and reports the rest', () => {
    const evidence = new Map<string, NameEvidence>();
    collectFromMessage(
      evidence,
      message({ sender: { name: DELETED, displayName: 'Jenny Fuksa' } })
    );
    collectFromMessage(
      evidence,
      message({ sender: { name: ACTIVE, displayName: 'Should Be Ignored' } })
    );

    const plan = buildRecoveryPlan(evidence, users, [
      { email: 'jenny.fuksa@hrc.email', claimed: false },
    ]);
    expect(plan.recovered.map((r) => r.chatUserId)).toEqual([DELETED]);
    expect(plan.recovered[0].email).toBe('jenny.fuksa@hrc.email');
    expect(plan.unresolved).toEqual(['users/unknowable']);
    expect(plan.warnings).toEqual([]);
    expect(plan.aliases).toEqual([]);
  });

  it('writes recovered names without touching directory-named people', () => {
    const plan = {
      recovered: [
        {
          chatUserId: DELETED,
          name: 'Jenny Fuksa',
          confidence: 'high' as const,
          alternates: [],
          fromDisplayName: true,
          mentionCount: 0,
          email: 'jenny.fuksa@hrc.email',
        },
        {
          chatUserId: ACTIVE,
          name: 'Wrong',
          confidence: 'high' as const,
          alternates: [],
          fromDisplayName: true,
          mentionCount: 0,
        },
      ],
      unresolved: [],
      warnings: [],
      aliases: [],
    };
    const { users: next, updated } = applyRecovery(users, plan, 'run');
    expect(updated).toBe(1);
    expect(next[DELETED]).toMatchObject({
      fullName: 'Jenny Fuksa',
      placeholderName: 'Jenny Fuksa',
      email: 'jenny.fuksa@hrc.email',
      status: 'deleted',
      isPlaceholder: true,
    });
    expect(next[ACTIVE].fullName).toBe('Pat Pastor');
  });

  it('keeps an email the store already had', () => {
    const withEmail = {
      ...users,
      [DELETED]: { ...placeholder(DELETED), email: 'known@hrc.email' },
    };
    const { users: next } = applyRecovery(
      withEmail,
      {
        recovered: [
          {
            chatUserId: DELETED,
            name: 'Jenny Fuksa',
            confidence: 'high' as const,
            alternates: [],
            fromDisplayName: true,
            mentionCount: 0,
            email: 'guessed@hrc.email',
          },
        ],
        unresolved: [],
        warnings: [],
        aliases: [],
      },
      'run'
    );
    expect(next[DELETED].email).toBe('known@hrc.email');
  });
});

describe('reviewWarnings', () => {
  const person = (
    id: string,
    name: string,
    email?: string,
    alternates: string[] = []
  ): RecoveredName => ({
    chatUserId: id,
    name,
    confidence: 'high',
    alternates,
    fromDisplayName: true,
    mentionCount: 0,
    email,
  });

  it('flags one name claimed by two accounts', () => {
    const warnings = reviewWarnings([
      person('users/aaa111', 'Felecia McCarthy'),
      person('users/bbb222', 'Felecia McCarthy'),
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('claimed by 2 accounts');
  });

  it('flags an address that spells an alternate name', () => {
    const warnings = reviewWarnings([
      person('users/ccc', 'Jenny Munoz', 'jenny.fuksa@hrc.email', [
        'Jenny Fuksa',
      ]),
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Jenny Fuksa');
  });

  it('stays quiet when the address agrees with the chosen name', () => {
    expect(
      reviewWarnings([
        person('users/d', 'Jenny Fuksa', 'jenny.fuksa@hrc.email'),
      ])
    ).toEqual([]);
  });
});

describe('aliases', () => {
  const vaultUser: StoredUser = {
    chatUserId: 'users/vault-abc',
    source: 'vault',
    email: 'jenny.fuksa@hrc.email',
    fullName: 'jenny.fuksa@hrc.email',
    status: 'deleted',
    isPlaceholder: true,
    sources: ['sender'],
    firstSeenRun: 'r',
  };
  const recovered: RecoveredName = {
    chatUserId: DELETED,
    name: 'Jenny Fuksa',
    confidence: 'high',
    alternates: ['Jenny Munoz'],
    fromDisplayName: false,
    mentionCount: 154,
    email: 'jenny.fuksa@hrc.email',
  };

  it('retires the email-keyed record in favour of the id the messages use', () => {
    const aliases = planAliases([recovered], {
      [DELETED]: placeholder(DELETED),
      'users/vault-abc': vaultUser,
    });
    expect(aliases).toEqual([
      {
        chatUserId: 'users/vault-abc',
        canonical: DELETED,
        reason: expect.stringContaining('Jenny Fuksa'),
      },
    ]);
  });

  it('accepts a merge made by hand', () => {
    const aliases = planAliases([], {}, { 'users/old': 'users/new' });
    expect(aliases).toEqual([
      {
        chatUserId: 'users/old',
        canonical: 'users/new',
        reason: 'merged by hand',
      },
    ]);
  });

  it('ignores a record pointed at itself', () => {
    expect(planAliases([], {}, { 'users/same': 'users/same' })).toEqual([]);
  });

  it('follows a chain to the record that should be used', () => {
    const users: Record<string, StoredUser> = {
      'users/a': { ...placeholder('users/a'), aliasOf: 'users/b' },
      'users/b': { ...placeholder('users/b'), aliasOf: 'users/c' },
      'users/c': placeholder('users/c'),
    };
    expect(resolveAlias(users, 'users/a')).toBe('users/c');
    expect(resolveAlias(users, 'users/c')).toBe('users/c');
    expect(resolveAlias(users, 'users/missing')).toBe('users/missing');
  });

  it('does not loop on a cycle', () => {
    const users: Record<string, StoredUser> = {
      'users/a': { ...placeholder('users/a'), aliasOf: 'users/b' },
      'users/b': { ...placeholder('users/b'), aliasOf: 'users/a' },
    };
    expect(['users/a', 'users/b']).toContain(resolveAlias(users, 'users/a'));
  });

  it('writes the alias and keeps the merged address', () => {
    const users: Record<string, StoredUser> = {
      [DELETED]: placeholder(DELETED),
      'users/vault-abc': vaultUser,
    };
    const { users: next, aliased } = applyRecovery(
      users,
      {
        aliases: [
          {
            chatUserId: 'users/vault-abc',
            canonical: DELETED,
            reason: 'same person',
          },
        ],
        recovered: [],
        unresolved: [],
        warnings: [],
      },
      'run'
    );
    expect(aliased).toBe(1);
    expect(next['users/vault-abc'].aliasOf).toBe(DELETED);
    expect(next[DELETED].email).toBe('jenny.fuksa@hrc.email');
  });
});

describe('needsName', () => {
  it('targets deleted and unknown placeholders only', () => {
    expect(needsName(placeholder(DELETED))).toBe(true);
    expect(needsName({ ...placeholder(DELETED), status: 'unknown' })).toBe(
      true
    );
    expect(needsName({ ...placeholder(DELETED), status: 'bot' })).toBe(false);
    expect(needsName({ ...placeholder(DELETED), isPlaceholder: false })).toBe(
      false
    );
    expect(needsName(undefined)).toBe(true);
  });
});
