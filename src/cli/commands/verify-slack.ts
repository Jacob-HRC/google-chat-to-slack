import { access } from 'node:fs/promises';
import path from 'node:path';
import type { WebClient } from '@slack/web-api';
import type { CommandModule } from 'yargs';
import { getSlackUserClient, getSlackWebClient } from '../../services/slack';
import {
  fetchSlackMembers,
  type SlackMemberSnapshot,
} from '../../services/slack-archive/slack-members';
import { sidecarPath } from '../../services/slack-archive/writer';
import {
  loadDestinationDirectory,
  mapArchiveUsers,
  resolveDestination,
} from '../../services/slack-destination';
import {
  type ConversationReport,
  compareConversation,
  compareMembers,
  fetchConversation,
  type MemberReport,
} from '../../services/slack-verify';
import type {
  ArchiveManifest,
  MessageIndexConversation,
} from '../../types/slack-export';
import { readJsonFile, writeJsonAtomic } from '../../utils/fs-atomic';
import { makeRunId } from '../../utils/timestamps';

type VerifySlackArgs = {
  archive?: string;
  before?: string;
  joinPublic?: boolean;
  skipMessages?: boolean;
  space?: string[];
};

const SHOWN = 10;

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function requireJson<T>(filePath: string, what: string): Promise<T> {
  const value = await readJsonFile<T>(filePath);
  if (!value) {
    throw new Error(`${what} not found at ${filePath}`);
  }
  return value;
}

function printMembers(report: MemberReport): boolean {
  let ok = true;
  console.log('\n👥 Members');
  if (report.vanished.length > 0 || report.changed.length > 0) {
    ok = false;
    console.log(
      `   ❌ ${report.vanished.length} existing member(s) gone, ${report.changed.length} field change(s) on existing members:`
    );
    for (const change of report.changed.slice(0, SHOWN)) {
      console.log(
        `     ${change.email ?? change.id} ${change.field}: ${JSON.stringify(change.before)} → ${JSON.stringify(change.after)}`
      );
    }
  } else {
    console.log('   ✅ Every existing member is unchanged');
  }
  if (report.newActive.length > 0) {
    ok = false;
    console.log(
      `   ❌ ${report.newActive.length} new account(s) are ACTIVE and can sign in: ${report.newActive
        .slice(0, SHOWN)
        .map((m) => m.email ?? m.id)
        .join(', ')}`
    );
  } else {
    console.log(
      `   ✅ ${report.newDeactivated} new account(s), all deactivated`
    );
  }
  const wrong = report.people.filter((p) => !p.ok);
  if (wrong.length > 0) {
    ok = false;
    console.log(`   ❌ ${wrong.length} person(s) did not land as planned:`);
    for (const person of wrong.slice(0, SHOWN)) {
      console.log(
        `     ${person.name} <${person.email ?? 'no address'}>: planned ${person.expected}, found ${person.actual}`
      );
    }
  } else {
    console.log(
      `   ✅ All ${report.people.length} archived people landed as planned`
    );
  }
  return ok;
}

interface VerifyContext {
  bot: WebClient;
  user?: WebClient;
  joinPublic: boolean;
}

async function verifyOne(
  conversation: MessageIndexConversation,
  destination: ReturnType<typeof resolveDestination>,
  ctx: VerifyContext
): Promise<ConversationReport> {
  const base: ConversationReport = {
    name: conversation.name,
    kind: conversation.kind,
    status: 'unverifiable',
    expected: conversation.messages.length,
    found: 0,
    missing: [],
    extra: [],
    fileProblems: [],
    unthreaded: [],
  };
  if (!destination.channelId) {
    return { ...base, reason: destination.unreachable };
  }
  const client = destination.via === 'user' ? ctx.user : ctx.bot;
  if (!client) {
    return { ...base, reason: 'no token for this conversation' };
  }
  if (destination.needsJoin) {
    if (!ctx.joinPublic) {
      return {
        ...base,
        reason: 'public channel the bot is not in; rerun with --join-public',
      };
    }
    await ctx.bot.conversations.join({ channel: destination.channelId });
  }
  const actual = await fetchConversation(client, destination.channelId);
  return compareConversation(conversation, actual, destination.channelId);
}

