import path from 'node:path';
import { google } from 'googleapis';
import type { CommandModule } from 'yargs';
import {
  type AddressFinding,
  findAddressesInAuditLogs,
} from '../../services/audit-addresses';
import { loadUsers, openStore } from '../../services/export-store';
import { getGoogleAuthClient } from '../../services/google-auth';
import {
  applyUsersOverlay,
  peopleWithoutAddress,
  type UserOverlay,
} from '../../services/name-recovery';
import type { SlackMemberSnapshot } from '../../services/slack-archive/slack-members';
import type { UserOverride } from '../../services/slack-archive/users';
import type { StoredUser } from '../../types/export-store';
import {
  getDefaultSlackMembersFile,
  getDefaultWorkspaceExportDirectory,
} from '../../utils/data-directory';
import { readJsonFile, writeJsonAtomic } from '../../utils/fs-atomic';

type FindAddressesArgs = {
  input: string;
  usersOverlay?: string;
  userOverrides?: string;
  slackMembers?: string;
  apply?: boolean;
  subject?: string;
};

export type Verdict =
  | { ok: true; email: string }
  | { ok: false; email?: string; reason: string };

export interface VerifyContext {
  /** Address → Google id of the HRC account holding it, when one does. */
  directoryHolders: Map<string, string>;
  slackEmails: Set<string>;
  /** Address → the store record already carrying it. */
  storeEmails: Map<string, string>;
}

/**
 * Accepts a finding only when exactly one address was seen and nobody else
 * holds it: no other Google account, no Slack member (which the import would
 * merge into), no other person in the store. Pure.
 */
export function judgeFinding(
  finding: AddressFinding,
  ctx: VerifyContext
): Verdict {
  if (finding.sightings.length === 0) {
    return { ok: false, reason: 'not in the audit logs' };
  }
  if (finding.sightings.length > 1) {
    return {
      ok: false,
      reason: `seen under ${finding.sightings.length} addresses: ${finding.sightings.map((s) => s.email).join(', ')}`,
    };
  }
  const { email } = finding.sightings[0];
  const profileId = finding.chatUserId.replace('users/', '');
  const holder = ctx.directoryHolders.get(email);
  if (holder && holder !== profileId) {
    return {
      ok: false,
      email,
      reason: 'now belongs to another Google account',
    };
  }
  if (ctx.slackEmails.has(email)) {
    return {
      ok: false,
      email,
      reason: 'belongs to a Slack member; the import would merge into them',
    };
  }
  const other = ctx.storeEmails.get(email);
  if (other && other !== finding.chatUserId) {
    return { ok: false, email, reason: `already on ${other}; same person?` };
  }
  return { ok: true, email };
}

async function directoryHolders(
  emails: string[],
  subject?: string
): Promise<Map<string, string>> {
  const auth = await getGoogleAuthClient(subject);
  const directory = google.admin({ version: 'directory_v1', auth });
  const holders = new Map<string, string>();
  for (const email of emails) {
    try {
      // biome-ignore lint/nursery/noAwaitInLoop: a handful of lookups.
      const res = await directory.users.get({ userKey: email });
      if (res.data.id) {
        holders.set(email, res.data.id);
      }
    } catch {
      // Not an account in this organisation (deleted, a group, or another domain).
    }
  }
  return holders;
}

function currentUsers(
  users: Record<string, StoredUser>,
  overlay: UserOverlay,
  overrides: Record<string, UserOverride>
): Record<string, StoredUser> {
  const merged = applyUsersOverlay(users, overlay);
  for (const [id, override] of Object.entries(overrides)) {
    if (merged[id] && override.email) {
      merged[id] = { ...merged[id], email: override.email };
    }
  }
  return merged;
}

async function loadCurrent(argv: FindAddressesArgs): Promise<{
  users: Record<string, StoredUser>;
  overrides: Record<string, UserOverride>;
  overridesPath?: string;
}> {
  const store = await openStore(path.resolve(argv.input));
  const overlay = argv.usersOverlay
    ? ((await readJsonFile<UserOverlay>(path.resolve(argv.usersOverlay))) ?? {})
    : {};
  const overridesPath = argv.userOverrides
    ? path.resolve(argv.userOverrides)
    : undefined;
  const overrides = overridesPath
    ? ((await readJsonFile<Record<string, UserOverride>>(overridesPath)) ?? {})
    : {};
  return {
    users: currentUsers(await loadUsers(store), overlay, overrides),
    overrides,
    overridesPath,
  };
}

