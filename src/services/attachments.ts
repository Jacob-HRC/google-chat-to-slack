/**
 * Attachment indexing and download. Records are keyed by
 * `<spaceId>/<messageId>/<kind>-<index>` and live in attachments/index.json.
 * Files go to attachments/files/<spaceId>/<messageId>/<name>.
 */
import path from 'node:path';
import type {
  AttachmentRecord,
  DriveFileMetadata,
  StoredMessage,
} from '../types/export-store';
import { digestFile, fileExists, safeFilename } from '../utils/fs-atomic';
import type { Logger } from '../utils/logger';
import {
  downloadChatMediaAs,
  downloadPublicUrl,
  isAccessError,
} from './chat-reader';
import {
  type DriveExportPreference,
  downloadDriveFileAs,
  getDriveMetadataAs,
  isGoogleNativeMime,
  withSubjectFallback,
} from './drive';

export type DriveLinkPolicy = 'metadata' | 'download';

export interface AttachmentBuildOptions {
  driveLinks: DriveLinkPolicy;
}

const MAX_ATTEMPTS = 3;
const SAVE_EVERY = 10;

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'image/svg+xml': '.svg',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
  'text/csv': '.csv',
  'application/zip': '.zip',
  'application/json': '.json',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.ms-powerpoint': '.ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation':
    '.pptx',
};

export function attachmentKey(
  spaceId: string,
  messageId: string,
  kind: string,
  index: number
): string {
  return `${spaceId}/${messageId}/${kind}-${index}`;
}

/** Builds pending records for everything attached to or linked from a message. */
export function buildAttachmentRecords(
  message: StoredMessage,
  options: AttachmentBuildOptions
): AttachmentRecord[] {
  const records: AttachmentRecord[] = [];
  const base = {
    spaceId: message.spaceId,
    messageName: message.name,
    senderId: message.senderId,
    status: 'pending' as const,
    attempts: 0,
  };

  (message.raw.attachment ?? []).forEach((attachment, index) => {
    const isDrive =
      attachment.source === 'DRIVE_FILE' ||
      Boolean(attachment.driveDataRef?.driveFileId);
    records.push({
      ...base,
      key: attachmentKey(
        message.spaceId,
        message.messageId,
        isDrive ? 'drive' : 'upload',
        index
      ),
      kind: isDrive ? 'DRIVE_FILE' : 'UPLOADED_CONTENT',
      index,
      contentName: attachment.contentName ?? undefined,
      contentType: attachment.contentType ?? undefined,
      downloadUri: attachment.downloadUri ?? undefined,
      thumbnailUri: attachment.thumbnailUri ?? undefined,
      resourceName: attachment.attachmentDataRef?.resourceName ?? undefined,
      driveFileId: attachment.driveDataRef?.driveFileId ?? undefined,
      policy: 'download',
      raw: attachment,
    });
  });

  (message.raw.attachedGifs ?? []).forEach((gif, index) => {
    if (!gif.uri) {
      return;
    }
    records.push({
      ...base,
      key: attachmentKey(message.spaceId, message.messageId, 'gif', index),
      kind: 'ATTACHED_GIF',
      index,
      contentType: 'image/gif',
      downloadUri: gif.uri,
      policy: 'download',
      raw: gif,
    });
  });

  const seenDriveIds = new Set(
    records.map((r) => r.driveFileId).filter((id): id is string => Boolean(id))
  );
  let linkIndex = 0;
  for (const link of message.links) {
    if (!link.driveFileId || seenDriveIds.has(link.driveFileId)) {
      continue;
    }
    seenDriveIds.add(link.driveFileId);
    records.push({
      ...base,
      key: attachmentKey(message.spaceId, message.messageId, 'link', linkIndex),
      kind: 'DRIVE_LINK',
      index: linkIndex,
      downloadUri: link.url,
      driveFileId: link.driveFileId,
      contentType: link.driveMimeType,
      policy: options.driveLinks,
      raw: link,
    });
    linkIndex += 1;
  }

  return records;
}

function extensionFor(record: AttachmentRecord): string {
  const fromName = path.extname(record.drive?.name ?? record.contentName ?? '');
  if (fromName) {
    return fromName;
  }
  const mime = record.drive?.mimeType ?? record.contentType;
  return (mime && EXTENSION_BY_MIME[mime]) ?? '';
}

