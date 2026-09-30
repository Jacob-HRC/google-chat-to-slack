import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  type ArchivedReaction,
  addReaction,
  fetchMessage,
  footerFor,
  footerOf,
  ledgerKey,
  markRestored,
  pairKey,
  type RestoredLedger,
  replaceFooter,
  tasksFor,
} from '../../services/reaction-restore';
import {
  authorizeUrl,
  keyringAccount,
  startConnectServer,
} from '../../services/slack-connect';

const stored = vi.hoisted(() => new Map<string, string>());
const slack = vi.hoisted(() => ({
  userId: 'U_KEN',
  teamId: 'T_HRC',
  reactionError: undefined as string | undefined,
}));

vi.mock('../../utils/token-manager', () => ({
  setToken: (account: string, token: string) => {
    stored.set(account, token);
    return Promise.resolve();
  },
  getToken: (account: string) => Promise.resolve(stored.get(account) ?? null),
}));

vi.mock('@slack/web-api', () => ({
  WebClient: class {
    oauth = {
      v2: {
        // A code of the form U_… stands for that person's approval.
        access: ({ code }: { code: string }) => {
          const id = code.startsWith('U_') ? code : slack.userId;
          return Promise.resolve({
            team: { id: slack.teamId },
            authed_user: {
              id,
              access_token: `xoxp-${id}`,
              scope: 'reactions:write',
            },
          });
        },
      },
    };
    auth = { test: () => Promise.resolve({ user: 'someone' }) };
    reactions = {
      add: () =>
        slack.reactionError
          ? Promise.reject({ data: { error: slack.reactionError } })
          : Promise.resolve({ ok: true }),
    };
  },
}));

const archived: ArchivedReaction[] = [
  {
    folder: 'D1',
    ts: '1700000000.000100',
    author: 'U_JACOB',
    text: 'Lunch?\n_Reactions: :+1: Ken Kicker, Amy · :heart: Ken Kicker_',
    reactions: [
      { name: '+1', users: ['U_KEN', 'U_AMY'] },
      { name: 'heart', users: ['U_KEN'] },
    ],
  },
  {
    folder: 'general',
    ts: '1700000000.000200',
    author: 'U_KEN',
    text: 'Done\n_Reactions: :tada: Amy_',
    reactions: [{ name: 'tada', users: ['U_AMY'] }],
  },
];

const names: Record<string, string> = {
  U_KEN: 'Ken Kicker',
  U_AMY: 'Amy',
};
const nameOf = (id: string): string => names[id] ?? id;

describe('tasksFor', () => {
  it("lists only the given person's reactions", () => {
    expect(tasksFor(archived, 'U_KEN')).toEqual([
      { folder: 'D1', ts: '1700000000.000100', name: '+1' },
      { folder: 'D1', ts: '1700000000.000100', name: 'heart' },
    ]);
    expect(tasksFor(archived, 'U_AMY')).toHaveLength(2);
    expect(tasksFor(archived, 'U_JACOB')).toEqual([]);
  });
});

describe('reaction line', () => {
  const [lunch] = archived;
  const footer = footerOf(lunch.text) ?? '';

  it('names only the reactions not yet real, per person and emoji', () => {
    // Ken's +1 went through but his heart failed: the heart stays listed.
    expect(
      footerFor(lunch.reactions, new Set([pairKey('U_KEN', '+1')]), nameOf)
    ).toBe('_Reactions: :+1: Amy · :heart: Ken Kicker_');
    expect(
      footerFor(
        lunch.reactions,
        new Set([
          pairKey('U_KEN', '+1'),
          pairKey('U_AMY', '+1'),
          pairKey('U_KEN', 'heart'),
        ]),
        nameOf
      )
    ).toBe('');
  });

  it('shows an emoji Slack has no name for as the character', () => {
    expect(
      footerFor([{ name: '\u{1FAEA}', users: ['U_AMY'] }], new Set(), nameOf)
    ).toBe('_Reactions: \u{1FAEA} Amy_');
  });

  it('swaps only the last line, keeping the text as it is now', () => {
    expect(replaceFooter(lunch.text, footer, '')).toBe('Lunch?');
    expect(replaceFooter(lunch.text, footer, '_Reactions: :+1: Amy_')).toBe(
      'Lunch?\n_Reactions: :+1: Amy_'
    );
    // A line the author wrote that happens to look like ours is kept.
    const own = `_Reactions: pending_\nsee above\n${footer}`;
    expect(replaceFooter(own, footer, '')).toBe(
      '_Reactions: pending_\nsee above'
    );
    // A file-only message ends up empty (the caller passes its files).
    expect(replaceFooter(`\n${footer}`, footer, '')).toBe('');
  });

  it('leaves a message alone when its line is not exactly as written', () => {
    expect(
      replaceFooter('Lunch at noon?\n_Reactions: edited_', footer, '')
    ).toBeUndefined();
    expect(replaceFooter('Lunch at noon?', footer, '')).toBeUndefined();
    expect(replaceFooter(lunch.text, footer, footer)).toBeUndefined();
  });

  it('finds the line the archive wrote only at the end', () => {
    expect(footerOf(lunch.text)).toBe(
      '_Reactions: :+1: Ken Kicker, Amy · :heart: Ken Kicker_'
    );
    expect(footerOf('_Reactions: pending_\nhello')).toBeUndefined();
  });
});

