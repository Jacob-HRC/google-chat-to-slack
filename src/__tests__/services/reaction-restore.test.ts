import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  type ArchivedReaction,
  addReaction,
  ledgerKey,
  markRestored,
  messageFileIds,
  type RestoredLedger,
  rewriteReactionLine,
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

describe('rewriteReactionLine', () => {
  const [lunch] = archived;

  it('keeps only the people still missing', () => {
    expect(
      rewriteReactionLine(
        lunch.text,
        lunch.reactions,
        new Set(['U_KEN']),
        nameOf
      )
    ).toBe('Lunch?\n_Reactions: :+1: Amy_');
  });

  it('shows an emoji Slack has no name for as the character', () => {
    expect(
      rewriteReactionLine(
        'Hi\n_Reactions: :+1: Amy · \u{1FAEA} Amy_',
        [
          { name: '+1', users: ['U_AMY', 'U_KEN'] },
          { name: '\u{1FAEA}', users: ['U_AMY'] },
        ],
        new Set(['U_KEN']),
        nameOf
      )
    ).toBeUndefined();
  });

  it('drops the line once everyone is restored', () => {
    expect(
      rewriteReactionLine(
        lunch.text,
        lunch.reactions,
        new Set(['U_KEN', 'U_AMY']),
        nameOf
      )
    ).toBe('Lunch?');
  });

  it('returns undefined when nothing changes or there is no line', () => {
    expect(
      rewriteReactionLine(lunch.text, lunch.reactions, new Set(), nameOf)
    ).toBeUndefined();
    expect(
      rewriteReactionLine('Lunch?', lunch.reactions, new Set(['U_KEN']), nameOf)
    ).toBeUndefined();
  });
});

describe('markRestored', () => {
  it('builds on earlier runs without duplicates', () => {
    const ledger: RestoredLedger = {
      restored: { [ledgerKey('D1', '1.1')]: ['U_KEN'] },
      lines: {},
    };
    markRestored(ledger, ledgerKey('D1', '1.1'), 'U_AMY');
    markRestored(ledger, ledgerKey('D1', '1.1'), 'U_KEN');
    expect(ledger.restored['D1:1.1']).toEqual(['U_KEN', 'U_AMY']);
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

describe('messageFileIds', () => {
  const page = {
    messages: [
      { ts: '5.5', files: [{ id: 'F1' }, { id: 'F2' }] },
      { ts: '6.6', files: [{ id: 'F3' }] },
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
    expect(await messageFileIds(client, 'D1', { ts: '5.5' })).toEqual([
      'F1',
      'F2',
    ]);
    expect(
      await messageFileIds(client, 'D1', { ts: '6.6', threadTs: '5.5' })
    ).toEqual(['F3']);
    expect(await messageFileIds(client, 'D1', { ts: '9.9' })).toEqual([]);
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
