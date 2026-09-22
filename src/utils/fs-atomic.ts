import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

// Path separators, Windows-reserved punctuation, and control characters.
const UNSAFE_FILENAME_REGEX = /[<>:"/\\|?*]|\p{Cc}/gu;
const MULTI_SPACE_REGEX = /\s+/g;
const MAX_FILENAME_LENGTH = 150;

/** Writes JSON to a temp file in the same directory, then renames over the target. */
export async function writeJsonAtomic(
  filePath: string,
  data: unknown
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
  await rename(tmpPath, filePath);
}

/**
 * Reads and parses JSON. Missing files yield `undefined`. A file that exists
 * but does not parse is copied aside as `<name>.corrupt-<timestamp>` before
 * the error propagates, so a later write cannot silently destroy it.
 */
export async function readJsonFile<T>(
  filePath: string
): Promise<T | undefined> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw error;
  }
  try {
    return JSON.parse(content) as T;
  } catch (error) {
    const backup = `${filePath}.corrupt-${Date.now()}`;
    await copyFile(filePath, backup);
    throw new Error(
      `Could not parse ${filePath}; a copy was saved to ${backup}. ${(error as Error).message}`
    );
  }
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function fileSize(filePath: string): Promise<number | undefined> {
  try {
    return (await stat(filePath)).size;
  } catch {
    return;
  }
}

export interface FileDigest {
  sha256: string;
  md5: string;
  size: number;
}

export async function digestFile(filePath: string): Promise<FileDigest> {
  const sha256 = createHash('sha256');
  const md5 = createHash('md5');
  let size = 0;
  await new Promise<void>((resolve, reject) => {
    createReadStream(filePath)
      .on('data', (chunk: Buffer | string) => {
        const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        sha256.update(buffer);
        md5.update(buffer);
        size += buffer.length;
      })
      .on('end', resolve)
      .on('error', reject);
  });
  return { sha256: sha256.digest('hex'), md5: md5.digest('hex'), size };
}

/** Makes a name safe for the local filesystem without losing readability. */
export function safeFilename(
  name: string | undefined,
  fallback: string
): string {
  const cleaned = (name ?? '')
    .replace(UNSAFE_FILENAME_REGEX, '_')
    .replace(MULTI_SPACE_REGEX, ' ')
    .trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') {
    return fallback;
  }
  if (cleaned.length <= MAX_FILENAME_LENGTH) {
    return cleaned;
  }
  const ext = path.extname(cleaned);
  const base = cleaned.slice(0, MAX_FILENAME_LENGTH - ext.length);
  return `${base}${ext}`;
}
