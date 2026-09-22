/**
 * Minimal MIME reader for Google Vault Chat export documents.
 *
 * Vault emits a narrow, stable shape: `multipart/mixed` with one
 * `text/html` part carrying the rendered conversation and one part per
 * attachment, base64 encoded. A focused reader keeps this dependency-free and
 * lets the tests run against real exported bytes.
 */

export interface MimePart {
  headers: Record<string, string>;
  contentType: string;
  filename?: string;
  encoding: string;
  body: Buffer;
}

export interface MimeDocument {
  headers: Record<string, string>;
  /** `Message-ID` without angle brackets, e.g. `AAAAxyz-MBI-FLAT:2022-09-…`. */
  messageId?: string;
  html?: string;
  attachments: MimePart[];
}

const HEADER_LINE = /^([\w-]+):\s*(.*)$/;
const CONTINUATION = /^[ \t]+/;
const FILENAME_PARAM =
  /(?:filename|name)\s*=\s*"([^"]*)"|(?:filename|name)\s*=\s*([^;\s]+)/i;
const BOUNDARY_PARAM = /boundary\s*=\s*(?:"([^"]*)"|([^;\s]+))/i;
const CHARSET_PARAM = /charset\s*=\s*(?:"([^"]*)"|([^;\s]+))/i;
const SOFT_BREAK = /=\r?\n/g;
const QP_HEX = /=([0-9A-Fa-f]{2})/g;
const LINE_SPLIT = /\r?\n/;
const LEADING_NEWLINE = /^\r?\n/;
const WHITESPACE = /\s+/g;
const ANGLE_BRACKETS = /^<|>$/g;

/**
 * Reads the header block without splitting the whole document.
 *
 * Attachment parts run to hundreds of megabytes, so slicing the entire string
 * into lines just to read a few headers is what exhausted the heap before.
 */
function splitHeaders(raw: string): {
  headers: Record<string, string>;
  bodyStart: number;
} {
  let end = raw.indexOf('\n\n');
  let separatorLength = 2;
  const crlfEnd = raw.indexOf('\r\n\r\n');
  if (crlfEnd >= 0 && (end < 0 || crlfEnd < end)) {
    end = crlfEnd;
    separatorLength = 4;
  }
  const headerText = end >= 0 ? raw.slice(0, end) : raw;
  const bodyStart = end >= 0 ? end + separatorLength : raw.length;

  const headers: Record<string, string> = {};
  let current: string | null = null;
  for (const line of headerText.split(LINE_SPLIT)) {
    if (CONTINUATION.test(line) && current) {
      headers[current] += ` ${line.trim()}`;
      continue;
    }
    const match = HEADER_LINE.exec(line);
    if (match) {
      current = match[1].toLowerCase();
      headers[current] = match[2].trim();
    }
  }
  return { headers, bodyStart };
}

/**
 * Decodes quoted-printable. Hex escapes become raw bytes via a latin1 buffer,
 * which is then read back in the declared charset.
 */
export function decodeQuotedPrintable(
  input: string,
  charset = 'utf-8'
): string {
  const unfolded = input.replace(SOFT_BREAK, '');
  const withBytes = unfolded.replace(QP_HEX, (_, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16))
  );
  const buffer = Buffer.from(withBytes, 'latin1');
  const encoding: BufferEncoding = charset.toLowerCase().includes('utf')
    ? 'utf-8'
    : 'latin1';
  return buffer.toString(encoding);
}

function decodeBody(body: string, encoding: string, charset: string): Buffer {
  const normalized = encoding.toLowerCase();
  if (normalized === 'base64') {
    return Buffer.from(body.replace(WHITESPACE, ''), 'base64');
  }
  if (normalized === 'quoted-printable') {
    return Buffer.from(decodeQuotedPrintable(body, charset), 'utf-8');
  }
  return Buffer.from(body, 'utf-8');
}

function paramOf(
  value: string | undefined,
  pattern: RegExp
): string | undefined {
  if (!value) {
    return;
  }
  const match = pattern.exec(value);
  if (!match) {
    return;
  }
  return match[1] ?? match[2];
}

function parsePart(raw: string): MimePart {
  const { headers, bodyStart } = splitHeaders(raw);
  const contentType = (headers['content-type'] ?? 'text/plain')
    .split(';')[0]
    .trim();
  const encoding = headers['content-transfer-encoding'] ?? '7bit';
  const charset = paramOf(headers['content-type'], CHARSET_PARAM) ?? 'utf-8';
  const filename =
    paramOf(headers['content-disposition'], FILENAME_PARAM) ??
    paramOf(headers['content-type'], FILENAME_PARAM);
  return {
    headers,
    contentType,
    filename,
    encoding,
    body: decodeBody(raw.slice(bodyStart), encoding, charset),
  };
}

/** Splits a multipart body on its boundary, dropping the preamble and epilogue. */
export function splitOnBoundary(body: string, boundary: string): string[] {
  const marker = `--${boundary}`;
  return body
    .split(marker)
    .slice(1)
    .filter((segment) => !segment.startsWith('--'))
    .map((segment) => segment.replace(LEADING_NEWLINE, ''));
}

/** Files the part as the document body or as an attachment. */
function collectPart(part: MimePart, document: MimeDocument): void {
  if (part.contentType === 'text/html' && !document.html) {
    document.html = part.body.toString('utf-8');
    return;
  }
  if (part.filename) {
    document.attachments.push(part);
  }
}

/** Parses one Vault export document into its HTML body and attachments. */
export function parseMimeDocument(raw: string): MimeDocument {
  const { headers, bodyStart } = splitHeaders(raw);
  const messageId = headers['message-id']?.replace(ANGLE_BRACKETS, '');
  const boundary = paramOf(headers['content-type'], BOUNDARY_PARAM);
  const document: MimeDocument = { headers, messageId, attachments: [] };

  if (!boundary) {
    collectPart(parsePart(raw), document);
    return document;
  }

  for (const segment of splitOnBoundary(raw.slice(bodyStart), boundary)) {
    const part = parsePart(segment);
    const nested = paramOf(part.headers['content-type'], BOUNDARY_PARAM);
    if (nested) {
      // multipart/related wrappers appear occasionally around inline images.
      for (const inner of splitOnBoundary(segment, nested)) {
        collectPart(parsePart(inner), document);
      }
      continue;
    }
    collectPart(part, document);
  }
  return document;
}