describe('markRestored', () => {
  it('builds on earlier runs without duplicates', () => {
    const ledger: RestoredLedger = {
      restored: { [ledgerKey('D1', '1.1')]: [pairKey('U_KEN', '+1')] },
      footers: {},
    };
    markRestored(ledger, ledgerKey('D1', '1.1'), 'U_AMY', '+1');
    markRestored(ledger, ledgerKey('D1', '1.1'), 'U_KEN', '+1');
    markRestored(ledger, ledgerKey('D1', '1.1'), 'U_KEN', 'heart');
    expect(ledger.restored['D1:1.1']).toEqual([
      'U_KEN +1',
      'U_AMY +1',
      'U_KEN heart',
    ]);
  });
});

describe('addReaction', () => {
  const task = { folder: 'D1', ts: '1.1', name: '+1' };

  it('sorts Slack errors into outcomes', async () => {
    const { WebClient } = await import('@slack/web-api');
    const client = new WebClient();
    const destination = { channelId: 'D123' };
    slack.reactionError = undefined;
    expect(await addReaction(client, destination, task)).toBe('added');
    slack.reactionError = 'already_reacted';
    expect(await addReaction(client, destination, task)).toBe('already');
    slack.reactionError = 'message_not_found';
    expect(await addReaction(client, destination, task)).toBe('message-gone');
    slack.reactionError = 'invalid_name';
    expect(await addReaction(client, destination, task)).toBe('emoji-missing');
    slack.reactionError = 'ratelimited';
    expect(await addReaction(client, destination, task)).toBe('failed');
    expect(
      await addReaction(client, { unreachable: 'not a member' }, task)
    ).toBe('unreachable');
  });
});

describe('fetchMessage', () => {
  const page = {
    messages: [
      { ts: '5.5', text: 'a', files: [{ id: 'F1' }, { id: 'F2' }] },
      { ts: '6.6', text: 'b', files: [{ id: 'F3' }], edited: { ts: '7.7' } },
    ],
  };
  const calls: string[] = [];
  const client = {
    conversations: {
      history: () => {
        calls.push('history');
        return Promise.resolve(page);
      },
      replies: (args: { ts: string }) => {
        calls.push(`replies:${args.ts}`);
        return Promise.resolve(page);
      },
    },
  } as unknown as import('@slack/web-api').WebClient;

  it('reads top-level messages from history and replies from their thread', async () => {
    expect(await fetchMessage(client, 'D1', { ts: '5.5' })).toEqual({
      text: 'a',
      fileIds: ['F1', 'F2'],
      editedTs: undefined,
    });
    expect(
      await fetchMessage(client, 'D1', { ts: '6.6', threadTs: '5.5' })
    ).toEqual({ text: 'b', fileIds: ['F3'], editedTs: '7.7' });
    expect(await fetchMessage(client, 'D1', { ts: '9.9' })).toBeUndefined();
    expect(calls).toEqual(['history', 'replies:5.5', 'history']);
  });
});

