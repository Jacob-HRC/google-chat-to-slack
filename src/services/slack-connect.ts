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

/** What a connected person's token may do: react, and tidy their own messages. */
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

/** Slack's authorize URL for the user scopes above. Pure. */
export function authorizeUrl(
  clientId: string,
  redirectUri: string,
  state: string
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    user_scope: RESTORE_USER_SCOPES.join(','),
    redirect_uri: redirectUri,
    state,
  });
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
}

const LESS_THAN_REGEX = /</g;
/** Tailscale may or may not strip the /slack mount before forwarding. */
const MOUNT_PREFIX_REGEX = /^\/slack(?=\/)/;
const PAGE_STYLE =
  'font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;line-height:1.5';

function page(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(`<!doctype html><body style="${PAGE_STYLE}">${body}</body>`);
}

export function startConnectServer(
  options: ConnectServerOptions
): Promise<Server> {
  const redirectUri = `${options.publicBase}/slack/callback`;
  const states = new Set<string>();

  const callback = async (url: URL, res: ServerResponse): Promise<void> => {
    const state = url.searchParams.get('state') ?? '';
    const code = url.searchParams.get('code');
    if (!(code && states.delete(state))) {
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
    const registry = await loadRegistry(options.registryPath);
    registry[user.id] = {
      slackId: user.id,
      name: info.user,
      connectedAt: new Date().toISOString(),
      scopes: user.scope ?? '',
    };
    await writeJsonAtomic(options.registryPath, registry);
    page(
      res,
      200,
      '<p>Thanks, you are connected. Your reactions from Google Chat will be restored. You can close this tab.</p>'
    );
  };

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? '/', options.publicBase);
    if (req.method !== 'GET') {
      page(res, 405, '');
      return;
    }
    const route = url.pathname.replace(MOUNT_PREFIX_REGEX, '');
    if (route === '/connect') {
      const state = randomBytes(16).toString('hex');
      states.add(state);
      res.writeHead(302, {
        Location: authorizeUrl(options.clientId, redirectUri, state),
        'Cache-Control': 'no-store',
      });
      res.end();
      return;
    }
    if (route === '/callback') {
      callback(url, res).catch((error: Error) =>
        page(
          res,
          500,
          `<p>Something went wrong: ${error.message.replace(LESS_THAN_REGEX, '&lt;')}</p>`
        )
      );
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
