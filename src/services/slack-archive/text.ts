/**
 * Google Chat text → Slack mrkdwn. Google's `formattedText` already uses
 * `*bold*`, `_italic_`, `~strike~`, `` `code` ``, ```` ```block``` ````,
 * `<url|label>` links and `<users/id>` mentions, which is nearly Slack's own
 * syntax. What remains: mentions become `<@U…>`, bare `&`, `<`, `>` outside
 * tokens are escaped, and list bullets become `•`.
 */
import type { StoredMessage, StoredReaction } from '../../types/export-store';
import { slackEmojiName } from './emoji';

const SCHEME_REGEX = /^https?:\/\//;
const TOKEN_REGEX = /<[^<>]*>/g;
const USER_TOKEN_REGEX = /^<users\/([^>|]+)(?:\|[^>]*)?>$/;
const LINK_TOKEN_REGEX = /^<(https?:\/\/[^|>\s]+)(?:\|([^>]*))?>$/;
const BULLET_LINE_REGEX = /^(\s*)[*-] (?=\S)/gm;
const COLON_REGEX = /^:|:$/g;

export interface TextContext {
  /** Slack user id for a Google `users/<id>`; undefined when unmapped. */
  slackIdFor: (chatUserId: string) => string | undefined;
  /** Human-readable name for a Google `users/<id>`. */
  nameFor: (chatUserId: string) => string;
}

export function escapeSlackText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function convertToken(token: string, ctx: TextContext): string {
  const user = USER_TOKEN_REGEX.exec(token);
  if (user) {
    const chatUserId = `users/${user[1]}`;
    const slackId = ctx.slackIdFor(chatUserId);
    return slackId ? `<@${slackId}>` : `@${ctx.nameFor(chatUserId)}`;
  }
  const link = LINK_TOKEN_REGEX.exec(token);
  if (link) {
    const label = link[2];
    return label ? `<${link[1]}|${escapeSlackText(label)}>` : `<${link[1]}>`;
  }
  return escapeSlackText(token);
}

/** Converts Google formatted text (with `<…>` tokens) to Slack mrkdwn. */
export function convertFormattedText(
  formatted: string,
  ctx: TextContext
): string {
  let result = '';
  let last = 0;
  TOKEN_REGEX.lastIndex = 0;
  let match = TOKEN_REGEX.exec(formatted);
  while (match) {
    result += escapeSlackText(formatted.slice(last, match.index));
    result += convertToken(match[0], ctx);
    last = match.index + match[0].length;
    match = TOKEN_REGEX.exec(formatted);
  }
  result += escapeSlackText(formatted.slice(last));
  return result.replace(BULLET_LINE_REGEX, '$1• ');
}

/** Body text for a message, with an optional quoted message prefixed. */
export function messageText(
  message: StoredMessage,
  ctx: TextContext,
  quotedText?: string
): string {
  const source = message.formattedText ?? message.text;
  const body = message.formattedText
    ? convertFormattedText(source, ctx)
    : escapeSlackText(source);
  if (!quotedText) {
    return body;
  }
  const quote = quotedText
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  return body ? `${quote}\n${body}` : quote;
}

interface RichLinkAnnotation {
  type?: string | null;
  richLinkMetadata?: {
    uri?: string | null;
    richLinkType?: string | null;
  } | null;
}

/**
 * Text for a message whose body is empty, so Slack never receives an empty
 * message (it silently drops those). A shared Google Meet link arrives as a
 * link card with no text at all; that is the common case.
 */
export function fallbackText(message: StoredMessage): string {
  const annotations = (message.raw.annotations ?? []) as RichLinkAnnotation[];
  const lines: string[] = [];
  for (const annotation of annotations) {
    const uri = annotation.richLinkMetadata?.uri;
    if (annotation.type !== 'RICH_LINK' || !uri) {
      continue;
    }
    const label = uri.replace(SCHEME_REGEX, '').split('?')[0];
    lines.push(
      annotation.richLinkMetadata?.richLinkType === 'MEET_SPACE'
        ? `📹 Google Meet: <${uri}|${label}>`
        : `🔗 <${uri}|${label}>`
    );
  }
  return lines.length > 0
    ? lines.join('\n')
    : '_(This Google Chat message had no text or file that could be carried over.)_';
}

/** Slack reaction short name for a stored reaction, or undefined if unknown. */
export function reactionShortName(
  reaction: StoredReaction
): string | undefined {
  if (reaction.emoji.customEmoji?.emojiName) {
    const name = reaction.emoji.customEmoji.emojiName.replace(COLON_REGEX, '');
    return name || undefined;
  }
  const unicode = reaction.emoji.unicode;
  if (!unicode) {
    return;
  }
  // Unknown to Slack (newer Unicode): keep the character, never drop it.
  return slackEmojiName(unicode) ?? unicode;
}
