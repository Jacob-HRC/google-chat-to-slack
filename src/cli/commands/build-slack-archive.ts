import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { CommandModule } from 'yargs';
import type { LargeFileLedger } from '../../services/large-files';
import type { UserOverlay } from '../../services/name-recovery';
import {
  type BuildArchiveOptions,
  buildArchiveModel,
} from '../../services/slack-archive/builder';
import type { SpaceVisibility } from '../../services/slack-archive/conversations';
import type { MeetingChatMode } from '../../services/slack-archive/meeting-chats';
import type {
  DeletedPolicy,
  DriveCopy,
  FileStrategy,
} from '../../services/slack-archive/messages';
import type { SlackMemberSnapshot } from '../../services/slack-archive/slack-members';
import type { UserOverride } from '../../services/slack-archive/users';
import {
  type ValidationIssue,
  validateArchive,
} from '../../services/slack-archive/validate';
import {
  parseCsv,
  type Visibility,
} from '../../services/slack-archive/visibility';
import {
  printArchiveReport,
  writeArchive,
} from '../../services/slack-archive/writer';
import type { ArchiveModel } from '../../types/slack-export';
import {
  getDefaultSlackArchiveDirectory,
  getDefaultSlackMembersFile,
  getDefaultWorkspaceExportDirectory,
} from '../../utils/data-directory';
import { readJsonFile } from '../../utils/fs-atomic';
import { makeRunId, parseRfc3339 } from '../../utils/timestamps';

/** Stable made-up id for the Google Chat "workspace" the archive comes from. */
const SOURCE_TEAM_ID = 'T0GCHAT0001';

type BuildArgs = {
  input: string;
  output?: string;
  unpacked?: string;
  dryRun?: boolean;
  space?: string[];
  excludeSpace?: string[];
  includeBotDms?: boolean;
  spaceVisibility?: string;
  deleted?: string;
  files?: string;
  filesBaseUrl?: string;
  userOverrides?: string;
  firstSeenAfter?: string;
  messagesSince?: string;
  teamId?: string;
  vaultPrefix?: string;
  placeholderEmailDomain?: string;
  slackMembers?: string;
  usersOverlay?: string;
  meetingChats?: string;
  channelVisibility?: string;
  membersChannel?: string;
  largeFiles?: string;
};

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Loads the member snapshot. An explicit path must exist; the default path is
 * optional so a build on a machine without Slack access still works.
 */
async function loadSlackMembers(
  argv: BuildArgs
): Promise<SlackMemberSnapshot | undefined> {
  const explicit = argv.slackMembers !== undefined && argv.slackMembers !== '';
  const filePath = path.resolve(
    argv.slackMembers || getDefaultSlackMembersFile()
  );
  if (!(await fileExists(filePath))) {
    if (explicit) {
      throw new Error(`--slack-members file not found: ${filePath}`);
    }
    return;
  }
  const snapshot = await readJsonFile<SlackMemberSnapshot>(filePath);
  if (!(snapshot && Array.isArray(snapshot.members))) {
    throw new Error(`${filePath} is not a slack-members snapshot`);
  }
  return snapshot;
}

async function loadVisibility(filePath: string): Promise<{
  visibility: Map<string, Visibility>;
  archived: Set<string>;
}> {
  const rows = parseCsv(await readFile(filePath, 'utf-8'));
  const publicCount = rows.filter((r) => r.visibility === 'public').length;
  const archived = new Set(rows.filter((r) => r.archive).map((r) => r.spaceId));
  console.log(
    `Channel visibility from ${filePath}: ${publicCount} public, ${rows.length - publicCount} private; anything unlisted is private. ${archived.size} will import archived.`
  );
  return {
    visibility: new Map(rows.map((r) => [r.spaceId, r.visibility])),
    archived,
  };
}

async function loadDriveCopies(
  filePath: string
): Promise<Record<string, DriveCopy>> {
  const ledger = await readJsonFile<LargeFileLedger>(filePath);
  if (!ledger) {
    throw new Error(`--large-files ledger not found: ${filePath}`);
  }
  const byKey: Record<string, DriveCopy> = {};
  for (const staged of Object.values(ledger)) {
    for (const key of staged.keys) {
      byKey[key] = {
        name: staged.name,
        size: staged.size,
        webViewLink: staged.webViewLink,
      };
    }
  }
  console.log(
    `Linking ${Object.keys(byKey).length} attachment(s) to their Google Drive copies (${filePath}).`
  );
  return byKey;
}

async function requireOverlay(filePath: string): Promise<UserOverlay> {
  const overlay = await readJsonFile<UserOverlay>(filePath);
  if (!overlay) {
    throw new Error(`--users-overlay file not found: ${filePath}`);
  }
  console.log(
    `Laying recovered names and addresses for ${Object.keys(overlay).length} people over users.json (${filePath}).`
  );
  return overlay;
}

