/**
 * Streams every entry of a ZIP to disk. Vault nests its archives (a ZIP
 * holding `<name>_0.mbox.zip` holding the mbox), and the inner files run to
 * gigabytes, so entries are streamed rather than buffered, and each is
 * written to `.part` and renamed only when complete. An entry already on
 * disk is skipped, so an interrupted run can simply be repeated.
 */
import { createWriteStream } from 'node:fs';
import { access, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Resolves `name` inside `dir`, refusing entries that would escape it. */
export function safeEntryPath(dir: string, name: string): string {
  const target = path.resolve(dir, name);
  const root = path.resolve(dir);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error(`ZIP entry escapes the target directory: ${name}`);
  }
  return target;
}

/** Extracts `zipPath` into `destDir`; returns the paths of the files written or found. */
export async function extractZip(
  zipPath: string,
  destDir: string
): Promise<string[]> {
  const zip = await yauzl.openPromise(zipPath, { autoClose: false });
  const written: string[] = [];
  try {
    for await (const entry of zip.eachEntry()) {
      if (entry.fileName.endsWith('/')) {
        continue;
      }
      const target = safeEntryPath(destDir, entry.fileName);
      written.push(target);
      if (await exists(target)) {
        continue;
      }
      await mkdir(path.dirname(target), { recursive: true });
      const partial = `${target}.part`;
      const stream = await zip.openReadStreamPromise(entry);
      await pipeline(stream, createWriteStream(partial));
      await rename(partial, target);
    }
  } finally {
    zip.close();
  }
  return written;
}

/** Extracts a ZIP and any ZIPs inside it, until only plain files remain. */
export async function extractNested(
  zipPath: string,
  destDir: string
): Promise<string[]> {
  const files: string[] = [];
  for (const file of await extractZip(zipPath, destDir)) {
    if (file.endsWith('.zip')) {
      // biome-ignore lint/nursery/noAwaitInLoop: nested archives are extracted one at a time to bound disk use.
      files.push(...(await extractNested(file, destDir)));
    } else {
      files.push(file);
    }
  }
  return files;
}
