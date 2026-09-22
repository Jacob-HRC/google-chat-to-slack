/**
 * Google Drive access for attachments and links. Downloads binary files as
 * stored, exports Google-native documents to a portable format, and records
 * full metadata so the Slack side can keep the original link.
 */
import { type drive_v3, google } from 'googleapis';
import type { DriveFileMetadata } from '../types/export-store';
import { withGoogleChatRateLimit } from '../utils/rate-limiting';
import {
  annotateError,
  type DownloadResult,
  isAccessError,
  streamToFile,
} from './chat-reader';
import { getGoogleAuthClient } from './google-auth';

export const DRIVE_METADATA_FIELDS =
  'id,name,mimeType,size,md5Checksum,createdTime,modifiedTime,owners(emailAddress,displayName),lastModifyingUser(emailAddress,displayName),webViewLink,webContentLink,iconLink,trashed,shortcutDetails,driveId,description';

export type DriveExportPreference = 'office' | 'pdf';

export interface ExportFormat {
  mimeType: string;
  extension: string;
}

const GOOGLE_APPS_PREFIX = 'application/vnd.google-apps.';
const PDF: ExportFormat = { mimeType: 'application/pdf', extension: '.pdf' };

const OFFICE_FORMATS: Record<string, ExportFormat> = {
  'application/vnd.google-apps.document': {
    mimeType:
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    extension: '.docx',
  },
  'application/vnd.google-apps.spreadsheet': {
    mimeType:
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    extension: '.xlsx',
  },
  'application/vnd.google-apps.presentation': {
    mimeType:
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    extension: '.pptx',
  },
  'application/vnd.google-apps.drawing': PDF,
  'application/vnd.google-apps.script': {
    mimeType: 'application/vnd.google-apps.script+json',
    extension: '.json',
  },
};

const PDF_FORMATS: Record<string, ExportFormat> = {
  'application/vnd.google-apps.document': PDF,
  'application/vnd.google-apps.spreadsheet': PDF,
  'application/vnd.google-apps.presentation': PDF,
  'application/vnd.google-apps.drawing': PDF,
  'application/vnd.google-apps.script':
    OFFICE_FORMATS['application/vnd.google-apps.script'],
};

export function isGoogleNativeMime(mimeType: string | undefined): boolean {
  return Boolean(mimeType?.startsWith(GOOGLE_APPS_PREFIX));
}

/**
 * Picks the export format for a Google-native MIME type, or undefined when
 * the type cannot be exported (folders, shortcuts, forms, sites, maps). Those
 * are kept as links only.
 * https://developers.google.com/workspace/drive/api/guides/ref-export-formats
 */
export function chooseExportFormat(
  mimeType: string | undefined,
  preference: DriveExportPreference
): ExportFormat | undefined {
  if (!mimeType) {
    return;
  }
  const table = preference === 'pdf' ? PDF_FORMATS : OFFICE_FORMATS;
  return table[mimeType];
}

function orUndefined<T>(value: T | null | undefined): T | undefined {
  return value ?? undefined;
}

function toPerson(
  person: drive_v3.Schema$User | undefined
): { emailAddress?: string; displayName?: string } | undefined {
  if (!person) {
    return;
  }
  return {
    emailAddress: orUndefined(person.emailAddress),
    displayName: orUndefined(person.displayName),
  };
}

function toShortcut(
  details: drive_v3.Schema$File['shortcutDetails']
): DriveFileMetadata['shortcutDetails'] {
  if (!details) {
    return;
  }
  return {
    targetId: orUndefined(details.targetId),
    targetMimeType: orUndefined(details.targetMimeType),
  };
}

function toMetadata(
  file: drive_v3.Schema$File,
  subject: string
): DriveFileMetadata {
  return {
    id: file.id ?? '',
    name: orUndefined(file.name),
    mimeType: orUndefined(file.mimeType),
    size: file.size ? Number(file.size) : undefined,
    md5Checksum: orUndefined(file.md5Checksum),
    createdTime: orUndefined(file.createdTime),
    modifiedTime: orUndefined(file.modifiedTime),
    owners: file.owners
      ?.map(toPerson)
      .filter((p): p is NonNullable<typeof p> => Boolean(p)),
    lastModifyingUser: toPerson(file.lastModifyingUser),
    webViewLink: orUndefined(file.webViewLink),
    webContentLink: orUndefined(file.webContentLink),
    iconLink: orUndefined(file.iconLink),
    trashed: orUndefined(file.trashed),
    shortcutDetails: toShortcut(file.shortcutDetails),
    driveId: orUndefined(file.driveId),
    description: orUndefined(file.description),
    fetchedAt: new Date().toISOString(),
    fetchedBy: subject,
  };
}