function printConversations(reports: ConversationReport[]): boolean {
  const count = (status: ConversationReport['status']): number =>
    reports.filter((r) => r.status === status).length;
  console.log('\n💬 Conversations');
  console.log(
    `   ${count('match')} match · ${count('mismatch')} mismatch · ${count('unverifiable')} not readable with these tokens`
  );
  for (const report of reports
    .filter((r) => r.status === 'mismatch')
    .slice(0, SHOWN)) {
    console.log(
      `   ❌ ${report.name} (${report.kind}): ${report.found}/${report.expected} found · ${report.missing.length} missing · ${report.extra.length} extra · ${report.fileProblems.length} file problem(s) · ${report.unthreaded.length} out of thread`
    );
    const example =
      report.missing[0] ?? report.fileProblems[0] ?? report.unthreaded[0];
    if (example) {
      console.log(`      e.g. ${example}`);
    }
  }
  const reasons = new Map<string, number>();
  for (const report of reports.filter((r) => r.status === 'unverifiable')) {
    const reason = report.reason ?? 'unknown';
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  }
  for (const [reason, n] of reasons) {
    console.log(`   · ${n} × ${reason}`);
  }
  return count('mismatch') === 0;
}

async function loadBefore(
  argv: VerifySlackArgs,
  zipPath: string
): Promise<SlackMemberSnapshot | undefined> {
  const candidate = argv.before
    ? path.resolve(argv.before)
    : sidecarPath(zipPath, 'members-before.json');
  if (!(await exists(candidate))) {
    return;
  }
  return readJsonFile<SlackMemberSnapshot>(candidate);
}

export const verifySlackCommand: CommandModule<object, VerifySlackArgs> = {
  command: 'verify-slack',
  describe:
    'After a Slack import: check no existing member changed, every new account is deactivated, and every message is where the archive put it. Read-only unless --join-public.',
  builder: (yargs) =>
    yargs
      .option('archive', {
        describe:
          'The imported ZIP. Its sidecars (manifest, message index, member snapshot) are read from beside it.',
        type: 'string',
      })
      .option('before', {
        describe:
          'Member snapshot from before the import, if not the one saved beside the archive.',
        type: 'string',
      })
      .option('join-public', {
        describe:
          'Let the bot join imported public channels so it can read them. Visible to members.',
        type: 'boolean',
        default: false,
      })
      .option('skip-messages', {
        describe: 'Only check members.',
        type: 'boolean',
        default: false,
      })
      .option('space', {
        describe: 'Only these conversations (channel name or archive id).',
        type: 'string',
        array: true,
      })
      .strict(),
  handler: async (argv) => {
    try {
      if (!argv.archive) {
        throw new Error('--archive is required');
      }
      const zipPath = path.resolve(argv.archive);
      const manifest = await requireJson<ArchiveManifest>(
        sidecarPath(zipPath, 'archive-manifest.json'),
        'Archive manifest'
      );
      const bot = await getSlackWebClient();
      const user = await getSlackUserClient();
      const after = await fetchSlackMembers(bot);
      await writeJsonAtomic(sidecarPath(zipPath, 'members-after.json'), after);

      const before = await loadBefore(argv, zipPath);
      let membersOk = true;
      let memberReport: MemberReport | undefined;
      if (before) {
        memberReport = compareMembers(before, after, manifest.users);
        membersOk = printMembers(memberReport);
      } else {
        console.log(
          '\n👥 Members: no pre-import snapshot beside the archive; pass --before to diff'
        );
      }

      let conversationsOk = true;
      const reports: ConversationReport[] = [];
      if (!argv.skipMessages) {
        const index = await requireJson<MessageIndexConversation[]>(
          sidecarPath(zipPath, 'message-index.json'),
          'Message index'
        );
        const wanted = new Set(argv.space ?? []);
        const selected = index.filter(
          (c) =>
            wanted.size === 0 ||
            wanted.has(c.name) ||
            wanted.has(c.archiveId) ||
            wanted.has(c.spaceId)
        );
        const directory = await loadDestinationDirectory(
          bot,
          user,
          mapArchiveUsers(manifest.users, after)
        );
        if (!user) {
          console.log(
            '\nNo Slack user token (SLACK_USER_TOKEN or keyring "slack-user"); DMs cannot be checked.'
          );
        }
        const ctx: VerifyContext = {
          bot,
          user,
          joinPublic: argv.joinPublic ?? false,
        };
        for (const conversation of selected) {
          // biome-ignore lint/nursery/noAwaitInLoop: sequential to stay inside Slack's rate limits.
          const report = await verifyOne(
            conversation,
            resolveDestination(conversation, directory),
            ctx
          );
          reports.push(report);
        }
        conversationsOk = printConversations(reports);
      }

      const reportPath = sidecarPath(zipPath, `verify-${makeRunId()}.json`);
      await writeJsonAtomic(reportPath, {
        verifiedAt: new Date().toISOString(),
        archive: zipPath,
        members: memberReport,
        conversations: reports,
      });
      console.log(`\nFull report: ${reportPath}`);
      if (!(membersOk && conversationsOk)) {
        process.exit(1);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('verify-slack failed:', message);
      process.exit(1);
    }
  },
};
