import { createReadStream } from 'node:fs';
import path from 'node:path';
import type { WebClient } from '@slack/web-api';
import type { CommandModule } from 'yargs';
import { getSlackUserClient, getSlackWebClient } from '../../services/slack';
import { fetchSlackMembers } from '../../services/slack-archive/slack-members';
import { sidecarPath } from '../../services/slack-archive/writer';
import {
  type Destination,
  type DestinationDirectory,
  loadDestinationDirectory,
  mapArchiveUsers,
  resolveDestination,
} from '../../services/slack-destination';
import type {
  ArchiveManifest,
  FileUploadTask,
  MessageIndexConversation,
} from '../../types/slack-export';
import { readJsonFile, writeJsonAtomic } from '../../utils/fs-atomic';

type UploadFilesArgs = {
  archive?: string;
  dryRun?: boolean;
  space?: string[];
  limit?: number;
  joinPublic?: boolean;
};

interface LedgerEntry {
  channelId: string;
  fileId?: string;
  uploadedAt: string;
}

type Ledger = Record<string, LedgerEntry>;

type Outcome =
  | 'uploaded'
  | 'would-upload'
  | 'already-uploaded'
  | 'unreachable'
  | 'message-not-found'
  | 'failed';

interface RunState {
  bot: WebClient;
  user?: WebClient;
  directory: DestinationDirectory;
  manifest: ArchiveManifest;
  ledger: Ledger;
  ledgerPath: string;
  dryRun: boolean;
  joinPublic: boolean;
  /** channel:ts → whether the message exists, so each parent is checked once. */
  present: Map<string, boolean>;
  joined: Set<string>;
  counts: Map<Outcome, number>;
  reasons: Map<string, number>;
}

/** The conversation shape resolveDestination expects, from the manifest. */
function conversationFor(
  task: FileUploadTask,
  manifest: ArchiveManifest
): MessageIndexConversation {
  const entry = Object.entries(manifest.conversations).find(
    ([, c]) => c.id === task.conversationId
  );
  return {
    spaceId: entry?.[0] ?? '',
    kind: task.conversationKind,
    name: task.conversationName,
    archiveId: task.conversationId,
    members: entry?.[1].members ?? [],
    messages: [],
  };
}

function senderName(userId: string, manifest: ArchiveManifest): string {
  const mapping = Object.values(manifest.users).find(
    (u) => u.slackId === userId
  );
  return mapping?.name ?? 'someone';
}

function comment(task: FileUploadTask, manifest: ArchiveManifest): string {
  const seconds = Number(task.ts.split('.')[0]);
  const when = new Date(seconds * 1000).toLocaleString('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'America/Chicago',
  });
  const drive = task.driveLink
    ? ` · <${task.driveLink}|Open in Google Drive>`
    : '';
  return `📎 Attached in Google Chat by ${senderName(task.userId, manifest)}, ${when}${drive}`;
}

async function messageExists(
  client: WebClient,
  channel: string,
  ts: string,
  state: RunState
): Promise<boolean> {
  const key = `${channel}:${ts}`;
  const known = state.present.get(key);
  if (known !== undefined) {
    return known;
  }
  const page = await client.conversations.history({
    channel,
    latest: ts,
    oldest: ts,
    inclusive: true,
    limit: 1,
  });
  const found = (page.messages ?? []).some((m) => m.ts === ts);
  state.present.set(key, found);
  return found;
}

function clientFor(
  destination: Destination,
  state: RunState
): WebClient | undefined {
  return destination.via === 'user' ? state.user : state.bot;
}

