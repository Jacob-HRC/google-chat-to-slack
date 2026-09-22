/**
 * Read-only Google Chat API access on behalf of a specific Workspace user
 * (`subject`). Every call goes through the shared rate limiter. Functions
 * return Google's payloads untouched so the store can keep them verbatim.
 */
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { type chat_v1, google } from 'googleapis';
import { withGoogleChatRateLimit } from '../utils/rate-limiting';
import { getGoogleAccessToken, getGoogleAuthClient } from './google-auth';

const PAGE_SIZE = 1000;
const REACTIONS_PAGE_SIZE = 200;

export interface ApiCallError extends Error {
  status?: number;
  subject: string;
  resource: string;
}

export interface DownloadResult {
  size: number;
  sha256: string;
  md5: string;
}

export function annotateError(
  error: unknown,
  subject: string,
  resource: string
): ApiCallError {
  const source = error as {
    message?: string;
    response?: { status?: number };
    code?: number | string;
    status?: number;
  };
  const status =
    source.response?.status ??
    (typeof source.code === 'number' ? source.code : undefined) ??
    source.status;
  const annotated = new Error(
    `${resource} as ${subject}: ${source.message ?? String(error)}`
  ) as ApiCallError;
  annotated.status = status;
  annotated.subject = subject;
  annotated.resource = resource;
  return annotated;
}

export function isAccessError(error: unknown): boolean {
  const status = (error as { status?: number }).status;
  return status === 403 || status === 404 || status === 401;
}

async function chatClientAs(subject: string): Promise<chat_v1.Chat> {
  const auth = await getGoogleAuthClient(subject);
  return google.chat({ version: 'v1', auth });
}

async function pageAll<T>(
  subject: string,
  resource: string,
  fetchPage: (
    pageToken?: string
  ) => Promise<{ items?: T[] | null; nextPageToken?: string | null }>
): Promise<T[]> {
  const items: T[] = [];
  let pageToken: string | undefined;
  do {
    let page: { items?: T[] | null; nextPageToken?: string | null };
    try {
      // biome-ignore lint/nursery/noAwaitInLoop: pagination is sequential by nature.
      page = await withGoogleChatRateLimit(() => fetchPage(pageToken));
    } catch (error) {
      throw annotateError(error, subject, resource);
    }
    items.push(...(page.items ?? []));
    pageToken = page.nextPageToken ?? undefined;
  } while (pageToken);
  return items;
}

/** All spaces (named, group chats, DMs) the subject is a member of. */
export async function listSpacesAs(
  subject: string
): Promise<chat_v1.Schema$Space[]> {
  const chat = await chatClientAs(subject);
  return await pageAll(subject, 'spaces.list', async (pageToken) => {
    const res = await chat.spaces.list({ pageSize: PAGE_SIZE, pageToken });
    return { items: res.data.spaces, nextPageToken: res.data.nextPageToken };
  });
}

export async function listMembershipsAs(
  subject: string,
  spaceName: string,
  useAdminAccess = false
): Promise<chat_v1.Schema$Membership[]> {
  const chat = await chatClientAs(subject);
  return await pageAll(
    subject,
    `members.list(${spaceName})`,
    async (pageToken) => {
      const res = await chat.spaces.members.list({
        parent: spaceName,
        pageSize: PAGE_SIZE,
        pageToken,
        showGroups: true,
        showInvited: true,
        useAdminAccess,
      });
      return {
        items: res.data.memberships,
        nextPageToken: res.data.nextPageToken,
      };
    }
  );
}

export interface ListMessagesOptions {
  /** RFC 3339; only messages created strictly after this are returned. */
  since?: string;
  /** Stop after roughly this many messages (dry runs). */
  limit?: number;
}

/**
 * Every message in a space in creation order, including deleted ones (which
 * carry `deleteTime` and `deletionMetadata` but no content) and thread
 * replies.
 */
