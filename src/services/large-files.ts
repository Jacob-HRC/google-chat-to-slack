/**
 * Files too large for Slack's importer, moved to Google Drive instead.
 *
 * The pilot showed Slack's importer never requests files over roughly
 * 100 MB (it took up to 62.6 MB), and Slack refuses any upload over 1 GB, so
 * the biggest attachments cannot reach Slack at all. They go to one Drive
 * folder, uploaded once per distinct file, and the archive links to them
 * where the attachment was.
 *
 * Staging and sharing are separate on purpose. Uploads are private to the
 * uploading admin; sharing (without notification emails) is a later,
 * explicit step, so nobody sees a "shared with you" notice before the
 * migration is announced. Who gets access mirrors Google Chat: a file posted
 * in a public channel is shared with the domain; otherwise with each
 * participant who still has an active account.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { google } from 'googleapis';
import type { AttachmentRecord } from '../types/export-store';
import { getScopedAuthClient } from './google-auth';

export const DRIVE_FILE_SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
] as const;
/** A Shared Drive is not the app's own, so writing into it needs the full scope. */
export const DRIVE_FULL_SCOPES = [
  'https://www.googleapis.com/auth/drive',
] as const;

/** Where the folder lives: the admin's My Drive, or a Shared Drive by id. */
export interface DriveTarget {
  subject?: string;
  sharedDriveId?: string;
}

/** Files above this go to Drive: the largest the pilot saw Slack accept. */
export const DRIVE_THRESHOLD_BYTES = 62 * 1024 * 1024;
export const DRIVE_FOLDER_NAME = 'Google Chat attachments (archive)';
const CHUNK_BYTES = 64 * 1024 * 1024;
const APP_PROPERTY = 'gctsSha256';

export interface LargeFile {
  sha256: string;
  size: number;
  name: string;
  mimeType: string;
  localPath: string;
  /** Attachment records (index keys) that are this file. */
  keys: string[];
  spaceIds: string[];
}

export type Audience =
  | { kind: 'domain'; domain: string }
  | { kind: 'people'; emails: string[] };

export interface StagedFile {
  fileId: string;
  webViewLink: string;
  name: string;
  size: number;
  keys: string[];
  audience: Audience;
  sharedAt?: string;
}

/** Keyed by sha256. */
export type LargeFileLedger = Record<string, StagedFile>;

/** Downloaded attachments above the threshold, one entry per distinct file. Pure. */
export function selectLargeFiles(
  index: Record<string, AttachmentRecord>,
  thresholdBytes = DRIVE_THRESHOLD_BYTES
): LargeFile[] {
  const bySha = new Map<string, LargeFile>();
  for (const record of Object.values(index)) {
    const size = record.size ?? 0;
    const done = record.status === 'downloaded' || record.status === 'exported';
    if (!(done && record.localPath && record.sha256 && size > thresholdBytes)) {
      continue;
    }
    const existing = bySha.get(record.sha256);
    if (existing) {
      existing.keys.push(record.key);
      if (!existing.spaceIds.includes(record.spaceId)) {
        existing.spaceIds.push(record.spaceId);
      }
      continue;
    }
    bySha.set(record.sha256, {
      sha256: record.sha256,
      size,
      name: record.fileName ?? record.contentName ?? 'file',
      mimeType:
        record.exportedAs?.mimeType ??
        record.contentType ??
        'application/octet-stream',
      localPath: record.localPath,
      keys: [record.key],
      spaceIds: [record.spaceId],
    });
  }
  // Smallest first: quick early progress, and the huge ones cannot stall the rest.
  return [...bySha.values()].sort((a, b) => a.size - b.size);
}

/**
 * Who may open a file: the domain if any conversation it appeared in is a
 * public channel, otherwise the union of those conversations' people with an
 * active account. Pure.
 */
export function audienceFor(
  spaceIds: string[],
  isPublic: (spaceId: string) => boolean,
  activeParticipants: (spaceId: string) => string[],
  domain: string
): Audience {
  if (spaceIds.some(isPublic)) {
    return { kind: 'domain', domain };
  }
  const emails = new Set<string>();
  for (const spaceId of spaceIds) {
    for (const email of activeParticipants(spaceId)) {
      emails.add(email.toLowerCase());
    }
  }
  return { kind: 'people', emails: [...emails].sort() };
}

async function drive(target: DriveTarget) {
  const auth = await getScopedAuthClient(
    target.sharedDriveId ? DRIVE_FULL_SCOPES : DRIVE_FILE_SCOPES,
    target.subject
  );
  return { client: google.drive({ version: 'v3', auth }), auth };
}