/** Local file name for a record: original name when known, else a stable id. */
export function attachmentFileName(record: AttachmentRecord): string {
  const original = record.drive?.name ?? record.contentName;
  const fallback = `${record.kind.toLowerCase()}-${record.index}`;
  const base = safeFilename(original, fallback);
  const ext = extensionFor(record);
  if (ext && !base.toLowerCase().endsWith(ext.toLowerCase())) {
    return `${base}${ext}`;
  }
  return base;
}

export interface AttachmentSyncContext {
  filesDir: string;
  readerSubject: string;
  /** Active users, by chat id, who could be impersonated to read Drive files. */
  subjectForUser: (chatUserId: string | undefined) => string | undefined;
  memberSubjects: string[];
  driveExportFormat: DriveExportPreference;
  logger: Logger;
  onProgress?: (record: AttachmentRecord) => void;
  save: () => Promise<void>;
}

export interface AttachmentSyncStats {
  total: number;
  downloaded: number;
  linkOnly: number;
  skipped: number;
  failed: number;
  bytes: number;
}

function candidateSubjects(
  record: AttachmentRecord,
  ctx: AttachmentSyncContext
): string[] {
  const sender = ctx.subjectForUser(record.senderId);
  const ordered = [ctx.readerSubject, sender, ...ctx.memberSubjects].filter(
    (s): s is string => Boolean(s)
  );
  return Array.from(new Set(ordered));
}

function targetDir(
  record: AttachmentRecord,
  ctx: AttachmentSyncContext
): string {
  const messageId = record.messageName.split('/messages/')[1] ?? 'unknown';
  return path.join(
    ctx.filesDir,
    record.spaceId,
    safeFilename(messageId, 'msg')
  );
}

async function alreadyOnDisk(record: AttachmentRecord): Promise<boolean> {
  if (!(record.localPath && record.sha256)) {
    return false;
  }
  if (!(await fileExists(record.localPath))) {
    return false;
  }
  const digest = await digestFile(record.localPath);
  return digest.sha256 === record.sha256;
}

async function syncUpload(
  record: AttachmentRecord,
  ctx: AttachmentSyncContext
): Promise<AttachmentRecord> {
  if (!record.resourceName) {
    return {
      ...record,
      status: 'failed',
      error: 'No attachmentDataRef.resourceName on uploaded content',
    };
  }
  const fileName = attachmentFileName(record);
  const destPath = path.join(targetDir(record, ctx), fileName);
  const resourceName = record.resourceName;
  const { result, subject } = await withSubjectFallback(
    candidateSubjects(record, ctx),
    (s) => downloadChatMediaAs(s, resourceName, destPath)
  );
  return {
    ...record,
    status: 'downloaded',
    fileName,
    localPath: destPath,
    size: result.size,
    sha256: result.sha256,
    md5: result.md5,
    downloadedBy: subject,
    downloadedAt: new Date().toISOString(),
    error: undefined,
  };
}

async function syncGif(
  record: AttachmentRecord,
  ctx: AttachmentSyncContext
): Promise<AttachmentRecord> {
  if (!record.downloadUri) {
    return { ...record, status: 'failed', error: 'GIF has no uri' };
  }
  const fileName = attachmentFileName(record);
  const destPath = path.join(targetDir(record, ctx), fileName);
  const result = await downloadPublicUrl(record.downloadUri, destPath);
  return {
    ...record,
    status: 'downloaded',
    fileName,
    localPath: destPath,
    size: result.size,
    sha256: result.sha256,
    md5: result.md5,
    downloadedBy: 'anonymous',
    downloadedAt: new Date().toISOString(),
    error: undefined,
  };
}

async function fetchDriveMetadata(
  record: AttachmentRecord,
  ctx: AttachmentSyncContext
): Promise<{ metadata: DriveFileMetadata; subject: string }> {
  const fileId = record.driveFileId as string;
  const { result, subject } = await withSubjectFallback(
    candidateSubjects(record, ctx),
    (s) => getDriveMetadataAs(s, fileId)
  );
  return { metadata: result, subject };
}

