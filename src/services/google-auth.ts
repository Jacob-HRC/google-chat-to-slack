import { readFile } from 'node:fs/promises';
import http from 'node:http';
import url from 'node:url';
import { JWT, OAuth2Client } from 'google-auth-library';
import { google } from 'googleapis';
import open from 'open';
import { z } from 'zod';
import { config, requireGoogleOAuthConfig } from '../config';
import { deleteToken, getToken, setToken } from '../utils/token-manager';

const REDIRECT_URI = 'http://localhost:3000';

/**
 * Scopes used by both auth modes.
 *
 * For a service account, this exact list must be authorized for the service
 * account's client ID in the Google Admin console under
 * Security > Access and data control > API controls > Domain-wide delegation.
 */
export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/chat.spaces.readonly',
  'https://www.googleapis.com/auth/chat.messages.readonly',
  'https://www.googleapis.com/auth/chat.memberships.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/admin.directory.user.readonly',
] as const;

export const GOOGLE_AUTH_MODES = {
  OAUTH: 'oauth',
  SERVICE_ACCOUNT: 'service-account',
} as const;

export type GoogleAuthMode =
  (typeof GOOGLE_AUTH_MODES)[keyof typeof GOOGLE_AUTH_MODES];

// Keyring accounts (service name is shared with the Slack token).
const KEYRING_OAUTH_ACCOUNT = 'google';
const KEYRING_SA_KEY_ACCOUNT = 'google-service-account-key';
const KEYRING_SA_SUBJECT_ACCOUNT = 'google-service-account-subject';

const serviceAccountKeySchema = z.object({
  type: z.literal('service_account'),
  client_email: z.string().email(),
  private_key: z.string().min(1),
  client_id: z.string().optional(),
  project_id: z.string().optional(),
});

export type ServiceAccountKey = z.infer<typeof serviceAccountKeySchema>;

export interface ServiceAccountCredentials {
  key: ServiceAccountKey;
  /** Default user to impersonate (a Workspace admin for Directory calls). */
  subject: string;
}

export interface AuthModeInputs {
  hasServiceAccount: boolean;
  hasOAuthToken: boolean;
  requested?: GoogleAuthMode;
}

export interface AccessCheck {
  ok: boolean;
  detail: string;
}

export interface ServiceAccountReport {
  clientEmail: string;
  subject: string;
  directory: AccessCheck;
  chat: AccessCheck;
}

export interface GoogleLoginOptions {
  serviceAccountKeyFile?: string;
  subject?: string;
}

// Process-level caches. `undefined` means "not loaded yet", `null` means
// "loaded and absent".
let cachedServiceAccount: ServiceAccountCredentials | null | undefined;
let cachedOAuthClient: OAuth2Client | undefined;
const jwtClients = new Map<string, JWT>();

export function resetGoogleAuthCache(): void {
  cachedServiceAccount = undefined;
  cachedOAuthClient = undefined;
  jwtClients.clear();
}

export function parseServiceAccountKey(json: string): ServiceAccountKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('Service account key is not valid JSON.');
  }

  const result = serviceAccountKeySchema.safeParse(parsed);
  if (!result.success) {
    const fields = result.error.issues
      .map((issue) => issue.path.join('.'))
      .join(', ');
    throw new Error(
      `Service account key is missing or has invalid fields: ${fields}. Download the JSON key for the service account from the Google Cloud console.`
    );
  }

  return result.data;
}

/**
 * Decides which auth mode to use. Pure so it can be unit tested.
 * A configured service account wins over a stored OAuth token unless the
 * user explicitly requests a mode.
 */
