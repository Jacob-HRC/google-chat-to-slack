/**
 * Google Vault access for Chat spaces that no live account can read.
 *
 * The Chat API can only return a space through a member's account. When every
 * member of a space has been deleted, the messages still exist in Google's
 * retained copy but there is no one left to impersonate. Vault's `ROOM` search
 * method addresses spaces by id instead of by member, which is the only
 * documented way to reach them.
 *
 * Vault is used read-mostly: it creates a matter (a container, reversible) and
 * then counts or exports. It never writes to Chat.
 */
import { google, type vault_v1 } from 'googleapis';
import { withGoogleChatRateLimit } from '../utils/rate-limiting';
import { getScopedAuthClient, VAULT_SCOPES } from './google-auth';

/** Vault accepts at most 500 Chat space ids per request. */
export const MAX_ROOM_IDS_PER_REQUEST = 500;

const OPERATION_POLL_MS = 5000;
const OPERATION_TIMEOUT_MS = 10 * 60 * 1000;

export type ChatExportFormat = 'MBOX' | 'PST';

export interface VaultMatter {
  matterId: string;
  name: string;
  state?: string;
}

export interface VaultExportSummary {
  id: string;
  name: string;
  status?: string;
  createTime?: string;
  exportedArtifactCount?: number;
  totalArtifactCount?: number;
  sizeInBytes?: number;
  bucketName?: string;
  objectNames: string[];
}

/** Splits space ids into request-sized batches. Pure. */
export function chunkRoomIds(
  roomIds: readonly string[],
  size = MAX_ROOM_IDS_PER_REQUEST
): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < roomIds.length; i += size) {
    chunks.push([...roomIds.slice(i, i + size)]);
  }
  return chunks;
}

/**
 * Builds a Chat query addressed by space id.
 * `searchMethod: ROOM` means "search messages in the Chat spaces specified in
 * HangoutsChatInfo", which does not require a member account.
 */
export function buildRoomQuery(
  roomIds: readonly string[],
  options: { startTime?: string; endTime?: string; terms?: string } = {}
): vault_v1.Schema$Query {
  return {
    corpus: 'HANGOUTS_CHAT',
    dataScope: 'ALL_DATA',
    searchMethod: 'ROOM',
    hangoutsChatInfo: { roomId: [...roomIds] },
    startTime: options.startTime,
    endTime: options.endTime,
    terms: options.terms,
  };
}

