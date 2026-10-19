/**
 * Runs exportWorkspace end to end on a temporary store with Google mocked, to
 * check what a delta touches: which conversations are listed, and which files
 * are rewritten.
 */
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { chat_v1 } from 'googleapis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  listMembershipsAs,
  listMessagesAs,
  listReactionsAs,
  listSpacesAs,
} from '../../services/chat-reader';
import { getDomainUser, listDomainUsers } from '../../services/directory';
import {
  attachmentsIndexPath,
  manifestPath,
  messagesPath,
  spaceDir,
  statePath,
} from '../../services/export-store';
import {
  exportWorkspace,
  type WorkspaceExportOptions,
} from '../../services/workspace-export';
import {
  MEMBERSHIPS_GENERAL,
  MSG_PLAIN,
  MSG_REPLY_WITH_REACTION,
  MSG_WITH_ATTACHMENTS,
  SPACE_GENERAL,
} from '../fixtures/chat-api';

vi.mock('../../services/chat-reader', () => ({
  listSpacesAs: vi.fn(),
  listMembershipsAs: vi.fn(),
  listMessagesAs: vi.fn(),
  listReactionsAs: vi.fn(),
  searchNamedSpacesAsAdmin: vi.fn(),
}));
vi.mock('../../services/directory', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listDomainUsers: vi.fn(),
  getDomainUser: vi.fn(),
}));

const SINCE = '2026-09-24T12:40:00Z';
const QUIET = { ...SPACE_GENERAL, lastActiveTime: '2025-02-01T09:00:00Z' };
const BUSY = { ...SPACE_GENERAL, lastActiveTime: '2026-10-01T09:00:00Z' };
const NEW_MESSAGE: chat_v1.Schema$Message = {
  ...MSG_PLAIN,
  name: 'spaces/AAAAgeneral/messages/msg900.msg900',
  createTime: '2026-10-01T09:00:00.000000Z',
  text: 'posted after the cutoff',
};

const chat = {
  listSpacesAs: vi.mocked(listSpacesAs),
  listMembershipsAs: vi.mocked(listMembershipsAs),
  listMessagesAs: vi.mocked(listMessagesAs),
  listReactionsAs: vi.mocked(listReactionsAs),
};
const dir = {
  listDomainUsers: vi.mocked(listDomainUsers),
  getDomainUser: vi.mocked(getDomainUser),
};

function quiet(): void {
  // Keep the run's progress lines out of the test output.
}

