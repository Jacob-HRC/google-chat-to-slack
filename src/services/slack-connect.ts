/**
 * "Connect" flow for restoring reactions. Slack only lets a person add their
 * own reactions, and only with their own token, so each person approves the
 * app once through Slack's OAuth page and the token is kept in the OS
 * keyring under `slack-user:<Slack user id>`. Nothing is stored in the repo.
 *
 * The page is served by a tiny HTTP server behind Tailscale Funnel only
 * while people are connecting.
 */
import { randomBytes } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { WebClient } from '@slack/web-api';
import { readJsonFile, writeJsonAtomic } from '../utils/fs-atomic';
import { getToken, setToken } from '../utils/token-manager';

/**
 * What a connected person's token may do: react, tidy their own messages,
 * and archive private channels they are in (see archive-channels).
 */
export const RESTORE_USER_SCOPES = [
  'reactions:write',
  'chat:write',
  'channels:read',
  'groups:read',
  'im:read',
  'mpim:read',
  'channels:history',
  'groups:history',
  'im:history',
  'mpim:history',
  'groups:write',
] as const;

export interface ConnectedUser {
  slackId: string;
  name?: string;
  connectedAt: string;
  scopes: string;
}

/** Who is connected; ids and names only, the tokens live in the keyring. */
export type ConnectedRegistry = Record<string, ConnectedUser>;

export function keyringAccount(slackId: string): string {
  return `slack-user:${slackId}`;
}

export async function loadRegistry(path: string): Promise<ConnectedRegistry> {
  return (await readJsonFile<ConnectedRegistry>(path)) ?? {};
}

export function tokenFor(slackId: string): Promise<string | null> {
  return getToken(keyringAccount(slackId));
}

/** Slack's authorize URL for the user scopes above, pinned to one workspace. Pure. */
export function authorizeUrl(
  clientId: string,
  redirectUri: string,
  state: string,
  teamId?: string
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    user_scope: RESTORE_USER_SCOPES.join(','),
    redirect_uri: redirectUri,
    state,
  });
  if (teamId) {
    params.set('team', teamId);
  }
  return `https://slack.com/oauth/v2/authorize?${params.toString()}`;
}

export interface ConnectServerOptions {
  clientId: string;
  clientSecret: string;
  /** Public base, e.g. https://server.tail3620c0.ts.net:8443 */
  publicBase: string;
  port: number;
  registryPath: string;
  /** Only these Slack user ids may connect (the test), or anyone when empty. */
  allow: Set<string>;
  /** The destination workspace. A token from any other workspace is refused. */
  teamId: string;
}

/** Tailscale may or may not strip the /slack mount before forwarding. */
const MOUNT_PREFIX_REGEX = /^\/slack(?=\/)/;
const PAGE_STYLE =
  'font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;line-height:1.5';
/** A pending login expires, and only so many can wait at once. */
const STATE_TTL_MS = 15 * 60 * 1000;
const MAX_PENDING_STATES = 500;

function page(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(`<!doctype html><body style="${PAGE_STYLE}">${body}</body>`);
}

/** One-use login states that expire, capped so the public page can't be flooded. */
function stateStore(): {
  issue: () => string | undefined;
  take: (state: string) => boolean;
} {
  const states = new Map<string, number>();
  return {
    issue: () => {
      const now = Date.now();
      for (const [key, expires] of states) {
        if (expires <= now) {
          states.delete(key);
        }
      }
      if (states.size >= MAX_PENDING_STATES) {
        return;
      }
      const state = randomBytes(16).toString('hex');
      states.set(state, now + STATE_TTL_MS);
      return state;
    },
    take: (state) => {
      const expires = states.get(state);
      states.delete(state);
      return expires !== undefined && expires > Date.now();
    },
  };
}

export function startConnectServer(
  options: ConnectServerOptions
): Promise<Server> {
  const redirectUri = `${options.publicBase}/slack/callback`;
  const states = stateStore();
  // Registry updates run one at a time, so simultaneous approvals all land.
  let registryQueue: Promise<void> = Promise.resolve();
  const record = (entry: ConnectedUser): Promise<void> => {
    registryQueue = registryQueue.then(async () => {
      const registry = await loadRegistry(options.registryPath);
      registry[entry.slackId] = entry;
      await writeJsonAtomic(options.registryPath, registry);
    });
    return registryQueue;
  };

  const callback = async (url: URL, res: ServerResponse): Promise<void> => {
    const code = url.searchParams.get('code');
    if (!(code && states.take(url.searchParams.get('state') ?? ''))) {
      page(
        res,
        400,
        '<p>This link has expired. Please start again from the link you were sent.</p>'
      );
      return;
    }
    const exchange = await new WebClient().oauth.v2.access({
      client_id: options.clientId,
      client_secret: options.clientSecret,
      code,
      redirect_uri: redirectUri,
    });
    const user = exchange.authed_user;
    if (exchange.team?.id !== options.teamId) {
      page(res, 403, '<p>That is a different Slack workspace.</p>');
      return;
    }
    if (!(user?.id && user.access_token)) {
      page(res, 500, '<p>Slack did not return a user token.</p>');
      return;
    }
    if (options.allow.size > 0 && !options.allow.has(user.id)) {
      page(res, 403, '<p>This restore is not open to your account yet.</p>');
      return;
    }
    await setToken(keyringAccount(user.id), user.access_token);
    const info = await new WebClient(user.access_token).auth.test();
    await record({
      slackId: user.id,
      name: info.user,
      connectedAt: new Date().toISOString(),
      scopes: user.scope ?? '',
    });
    page(
      res,
      200,
      '<p>Thanks, you are connected. Your reactions from Google Chat will be restored. You can close this tab.</p>'
    );
  };

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', options.publicBase);
    } catch {
      page(res, 400, '');
      return;
    }
    if (req.method !== 'GET') {
      page(res, 405, '');
      return;
    }
    const route = url.pathname.replace(MOUNT_PREFIX_REGEX, '');
    if (route === '/connect') {
      const state = states.issue();
      if (!state) {
        page(
          res,
          503,
          '<p>Busy right now. Please try again in a few minutes.</p>'
        );
        return;
      }
      res.writeHead(302, {
        Location: authorizeUrl(
          options.clientId,
          redirectUri,
          state,
          options.teamId
        ),
        'Cache-Control': 'no-store',
      });
      res.end();
      return;
    }
    if (route === '/callback') {
      callback(url, res).catch((error: Error) => {
        // Details stay in the server log; the public page says nothing internal.
        console.error('slack-connect callback failed:', error.message);
        page(
          res,
          500,
          '<p>Something went wrong. Please try the link again.</p>'
        );
      });
      return;
    }
    page(res, 404, '');
  };

  const server = createServer(handle);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, '127.0.0.1', () => resolve(server));
  });
}
