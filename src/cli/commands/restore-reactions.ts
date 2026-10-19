import path from 'node:path';
import { WebClient } from '@slack/web-api';
import type { CommandModule } from 'yargs';
import {
  type ArchivedReaction,
  addReaction,
  conversationsByFolder,
  fetchMessage,
  footerFor,
  footerOf,
  isArchivedChannelError,
  ledgerKey,
  markRestored,
  type RestoredLedger,
  type RestoreOutcome,
  readArchiveReactions,
  replaceFooter,
  tasksFor,
} from '../../services/reaction-restore';
import { getSlackWebClient } from '../../services/slack';
import { fetchSlackMembers } from '../../services/slack-archive/slack-members';
import { sidecarPath } from '../../services/slack-archive/writer';
import { loadRegistry, tokenFor } from '../../services/slack-connect';
import {
  type DestinationDirectory,
  loadDestinationDirectory,
  mapArchiveUsers,
  resolveDestination,
} from '../../services/slack-destination';
import type {
  ArchiveManifest,
  MessageIndexConversation,
} from '../../types/slack-export';
import { getDefaultConnectedUsersFile } from '../../utils/data-directory';
import { readJsonFile, writeJsonAtomic } from '../../utils/fs-atomic';
import { makeRunId } from '../../utils/timestamps';

type RestoreArgs = {
  archive?: string;
  only?: string[];
  dryRun?: boolean;
  rewriteLines?: boolean;
};

interface Person {
  slackId: string;
  archiveId: string;
  client: WebClient;
  directory: DestinationDirectory;
}

type Counts = Map<RestoreOutcome | 'would-add', number>;

interface LineResult {
  edited: number;
  /** Someone changed the message since the import; left alone. */
  changed: number;
  /** In a channel archived after the import; can never be edited. */
  archived: number;
  failed: number;
}

/**
 * Connected people in this workspace whose token still works. A token that
 * fails, or belongs to another workspace, is reported and skipped.
 */
async function connectedPeople(
  argv: RestoreArgs,
  bot: WebClient,
  teamId: string,
  slackUserIds: Map<string, string>
): Promise<Person[]> {
  const registry = await loadRegistry(getDefaultConnectedUsersFile());
  const archiveIdOf = new Map([...slackUserIds].map(([a, s]) => [s, a]));
  const only = new Set(argv.only ?? []);
  const people: Person[] = [];
  for (const slackId of Object.keys(registry)) {
    const archiveId = archiveIdOf.get(slackId);
    if ((only.size > 0 && !only.has(slackId)) || !archiveId) {
      continue;
    }
    // biome-ignore lint/nursery/noAwaitInLoop: a few people, each with their own token.
    const person = await connect(slackId, archiveId, bot, teamId, slackUserIds);
    if (person) {
      people.push(person);
    }
  }
  return people;
}

async function connect(
  slackId: string,
  archiveId: string,
  bot: WebClient,
  teamId: string,
  slackUserIds: Map<string, string>
): Promise<Person | undefined> {
  const token = await tokenFor(slackId);
  if (!token) {
    return;
  }
  const client = new WebClient(token);
  try {
    const check = await client.auth.test();
    if (check.team_id !== teamId || check.user_id !== slackId) {
      console.warn(`   skipped ${slackId}: token is for another account`);
      return;
    }
    return {
      slackId,
      archiveId,
      client,
      directory: await loadDestinationDirectory(bot, client, slackUserIds),
    };
  } catch (error) {
    const code = (error as { data?: { error?: string } }).data?.error;
    console.warn(`   skipped ${slackId}: ${code ?? String(error)}`);
    return;
  }
}