describe('exportWorkspace deltas', () => {
  let root: string;

  function options(
    overrides: Partial<WorkspaceExportOptions> = {}
  ): WorkspaceExportOptions {
    return {
      outputDir: root,
      selection: { emails: [], includeSuspended: false },
      dryRun: false,
      resume: false,
      skipInactive: true,
      spaceFilter: [],
      skipBotDms: false,
      driveLinks: 'metadata',
      driveExportFormat: 'office',
      skipAttachments: true,
      adminSweep: false,
      concurrency: 1,
      refreshUsers: false,
      ...overrides,
    };
  }

  function listing(space: chat_v1.Schema$Space): void {
    chat.listSpacesAs.mockResolvedValue([space]);
  }

  /** A file's inode: an atomic rewrite replaces it. */
  async function inode(file: string): Promise<number> {
    return (await stat(file)).ino;
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'gcts-delta-'));
    vi.spyOn(console, 'log').mockImplementation(quiet);
    dir.listDomainUsers.mockResolvedValue([
      {
        id: '100000000000000000001',
        email: 'pastor@example.com',
        fullName: 'Pat Pastor',
        suspended: false,
        archived: false,
        orgUnitPath: '/',
      },
    ]);
    dir.getDomainUser.mockResolvedValue(undefined);
    chat.listMembershipsAs.mockResolvedValue(MEMBERSHIPS_GENERAL);
    chat.listMessagesAs.mockResolvedValue([MSG_PLAIN]);
    chat.listReactionsAs.mockResolvedValue([]);
    listing(QUIET);
    await exportWorkspace(options());
    vi.clearAllMocks();
    chat.listMembershipsAs.mockResolvedValue(MEMBERSHIPS_GENERAL);
    chat.listReactionsAs.mockResolvedValue([]);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it('leaves an inactive conversation alone but refreshes its record and members', async () => {
    const before = await inode(messagesPath(root, 'AAAAgeneral'));
    const stateBefore = await readFile(statePath(root, 'AAAAgeneral'), 'utf-8');
    const report = await exportWorkspace(options({ since: SINCE }));

    expect(report.totals.spacesSkipped).toBe(1);
    // Its last listing time must not move, or a later cutoff could leave a gap.
    expect(await readFile(statePath(root, 'AAAAgeneral'), 'utf-8')).toBe(
      stateBefore
    );
    expect(chat.listMessagesAs).not.toHaveBeenCalled();
    // A named Space's members are refreshed even when skipped.
    expect(chat.listMembershipsAs).toHaveBeenCalledTimes(1);
    expect(await inode(messagesPath(root, 'AAAAgeneral'))).toBe(before);
    const space = JSON.parse(
      await readFile(
        path.join(spaceDir(root, 'AAAAgeneral'), 'space.json'),
        'utf-8'
      )
    );
    expect(space.lastSeenRun).toBe(report.runId);
    expect(space.raw.lastActiveTime).toBe(QUIET.lastActiveTime);
  });

  it('lists only the window of an active conversation and saves what is new', async () => {
    listing(BUSY);
    chat.listMessagesAs.mockResolvedValue([NEW_MESSAGE]);
    const report = await exportWorkspace(options({ since: SINCE }));

    expect(chat.listMessagesAs).toHaveBeenCalledWith(
      'pastor@example.com',
      'spaces/AAAAgeneral',
      { since: SINCE, limit: undefined }
    );
    expect(report.totals.messagesAdded).toBe(1);
    const stored = JSON.parse(
      await readFile(messagesPath(root, 'AAAAgeneral'), 'utf-8')
    );
    expect(stored.map((m: { text: string }) => m.text)).toContain(
      'posted after the cutoff'
    );
  });

  it('does not rewrite an unchanged history', async () => {
    chat.listMessagesAs.mockResolvedValue([MSG_PLAIN]);
    const before = await inode(messagesPath(root, 'AAAAgeneral'));
    await exportWorkspace(options());
    expect(await inode(messagesPath(root, 'AAAAgeneral'))).toBe(before);
  });

  it('saves reactions fetched after the first save', async () => {
    chat.listMessagesAs.mockResolvedValue([MSG_PLAIN, MSG_REPLY_WITH_REACTION]);
    chat.listReactionsAs.mockResolvedValue([
      {
        name: `${MSG_REPLY_WITH_REACTION.name}/reactions/r1`,
        user: { name: 'users/100000000000000000001', type: 'HUMAN' },
        emoji: { unicode: '🙏' },
      },
    ]);
    await exportWorkspace(options());
    const stored = JSON.parse(
      await readFile(messagesPath(root, 'AAAAgeneral'), 'utf-8')
    );
    const reply = stored.find(
      (m: { name: string }) => m.name === MSG_REPLY_WITH_REACTION.name
    );
    expect(reply.reactions).toHaveLength(1);
  });

  it('gives a conversation never listed in full its whole history', async () => {
    const state = statePath(root, 'AAAAgeneral');
    const saved = JSON.parse(await readFile(state, 'utf-8'));
    await writeFile(
      state,
      JSON.stringify({ ...saved, lastFullListingAt: undefined })
    );
    listing(BUSY);
    chat.listMessagesAs.mockResolvedValue([MSG_PLAIN, NEW_MESSAGE]);
    await exportWorkspace(options({ since: SINCE }));
    expect(chat.listMessagesAs).toHaveBeenCalledWith(
      'pastor@example.com',
      'spaces/AAAAgeneral',
      { since: undefined, limit: undefined }
    );
    const after = JSON.parse(await readFile(state, 'utf-8'));
    expect(after.lastFullListingAt).toBeDefined();
  });

  it('resumes an interrupted delta with its own cutoff', async () => {
    const manifest = JSON.parse(await readFile(manifestPath(root), 'utf-8'));
    const interrupted = {
      runId: '20261019T000000Z',
      startedAt: '2026-10-19T00:00:00.000Z',
      status: 'running',
      since: SINCE,
    };
    manifest.runs.push(interrupted);
    manifest.lastRun = interrupted;
    await writeFile(manifestPath(root), JSON.stringify(manifest));
    listing(BUSY);
    chat.listMessagesAs.mockResolvedValue([]);
    const report = await exportWorkspace(options({ resume: true }));
    expect(report.mode).toBe('resume');
    expect(chat.listMessagesAs).toHaveBeenCalledWith(
      'pastor@example.com',
      'spaces/AAAAgeneral',
      { since: SINCE, limit: undefined }
    );
  });

  async function readJson<T>(file: string): Promise<T> {
    return JSON.parse(await readFile(file, 'utf-8')) as T;
  }

  async function patchState(patch: Record<string, unknown>): Promise<void> {
    const file = statePath(root, 'AAAAgeneral');
    await writeFile(
      file,
      JSON.stringify({ ...(await readJson<object>(file)), ...patch })
    );
  }

  it('lists from the last listing when that was before the cutoff', async () => {
    await patchState({ lastMessagesSyncAt: '2026-08-01T10:00:00.000Z' });
    // Activity after our last listing but before the cutoff is not skipped.
    listing({ ...SPACE_GENERAL, lastActiveTime: '2026-08-15T09:00:00Z' });
    chat.listMessagesAs.mockResolvedValue([]);
    await exportWorkspace(options({ since: SINCE }));
    expect(chat.listMessagesAs).toHaveBeenCalledWith(
      'pastor@example.com',
      'spaces/AAAAgeneral',
      { since: '2026-08-01T09:00:00.000Z', limit: undefined }
    );
  });

  it('keeps the attachment index and history untouched when nothing changed', async () => {
    chat.listMessagesAs.mockResolvedValue([MSG_PLAIN, MSG_WITH_ATTACHMENTS]);
    await exportWorkspace(options());
    const index = await readJson<Record<string, unknown>>(
      attachmentsIndexPath(root)
    );
    expect(Object.keys(index).length).toBeGreaterThan(0);
    const indexBefore = await inode(attachmentsIndexPath(root));
    const messagesBefore = await inode(messagesPath(root, 'AAAAgeneral'));
    await exportWorkspace(options());
    expect(await inode(attachmentsIndexPath(root))).toBe(indexBefore);
    expect(await inode(messagesPath(root, 'AAAAgeneral'))).toBe(messagesBefore);
  });

  it('stores attachment keys with new messages, and never skips pending downloads', async () => {
    chat.listMessagesAs.mockResolvedValue([MSG_PLAIN, MSG_WITH_ATTACHMENTS]);
    await exportWorkspace(options());
    const stored = await readJson<
      Array<{ name: string; attachmentKeys: string[] }>
    >(messagesPath(root, 'AAAAgeneral'));
    const withFiles = stored.find((m) => m.name === MSG_WITH_ATTACHMENTS.name);
    expect(withFiles?.attachmentKeys.length).toBeGreaterThan(0);

    // --skip-attachments left them pending, so the quiet conversation is
    // still visited (and its files retried when downloads are on).
    chat.listMessagesAs.mockClear();
    const report = await exportWorkspace(options({ since: SINCE }));
    expect(report.totals.spacesSkipped).toBe(0);
    expect(chat.listMessagesAs).toHaveBeenCalled();
  });

  it('re-indexes a conversation an interrupted run left part-way', async () => {
    chat.listMessagesAs.mockResolvedValue([MSG_PLAIN, MSG_WITH_ATTACHMENTS]);
    await exportWorkspace(options());
    // Simulate a crash after the first save: keys and records lost.
    const file = messagesPath(root, 'AAAAgeneral');
    const stored = await readJson<Record<string, unknown>[]>(file);
    await writeFile(
      file,
      JSON.stringify(stored.map((m) => ({ ...m, attachmentKeys: [] })))
    );
    await writeFile(attachmentsIndexPath(root), '{}');
    await patchState({ status: 'messages-synced' });

    await exportWorkspace(options());
    const repaired =
      await readJson<Array<{ name: string; attachmentKeys: string[] }>>(file);
    expect(
      repaired.find((m) => m.name === MSG_WITH_ATTACHMENTS.name)?.attachmentKeys
        .length
    ).toBeGreaterThan(0);
    const index = await readJson<Record<string, unknown>>(
      attachmentsIndexPath(root)
    );
    expect(Object.keys(index).length).toBeGreaterThan(0);
  });

  it('keeps the stored member count when the member listing fails', async () => {
    const grown = {
      ...QUIET,
      membershipCount: { joinedDirectHumanUserCount: 4 },
    };
    listing(grown);
    chat.listMembershipsAs.mockRejectedValue(new Error('backend error'));
    chat.listMessagesAs.mockResolvedValue([]);
    await exportWorkspace(options({ since: SINCE }));
    const space = await readJson<{ raw: chat_v1.Schema$Space }>(
      path.join(spaceDir(root, 'AAAAgeneral'), 'space.json')
    );
    expect(space.raw.membershipCount).toEqual(SPACE_GENERAL.membershipCount);

    // So the next run still sees a change and lists the members again.
    chat.listMembershipsAs.mockResolvedValue(MEMBERSHIPS_GENERAL);
    const report = await exportWorkspace(options({ since: SINCE }));
    expect(report.totals.spacesSkipped).toBe(0);
  });

  it('fetches reactions a part-way conversation never got, even outside the window', async () => {
    chat.listMessagesAs.mockResolvedValue([MSG_PLAIN, MSG_REPLY_WITH_REACTION]);
    await exportWorkspace(options());
    const file = messagesPath(root, 'AAAAgeneral');
    const stored = await readJson<Record<string, unknown>[]>(file);
    await writeFile(
      file,
      JSON.stringify(
        stored.map((m) => ({ ...m, reactionsFetchedRun: undefined }))
      )
    );
    await patchState({ status: 'messages-synced' });
    chat.listReactionsAs.mockClear();
    listing(BUSY);
    chat.listMessagesAs.mockResolvedValue([]);
    await exportWorkspace(options({ since: SINCE }));
    expect(chat.listReactionsAs).toHaveBeenCalledWith(
      'pastor@example.com',
      MSG_REPLY_WITH_REACTION.name
    );
  });
});
