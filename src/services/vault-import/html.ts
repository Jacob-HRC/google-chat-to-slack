/**
 * Reads Vault's rendered conversation HTML back into messages.
 *
 * Vault does not export structured data for Chat. Each document is a page of
 * HTML in which every message is shaped like this:
 *
 * ```html
 * <div data-id="MESSAGE_ID">
 *   <div>                                    <!-- wrapper -->
 *     <div><span>sender@example.com </span>September 28, 2022 at 1:01:10 PM UTC</div>
 *     <div>the message text</div>
 *     <div><div>attached-file.png</div></div> <!-- or a link preview -->
 *   </div>
 * </div>
 * ```
 *
 * A threaded message carries an extra leading `N Replies` marker, which is the
 * only trace of threading Vault keeps: the reply count survives, but not which
 * messages the replies were. Reactions, edits, deletions and sub-second
 * timestamps do not survive at all.
 */

const MESSAGE_BLOCK =
  /<div\s+data-id="([^"]+)"[^>]*>([\s\S]*?)(?=<div\s+data-id="|$)/g;
const DIV_TAG = /<div\b[^>]*>|<\/div>/g;
const SENDER_SPAN = /<span[^>]*>([^<]*)<\/span>/;
const ANCHOR = /<a\s[^>]*href=/i;
const TAG = /<[^>]+>/g;
const BR = /<br\s*\/?>/gi;
/** e.g. `September 28, 2022 at 1:01:10 PM UTC`, with a narrow no-break space. */
const TIMESTAMP =
  /([A-Z][a-z]+)\s+(\d{1,2}),\s*(\d{4})\s+at\s+(\d{1,2}):(\d{2}):(\d{2})\s* ?\s*(AM|PM)/;
/** Chat renders app-relayed posts as `* Via User(Name) *`. */
const VIA_USER = /^\*?\s*Via User\(([^)]*)\)\s*\*?\s*/;
/** Threaded messages carry a leading `2 Replies` marker before the header. */
const REPLY_COUNT = /^(\d+)\s+Repl(?:y|ies)$/i;
const NBSP = / /g;
const NUMERIC_ENTITY = /&#(\d+);/g;
const HEX_ENTITY = /&#x([0-9a-fA-F]+);/g;
const NAMED_ENTITY = /&(amp|lt|gt|quot|apos|#39|nbsp);/g;

const MONTHS: Record<string, number> = {
  January: 1,
  February: 2,
  March: 3,
  April: 4,
  May: 5,
  June: 6,
  July: 7,
  August: 8,
  September: 9,
  October: 10,
  November: 11,
  December: 12,
};

export interface VaultMessage {
  /** Chat message id, from `data-id`. */
  messageId: string;
  senderEmail?: string;
  /** RFC 3339, second precision; Vault does not render finer than that. */
  createTime?: string;
  text: string;
  /**
   * Text rendered in trailing blocks. Some are attachment filenames, which are
   * matched to MIME parts later; the rest are quoted or preview text and are
   * folded back into the message so nothing is dropped.
   */
  attachmentNames: string[];
  /**
   * Replies this message received, when Vault rendered a `N Replies` marker.
   * Which messages those replies are is not recoverable from the render.
   */
  replyCount?: number;
  /** Display name when the message was relayed by an app on someone's behalf. */
  viaUser?: string;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  '#39': "'",
  apos: "'",
  nbsp: ' ',
};

export function decodeEntities(input: string): string {
  return input
    .replace(NAMED_ENTITY, (_, name: string) => ENTITIES[name])
    .replace(NUMERIC_ENTITY, (_, code: string) =>
      String.fromCodePoint(Number(code))
    )
    .replace(HEX_ENTITY, (_, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16))
    );
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(BR, '\n').replace(TAG, '')).trim();
}

/**
 * Immediate child divs of `inner`, tracking nesting so a wrapper is not
 * mistaken for its contents.
 */
