/**
 * What an earlier import already brought into Slack, so a supplemental
 * import brings only the rest.
 *
 * The record is the directory frozen after that import: its
 * `import-record.json` (with the store's last run when the ZIP was built),
 * its `*archive-manifest.json`, and optionally `lost-messages.json`, the
 * messages Slack dropped (`[{ conversationName, ts }]`, by verify-slack and
 * hand analysis).
 *
 * Every message that run had stored went into the ZIP, so the supplement
 * takes messages first stored after it (`firstSeenRun`), plus the lost ones.
 * That holds whatever a conversation is called now: a private channel's
 * supplement gets a new name, and meeting chats fold into other
 * conversations.
 *
 * In Slack (test 6, 2026-11-04): a public channel with the same name merges
 * when it isn't archived; a private one never merges. So a public channel
 * keeps the name it was imported under, and a private one gets a new name
 * next to the old one.
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type {
  ArchiveConversationMapping,
  ArchiveManifest,
  ConversationPlan,
} from '../../types/slack-export';
import { readJsonFile } from '../../utils/fs-atomic';
import { uniqueName } from './ids';

export interface ImportedRecord {
  /** The store's last export run when the imported ZIP was built. */
  storeLastRun: string;
  /** Conversations the import created, by Space id, as its manifest has them. */
  conversations: Record<string, ArchiveConversationMapping>;
  /** Chat user ids of everyone the import brought in. */
  users: Set<string>;
  /** `slackTs` of messages stored before the build that Slack dropped. */
  reinclude: Set<string>;
}

/** Appended to a private channel's name for its supplement. */
export const SUPPLEMENT_SUFFIX = '-2';
/** Slack's longest channel name. */
const MAX_CHANNEL_NAME = 80;
const MANIFEST_SUFFIX = 'archive-manifest.json';

interface RecordFile {
  storeLastRun?: string | { runId?: string };
}

/**
 * Every channel name the import created. A supplement reserves them all:
 * the bot can't see private channels, so the member roster doesn't list
 * them, and no new conversation may take one. Pure.
 */
export function importedChannelNames(record: ImportedRecord): string[] {
  return Object.values(record.conversations)
    .filter(
      (c) =>
        (c.kind === 'channel' || c.kind === 'group') &&
        !c.skippedReason &&
        !c.mergedInto
    )
    .map((c) => c.name);
}

/** Reads a frozen import record directory. */
export async function loadImportedRecord(dir: string): Promise<ImportedRecord> {
  const record = await readJsonFile<RecordFile>(
    path.join(dir, 'import-record.json')
  );
  const lastRun =
    typeof record?.storeLastRun === 'string'
      ? record.storeLastRun
      : record?.storeLastRun?.runId;
  if (!lastRun) {
    throw new Error(`${dir}/import-record.json has no storeLastRun`);
  }
  const manifests = (await readdir(dir)).filter((f) =>
    f.endsWith(MANIFEST_SUFFIX)
  );
  if (manifests.length !== 1) {
    throw new Error(
      `${dir} must hold exactly one *${MANIFEST_SUFFIX}; found ${manifests.length}`
    );
  }
  const manifest = await readJsonFile<ArchiveManifest>(
    path.join(dir, manifests[0])
  );
  if (!manifest) {
    throw new Error(`${dir}/${manifests[0]} could not be read`);
  }
  const lost =
    (await readJsonFile<Array<{ ts: string }>>(
      path.join(dir, 'lost-messages.json')
    )) ?? [];
  return {
    storeLastRun: lastRun,
    conversations: manifest.conversations,
    users: new Set(Object.keys(manifest.users)),
    reinclude: new Set(lost.map((m) => m.ts)),
  };
}

/**
 * Renames a supplement's channel after the one the import created, in
 * place. A public channel takes the same name, to merge; a private one
 * gets `<name>-2` (or the next free name). DMs and group DMs are matched
 * by their people, and conversations the import didn't create are left as
 * planned. Pure apart from reserving the name in `usedNames`.
 */
export function nameForSupplement(
  plan: ConversationPlan,
  record: ImportedRecord,
  usedNames: Set<string>
): void {
  const imported = record.conversations[plan.spaceId];
  const isChannel = plan.kind === 'channel' || plan.kind === 'group';
  if (
    !(isChannel && imported) ||
    imported.skippedReason ||
    imported.mergedInto ||
    !(imported.kind === 'channel' || imported.kind === 'group')
  ) {
    return;
  }
  // The name planning reserved for this channel is replaced, so free it.
  usedNames.delete(plan.name);
  if (plan.kind === 'channel' && imported.kind === 'channel') {
    plan.name = imported.name;
    plan.mergeInto = true;
    usedNames.add(imported.name);
    return;
  }
  const base = imported.name.slice(
    0,
    MAX_CHANNEL_NAME - SUPPLEMENT_SUFFIX.length
  );
  plan.name = uniqueName(`${base}${SUPPLEMENT_SUFFIX}`, usedNames);
}
