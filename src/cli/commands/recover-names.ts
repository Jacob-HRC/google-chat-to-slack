import path from 'node:path';
import type { CommandModule } from 'yargs';
import {
  listStoredSpaceIds,
  loadMessages,
  loadUsers,
  openStore,
  saveUsers,
} from '../../services/export-store';
import {
  applyRecovery,
  buildRecoveryPlan,
  collectFromMessage,
  type EmailCandidate,
  type NameEvidence,
  type RecoveryPlan,
} from '../../services/name-recovery';
import { getDefaultWorkspaceExportDirectory } from '../../utils/data-directory';
import { readJsonFile, writeJsonAtomic } from '../../utils/fs-atomic';
import { makeRunId } from '../../utils/timestamps';

type RecoverNamesArgs = {
  input: string;
  apply?: boolean;
  json?: string;
  aliases?: string;
};

function printRecovered(plan: RecoveryPlan): void {
  if (plan.recovered.length === 0) {
    return;
  }
  console.log('\n   Recovered:');
  for (const person of [...plan.recovered].sort((a, b) =>
    a.name.localeCompare(b.name)
  )) {
    const source = person.fromDisplayName
      ? 'Google display name'
      : `${person.mentionCount} mention(s)`;
    const email = person.email ? ` · ${person.email}` : '';
    const alternates =
      person.alternates.length > 0
        ? ` · also seen as ${person.alternates.slice(0, 2).join(', ')}`
        : '';
    console.log(
      `     ${person.name.padEnd(24)} ${person.confidence.padEnd(6)} ${source}${email}${alternates}`
    );
  }
}

function printAliases(plan: RecoveryPlan): void {
  if (plan.aliases.length === 0) {
    return;
  }
  console.log(`\n   Merged as the same person: ${plan.aliases.length}`);
  for (const alias of plan.aliases.slice(0, 12)) {
    console.log(
      `     ${alias.chatUserId.replace('users/', '').slice(-8)} → ${alias.canonical.replace('users/', '').slice(-8)} · ${alias.reason}`
    );
  }
}

function printPlan(plan: RecoveryPlan, applied: number | undefined): void {
  const withEmail = plan.recovered.filter((r) => r.email);
  console.log('\n🪪  Name recovery for people with no Google account left\n');
  console.log(
    `   Named: ${plan.recovered.length} · still unnamed: ${plan.unresolved.length}`
  );
  console.log(
    `   Emails matched from Vault: ${withEmail.length} (${withEmail.filter((r) => r.emailMatch === 'full-name').length} on the full name, ${withEmail.filter((r) => r.emailMatch === 'first-name').length} on the first name)`
  );
  if (applied !== undefined) {
    console.log(`   Written to the store: ${applied}`);
  }
  printRecovered(plan);
  printAliases(plan);

  if (plan.warnings.length > 0) {
    console.log('\n   Worth a look before you keep these:');
    for (const warning of plan.warnings) {
      console.log(`     • ${warning}`);
    }
  }
  if (plan.unresolved.length > 0) {
    console.log(
      `\n   No source names these ${plan.unresolved.length}: ${plan.unresolved
        .map((id) => id.replace('users/', '').slice(-6))
        .join(', ')}`
    );
  }
}

export const recoverNamesCommand: CommandModule<object, RecoverNamesArgs> = {
  command: 'recover-names',
  describe:
    'Recover real names, and emails where Vault supplies them, for people whose Google accounts were deleted.',
  builder: (yargs) =>
    yargs
      .option('input', {
        describe: 'Workspace export store to read and update.',
        type: 'string',
        default: getDefaultWorkspaceExportDirectory(),
      })
      .option('apply', {
        describe:
          'Write the recovered names into users.json. Without this the command only reports.',
        type: 'boolean',
        default: false,
      })
      .option('json', {
        describe: 'Write the plan to this JSON file for review.',
        type: 'string',
      })
      .option('aliases', {
        describe:
          'JSON file merging people by hand: { "users/<old id>": "users/<id to keep>" }. Use it when one person had two accounts.',
        type: 'string',
      })
      .example('$0 recover-names', 'Report who can be named and from what')
      .example('$0 recover-names --apply', 'Write the recovered names in')
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
      const storeDir = path.resolve(argv.input);
      const store = await openStore(storeDir);
      const users = await loadUsers(store);

      const evidence = new Map<string, NameEvidence>();
      for (const spaceId of await listStoredSpaceIds(store)) {
        // biome-ignore lint/nursery/noAwaitInLoop: one space at a time bounds memory.
        const messages = await loadMessages(store, spaceId);
        for (const message of messages) {
          collectFromMessage(evidence, message);
        }
      }

      // Vault contributes addresses for people the Directory has forgotten.
      const vaultEmails: EmailCandidate[] = Object.values(users)
        .filter((user) => user.email)
        .map((user) => ({
          email: user.email as string,
          claimed: !user.isPlaceholder,
        }));

      const manualAliases = argv.aliases
        ? ((await readJsonFile<Record<string, string>>(
            path.resolve(argv.aliases)
          )) ?? {})
        : {};
      const plan = buildRecoveryPlan(
        evidence,
        users,
        vaultEmails,
        manualAliases
      );

      let applied: number | undefined;
      if (argv.apply) {
        const result = applyRecovery(users, plan, `names-${makeRunId()}`);
        await saveUsers(store, result.users);
        applied = result.updated;
      }
      printPlan(plan, applied);

      if (argv.json) {
        await writeJsonAtomic(path.resolve(argv.json), plan);
        console.log(`\nPlan written to ${path.resolve(argv.json)}`);
      }
      if (!argv.apply) {
        console.log(
          '\nNothing was written. Re-run with --apply to keep these names.'
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('Name recovery failed:', message);
      process.exit(1);
    }
  },
};