export function resolveAuthMode(inputs: AuthModeInputs): GoogleAuthMode {
  const { hasServiceAccount, hasOAuthToken, requested } = inputs;

  if (requested === GOOGLE_AUTH_MODES.SERVICE_ACCOUNT) {
    if (!hasServiceAccount) {
      throw new Error(
        'GOOGLE_AUTH_MODE=service-account but no service account is configured. Run "login google --service-account <key.json> --subject <admin@domain>" or set GOOGLE_SERVICE_ACCOUNT_KEY_FILE and GOOGLE_ADMIN_SUBJECT.'
      );
    }
    return GOOGLE_AUTH_MODES.SERVICE_ACCOUNT;
  }

  if (requested === GOOGLE_AUTH_MODES.OAUTH) {
    if (!hasOAuthToken) {
      throw new Error(
        'User not authenticated. Please run "login google" first.'
      );
    }
    return GOOGLE_AUTH_MODES.OAUTH;
  }

  if (hasServiceAccount) {
    return GOOGLE_AUTH_MODES.SERVICE_ACCOUNT;
  }
  if (hasOAuthToken) {
    return GOOGLE_AUTH_MODES.OAUTH;
  }

  throw new Error(
    'Not authenticated with Google. Run "login google" for the OAuth flow, or "login google --service-account <key.json> --subject <admin@domain>" for domain-wide delegation.'
  );
}

async function readServiceAccountKeyJson(): Promise<string | undefined> {
  if (config.GOOGLE_SERVICE_ACCOUNT_KEY) {
    return config.GOOGLE_SERVICE_ACCOUNT_KEY;
  }
  if (config.GOOGLE_SERVICE_ACCOUNT_KEY_FILE) {
    return await readFile(config.GOOGLE_SERVICE_ACCOUNT_KEY_FILE, 'utf-8');
  }
  return (await getToken(KEYRING_SA_KEY_ACCOUNT)) ?? undefined;
}

export async function getServiceAccountCredentials(): Promise<
  ServiceAccountCredentials | undefined
> {
  if (cachedServiceAccount !== undefined) {
    return cachedServiceAccount ?? undefined;
  }

  const keyJson = await readServiceAccountKeyJson();
  if (!keyJson) {
    cachedServiceAccount = null;
    return;
  }

  const subject =
    config.GOOGLE_ADMIN_SUBJECT ?? (await getToken(KEYRING_SA_SUBJECT_ACCOUNT));
  if (!subject) {
    throw new Error(
      'A service account key is configured but there is no admin to impersonate. Set GOOGLE_ADMIN_SUBJECT or run "login google --service-account <key.json> --subject <admin@domain>".'
    );
  }

  cachedServiceAccount = {
    key: parseServiceAccountKey(keyJson),
    subject: subject.toLowerCase(),
  };
  return cachedServiceAccount;
}

export async function storeServiceAccountCredentials(
  keyJson: string,
  subject: string
): Promise<ServiceAccountKey> {
  const key = parseServiceAccountKey(keyJson);
  await setToken(KEYRING_SA_KEY_ACCOUNT, keyJson);
  await setToken(KEYRING_SA_SUBJECT_ACCOUNT, subject.toLowerCase());
  resetGoogleAuthCache();
  return key;
}

export async function clearGoogleCredentials(): Promise<void> {
  await deleteToken(KEYRING_OAUTH_ACCOUNT);
  await deleteToken(KEYRING_SA_KEY_ACCOUNT);
  await deleteToken(KEYRING_SA_SUBJECT_ACCOUNT);
  resetGoogleAuthCache();
}

export async function getGoogleAuthMode(): Promise<GoogleAuthMode> {
  const serviceAccount = await getServiceAccountCredentials();
  const oauthToken = await getToken(KEYRING_OAUTH_ACCOUNT);
  return resolveAuthMode({
    hasServiceAccount: serviceAccount !== undefined,
    hasOAuthToken: Boolean(oauthToken),
    requested: config.GOOGLE_AUTH_MODE,
  });
}

function getOauth2Client(): OAuth2Client {
  const { clientId, clientSecret } = requireGoogleOAuthConfig();
  return new OAuth2Client(clientId, clientSecret, REDIRECT_URI);
}

async function getOAuthClientWithRefreshToken(): Promise<OAuth2Client> {
  if (cachedOAuthClient) {
    return cachedOAuthClient;
  }

  const refreshToken = await getToken(KEYRING_OAUTH_ACCOUNT);
  if (!refreshToken) {
    throw new Error('User not authenticated. Please run "login google" first.');
  }

  const client = getOauth2Client();
  client.setCredentials({ refresh_token: refreshToken });
  cachedOAuthClient = client;
  return client;
}