/** Vault export names reject these characters, which break downloads. */
const UNSAFE_EXPORT_NAME_REGEX = /[~!$'(),;@:/?]/g;

export function safeExportName(name: string): string {
  return name.replace(UNSAFE_EXPORT_NAME_REGEX, '-').trim() || 'chat-export';
}

async function vaultClient(subject?: string): Promise<vault_v1.Vault> {
  const auth = await getScopedAuthClient(VAULT_SCOPES, subject);
  return google.vault({ version: 'v1', auth });
}

/** Turns Vault's opaque failures into something actionable. */
export function describeVaultError(error: unknown): string {
  const err = error as {
    message?: string;
    response?: { status?: number; data?: { error?: { message?: string } } };
  };
  const status = err.response?.status;
  const detail =
    err.response?.data?.error?.message ?? err.message ?? String(error);

  if (detail.includes('unauthorized_client')) {
    return `${detail}. The service account is not authorized for the Vault scope. Add https://www.googleapis.com/auth/ediscovery to its domain-wide delegation entry in the Admin console.`;
  }
  if (status === 403) {
    return `${detail}. The impersonated user needs Vault privileges in the Admin console (Account > Admin roles), and the Workspace edition must include Vault.`;
  }
  if (status === 400) {
    return `${detail}. Check the space ids: Vault accepts at most ${MAX_ROOM_IDS_PER_REQUEST} per request and only ids from the Chat API.`;
  }
  return detail;
}

export async function listMatters(subject?: string): Promise<VaultMatter[]> {
  const vault = await vaultClient(subject);
  const matters: VaultMatter[] = [];
  let pageToken: string | undefined;
  do {
    // biome-ignore lint/nursery/noAwaitInLoop: pagination is sequential.
    const res = await withGoogleChatRateLimit(() =>
      vault.matters.list({ pageSize: 100, pageToken, state: 'OPEN' })
    );
    for (const matter of res.data.matters ?? []) {
      matters.push({
        matterId: matter.matterId ?? '',
        name: matter.name ?? '',
        state: matter.state ?? undefined,
      });
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return matters;
}

/** Finds an open matter by exact name, or creates one. */
export async function ensureMatter(
  name: string,
  description: string,
  subject?: string
): Promise<{ matter: VaultMatter; created: boolean }> {
  const existing = (await listMatters(subject)).find((m) => m.name === name);
  if (existing) {
    return { matter: existing, created: false };
  }
  const vault = await vaultClient(subject);
  const res = await withGoogleChatRateLimit(() =>
    vault.matters.create({ requestBody: { name, description } })
  );
  return {
    matter: {
      matterId: res.data.matterId ?? '',
      name: res.data.name ?? name,
      state: res.data.state ?? undefined,
    },
    created: true,
  };
}

export async function deleteMatter(
  matterId: string,
  subject?: string
): Promise<void> {
  const vault = await vaultClient(subject);
  await withGoogleChatRateLimit(() => vault.matters.close({ matterId }));
  await withGoogleChatRateLimit(() => vault.matters.delete({ matterId }));
}

async function waitForOperation(
  vault: vault_v1.Vault,
  operationName: string
): Promise<vault_v1.Schema$Operation> {
  const deadline = Date.now() + OPERATION_TIMEOUT_MS;
  let operation: vault_v1.Schema$Operation = { name: operationName };
  while (Date.now() < deadline) {
    // biome-ignore lint/nursery/noAwaitInLoop: polling is sequential by nature.
    const res = await withGoogleChatRateLimit(() =>
      vault.operations.get({ name: operationName })
    );
    operation = res.data;
    if (operation.done) {
      return operation;
    }
    // biome-ignore lint/nursery/noAwaitInLoop: polling interval.
    await new Promise((resolve) => setTimeout(resolve, OPERATION_POLL_MS));
  }
  throw new Error(
    `Vault operation ${operationName} did not finish within ${OPERATION_TIMEOUT_MS / 1000}s.`
  );
}

export interface ChatCountResult {
  roomIds: string[];
  totalCount?: number;
  /** Vault's raw response; the Chat breakdown is not in the published schema. */
  raw: unknown;
  error?: string;
}

/**
 * Counts messages Vault holds for the given spaces.
 *
 * Note: the published CountArtifactsResponse documents only Gmail and Groups
 * breakdowns, so `totalCount` may be the only usable number for Chat. The raw
 * response is returned so the pilot can see exactly what Vault sends back.
 */
export async function countChatMessages(
  matterId: string,
  roomIds: readonly string[],
  subject?: string
): Promise<ChatCountResult[]> {
  const vault = await vaultClient(subject);
  const results: ChatCountResult[] = [];
  for (const chunk of chunkRoomIds(roomIds)) {
    try {
      // biome-ignore lint/nursery/noAwaitInLoop: one batch at a time to respect quota.
      const res = await withGoogleChatRateLimit(() =>
        vault.matters.count({
          matterId,
          requestBody: { query: buildRoomQuery(chunk), view: 'TOTAL_COUNT' },
        })
      );
      const operationName = res.data.name;
      const operation = operationName
        ? await waitForOperation(vault, operationName)
        : res.data;
      const response = operation.response as
        | { totalCount?: string }
        | undefined;
      results.push({
        roomIds: chunk,
        totalCount: response?.totalCount
          ? Number(response.totalCount)
          : undefined,
        raw: operation.error ?? operation.response ?? operation,
        error: operation.error ? JSON.stringify(operation.error) : undefined,
      });
    } catch (error) {
      results.push({
        roomIds: chunk,
        raw: undefined,
        error: describeVaultError(error),
      });
    }
  }
  return results;
}

function toExportSummary(
  exportItem: vault_v1.Schema$Export
): VaultExportSummary {
  const stats = exportItem.stats;
  const sink = exportItem.cloudStorageSink;
  return {
    id: exportItem.id ?? '',
    name: exportItem.name ?? '',
    status: exportItem.status ?? undefined,
    createTime: exportItem.createTime ?? undefined,
    exportedArtifactCount: stats?.exportedArtifactCount
      ? Number(stats.exportedArtifactCount)
      : undefined,
    totalArtifactCount: stats?.totalArtifactCount
      ? Number(stats.totalArtifactCount)
      : undefined,
    sizeInBytes: stats?.sizeInBytes ? Number(stats.sizeInBytes) : undefined,
    bucketName: sink?.files?.[0]?.bucketName ?? undefined,
    objectNames: (sink?.files ?? [])
      .map((f) => f.objectName ?? '')
      .filter(Boolean),
  };
}

/** Starts one export per batch of spaces. Vault processes them in the background. */
export async function createChatExports(
  matterId: string,
  roomIds: readonly string[],
  namePrefix: string,
  format: ChatExportFormat,
  subject?: string
): Promise<VaultExportSummary[]> {
  const vault = await vaultClient(subject);
  const chunks = chunkRoomIds(roomIds);
  const created: VaultExportSummary[] = [];
  for (const [index, chunk] of chunks.entries()) {
    const name = safeExportName(
      chunks.length > 1 ? `${namePrefix}-${index + 1}` : namePrefix
    );
    // biome-ignore lint/nursery/noAwaitInLoop: one export at a time.
    const res = await withGoogleChatRateLimit(() =>
      vault.matters.exports.create({
        matterId,
        requestBody: {
          name,
          query: buildRoomQuery(chunk),
          exportOptions: { hangoutsChatOptions: { exportFormat: format } },
        },
      })
    );
    created.push(toExportSummary(res.data));
  }
  return created;
}

export async function listChatExports(
  matterId: string,
  subject?: string
): Promise<VaultExportSummary[]> {
  const vault = await vaultClient(subject);
  const exports: VaultExportSummary[] = [];
  let pageToken: string | undefined;
  do {
    // biome-ignore lint/nursery/noAwaitInLoop: pagination is sequential.
    const res = await withGoogleChatRateLimit(() =>
      vault.matters.exports.list({ matterId, pageSize: 100, pageToken })
    );
    for (const item of res.data.exports ?? []) {
      exports.push(toExportSummary(item));
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return exports;
}