describe('authorizeUrl', () => {
  it('asks for user scopes only, with the state and redirect', () => {
    const url = new URL(
      authorizeUrl('123.456', 'https://host:8443/slack/callback', 'abc')
    );
    expect(url.origin + url.pathname).toBe(
      'https://slack.com/oauth/v2/authorize'
    );
    expect(url.searchParams.get('user_scope')).toContain('reactions:write');
    expect(url.searchParams.get('scope')).toBeNull();
    expect(url.searchParams.get('state')).toBe('abc');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://host:8443/slack/callback'
    );
  });
});

describe('connect server', () => {
  let dir: string;
  let server: Server;
  let base: string;
  let registryPath: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'slack-connect-'));
    registryPath = path.join(dir, 'connected.json');
    server = await startConnectServer({
      clientId: '123.456',
      clientSecret: 'secret',
      publicBase: 'https://host:8443',
      port: 0,
      registryPath,
      allow: new Set(['U_JACOB', 'U_KEN']),
      teamId: 'T_HRC',
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.close();
    await rm(dir, { recursive: true, force: true });
  });

  async function startState(route: string): Promise<string> {
    const res = await fetch(`${base}${route}`, { redirect: 'manual' });
    const state = new URL(res.headers.get('location') ?? '').searchParams.get(
      'state'
    );
    if (res.status !== 302 || !state) {
      throw new Error(`${route} did not redirect with a state`);
    }
    return state;
  }

  it('redirects to Slack whether or not Funnel strips /slack', async () => {
    await startState('/slack/connect');
    await startState('/connect');
  });

  it('refuses a callback with an unknown state', async () => {
    const res = await fetch(`${base}/slack/callback?code=c&state=forged`);
    expect(res.status).toBe(400);
  });

  it('refuses people outside the allow list and stores nothing', async () => {
    slack.userId = 'U_OTHER';
    const state = await startState('/slack/connect');
    const res = await fetch(`${base}/slack/callback?code=c&state=${state}`);
    expect(res.status).toBe(403);
    expect(stored.has(keyringAccount('U_OTHER'))).toBe(false);
  });

  it('stores an allowed token in the keyring and lists the person', async () => {
    slack.userId = 'U_KEN';
    const state = await startState('/slack/connect');
    const res = await fetch(`${base}/slack/callback?code=c&state=${state}`);
    expect(res.status).toBe(200);
    expect(stored.get(keyringAccount('U_KEN'))).toBe('xoxp-U_KEN');
    const registry = JSON.parse(await readFile(registryPath, 'utf-8'));
    expect(Object.keys(registry)).toEqual(['U_KEN']);
    expect(JSON.stringify(registry)).not.toContain('xoxp');
  });

  it('refuses a token from another workspace', async () => {
    slack.teamId = 'T_OTHER';
    slack.userId = 'U_JACOB';
    const state = await startState('/slack/connect');
    const res = await fetch(`${base}/slack/callback?code=c&state=${state}`);
    slack.teamId = 'T_HRC';
    expect(res.status).toBe(403);
    expect(stored.has(keyringAccount('U_JACOB'))).toBe(false);
  });

  it('pins the approval page to the workspace', async () => {
    const res = await fetch(`${base}/slack/connect`, { redirect: 'manual' });
    const location = new URL(res.headers.get('location') ?? '');
    expect(location.searchParams.get('team')).toBe('T_HRC');
  });

  it('keeps every person when approvals land at the same moment', async () => {
    const [a, b] = [await startState('/connect'), await startState('/connect')];
    const results = await Promise.all([
      fetch(`${base}/slack/callback?code=U_JACOB&state=${a}`),
      fetch(`${base}/slack/callback?code=U_KEN&state=${b}`),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    const registry = JSON.parse(await readFile(registryPath, 'utf-8'));
    expect(Object.keys(registry).sort()).toEqual(['U_JACOB', 'U_KEN']);
  });

  it('does not accept the same state twice', async () => {
    const state = await startState('/slack/connect');
    expect(
      (await fetch(`${base}/slack/callback?code=c&state=${state}`)).status
    ).toBe(200);
    expect(
      (await fetch(`${base}/slack/callback?code=c&state=${state}`)).status
    ).toBe(400);
  });
});