export function topLevelDivs(inner: string): string[] {
  const results: string[] = [];
  DIV_TAG.lastIndex = 0;
  let depth = 0;
  let start = -1;
  let match = DIV_TAG.exec(inner);
  while (match) {
    if (match[0] === '</div>') {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        results.push(inner.slice(start, match.index));
        start = -1;
      }
    } else {
      if (depth === 0) {
        start = match.index + match[0].length;
      }
      depth += 1;
    }
    match = DIV_TAG.exec(inner);
  }
  return results;
}

/**
 * `September 28, 2022 at 1:01:10 PM UTC` → `2022-09-28T13:01:10.000000Z`.
 * Vault renders in UTC; the trailing marker is sometimes dropped.
 */
export function parseVaultTimestamp(input: string): string | undefined {
  const match = TIMESTAMP.exec(input.replace(NBSP, ' '));
  if (!match) {
    return;
  }
  const [, monthName, day, year, hour12, minute, second, meridiem] = match;
  const month = MONTHS[monthName];
  if (!month) {
    return;
  }
  let hour = Number(hour12) % 12;
  if (meridiem === 'PM') {
    hour += 12;
  }
  const pad = (value: number | string): string =>
    String(value).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}.000000Z`;
}

function parseBlock(messageId: string, blockInner: string): VaultMessage {
  // The block opens with a wrapper div holding the header, text and trailers.
  // Threaded messages insert a `N Replies` marker ahead of the header, so the
  // header is located by looking for the child that carries a timestamp.
  const wrappers = topLevelDivs(blockInner);
  const children = topLevelDivs(wrappers[0] ?? blockInner);
  const headerIndex = Math.max(
    0,
    children.findIndex(
      (child) => parseVaultTimestamp(stripTags(child)) !== undefined
    )
  );

  let replyCount: number | undefined;
  for (const marker of children.slice(0, headerIndex)) {
    const match = REPLY_COUNT.exec(stripTags(marker));
    if (match) {
      replyCount = Number(match[1]);
    }
  }

  const headerHtml = children[headerIndex] ?? '';
  const senderMatch = SENDER_SPAN.exec(headerHtml);
  const senderEmail = stripTags(senderMatch?.[1] ?? '').trim() || undefined;
  const createTime = parseVaultTimestamp(stripTags(headerHtml));

  let text = stripTags(children[headerIndex + 1] ?? '');
  const attachmentNames: string[] = [];
  for (const trailer of children.slice(headerIndex + 2)) {
    // Link preview cards repeat a URL already present in the text.
    if (ANCHOR.test(trailer)) {
      continue;
    }
    const name = stripTags(trailer);
    if (name) {
      attachmentNames.push(name);
    }
  }

  let viaUser: string | undefined;
  const via = VIA_USER.exec(text);
  if (via) {
    viaUser = via[1].trim();
    text = text.replace(VIA_USER, '').trim();
  }

  return {
    messageId,
    senderEmail,
    createTime,
    text,
    attachmentNames,
    replyCount,
    viaUser,
  };
}

/** Every message rendered in one Vault document, in document order. */
export function parseVaultHtml(html: string): VaultMessage[] {
  const messages: VaultMessage[] = [];
  MESSAGE_BLOCK.lastIndex = 0;
  let match = MESSAGE_BLOCK.exec(html);
  while (match) {
    messages.push(parseBlock(match[1], match[2]));
    match = MESSAGE_BLOCK.exec(html);
  }
  return messages;
}

/**
 * Matches attachment filenames rendered in the HTML to the MIME parts.
 * A name may repeat across messages, so each part is claimed at most once,
 * in document order.
 */
export function assignAttachments(
  messages: readonly Pick<VaultMessage, 'messageId' | 'attachmentNames'>[],
  partNames: readonly string[]
): Map<string, number[]> {
  const claimed = new Set<number>();
  const byMessage = new Map<string, number[]>();
  for (const message of messages) {
    for (const name of message.attachmentNames) {
      const index = partNames.findIndex(
        (partName, i) => partName === name && !claimed.has(i)
      );
      if (index >= 0) {
        claimed.add(index);
        const list = byMessage.get(message.messageId) ?? [];
        list.push(index);
        byMessage.set(message.messageId, list);
      }
    }
  }
  return byMessage;
}