async function toBuildOptions(argv: BuildArgs): Promise<BuildArchiveOptions> {
  if (argv.files === 'hosted' && !argv.filesBaseUrl) {
    throw new Error('--files hosted requires --files-base-url');
  }
  if (argv.messagesSince) {
    parseRfc3339(argv.messagesSince);
  }
  const overrides = argv.userOverrides
    ? ((await readJsonFile<Record<string, UserOverride>>(
        path.resolve(argv.userOverrides)
      )) ?? {})
    : {};
  const slackMembers = await loadSlackMembers(argv);
  const visibilityList = argv.channelVisibility
    ? await loadVisibility(path.resolve(argv.channelVisibility))
    : undefined;
  return {
    storeDir: path.resolve(argv.input),
    // The archive's own source team. Never the destination's id: the export
    // must not claim to come from the workspace it is imported into.
    teamId: argv.teamId ?? SOURCE_TEAM_ID,
    spaceFilter: argv.space ?? [],
    excludeSpaces: argv.excludeSpace ?? [],
    skipBotDms: !argv.includeBotDms,
    spaceVisibility: (argv.spaceVisibility ?? 'private') as SpaceVisibility,
    deletedPolicy: (argv.deleted ?? 'tombstone') as DeletedPolicy,
    fileStrategy: (argv.files ?? 'manifest') as FileStrategy,
    filesBaseUrl: argv.filesBaseUrl,
    overrides,
    firstSeenAfterRun: argv.firstSeenAfter,
    messagesSince: argv.messagesSince,
    vaultPrefix: argv.vaultPrefix,
    placeholderEmailDomain: argv.placeholderEmailDomain,
    slackMembers,
    meetingChats: (argv.meetingChats ?? 'fold') as MeetingChatMode,
    membersChannel: argv.membersChannel || undefined,
    driveCopies: argv.largeFiles
      ? await loadDriveCopies(path.resolve(argv.largeFiles))
      : undefined,
    visibilityBySpace: visibilityList?.visibility,
    archivedSpaces: visibilityList?.archived,
    usersOverlay: argv.usersOverlay
      ? await requireOverlay(path.resolve(argv.usersOverlay))
      : undefined,
  };
}

async function writeOutputs(
  model: ArchiveModel,
  argv: BuildArgs
): Promise<void> {
  const zipPath = path.resolve(
    argv.output ??
      path.join(getDefaultSlackArchiveDirectory(), `${makeRunId()}.zip`)
  );
  const result = await writeArchive(model, {
    zipPath,
    unpackedDir: argv.unpacked ? path.resolve(argv.unpacked) : undefined,
  });
  console.log(`\nWrote ${result.entries} entries to ${result.zipPath}`);
  for (const sidecar of result.sidecars) {
    console.log(`Beside it: ${sidecar}`);
  }
  if (result.unpackedDir) {
    console.log(`Unpacked copy: ${result.unpackedDir}`);
  }
  if (
    model.manifest.files.strategy === 'manifest' &&
    model.uploads.length > 0
  ) {
    console.log(
      `${model.uploads.length} file(s) listed in files-to-upload.json for the post-import uploader.`
    );
  }
}

const ISSUES_SHOWN = 15;

/** Prints validation issues; returns true when the archive must not be written. */
function reportIssues(issues: ValidationIssue[]): boolean {
  const errors = issues.filter((i) => i.level === 'error');
  const warnings = issues.length - errors.length;
  if (issues.length === 0) {
    console.log("   ✅ Validation: archive matches the importer's rules");
    return false;
  }
  console.log(
    `   ${errors.length > 0 ? '❌' : '⚠️ '} Validation: ${errors.length} error(s), ${warnings} warning(s)`
  );
  for (const issue of issues.slice(0, ISSUES_SHOWN)) {
    console.log(`     ${issue.level} · ${issue.where}: ${issue.message}`);
  }
  if (issues.length > ISSUES_SHOWN) {
    console.log(`     … and ${issues.length - ISSUES_SHOWN} more`);
  }
  return errors.length > 0;
}

