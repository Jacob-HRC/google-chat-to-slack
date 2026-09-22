import type { CommandModule } from 'yargs';
import {
  type DomainUser,
  listDomainUsers,
  resolveUserSelection,
  type UserSelection,
} from '../../services/directory';
import {
  GOOGLE_AUTH_MODES,
  getGoogleAuthMode,
} from '../../services/google-auth';
import {
  configureForExport,
  EXPORT_RATE_LIMITS,
} from '../../utils/rate-limiting';

type UsersArgs = {
  user?: string[];
  orgUnit?: string;
  includeSuspended?: boolean;
  json?: boolean;
};

function describeSelection(selection: UserSelection): string {
  const parts: string[] = [];
  if (selection.emails.length > 0) {
    parts.push(`${selection.emails.length} listed user(s)`);
  }
  if (selection.orgUnit) {
    parts.push(`org unit ${selection.orgUnit}`);
  }
  if (parts.length === 0) {
    parts.push('all users');
  }
  parts.push(
    selection.includeSuspended ? 'including suspended' : 'active only'
  );
  return parts.join(', ');
}

function describeStatus(user: DomainUser): string {
  if (user.archived) {
    return 'archived';
  }
  if (user.suspended) {
    return 'suspended';
  }
  return 'active';
}

function printUserTable(users: DomainUser[]): void {
  const emailWidth = Math.max(5, ...users.map((u) => u.email.length));
  const nameWidth = Math.max(4, ...users.map((u) => u.fullName.length));
  console.log(
    `${'EMAIL'.padEnd(emailWidth)}  ${'NAME'.padEnd(nameWidth)}  ORG UNIT  STATUS`
  );
  for (const user of users) {
    const status = describeStatus(user);
    console.log(
      `${user.email.padEnd(emailWidth)}  ${user.fullName.padEnd(nameWidth)}  ${user.orgUnitPath}  ${status}`
    );
  }
}

export const usersCommand: CommandModule<object, UsersArgs> = {
  command: 'users',
  describe:
    'List the Google Workspace users an export would cover (service account auth only)',
  builder: (yargs) =>
    yargs
      .option('user', {
        describe:
          'Restrict to these primary emails (repeat the flag or comma-separate). Overrides GOOGLE_EXPORT_USERS.',
        type: 'string',
        array: true,
      })
      .option('org-unit', {
        describe:
          'Restrict to an org unit path and its children, e.g. /Staff. Overrides GOOGLE_EXPORT_ORG_UNIT.',
        type: 'string',
      })
      .option('include-suspended', {
        describe: 'Also list suspended and archived users',
        type: 'boolean',
        default: false,
      })
      .option('json', {
        describe: 'Print the users as JSON',
        type: 'boolean',
        default: false,
      })
      .example('$0 users', 'List every active user in the domain')
      .example(
        '$0 users --user a@example.com --user b@example.com',
        'Check a pilot user list resolves'
      )
      .example('$0 users --org-unit /Staff', 'List one org unit')
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
    configureForExport(EXPORT_RATE_LIMITS);

    try {
      const mode = await getGoogleAuthMode();
      if (mode !== GOOGLE_AUTH_MODES.SERVICE_ACCOUNT) {
        console.error(
          'Listing domain users requires service account auth. Run "login google --service-account <key.json> --subject <admin@domain>".'
        );
        process.exit(1);
      }

      const selection = resolveUserSelection({
        users: argv.user,
        orgUnit: argv.orgUnit,
        includeSuspended: argv.includeSuspended,
      });

      const users = await listDomainUsers(selection);

      if (argv.json) {
        console.log(JSON.stringify(users, null, 2));
        return;
      }

      console.log(`Selection: ${describeSelection(selection)}`);
      console.log(`Users: ${users.length}\n`);
      if (users.length > 0) {
        printUserTable(users);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('Failed to list users:', message);
      process.exit(1);
    }
  },
};
