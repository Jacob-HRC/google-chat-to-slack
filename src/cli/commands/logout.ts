import type { CommandModule } from 'yargs';
import { clearGoogleCredentials } from '../../services/google-auth';
import { deleteToken } from '../../utils/token-manager';

type LogoutArgs = {
  provider: string;
};

export const logoutCommand: CommandModule<object, LogoutArgs> = {
  command: 'logout <provider>',
  describe: 'Logout from a chat provider',
  builder: (yargs) =>
    yargs
      .positional('provider', {
        describe:
          'The chat provider to logout from (google, google-chat, slack)',
        type: 'string',
        choices: ['google', 'google-chat', 'slack'],
        demandOption: true,
      })
      .strict()
      .fail((msg, err, yargsInstance) => {
        if (msg) {
          console.error(`Error: ${msg}`);
          console.error('');
          yargsInstance.showHelp();
        } else if (err) {
          console.error(`Error: ${err.message}`);
        }
        process.exit(1);
      }),
  handler: async (argv) => {
    if (argv.provider === 'google' || argv.provider === 'google-chat') {
      // Removes the OAuth refresh token and any stored service account key.
      await clearGoogleCredentials();
      console.log('Successfully logged out from Google Chat.');
    } else if (argv.provider === 'slack') {
      await deleteToken('slack');
      console.log('Successfully logged out from Slack.');
    } else {
      console.error(`Unsupported provider: ${argv.provider}`);
      process.exit(1);
    }
  },
};
