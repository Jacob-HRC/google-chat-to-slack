/**
 * Reads the XML sidecar Vault ships next to a Chat export. It carries the
 * facts the rendered HTML leaves out: which space a document belongs to, the
 * space's name and type, and the participant emails.
 */

const DOCUMENT_BLOCK = /<Document\b[\s\S]*?<\/Document>/g;
const TAG_ENTRY =
  /<Tag\s+TagName='([^']*)'\s+TagDataType='[^']*'\s+TagValue='([^']*)'\s*\/>/g;
const EXTERNAL_FILE = /<ExternalFile\s+FileName='([^']*)'/;

export interface VaultDocumentMetadata {
  /** `FileName` of the native file, which matches the mbox `Message-ID`. */
  fileName?: string;
  roomId?: string;
  roomName?: string;
  conversationType?: string;
  participants: string[];
  dateFirstMessage?: string;
  dateLastMessage?: string;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function decode(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|apos);/g, (_, name) => ENTITIES[name]);
}

function parseDocument(block: string): VaultDocumentMetadata {
  const tags: Record<string, string> = {};
  TAG_ENTRY.lastIndex = 0;
  let match = TAG_ENTRY.exec(block);
  while (match) {
    tags[match[1]] = decode(match[2]);
    match = TAG_ENTRY.exec(block);
  }
  const file = EXTERNAL_FILE.exec(block);
  return {
    fileName: file ? decode(file[1]) : undefined,
    roomId: tags.RoomID,
    roomName: tags.RoomName,
    conversationType: tags.ConversationType,
    participants: (tags.Participants ?? '')
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
    dateFirstMessage: tags['#DateFirstMessageSent'],
    dateLastMessage: tags['#DateLastMessageSent'],
  };
}

/** Parses the sidecar, keyed by the native file name (the mbox Message-ID). */
export function parseVaultMetadata(
  xml: string
): Map<string, VaultDocumentMetadata> {
  const byFileName = new Map<string, VaultDocumentMetadata>();
  DOCUMENT_BLOCK.lastIndex = 0;
  let match = DOCUMENT_BLOCK.exec(xml);
  while (match) {
    const document = parseDocument(match[0]);
    if (document.fileName) {
      byFileName.set(document.fileName, document);
    }
    match = DOCUMENT_BLOCK.exec(xml);
  }
  return byFileName;
}

/** Space-level facts, merged across every document of that space. */
export interface VaultSpaceInfo {
  roomId: string;
  roomName: string;
  conversationType: string;
  participants: Set<string>;
}

export function summarizeSpaces(
  documents: Iterable<VaultDocumentMetadata>
): Map<string, VaultSpaceInfo> {
  const spaces = new Map<string, VaultSpaceInfo>();
  for (const document of documents) {
    if (!document.roomId) {
      continue;
    }
    const existing = spaces.get(document.roomId) ?? {
      roomId: document.roomId,
      roomName: document.roomName ?? '',
      conversationType: document.conversationType ?? 'Room',
      participants: new Set<string>(),
    };
    if (!existing.roomName && document.roomName) {
      existing.roomName = document.roomName;
    }
    for (const participant of document.participants) {
      existing.participants.add(participant);
    }
    spaces.set(document.roomId, existing);
  }
  return spaces;
}