export async function listMessagesAs(
  subject: string,
  spaceName: string,
  options: ListMessagesOptions = {}
): Promise<chat_v1.Schema$Message[]> {
  const chat = await chatClientAs(subject);
  const filter = options.since ? `createTime > "${options.since}"` : undefined;
  const messages: chat_v1.Schema$Message[] = [];
  let pageToken: string | undefined;
  do {
    let res: { data: chat_v1.Schema$ListMessagesResponse };
    try {
      // biome-ignore lint/nursery/noAwaitInLoop: pagination is sequential by nature.
      res = await withGoogleChatRateLimit(() =>
        chat.spaces.messages.list({
          parent: spaceName,
          pageSize: PAGE_SIZE,
          pageToken,
          orderBy: 'createTime ASC',
          showDeleted: true,
          filter,
        })
      );
    } catch (error) {
      throw annotateError(error, subject, `messages.list(${spaceName})`);
    }
    messages.push(...(res.data.messages ?? []));
    pageToken = res.data.nextPageToken ?? undefined;
    if (options.limit && messages.length >= options.limit) {
      break;
    }
  } while (pageToken);
  return messages;
}

export async function listReactionsAs(
  subject: string,
  messageName: string
): Promise<chat_v1.Schema$Reaction[]> {
  const chat = await chatClientAs(subject);
  return await pageAll(
    subject,
    `reactions.list(${messageName})`,
    async (pageToken) => {
      const res = await chat.spaces.messages.reactions.list({
        parent: messageName,
        pageSize: REACTIONS_PAGE_SIZE,
        pageToken,
      });
      return {
        items: res.data.reactions,
        nextPageToken: res.data.nextPageToken,
      };
    }
  );
}

/**
 * Every named space in the customer, regardless of membership. Requires the
 * subject to be a Workspace admin with the Chat privilege and the
 * `chat.admin.spaces.readonly` scope. Does not return DMs or group chats.
 */
export async function searchNamedSpacesAsAdmin(
  adminSubject: string
): Promise<chat_v1.Schema$Space[]> {
  const chat = await chatClientAs(adminSubject);
  return await pageAll(adminSubject, 'spaces.search', async (pageToken) => {
    const res = await chat.spaces.search({
      useAdminAccess: true,
      query: 'customer = "customers/my_customer" AND spaceType = "SPACE"',
      pageSize: PAGE_SIZE,
      pageToken,
    });
    return { items: res.data.spaces, nextPageToken: res.data.nextPageToken };
  });
}

/** Streams a response body to disk while hashing it. */
export async function streamToFile(
  body: NodeJS.ReadableStream | Readable,
  destPath: string
): Promise<DownloadResult> {
  await mkdir(path.dirname(destPath), { recursive: true });
  const sha256 = createHash('sha256');
  const md5 = createHash('md5');
  let size = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback): void {
      sha256.update(chunk);
      md5.update(chunk);
      size += chunk.length;
      callback(null, chunk);
    },
  });
  await pipeline(body, counter, createWriteStream(destPath));
  return { size, sha256: sha256.digest('hex'), md5: md5.digest('hex') };
}

async function fetchToFile(
  url: string,
  destPath: string,
  headers: Record<string, string>,
  subject: string,
  resource: string
): Promise<DownloadResult> {
  return await withGoogleChatRateLimit(async () => {
    const response = await fetch(url, { headers });
    if (!(response.ok && response.body)) {
      const text = await response.text().catch(() => '');
      const error = new Error(
        `HTTP ${response.status} ${response.statusText} ${text.slice(0, 200)}`
      ) as ApiCallError;
      error.status = response.status;
      throw annotateError(error, subject, resource);
    }
    const body = Readable.fromWeb(
      response.body as unknown as import('node:stream/web').ReadableStream
    );
    return await streamToFile(body, destPath);
  });
}

/** Downloads an uploaded Chat attachment (`attachmentDataRef.resourceName`). */
export async function downloadChatMediaAs(
  subject: string,
  resourceName: string,
  destPath: string
): Promise<DownloadResult> {
  const token = await getGoogleAccessToken(subject);
  const url = `https://chat.googleapis.com/v1/media/${resourceName}?alt=media`;
  return await fetchToFile(
    url,
    destPath,
    { Authorization: `Bearer ${token}`, Accept: '*/*' },
    subject,
    `media.download(${resourceName})`
  );
}

/** Downloads a public URL (attached GIFs are served from tenor). */
export async function downloadPublicUrl(
  url: string,
  destPath: string
): Promise<DownloadResult> {
  return await fetchToFile(url, destPath, {}, 'anonymous', `GET ${url}`);
}