async function driveClientAs(subject: string): Promise<drive_v3.Drive> {
  const auth = await getGoogleAuthClient(subject);
  return google.drive({ version: 'v3', auth });
}

export async function getDriveMetadataAs(
  subject: string,
  fileId: string
): Promise<DriveFileMetadata> {
  const drive = await driveClientAs(subject);
  try {
    const res = await withGoogleChatRateLimit(() =>
      drive.files.get({
        fileId,
        fields: DRIVE_METADATA_FIELDS,
        supportsAllDrives: true,
      })
    );
    return toMetadata(res.data, subject);
  } catch (error) {
    throw annotateError(error, subject, `drive.files.get(${fileId})`);
  }
}

export interface DriveDownloadResult extends DownloadResult {
  md5Verified?: boolean;
  exportedAs?: ExportFormat;
}

async function exportNativeFile(
  drive: drive_v3.Drive,
  subject: string,
  metadata: DriveFileMetadata,
  destPathWithoutExt: string,
  format: ExportFormat
): Promise<DriveDownloadResult & { path: string }> {
  const destPath = `${destPathWithoutExt}${format.extension}`;
  try {
    const res = await withGoogleChatRateLimit(() =>
      drive.files.export(
        { fileId: metadata.id, mimeType: format.mimeType },
        { responseType: 'stream' }
      )
    );
    const result = await streamToFile(res.data, destPath);
    return { ...result, exportedAs: format, path: destPath };
  } catch (error) {
    throw annotateError(error, subject, `drive.files.export(${metadata.id})`);
  }
}

async function downloadBinaryFile(
  drive: drive_v3.Drive,
  subject: string,
  metadata: DriveFileMetadata,
  destPath: string
): Promise<DriveDownloadResult & { path: string }> {
  try {
    const res = await withGoogleChatRateLimit(() =>
      drive.files.get(
        { fileId: metadata.id, alt: 'media', supportsAllDrives: true },
        { responseType: 'stream' }
      )
    );
    const result = await streamToFile(res.data, destPath);
    const md5Verified = metadata.md5Checksum
      ? metadata.md5Checksum === result.md5
      : undefined;
    return { ...result, md5Verified, path: destPath };
  } catch (error) {
    throw annotateError(error, subject, `drive.files.get(${metadata.id})`);
  }
}

/**
 * Downloads the file bytes (binary files) or an export (Google-native files).
 * Binary downloads are checked against Drive's md5Checksum when present.
 * Returns undefined when nothing can be downloaded, e.g. folders.
 */
export async function downloadDriveFileAs(
  subject: string,
  metadata: DriveFileMetadata,
  destPathWithoutExt: string,
  preference: DriveExportPreference
): Promise<(DriveDownloadResult & { path: string }) | undefined> {
  const drive = await driveClientAs(subject);
  if (isGoogleNativeMime(metadata.mimeType)) {
    const format = chooseExportFormat(metadata.mimeType, preference);
    if (!format) {
      return;
    }
    return await exportNativeFile(
      drive,
      subject,
      metadata,
      destPathWithoutExt,
      format
    );
  }
  return await downloadBinaryFile(drive, subject, metadata, destPathWithoutExt);
}

export interface FallbackResult<T> {
  result: T;
  subject: string;
  attempts: string[];
}

/**
 * Tries `fn` with each subject in order, moving on only for access errors
 * (401/403/404). Any other error is thrown immediately. If every subject is
 * denied, the last error is thrown with the attempted subjects listed.
 */
export async function withSubjectFallback<T>(
  subjects: string[],
  fn: (subject: string) => Promise<T>
): Promise<FallbackResult<T>> {
  const attempts: string[] = [];
  let lastError: unknown;
  for (const subject of subjects) {
    attempts.push(subject);
    try {
      // biome-ignore lint/nursery/noAwaitInLoop: subjects are tried strictly in order.
      const result = await fn(subject);
      return { result, subject, attempts };
    } catch (error) {
      lastError = error;
      if (!isAccessError(error)) {
        throw error;
      }
    }
  }
  const message =
    lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`${message} (tried as ${attempts.join(', ') || 'nobody'})`);
}