export const buildSlackArchiveCommand: CommandModule<object, BuildArgs> = {
  command: 'build-slack-archive',
  describe:
    'Turn the workspace export store into a Slack import ZIP (channels, DMs, group DMs, users, per-day messages). Reads the store only.',
  builder: (yargs) =>
    yargs
      .option('input', {
        describe: 'Workspace export store directory.',
        type: 'string',
        default: getDefaultWorkspaceExportDirectory(),
      })
      .option('output', {
        describe:
          'ZIP path to write. Defaults to data/slack-archive/<timestamp>.zip.',
        type: 'string',
      })
      .option('unpacked', {
        describe: 'Also write the archive as plain files into this directory.',
        type: 'string',
      })
      .option('dry-run', {
        describe: 'Build and report; write nothing.',
        type: 'boolean',
        default: false,
      })
      .option('space', {
        describe:
          'Only these conversations (id, spaces/<id> or display name). Repeatable.',
        type: 'string',
        array: true,
      })
      .option('exclude-space', {
        describe:
          'Leave these conversations out (same forms as --space), e.g. ones a pilot import already brought over. Repeatable.',
        type: 'string',
        array: true,
      })
      .option('include-bot-dms', {
        describe: 'Include DMs with Chat apps and bots.',
        type: 'boolean',
        default: false,
      })
      .option('space-visibility', {
        describe: 'Import named Spaces as private or public Slack channels.',
        type: 'string',
        choices: ['private', 'public'],
        default: 'private',
      })
      .option('deleted', {
        describe:
          'Messages deleted in Google Chat: tombstone (placeholder text), content (last known text), omit.',
        type: 'string',
        choices: ['tombstone', 'content', 'omit'],
        default: 'tombstone',
      })
      .option('files', {
        describe:
          'manifest: list files in files-to-upload.json for the post-import uploader. hosted: reference them by URL under --files-base-url so Slack fetches them on import.',
        type: 'string',
        choices: ['manifest', 'hosted'],
        default: 'manifest',
      })
      .option('files-base-url', {
        describe:
          "Base URL serving the store's attachments/files directory (hosted strategy).",
        type: 'string',
      })
      .option('user-overrides', {
        describe:
          'JSON file mapping Google user ids (users/<id>) to { "name", "email" } for placeholders.',
        type: 'string',
      })
      .option('first-seen-after', {
        describe:
          'Delta archive: only messages first stored after this export run id.',
        type: 'string',
      })
      .option('messages-since', {
        describe:
          'Delta archive: only messages created after this RFC 3339 time.',
        type: 'string',
      })
      .option('placeholder-email-domain', {
        describe:
          'Mint an address like chat-import-1234567890@<domain> for anyone with none. Slack only imports a DM when every participant is imported, so without this their conversations are dropped.',
        type: 'string',
      })
      .option('vault-prefix', {
        describe:
          'Prefix for channels recovered from Google Vault, e.g. "archive-". Their lower fidelity is noted in the channel purpose either way.',
        type: 'string',
        default: '',
      })
      .option('slack-members', {
        describe:
          'Snapshot from `slack-members`. People whose email matches an existing member merge into it; everyone else is emitted deactivated so the importer creates them without inviting or notifying anyone. Defaults to data/slack/members.json when present.',
        type: 'string',
      })
      .option('large-files', {
        describe:
          'Ledger from stage-large-files: attachments moved to Google Drive are linked instead of attached.',
        type: 'string',
      })
      .option('members-channel', {
        describe:
          'Add a private channel with this name listing every person, so Slack imports people who appear only in DMs. Empty string for none.',
        type: 'string',
        default: 'chat-import-members',
      })
      .option('channel-visibility', {
        describe:
          'Reviewed public/private list from `channel-visibility`. Overrides --space-visibility; Spaces not on it are private.',
        type: 'string',
      })
      .option('meeting-chats', {
        describe:
          'Google Meet chats. fold: into the DM or group DM of the same people (or a private mtg-<series> channel), one thread per meeting. channels: a private channel per meeting. discard: leave them out.',
        type: 'string',
        choices: ['fold', 'channels', 'discard'],
        default: 'fold',
      })
      .option('users-overlay', {
        describe:
          'Recovered names and addresses from `recover-names --overlay`, laid over users.json for this build only.',
        type: 'string',
      })
      .option('team-id', {
        describe:
          'Team id written into users.json for the source. Defaults to a fixed made-up id; must not be the destination workspace id.',
        type: 'string',
      })
      .example(
        '$0 build-slack-archive --dry-run',
        'Report what the archive would contain'
      )
      .example(
        '$0 build-slack-archive --space general --unpacked ./archive-check',
        'One Space, ZIP plus readable copy'
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
      const options = await toBuildOptions(argv);
      const model = await buildArchiveModel(options);
      printArchiveReport(model, argv.dryRun ?? false);
      if (
        options.slackMembers &&
        options.teamId === options.slackMembers.teamId
      ) {
        throw new Error(
          `--team-id ${options.teamId} is the destination workspace; the archive must name a different source team`
        );
      }
      const existingNames =
        options.slackMembers?.channels?.map((c) => c.name) ?? [];
      const blocked = reportIssues(validateArchive(model, existingNames));
      if (argv.dryRun) {
        return;
      }
      if (blocked) {
        throw new Error(
          'validation failed; nothing written. Fix the errors above and rebuild.'
        );
      }
      await writeOutputs(model, argv);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('Archive build failed:', message);
      process.exit(1);
    }
  },
};