function createJwtClient(
  credentials: ServiceAccountCredentials,
  subject: string
): JWT {
  return new JWT({
    email: credentials.key.client_email,
    key: credentials.key.private_key,
    scopes: [...GOOGLE_SCOPES],
    subject,
  });
}

/**
 * Returns an authenticated client for Google APIs.
 *
 * In service-account mode, `subject` selects which Workspace user to
 * impersonate (defaults to the configured admin). One JWT client is cached per
 * subject so access tokens are reused across calls. In OAuth mode `subject`
 * is not supported because the token belongs to a single user.
 */
export async function getGoogleAuthClient(
  subject?: string
): Promise<OAuth2Client> {
  const mode = await getGoogleAuthMode();

  if (mode === GOOGLE_AUTH_MODES.SERVICE_ACCOUNT) {
    const credentials = await getServiceAccountCredentials();
    if (!credentials) {
      throw new Error('Service account credentials are not available.');
    }
    const effectiveSubject = (subject ?? credentials.subject).toLowerCase();
    let client = jwtClients.get(effectiveSubject);
    if (!client) {
      client = createJwtClient(credentials, effectiveSubject);
      jwtClients.set(effectiveSubject, client);
    }
    return client;
  }

  if (subject) {
    throw new Error(
      `Impersonating ${subject} requires service account auth with domain-wide delegation. Run "login google --service-account <key.json> --subject <admin@domain>".`
    );
  }

  return await getOAuthClientWithRefreshToken();
}

export async function getGoogleAccessToken(subject?: string): Promise<string> {
  const client = await getGoogleAuthClient(subject);
  const { token } = await client.getAccessToken();
  if (!token) {
    throw new Error('Failed to obtain a Google access token.');
  }
  return token;
}

/**
 * Turns Google API errors into actionable one-liners. Domain-wide delegation
 * failures are notoriously opaque, so the common ones get explicit hints.
 */
export function describeGoogleError(error: unknown): string {
  const err = error as {
    message?: string;
    response?: { status?: number; data?: { error?: unknown } };
  };
  const status = err.response?.status;
  const message = err.message ?? String(error);
  const body = JSON.stringify(err.response?.data?.error ?? '');

  if (
    message.includes('unauthorized_client') ||
    body.includes('unauthorized_client')
  ) {
    return `${message}. The service account's client ID is not authorized for these scopes in the Admin console (Security > Access and data control > API controls > Domain-wide delegation), or the scope list there does not match.`;
  }
  if (message.includes('invalid_grant') || body.includes('invalid_grant')) {
    return `${message}. The impersonated user was not found, is suspended, or the service account key is invalid.`;
  }
  if (status === 403) {
    return `${message}. The impersonated user lacks permission: for Directory calls the subject must be a Workspace admin; for Chat calls the subject must be a member of the space. Also confirm the Admin SDK, Chat and Drive APIs are enabled in the Cloud project.`;
  }
  if (status === 404) {
    return `${message}. The API is enabled but the resource does not exist for this user.`;
  }
  return message;
}

async function runAccessCheck(fn: () => Promise<string>): Promise<AccessCheck> {
  try {
    return { ok: true, detail: await fn() };
  } catch (error) {
    return { ok: false, detail: describeGoogleError(error) };
  }
}

/**
 * Exercises the two APIs that domain-wide delegation must unlock: the
 * Directory API as the admin subject, and the Chat API as `chatSubject`.
 */