async function restoreFor(
  person: Person,
  archived: ArchivedReaction[],
  byFolder: Map<string, MessageIndexConversation>,
  dryRun: boolean,
  ledger: RestoredLedger
): Promise<Counts> {
  const counts: Counts = new Map();
  for (const task of tasksFor(archived, person.archiveId)) {
    const conversation = byFolder.get(task.folder);
    const destination = conversation
      ? resolveDestination(conversation, person.directory)
      : { unreachable: 'conversation not in this archive' };
    let outcome: RestoreOutcome | 'would-add';
    if (dryRun) {
      outcome = destination.channelId ? 'would-add' : 'unreachable';
    } else {
      // biome-ignore lint/nursery/noAwaitInLoop: one reaction at a time, inside Slack's rate limits.
      outcome = await addReaction(person.client, destination, task);
    }
    counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
    if (outcome === 'added' || outcome === 'already') {
      markRestored(
        ledger,
        ledgerKey(task.folder, task.ts),
        person.archiveId,
        task.name
      );
    }
  }
  return counts;
}

/**
 * Updates the reaction line on one message, working from its current text:
 * only the line the archive added is touched, and only while it is still
 * exactly as last written. A message someone edited is left alone.
 */
async function updateLine(
  author: Person,
  channel: string,
  message: ArchivedReaction,
  expected: string,
  next: string,
  editedBefore: boolean
): Promise<'edited' | 'changed'> {
  const current = await fetchMessage(author.client, channel, message);
  if (!current) {
    return 'changed';
  }
  // An edit time the archive didn't give it means someone edited it in
  // Slack (our own earlier edits are known from the ledger).
  if (!editedBefore && current.editedTs !== message.editedTs) {
    return 'changed';
  }
  const text = replaceFooter(current.text, expected, next);
  if (text === undefined) {
    return 'changed';
  }
  await author.client.chat.update({
    channel,
    ts: message.ts,
    text,
    ...(text.trim() === '' ? { file_ids: current.fileIds } : {}),
  });
  return 'edited';
}

/** Rewrites reaction lines on messages whose authors are connected. */
async function rewriteLines(
  people: Person[],
  archived: ArchivedReaction[],
  byFolder: Map<string, MessageIndexConversation>,
  ledger: RestoredLedger,
  nameOf: (archiveId: string) => string
): Promise<LineResult> {
  const byArchiveId = new Map(people.map((p) => [p.archiveId, p]));
  const result: LineResult = { edited: 0, changed: 0, archived: 0, failed: 0 };
  for (const message of archived) {
    const author = message.author ? byArchiveId.get(message.author) : undefined;
    const conversation = byFolder.get(message.folder);
    const key = ledgerKey(message.folder, message.ts);
    const restored = ledger.restored[key];
    const expected = ledger.footers[key] ?? footerOf(message.text);
    if (!(author && conversation && restored && expected)) {
      continue;
    }
    const next = footerFor(message.reactions, new Set(restored), nameOf);
    const destination = resolveDestination(conversation, author.directory);
    if (next === expected || !destination.channelId) {
      continue;
    }
    try {
      // biome-ignore lint/nursery/noAwaitInLoop: edits go one at a time.
      const outcome = await updateLine(
        author,
        destination.channelId,
        message,
        expected,
        next,
        key in ledger.footers
      );
      if (outcome === 'edited') {
        ledger.footers[key] = next;
      }
      result[outcome] += 1;
    } catch (error) {
      const code = (error as { data?: { error?: string } }).data?.error;
      if (isArchivedChannelError(code)) {
        result.archived += 1;
        continue;
      }
      console.warn(
        `Could not edit ${message.folder} ${message.ts}: ${code ?? String(error)}`
      );
      result.failed += 1;
    }
  }
  return result;
}

async function readSidecars(zipPath: string): Promise<{
  manifest: ArchiveManifest;
  index: MessageIndexConversation[];
}> {
  const manifest = await readJsonFile<ArchiveManifest>(
    sidecarPath(zipPath, 'archive-manifest.json')
  );
  const index = await readJsonFile<MessageIndexConversation[]>(
    sidecarPath(zipPath, 'message-index.json')
  );
  if (!(manifest && index)) {
    throw new Error('manifest or message index not found beside the ZIP');
  }
  return { manifest, index };
}