/** List parameters that search the right drive. */
function listScope(target: DriveTarget): Record<string, unknown> {
  return target.sharedDriveId
    ? {
        corpora: 'drive',
        driveId: target.sharedDriveId,
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
      }
    : { spaces: 'drive' };
}

/** The archive folder, created on first use. drive.file only sees what this app made. */
export async function ensureFolder(target: DriveTarget): Promise<string> {
  const { client } = await drive(target);
  const found = await client.files.list({
    q: `name = '${DRIVE_FOLDER_NAME}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id)',
    ...listScope(target),
  });
  const id = found.data.files?.[0]?.id;
  if (id) {
    return id;
  }
  const created = await client.files.create({
    requestBody: {
      name: DRIVE_FOLDER_NAME,
      mimeType: 'application/vnd.google-apps.folder',
      parents: target.sharedDriveId ? [target.sharedDriveId] : undefined,
    },
    fields: 'id',
    supportsAllDrives: true,
  });
  return created.data.id as string;
}

/** A file this app already uploaded with these bytes, so reruns never duplicate. */
async function findUploaded(
  sha256: string,
  target: DriveTarget
): Promise<{ id: string; webViewLink: string } | undefined> {
  const { client } = await drive(target);
  const found = await client.files.list({
    q: `appProperties has { key='${APP_PROPERTY}' and value='${sha256}' } and trashed = false`,
    fields: 'files(id, webViewLink)',
    ...listScope(target),
  });
  const file = found.data.files?.[0];
  return file?.id
    ? { id: file.id, webViewLink: file.webViewLink ?? '' }
    : undefined;
}

/** Resumable upload in 64 MB chunks; files run to 20 GB. */
async function uploadResumable(
  file: LargeFile,
  folderId: string,
  target: DriveTarget
): Promise<{ id: string; webViewLink: string }> {
  const { auth } = await drive(target);
  const { token } = await auth.getAccessToken();
  const { size } = await stat(file.localPath);
  const start = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=id,webViewLink',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': file.mimeType,
        'X-Upload-Content-Length': String(size),
      },
      body: JSON.stringify({
        name: file.name,
        parents: [folderId],
        appProperties: { [APP_PROPERTY]: file.sha256 },
      }),
    }
  );
  const session = start.headers.get('location');
  if (!(start.ok && session)) {
    throw new Error(
      `Drive refused the upload of ${file.name}: HTTP ${start.status}`
    );
  }
  let offset = 0;
  while (offset < size) {
    const end = Math.min(offset + CHUNK_BYTES, size) - 1;
    const chunk = createReadStream(file.localPath, { start: offset, end });
    // biome-ignore lint/nursery/noAwaitInLoop: chunks of one upload go in order.
    const res = await fetch(session, {
      method: 'PUT',
      headers: {
        'Content-Length': String(end - offset + 1),
        'Content-Range': `bytes ${offset}-${end}/${size}`,
      },
      body: chunk as unknown as BodyInit,
      duplex: 'half',
    } as RequestInit);
    if (res.status === 308) {
      const range = res.headers.get('range');
      offset = range ? Number(range.split('-')[1]) + 1 : end + 1;
      continue;
    }
    if (!res.ok) {
      throw new Error(
        `Upload of ${file.name} failed at byte ${offset}: HTTP ${res.status}`
      );
    }
    const body = (await res.json()) as { id: string; webViewLink?: string };
    return { id: body.id, webViewLink: body.webViewLink ?? '' };
  }
  throw new Error(`Upload of ${file.name} ended without a file id`);
}

/** Uploads a file unless this app already holds one with the same bytes. */
export async function stageFile(
  file: LargeFile,
  folderId: string,
  target: DriveTarget
): Promise<{ id: string; webViewLink: string }> {
  return (
    (await findUploaded(file.sha256, target)) ??
    (await uploadResumable(file, folderId, target))
  );
}

/** Grants read access without notification emails. */
export async function shareFile(
  fileId: string,
  audience: Audience,
  target: DriveTarget
): Promise<void> {
  const { client } = await drive(target);
  if (audience.kind === 'domain') {
    await client.permissions.create({
      fileId,
      sendNotificationEmail: false,
      supportsAllDrives: true,
      requestBody: {
        type: 'domain',
        role: 'reader',
        domain: audience.domain,
        allowFileDiscovery: false,
      },
    });
    return;
  }
  for (const email of audience.emails) {
    // biome-ignore lint/nursery/noAwaitInLoop: one permission at a time, inside Drive's rate limits.
    await client.permissions.create({
      fileId,
      sendNotificationEmail: false,
      supportsAllDrives: true,
      requestBody: { type: 'user', role: 'reader', emailAddress: email },
    });
  }
}