async function syncDrive(
  record: AttachmentRecord,
  ctx: AttachmentSyncContext
): Promise<AttachmentRecord> {
  if (!record.driveFileId) {
    return { ...record, status: 'failed', error: 'No driveFileId' };
  }
  const { metadata, subject } = await fetchDriveMetadata(record, ctx);
  const withMeta: AttachmentRecord = {
    ...record,
    drive: metadata,
    contentName: record.contentName ?? metadata.name,
    contentType: metadata.mimeType ?? record.contentType,
  };

  const isContainer =
    metadata.mimeType === 'application/vnd.google-apps.folder' ||
    metadata.mimeType === 'application/vnd.google-apps.shortcut';
  if (record.policy === 'metadata' || isContainer) {
    return { ...withMeta, status: 'link-only', error: undefined };
  }

  const fileName = attachmentFileName(withMeta);
  const base = isGoogleNativeMime(metadata.mimeType)
    ? path.join(targetDir(record, ctx), path.parse(fileName).name)
    : path.join(targetDir(record, ctx), fileName);
  const download = await withSubjectFallback(
    [subject, ...candidateSubjects(record, ctx)],
    (s) => downloadDriveFileAs(s, metadata, base, ctx.driveExportFormat)
  );
  if (!download.result) {
    return { ...withMeta, status: 'link-only', error: undefined };
  }
  const result = download.result;
  return {
    ...withMeta,
    status: result.exportedAs ? 'exported' : 'downloaded',
    fileName: path.basename(result.path),
    localPath: result.path,
    size: result.size,
    sha256: result.sha256,
    md5: result.md5,
    md5Verified: result.md5Verified,
    exportedAs: result.exportedAs,
    downloadedBy: download.subject,
    downloadedAt: new Date().toISOString(),
    error: undefined,
  };
}

async function syncOne(
  record: AttachmentRecord,
  ctx: AttachmentSyncContext
): Promise<AttachmentRecord> {
  switch (record.kind) {
    case 'UPLOADED_CONTENT':
      return await syncUpload(record, ctx);
    case 'ATTACHED_GIF':
      return await syncGif(record, ctx);
    default:
      return await syncDrive(record, ctx);
  }
}

function isDone(record: AttachmentRecord): boolean {
  return (
    record.status === 'downloaded' ||
    record.status === 'exported' ||
    record.status === 'link-only' ||
    record.status === 'skipped'
  );
}

/**
 * Downloads every pending record in `index` (for the given keys), retrying
 * failures up to MAX_ATTEMPTS across runs. The index is saved periodically so
 * a crash loses at most a handful of entries.
 */
export async function syncAttachments(
  index: Record<string, AttachmentRecord>,
  keys: string[],
  ctx: AttachmentSyncContext
): Promise<AttachmentSyncStats> {
  const stats: AttachmentSyncStats = {
    total: keys.length,
    downloaded: 0,
    linkOnly: 0,
    skipped: 0,
    failed: 0,
    bytes: 0,
  };
  let sinceSave = 0;

  for (const key of keys) {
    const record = index[key];
    if (!record) {
      continue;
    }
    // biome-ignore lint/nursery/noAwaitInLoop: downloads are sequential to respect rate limits.
    const updated = await processRecord(record, ctx, stats);
    index[key] = updated;
    ctx.onProgress?.(updated);
    sinceSave += 1;
    if (sinceSave >= SAVE_EVERY) {
      await ctx.save();
      sinceSave = 0;
    }
  }
  await ctx.save();
  return stats;
}

async function processRecord(
  record: AttachmentRecord,
  ctx: AttachmentSyncContext,
  stats: AttachmentSyncStats
): Promise<AttachmentRecord> {
  if (isDone(record) && (await alreadyOnDisk(record))) {
    stats.skipped += 1;
    return record;
  }
  if (record.status === 'link-only' || record.status === 'skipped') {
    stats.skipped += 1;
    return record;
  }
  if (record.status === 'failed' && record.attempts >= MAX_ATTEMPTS) {
    stats.failed += 1;
    return record;
  }
  try {
    const updated = await syncOne(
      { ...record, attempts: record.attempts + 1 },
      ctx
    );
    if (updated.status === 'link-only') {
      stats.linkOnly += 1;
    } else if (updated.status === 'failed') {
      stats.failed += 1;
      ctx.logger.addError(
        'attachment_download',
        record.key,
        updated.error ?? 'unknown failure'
      );
    } else {
      stats.downloaded += 1;
      stats.bytes += updated.size ?? 0;
    }
    return updated;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stats.failed += 1;
    const level = isAccessError(error) ? 'addWarning' : 'addError';
    ctx.logger[level]('attachment_download', record.key, message);
    return {
      ...record,
      attempts: record.attempts + 1,
      status: 'failed',
      error: message,
    };
  }
}