export async function verifyServiceAccountAccess(
  chatSubject?: string
): Promise<ServiceAccountReport> {
  const credentials = await getServiceAccountCredentials();
  if (!credentials) {
    throw new Error('No service account is configured.');
  }
  const subject = (chatSubject ?? credentials.subject).toLowerCase();

  const directory = await runAccessCheck(async () => {
    const auth = await getGoogleAuthClient(credentials.subject);
    const admin = google.admin({ version: 'directory_v1', auth });
    const result = await admin.users.get({
      userKey: credentials.subject,
      fields: 'primaryEmail,name/fullName,isAdmin,isDelegatedAdmin',
    });
    const adminFlag =
      result.data.isAdmin || result.data.isDelegatedAdmin
        ? 'admin'
        : 'NOT an admin (Directory listing will fail)';
    return `${result.data.name?.fullName ?? ''} <${result.data.primaryEmail}> is ${adminFlag}`;
  });

  const chat = await runAccessCheck(async () => {
    const auth = await getGoogleAuthClient(subject);
    const chatApi = google.chat({ version: 'v1', auth });
    const result = await chatApi.spaces.list({ pageSize: 1 });
    const count = result.data.spaces?.length ?? 0;
    return count > 0
      ? `listed spaces as ${subject}`
      : `no spaces visible for ${subject} (auth works; the user may simply have none)`;
  });

  return {
    clientEmail: credentials.key.client_email,
    subject,
    directory,
    chat,
  };
}

function startServerForCodeRedirect(): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const parsedUrl = url.parse(req.url ?? '', true);
      const authCode = parsedUrl.query.code as string;

      if (authCode) {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Authentication successful! You can close this tab.');
        server.close();
        resolve(authCode);
      } else {
        const error = new Error('No code found in redirect.');
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end(error.message);
        server.close();
        reject(error);
      }
    });

    server.listen(3000, () => {
      console.log('Listening for redirect on http://localhost:3000');
    });

    server.on('error', reject);
  });
}

/** Interactive OAuth login for a single user's own spaces. */
export async function loginToGoogle(): Promise<void> {
  const oAuth2Client = getOauth2Client();

  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [...GOOGLE_SCOPES],
  });

  console.log('Authorize this app by visiting this url:', authUrl);
  open(authUrl);

  const code = await startServerForCodeRedirect();

  const { tokens } = await oAuth2Client.getToken(code);
  if (tokens.refresh_token) {
    await setToken(KEYRING_OAUTH_ACCOUNT, tokens.refresh_token);
    resetGoogleAuthCache();
    console.log('Successfully logged in to Google.');
  } else {
    console.error('Failed to get refresh token.');
  }
}

function printServiceAccountReport(report: ServiceAccountReport): void {
  const mark = (check: AccessCheck): string => (check.ok ? '✅' : '❌');
  console.log(`Service account: ${report.clientEmail}`);
  console.log(`Impersonating:   ${report.subject}`);
  console.log(
    `${mark(report.directory)} Directory API: ${report.directory.detail}`
  );
  console.log(`${mark(report.chat)} Chat API:      ${report.chat.detail}`);
}

/** Stores a service account key and subject, then verifies delegation works. */
export async function loginWithServiceAccount(
  keyFilePath: string,
  subject: string
): Promise<ServiceAccountReport> {
  const keyJson = await readFile(keyFilePath, 'utf-8');
  const key = await storeServiceAccountCredentials(keyJson, subject);
  console.log(
    `Stored service account ${key.client_email} in the OS keyring (subject ${subject.toLowerCase()}).`
  );

  const report = await verifyServiceAccountAccess();
  printServiceAccountReport(report);
  return report;
}

/**
 * Entry point for `login google`. With `--service-account` the key is stored
 * and verified. Without it, an already configured service account (env or
 * keyring) is verified; otherwise the OAuth flow runs.
 */
export async function loginGoogle(options: GoogleLoginOptions): Promise<void> {
  if (options.serviceAccountKeyFile) {
    if (!options.subject) {
      throw new Error(
        '--subject <admin@domain> is required with --service-account. It is the Workspace admin the service account impersonates for Directory API calls.'
      );
    }
    const report = await loginWithServiceAccount(
      options.serviceAccountKeyFile,
      options.subject
    );
    if (!(report.directory.ok && report.chat.ok)) {
      throw new Error(
        'Service account verification failed. See the checks above.'
      );
    }
    return;
  }

  const serviceAccount = await getServiceAccountCredentials();
  if (serviceAccount) {
    console.log('Service account credentials found; verifying access...');
    const report = await verifyServiceAccountAccess(options.subject);
    printServiceAccountReport(report);
    if (!(report.directory.ok && report.chat.ok)) {
      throw new Error(
        'Service account verification failed. See the checks above.'
      );
    }
    return;
  }

  await loginToGoogle();
}