/** Prints each verdict and adds accepted addresses to `overrides`; returns how many. */
function reportFindings(
  findings: AddressFinding[],
  ctx: VerifyContext,
  overrides: Record<string, UserOverride>
): number {
  let accepted = 0;
  for (const finding of findings) {
    const verdict = judgeFinding(finding, ctx);
    const label = (finding.name ?? finding.chatUserId).padEnd(28);
    if (verdict.ok) {
      accepted += 1;
      const seen = finding.sightings[0];
      console.log(
        `   ✅ ${label} ${verdict.email} (${seen.applications.join(', ')}; last ${seen.lastSeen.slice(0, 10)})`
      );
      overrides[finding.chatUserId] = {
        ...overrides[finding.chatUserId],
        email: verdict.email,
      };
    } else if (verdict.email) {
      console.log(`   ⚠️  ${label} ${verdict.email}: ${verdict.reason}`);
    }
  }
  return accepted;
}

export const findAddressesCommand: CommandModule<object, FindAddressesArgs> = {
  command: 'find-addresses',
  describe:
    "Find addresses for people with none, from Google's audit logs (exact match on account id). Needs admin.reports.audit.readonly. Read-only unless --apply.",
  builder: (yargs) =>
    yargs
      .option('input', {
        describe: 'Workspace export store.',
        type: 'string',
        default: getDefaultWorkspaceExportDirectory(),
      })
      .option('users-overlay', {
        describe:
          'Overlay from recover-names --overlay, so its addresses count.',
        type: 'string',
      })
      .option('user-overrides', {
        describe:
          'Overrides file (as for build-slack-archive). Its addresses count; --apply adds the verified finds to it.',
        type: 'string',
      })
      .option('slack-members', {
        describe: 'Slack member snapshot, to refuse addresses a member holds.',
        type: 'string',
        default: getDefaultSlackMembersFile(),
      })
      .option('apply', {
        describe: 'Add verified addresses to the --user-overrides file.',
        type: 'boolean',
        default: false,
      })
      .option('subject', {
        describe: 'Admin to act as. Defaults to the configured admin.',
        type: 'string',
      })
      .strict(),
  handler: async (argv) => {
    try {
      if (argv.apply && !argv.userOverrides) {
        throw new Error('--apply needs --user-overrides <file> to write to');
      }
      const { users, overrides, overridesPath } = await loadCurrent(argv);
      const missing = peopleWithoutAddress(users);
      console.log(
        `${missing.length} people have no address. Checking audit logs...`
      );

      const findings = await findAddressesInAuditLogs(missing, argv.subject);
      const found = findings.flatMap((f) => f.sightings.map((s) => s.email));
      const snapshot = await readJsonFile<SlackMemberSnapshot>(
        path.resolve(argv.slackMembers ?? getDefaultSlackMembersFile())
      );
      const ctx: VerifyContext = {
        directoryHolders: await directoryHolders(found, argv.subject),
        slackEmails: new Set(
          (snapshot?.members ?? []).flatMap((m) => (m.email ? [m.email] : []))
        ),
        storeEmails: new Map(
          Object.values(users)
            .filter((u) => u.email && !u.aliasOf)
            .map((u) => [(u.email as string).toLowerCase(), u.chatUserId])
        ),
      };

      const accepted = reportFindings(findings, ctx, overrides);
      const notFound = findings.filter((f) => f.sightings.length === 0).length;
      console.log(
        `\n${accepted} verified · ${notFound} not in the audit logs (older than their retention, or never active in the domain)`
      );
      if (argv.apply && overridesPath && accepted > 0) {
        await writeJsonAtomic(overridesPath, overrides);
        console.log(`Added to ${overridesPath}`);
      } else if (accepted > 0) {
        console.log('Nothing written. Re-run with --apply to keep them.');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('find-addresses failed:', message);
      process.exit(1);
    }
  },
};
