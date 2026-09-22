/**
 * Serialises an archive model to a Slack-import ZIP and, optionally, an
 * unpacked directory for inspection. Also prints the build report.
 */
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { ZipFile } from 'yazl';
import type { ArchiveModel } from '../../types/slack-export';
import { kindLabel } from './messages';

export interface ArchiveEntry {
  path: string;
  content: string;
}

export interface WriteArchiveOptions {
  zipPath?: string;
  unpackedDir?: string;
}

export interface WriteArchiveResult {
  zipPath?: string;
  unpackedDir?: string;
  entries: number;
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** Every file in the archive, in a stable order. Pure. */
export function archiveEntries(model: ArchiveModel): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [
    { path: 'users.json', content: json(model.users) },
    { path: 'channels.json', content: json(model.channels) },
    { path: 'groups.json', content: json(model.groups) },
    { path: 'dms.json', content: json(model.dms) },
    { path: 'mpims.json', content: json(model.mpims) },
    { path: 'integration_logs.json', content: json([]) },
  ];
  const sorted = [...model.conversations].sort((a, b) =>
    a.plan.name.localeCompare(b.plan.name)
  );
  for (const conversation of sorted) {
    const days = Object.keys(conversation.days).sort();
    for (const day of days) {
      entries.push({
        path: `${conversation.plan.name}/${day}.json`,
        content: json(conversation.days[day]),
      });
    }
  }
  entries.push({
    path: 'archive-manifest.json',
    content: json(model.manifest),
  });
  if (model.manifest.files.strategy === 'manifest') {
    entries.push({
      path: 'files-to-upload.json',
      content: json(model.uploads),
    });
  }
  return entries;
}

async function writeZip(
  entries: ArchiveEntry[],
  zipPath: string
): Promise<void> {
  await mkdir(path.dirname(zipPath), { recursive: true });
  const zip = new ZipFile();
  for (const entry of entries) {
    zip.addBuffer(Buffer.from(entry.content, 'utf-8'), entry.path, {
      mtime: new Date(),
      mode: 0o644,
    });
  }
  zip.end();
  await pipeline(zip.outputStream, createWriteStream(zipPath));
}

async function writeUnpacked(
  entries: ArchiveEntry[],
  dir: string
): Promise<void> {
  for (const entry of entries) {
    const target = path.join(dir, entry.path);
    // biome-ignore lint/nursery/noAwaitInLoop: sequential writes keep directory creation simple.
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, entry.content, 'utf-8');
  }
}

export async function writeArchive(
  model: ArchiveModel,
  options: WriteArchiveOptions
): Promise<WriteArchiveResult> {
  const entries = archiveEntries(model);
  if (options.zipPath) {
    await writeZip(entries, options.zipPath);
  }
  if (options.unpackedDir) {
    await writeUnpacked(entries, options.unpackedDir);
  }
  return {
    zipPath: options.zipPath,
    unpackedDir: options.unpackedDir,
    entries: entries.length,
  };
}

export function printArchiveReport(model: ArchiveModel, dryRun: boolean): void {
  const m = model.manifest;
  const t = m.totals;
  console.log(`\n📦 ${dryRun ? '[Dry run] ' : ''}Slack archive`);
  console.log(
    `   People: ${t.users} (${t.placeholders} deactivated placeholders for former staff, bots or external users)`
  );
  console.log(
    `   Conversations: ${t.channels} public channels · ${t.groups} private channels · ${t.dms} DMs · ${t.mpims} group DMs · ${t.skippedConversations} skipped`
  );
  console.log(
    `   Messages: ${t.messages} written · ${t.omittedMessages} omitted (deleted policy "${m.options.deletedPolicy}" or delta cut-off)`
  );
  const f = m.files;
  const fileLine =
    f.strategy === 'hosted'
      ? `${f.hosted} referenced from ${m.options.filesBaseUrl ?? '(no base URL)'}`
      : `${f.uploads} queued in files-to-upload.json for the post-import uploader`;
  console.log(
    `   Files: ${fileLine} · ${f.linkOnly} Drive links kept as links · ${f.unavailable} unavailable`
  );

  const kinds = new Map<string, number>();
  for (const c of model.conversations) {
    kinds.set(c.plan.kind, (kinds.get(c.plan.kind) ?? 0) + 1);
  }
  const largest = [...model.conversations]
    .sort((a, b) => b.messageCount - a.messageCount)
    .slice(0, 8);
  if (largest.length > 0) {
    console.log('   Largest conversations:');
    for (const c of largest) {
      console.log(
        `     ${c.plan.name.padEnd(40)} ${kindLabel(c.plan.kind).padEnd(16)} ${String(c.messageCount).padStart(6)} msgs · ${c.plan.members.length} members`
      );
    }
  }
  const skipped = Object.values(m.conversations).filter((c) => c.skippedReason);
  if (skipped.length > 0) {
    console.log(
      `   Skipped: ${skipped.length} conversation(s), e.g. ${skipped[0].skippedReason}`
    );
  }
  if (m.warnings.length > 0) {
    console.log(
      `   ⚠️  ${m.warnings.length} warning(s); first: ${m.warnings[0]}`
    );
  }
}
