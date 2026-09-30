import type { CommandModule } from 'yargs';
import { getSlackWebClient } from '../../services/slack';
import { loadRegistry, startConnectServer } from '../../services/slack-connect';
import { getDefaultConnectedUsersFile } from '../../utils/data-directory';
import { getToken } from '../../utils/token-manager';

type SlackConnectArgs = {
  publicBase?: string;
  port: number;
  allow?: string[];
  list?: boolean;
};

const DEFAULT_PUBLIC_BASE = 'https://server.tail3620c0.ts.net:8443';
const TRAILING_SLASH_REGEX = /\/+$/;

/** Env first, then the keyring; never a command-line flag, so shell history stays clean. */
async function secret(
  envName: string,
  keyringAccount: string
): Promise<string> {
  const value = process.env[envName] ?? (await getToken(keyringAccount));
  if (!value) {
    throw new Error(
      `${envName} is not set and the keyring has no "${keyringAccount}" entry`
    );
  }
  return value;
}

export const slackConnectCommand: CommandModule<object, SlackConnectArgs> = {
  command: 'slack-connect',
  describe:
    'Serve the page where people approve the app once, so restore-reactions can add their reactions with their own token. Put Tailscale Funnel in front of it only while people are connecting.',
  builder: (yargs) =>
    yargs
      .option('public-base', {
        describe: 'Public origin Slack redirects back to (…/slack/callback).',
        type: 'string',
        default: DEFAULT_PUBLIC_BASE,
      })
      .option('port', {
        describe: 'Local port behind the Funnel.',
        type: 'number',
        default: 8788,
      })
      .option('allow', {
        describe:
          'Only these Slack user ids may connect (for a test). Omit to open it to everyone.',
        type: 'string',
        array: true,
      })
      .option('list', {
        describe: 'Show who has connected, then exit.',
        type: 'boolean',
        default: false,
      })
      .strict(),
  handler: async (argv) => {
    try {
      const registryPath = getDefaultConnectedUsersFile();
      if (argv.list) {
        const registry = await loadRegistry(registryPath);
        const people = Object.values(registry);
        console.log(`${people.length} connected`);
        for (const person of people) {
          console.log(
            `   ${person.slackId} ${person.name ?? ''} (${person.connectedAt})`
          );
        }
        return;
      }
      const publicBase = (argv.publicBase ?? DEFAULT_PUBLIC_BASE).replace(
        TRAILING_SLASH_REGEX,
        ''
      );
      const allow = new Set(argv.allow ?? []);
      // The workspace the bot is installed in is the only one accepted.
      const teamId = (await (await getSlackWebClient()).auth.test()).team_id;
      if (!teamId) {
        throw new Error('could not read the workspace id from the bot token');
      }
      await startConnectServer({
        teamId,
        clientId: await secret('SLACK_CLIENT_ID', 'slack-client-id'),
        clientSecret: await secret(
          'SLACK_CLIENT_SECRET',
          'slack-client-secret'
        ),
        publicBase,
        port: argv.port,
        registryPath,
        allow,
      });
      console.log(`Listening on 127.0.0.1:${argv.port}`);
      console.log(
        `Funnel: tailscale funnel --bg --https=8443 --set-path=/slack http://127.0.0.1:${argv.port}/slack`
      );
      console.log(`Link to send: ${publicBase}/slack/connect`);
      console.log(
        allow.size > 0
          ? `Open only to: ${[...allow].join(', ')}`
          : 'Open to everyone in the workspace.'
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('slack-connect failed:', message);
      process.exit(1);
    }
  },
};
