import type { chat_v1 } from 'googleapis';
import type { ExtractedLink, LinkKind } from '../types/export-store';

// A URL ends at whitespace or at the characters Google Chat uses to wrap
// links in formattedText (`<url|label>`), plus closing brackets.
const URL_TAIL = '[^\\s<>|)\\]]*';
const GOOGLE_DOC_LINK_REGEX = new RegExp(
  `https?://docs\\.google\\.com/(document|spreadsheets|presentation|forms|drawings)/d/([a-zA-Z0-9_-]+)${URL_TAIL}`,
  'g'
);
const DRIVE_FILE_LINK_REGEX = new RegExp(
  `https?://drive\\.google\\.com/(?:file/d/|open\\?id=|uc\\?id=|drive/(?:u/\\d+/)?folders/)([a-zA-Z0-9_-]+)${URL_TAIL}`,
  'g'
);
const DRIVE_FOLDER_HINT_REGEX = /\/folders\//;
const CHAT_SPACE_LINK_REGEX = new RegExp(
  `https?://(?:chat\\.google\\.com/room/|mail\\.google\\.com/chat/u/\\d+/#chat/space/)([a-zA-Z0-9_-]+)${URL_TAIL}`,
  'g'
);
const MEET_LINK_REGEX = new RegExp(
  `https?://meet\\.google\\.com/${URL_TAIL}`,
  'g'
);
const CALENDAR_LINK_REGEX = new RegExp(
  `https?://calendar\\.google\\.com/${URL_TAIL}`,
  'g'
);

const DOC_KIND_BY_PATH: Record<string, LinkKind> = {
  document: 'docs',
  spreadsheets: 'sheets',
  presentation: 'slides',
  forms: 'forms',
  drawings: 'drawings',
};

const DOC_KIND_BY_MIME: Record<string, LinkKind> = {
  'application/vnd.google-apps.document': 'docs',
  'application/vnd.google-apps.spreadsheet': 'sheets',
  'application/vnd.google-apps.presentation': 'slides',
  'application/vnd.google-apps.form': 'forms',
  'application/vnd.google-apps.drawing': 'drawings',
  'application/vnd.google-apps.folder': 'drive-folder',
};

function collect(
  text: string,
  regex: RegExp,
  build: (match: RegExpExecArray) => ExtractedLink
): ExtractedLink[] {
  const links: ExtractedLink[] = [];
  regex.lastIndex = 0;
  let match = regex.exec(text);
  while (match) {
    links.push(build(match));
    match = regex.exec(text);
  }
  return links;
}

export function extractLinksFromText(
  text: string | undefined
): ExtractedLink[] {
  if (!text) {
    return [];
  }
  return [
    ...collect(text, GOOGLE_DOC_LINK_REGEX, (m) => ({
      url: m[0],
      kind: DOC_KIND_BY_PATH[m[1]] ?? 'drive',
      driveFileId: m[2],
      source: 'text',
    })),
    ...collect(text, DRIVE_FILE_LINK_REGEX, (m) => ({
      url: m[0],
      kind: DRIVE_FOLDER_HINT_REGEX.test(m[0]) ? 'drive-folder' : 'drive',
      driveFileId: m[1],
      source: 'text',
    })),
    ...collect(text, CHAT_SPACE_LINK_REGEX, (m) => ({
      url: m[0],
      kind: 'chat-space',
      spaceName: `spaces/${m[1]}`,
      source: 'text',
    })),
    ...collect(text, MEET_LINK_REGEX, (m) => ({
      url: m[0],
      kind: 'meet',
      source: 'text',
    })),
    ...collect(text, CALENDAR_LINK_REGEX, (m) => ({
      url: m[0],
      kind: 'calendar',
      source: 'text',
    })),
  ];
}

function annotationLink(meta: chat_v1.Schema$RichLinkMetadata): ExtractedLink {
  const url = meta.uri ?? undefined;
  const drive = meta.driveLinkData;
  if (meta.richLinkType === 'DRIVE_FILE' && drive?.driveDataRef?.driveFileId) {
    return {
      url,
      kind: DOC_KIND_BY_MIME[drive.mimeType ?? ''] ?? 'drive',
      driveFileId: drive.driveDataRef.driveFileId,
      driveMimeType: drive.mimeType ?? undefined,
      source: 'annotation',
    };
  }
  if (meta.richLinkType === 'CHAT_SPACE') {
    return {
      url,
      kind: 'chat-space',
      spaceName: meta.chatSpaceLinkData?.space ?? undefined,
      source: 'annotation',
    };
  }
  const kindByType: Record<string, LinkKind> = {
    MEET_SPACE: 'meet',
    CALENDAR_EVENT: 'calendar',
    GMAIL_MESSAGE: 'gmail',
  };
  return {
    url,
    kind: kindByType[meta.richLinkType ?? ''] ?? 'other',
    source: 'annotation',
  };
}

export function extractLinksFromAnnotations(
  annotations: chat_v1.Schema$Annotation[] | undefined
): ExtractedLink[] {
  const links: ExtractedLink[] = [];
  for (const annotation of annotations ?? []) {
    if (annotation.type === 'RICH_LINK' && annotation.richLinkMetadata) {
      links.push(annotationLink(annotation.richLinkMetadata));
    }
  }
  return links;
}

/**
 * All Google links in a message, annotation-derived first (they carry MIME
 * types), deduplicated by Drive file id or URL.
 */
export function extractLinks(message: chat_v1.Schema$Message): ExtractedLink[] {
  const seen = new Set<string>();
  const result: ExtractedLink[] = [];
  const candidates = [
    ...extractLinksFromAnnotations(message.annotations),
    ...extractLinksFromText(message.text ?? undefined),
  ];
  for (const link of candidates) {
    const key = link.driveFileId ?? link.spaceName ?? link.url;
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(link);
  }
  return result;
}
