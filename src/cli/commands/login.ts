import type { CommandModule } from 'yargs';
import { loginGoogle } from '../../services/google-auth';
import { loginToSlack } from '../../services/slack';

type LoginArgs = {
  provider: string;
  serviceAccount?: string;
  subject?: string;
};

export const loginCommand: CommandModule<object, LoginArgs> = {
  command: 'login <provider>',
  describe: 'Login to a chat provider',
  builder: (yargs) =>
    yargs
      .positional('provider', {
        describe: 'The chat provider to log in to (google, slack)',
        type: 'string',
        choices: ['google', 'slack'],
        demandOption: true,
      })
      .option('service-account', {
        describe:
          'Google only: path to a service account JSON key that has domain-wide delegation. Stored in the OS keyring.',
        type: 'string',
      })
      .option('subject', {
        describe:
          'Google only: Workspace admin email the service account impersonates for Directory API calls',
        type: 'string',
      })
      .example('$0 login google', 'Interactive OAuth login for your own spaces')
      .example(
        '$0 login google --service-account ./key.json --subject admin@example.com',
        'Store a delegated service account and verify Directory and Chat access'
      )
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
    try {
      if (argv.provider === 'google') {
        await loginGoogle({
          serviceAccountKeyFile: argv.serviceAccount,
          subject: argv.subject,
        });
      } else if (argv.provider === 'slack') {
        if (argv.serviceAccount || argv.subject) {
          console.error(
            '--service-account and --subject only apply to "login google".'
          );
          process.exit(1);
        }
        await loginToSlack();
      } else {
        console.error(`Unsupported provider: ${argv.provider}`);
        process.exit(1);
      }
      // Clean exit after successful login
      process.exit(0);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('Login failed:', message);
      process.exit(1);
    }
  },
};