/** The ledger for this build; one from another build is refused, never mixed in. */
async function readLedger(
  ledgerPath: string,
  builtAt: string
): Promise<RestoredLedger> {
  const ledger = await readJsonFile<RestoredLedger>(ledgerPath);
  if (!ledger) {
    return { builtAt, restored: {}, footers: {} };
  }
  if (ledger.builtAt !== builtAt || !ledger.footers) {
    throw new Error(
      `${ledgerPath} belongs to another build or an older format. After a Reverse Import and re-import, move it aside and run again.`
    );
  }
  return ledger;
}

function summary(counts: Counts): string {
  return [...counts].map(([k, v]) => `${v} ${k}`).join(' · ');
}

export const restoreReactionsCommand: CommandModule<object, RestoreArgs> = {
  command: 'restore-reactions',
  describe:
    "After the import: re-add each connected person's reactions with their own token (see slack-connect), then tidy the text reaction lines on messages whose authors are connected.",
  builder: (yargs) =>
    yargs
      .option('archive', {
        describe: 'The imported ZIP (with its sidecars beside it).',
        type: 'string',
      })
      .option('only', {
        describe: 'Only these Slack user ids (for a test).',
        type: 'string',
        array: true,
      })
      .option('dry-run', {
        describe: 'Count what would be restored; change nothing.',
        type: 'boolean',
        default: false,
      })
      .option('rewrite-lines', {
        describe: 'Update the text reaction lines once reactions are real.',
        type: 'boolean',
        default: true,
      })
      .strict(),
  handler: async (argv) => {
    try {
      if (!argv.archive) {
        throw new Error('--archive is required');
      }
      const zipPath = path.resolve(argv.archive);
      const dryRun = argv.dryRun ?? false;
      const { manifest, index } = await readSidecars(zipPath);
      const ledgerPath = sidecarPath(zipPath, 'reactions-restored.json');
      const ledger = await readLedger(ledgerPath, manifest.builtAt);
      const bot = await getSlackWebClient();
      const teamId = (await bot.auth.test()).team_id ?? '';
      const after = await fetchSlackMembers(bot);
      const slackUserIds = mapArchiveUsers(manifest.users, after);
      const people = await connectedPeople(argv, bot, teamId, slackUserIds);
      if (people.length === 0) {
        throw new Error('nobody connected yet (run slack-connect)');
      }
      const archived = await readArchiveReactions(zipPath);
      const byFolder = conversationsByFolder(index);
      const names = new Map(
        Object.values(manifest.users).map((u) => [u.slackId, u.name])
      );
      const report: Record<string, Record<string, number>> = {};
      let failures = 0;
      for (const person of people) {
        // biome-ignore lint/nursery/noAwaitInLoop: people one after another.
        const counts = await restoreFor(
          person,
          archived,
          byFolder,
          dryRun,
          ledger
        );
        failures += counts.get('failed') ?? 0;
        const label = names.get(person.archiveId) ?? person.slackId;
        report[label] = Object.fromEntries(counts);
        console.log(`${label}: ${summary(counts) || 'nothing to restore'}`);
        if (!dryRun) {
          // Progress survives an interruption.
          await writeJsonAtomic(ledgerPath, ledger);
        }
      }
      if (!dryRun && (argv.rewriteLines ?? true)) {
        const lines = await rewriteLines(
          people,
          archived,
          byFolder,
          ledger,
          (id) => names.get(id) ?? 'someone'
        );
        failures += lines.failed;
        await writeJsonAtomic(ledgerPath, ledger);
        console.log(
          `Reaction lines: ${lines.edited} updated · ${lines.changed} left alone (edited in Slack since the import) · ${lines.archived} in archived channels · ${lines.failed} failed`
        );
      }
      const reportPath = sidecarPath(
        zipPath,
        `reactions-restore-${makeRunId()}.json`
      );
      await writeJsonAtomic(reportPath, {
        at: new Date().toISOString(),
        dryRun,
        report,
      });
      console.log(`Report: ${reportPath}`);
      if (failures > 0) {
        console.error(`${failures} action(s) failed; rerun to retry them.`);
        process.exit(1);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('restore-reactions failed:', message);
      process.exit(1);
    }
  },
};