async function uploadOne(
  task: FileUploadTask,
  state: RunState
): Promise<Outcome> {
  if (state.ledger[task.attachmentKey]) {
    return 'already-uploaded';
  }
  const destination = resolveDestination(
    conversationFor(task, state.manifest),
    state.directory
  );
  const client = clientFor(destination, state);
  if (!(destination.channelId && client)) {
    const reason = destination.unreachable ?? 'no token';
    state.reasons.set(reason, (state.reasons.get(reason) ?? 0) + 1);
    return 'unreachable';
  }
  const channel = destination.channelId;
  if (destination.needsJoin && !state.joined.has(channel)) {
    if (!state.joinPublic) {
      const reason =
        'public channel the bot is not in; rerun with --join-public';
      state.reasons.set(reason, (state.reasons.get(reason) ?? 0) + 1);
      return 'unreachable';
    }
    if (!state.dryRun) {
      await state.bot.conversations.join({ channel });
    }
    state.joined.add(channel);
  }
  const parentTs = task.threadTs ?? task.ts;
  if (!(await messageExists(client, channel, parentTs, state))) {
    return 'message-not-found';
  }
  if (state.dryRun) {
    return 'would-upload';
  }
  const result = await client.files.uploadV2({
    channel_id: channel,
    thread_ts: parentTs,
    file: createReadStream(task.localPath),
    filename: task.fileName,
    title: task.title,
    initial_comment: comment(task, state.manifest),
  });
  const uploaded = (
    result as { files?: Array<{ files?: Array<{ id?: string }> }> }
  ).files?.[0]?.files?.[0]?.id;
  state.ledger[task.attachmentKey] = {
    channelId: channel,
    fileId: uploaded,
    uploadedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(state.ledgerPath, state.ledger);
  return 'uploaded';
}

function selectTasks(
  tasks: FileUploadTask[],
  argv: UploadFilesArgs
): FileUploadTask[] {
  const wanted = new Set(argv.space ?? []);
  const selected = tasks.filter(
    (t) =>
      wanted.size === 0 ||
      wanted.has(t.conversationName) ||
      wanted.has(t.conversationId)
  );
  return argv.limit ? selected.slice(0, argv.limit) : selected;
}

function printSummary(state: RunState, total: number): void {
  console.log(
    `\n📎 ${state.dryRun ? '[Dry run] ' : ''}${total} file(s) considered`
  );
  for (const [outcome, n] of state.counts) {
    console.log(`   ${outcome}: ${n}`);
  }
  for (const [reason, n] of state.reasons) {
    console.log(`   · ${n} × ${reason}`);
  }
}

export const uploadFilesCommand: CommandModule<object, UploadFilesArgs> = {
  command: 'upload-files',
  describe:
    'After a Slack import built with --files manifest: attach each file as a thread reply to the imported message it belonged to. Resumable.',
  builder: (yargs) =>
    yargs
      .option('archive', {
        describe:
          'The imported ZIP; files-to-upload.json and the manifest are read from beside it.',
        type: 'string',
      })
      .option('dry-run', {
        describe:
          'Resolve every destination and check each message exists; upload nothing.',
        type: 'boolean',
        default: false,
      })
      .option('space', {
        describe: 'Only these conversations (channel name or archive id).',
        type: 'string',
        array: true,
      })
      .option('limit', {
        describe: 'Stop after this many files (for a trial run).',
        type: 'number',
      })
      .option('join-public', {
        describe: 'Let the bot join imported public channels to post there.',
        type: 'boolean',
        default: false,
      })
      .strict(),
  handler: async (argv) => {
    try {
      if (!argv.archive) {
        throw new Error('--archive is required');
      }
      const zipPath = path.resolve(argv.archive);
      const tasks =
        (await readJsonFile<FileUploadTask[]>(
          sidecarPath(zipPath, 'files-to-upload.json')
        )) ?? [];
      const manifest = await readJsonFile<ArchiveManifest>(
        sidecarPath(zipPath, 'archive-manifest.json')
      );
      if (!manifest) {
        throw new Error('archive manifest not found beside the ZIP');
      }
      const bot = await getSlackWebClient();
      const user = await getSlackUserClient();
      const after = await fetchSlackMembers(bot);
      const ledgerPath = sidecarPath(zipPath, 'uploaded.json');
      const state: RunState = {
        bot,
        user,
        directory: await loadDestinationDirectory(
          bot,
          user,
          mapArchiveUsers(manifest.users, after)
        ),
        manifest,
        ledger: (await readJsonFile<Ledger>(ledgerPath)) ?? {},
        ledgerPath,
        dryRun: argv.dryRun ?? false,
        joinPublic: argv.joinPublic ?? false,
        present: new Map(),
        joined: new Set(),
        counts: new Map(),
        reasons: new Map(),
      };
      const selected = selectTasks(tasks, argv);
      for (const task of selected) {
        let outcome: Outcome;
        try {
          // biome-ignore lint/nursery/noAwaitInLoop: uploads are sequential to respect Slack's rate limits and keep the ledger exact.
          outcome = await uploadOne(task, state);
        } catch (error) {
          outcome = 'failed';
          const message =
            error instanceof Error ? error.message : String(error);
          console.error(
            `   ✗ ${task.conversationName} ${task.ts} ${task.fileName}: ${message}`
          );
        }
        state.counts.set(outcome, (state.counts.get(outcome) ?? 0) + 1);
      }
      printSummary(state, selected.length);
      if ((state.counts.get('failed') ?? 0) > 0) {
        process.exit(1);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('upload-files failed:', message);
      process.exit(1);
    }
  },
};
