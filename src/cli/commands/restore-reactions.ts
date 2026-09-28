import path from 'node:path';
import { WebClient } from '@slack/web-api';
import type { CommandModule } from 'yargs';
import {
  type ArchivedReaction,
  addReaction,
  conversationsByFolder,
  ledgerKey,
  markRestored,
  messageFileIds,
  type RestoredLedger,
  type RestoreOutcome,
  readArchiveReactions,
  rewriteReactionLine,
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

async function connectedPeople(
  argv: RestoreArgs,
  bot: WebClient,
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
    const token = await tokenFor(slackId);
    if (!token) {
      continue;
    }
    const client = new WebClient(token);
    people.push({
      slackId,
      archiveId,
      client,
      directory: await loadDestinationDirectory(bot, client, slackUserIds),
    });
  }
  return people;
}

async function restoreFor(
  person: Person,
  archived: ArchivedReaction[],
  byFolder: Map<string, MessageIndexConversation>,
  dryRun: boolean,
  ledger: RestoredLedger
): Promise<Map<RestoreOutcome | 'would-add', number>> {
  const counts = new Map<RestoreOutcome | 'would-add', number>();
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
      markRestored(ledger, ledgerKey(task.folder, task.ts), person.archiveId);
    }
  }
  return counts;
}

/** Edits a message's text; a message left empty keeps its files by naming them. */
async function editMessage(
  client: WebClient,
  channel: string,
  message: ArchivedReaction,
  text: string
): Promise<void> {
  const fileIds =
    text.trim() === ''
      ? await messageFileIds(client, channel, message)
      : undefined;
  await client.chat.update({
    channel,
    ts: message.ts,
    text,
    ...(fileIds ? { file_ids: fileIds } : {}),
  });
}

/** Rewrites reaction lines on messages whose authors are connected. */
async function rewriteLines(
  people: Person[],
  archived: ArchivedReaction[],
  byFolder: Map<string, MessageIndexConversation>,
  ledger: RestoredLedger,
  nameOf: (archiveId: string) => string
): Promise<{ edited: number; failed: number }> {
  const byArchiveId = new Map(people.map((p) => [p.archiveId, p]));
  let edited = 0;
  let failed = 0;
  for (const message of archived) {
    const author = message.author ? byArchiveId.get(message.author) : undefined;
    const conversation = byFolder.get(message.folder);
    const key = ledgerKey(message.folder, message.ts);
    const restored = ledger.restored[key];
    if (!(author && conversation && restored)) {
      continue;
    }
    const text = rewriteReactionLine(
      message.text,
      message.reactions,
      new Set(restored),
      nameOf
    );
    const destination = resolveDestination(conversation, author.directory);
    if (
      text === undefined ||
      text === ledger.lines[key] ||
      !destination.channelId
    ) {
      continue;
    }
    try {
      // biome-ignore lint/nursery/noAwaitInLoop: edits go one at a time.
      await editMessage(author.client, destination.channelId, message, text);
      ledger.lines[key] = text;
      edited += 1;
    } catch (error) {
      const code = (error as { data?: { error?: string } }).data?.error;
      console.warn(
        `Could not edit ${message.folder} ${message.ts}: ${code ?? String(error)}`
      );
      failed += 1;
    }
  }
  return { edited, failed };
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
      const { manifest, index } = await readSidecars(zipPath);
      const bot = await getSlackWebClient();
      const after = await fetchSlackMembers(bot);
      const slackUserIds = mapArchiveUsers(manifest.users, after);
      const people = await connectedPeople(argv, bot, slackUserIds);
      if (people.length === 0) {
        throw new Error('nobody connected yet (run slack-connect)');
      }
      const archived = await readArchiveReactions(zipPath);
      const byFolder = conversationsByFolder(index);
      const names = new Map(
        Object.values(manifest.users).map((u) => [u.slackId, u.name])
      );
      const ledgerPath = sidecarPath(zipPath, 'reactions-restored.json');
      const ledger: RestoredLedger = (await readJsonFile<RestoredLedger>(
        ledgerPath
      )) ?? { restored: {}, lines: {} };
      const report: Record<string, Record<string, number>> = {};
      for (const person of people) {
        // biome-ignore lint/nursery/noAwaitInLoop: people one after another.
        const counts = await restoreFor(
          person,
          archived,
          byFolder,
          argv.dryRun ?? false,
          ledger
        );
        report[names.get(person.archiveId) ?? person.slackId] =
          Object.fromEntries(counts);
        console.log(
          `${names.get(person.archiveId) ?? person.slackId}: ${[...counts].map(([k, v]) => `${v} ${k}`).join(' · ') || 'nothing to restore'}`
        );
      }
      if (!argv.dryRun && (argv.rewriteLines ?? true)) {
        const lines = await rewriteLines(
          people,
          archived,
          byFolder,
          ledger,
          (id) => names.get(id) ?? 'someone'
        );
        console.log(
          `Reaction lines rewritten: ${lines.edited}${lines.failed ? ` · ${lines.failed} could not be edited` : ''}`
        );
      }
      if (!argv.dryRun) {
        await writeJsonAtomic(ledgerPath, ledger);
      }
      const reportPath = sidecarPath(
        zipPath,
        `reactions-restore-${makeRunId()}.json`
      );
      await writeJsonAtomic(reportPath, {
        at: new Date().toISOString(),
        dryRun: argv.dryRun,
        report,
      });
      console.log(`Report: ${reportPath}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('restore-reactions failed:', message);
      process.exit(1);
    }
  },
};
