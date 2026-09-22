import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { config as dotenvConfig } from 'dotenv';
import { z } from 'zod';

// Load .env file if it exists (for development)
if (existsSync('.env')) {
  dotenvConfig();
}

// Try to load config from user's home directory
const configPaths = [
  join(homedir(), '.googletoslack', 'config'),
  join(homedir(), '.config', 'googletoslack', 'config'),
];

for (const configPath of configPaths) {
  if (existsSync(configPath)) {
    try {
      dotenvConfig({ path: configPath });
      break;
    } catch (_error) {
      console.warn(`Warning: Could not load config from ${configPath}`);
    }
  }
}

// Treat empty strings as unset so `FOO=""` behaves like a missing variable.
const optionalString = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().optional()
);

const configSchema = z.object({
  // OAuth client for the interactive `login google` flow.
  GOOGLE_CLIENT_ID: optionalString,
  GOOGLE_CLIENT_SECRET: optionalString,
  // Service account with domain-wide delegation (alternative to OAuth).
  // Either a path to the JSON key file or the JSON content itself.
  GOOGLE_SERVICE_ACCOUNT_KEY_FILE: optionalString,
  GOOGLE_SERVICE_ACCOUNT_KEY: optionalString,
  // Workspace admin to impersonate for Directory API calls.
  GOOGLE_ADMIN_SUBJECT: optionalString,
  SLACK_BOT_TOKEN: optionalString,
});

export type AppConfig = z.infer<typeof configSchema>;

// All fields are optional at load time. Each auth mode validates what it needs
// at the point of use so that, for example, service-account users never have to
// supply an OAuth client ID and the test suite can import services freely.
export const config: AppConfig = configSchema.parse(process.env);

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
}

export function requireGoogleOAuthConfig(): GoogleOAuthConfig {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = config;
  if (GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET) {
    return { clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET };
  }

  const missing: string[] = [];
  if (!GOOGLE_CLIENT_ID) {
    missing.push('GOOGLE_CLIENT_ID');
  }
  if (!GOOGLE_CLIENT_SECRET) {
    missing.push('GOOGLE_CLIENT_SECRET');
  }

  throw new Error(
    [
      `Missing required environment variables: ${missing.join(', ')}`,
      '',
      'You can set these by:',
      '1. Setting environment variables:',
      '   export GOOGLE_CLIENT_ID="your_client_id"',
      '   export GOOGLE_CLIENT_SECRET="your_client_secret"',
      '',
      '2. Creating a config file at:',
      `   ${join(homedir(), '.googletoslack', 'config')}`,
      '   or',
      `   ${join(homedir(), '.config', 'googletoslack', 'config')}`,
      '',
      '3. For development, create a .env file in the project directory',
      '',
      'Or use a service account instead (see README, "Service account auth").',
    ].join('\n')
  );
}
