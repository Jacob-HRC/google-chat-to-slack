/**
 * Google Chat text → Slack mrkdwn. Google's `formattedText` already uses
 * `*bold*`, `_italic_`, `~strike~`, `` `code` ``, ```` ```block``` ````,
 * `<url|label>` links and `<users/id>` mentions, which is nearly Slack's own
 * syntax. What remains: mentions become `<@U…>`, bare `&`, `<`, `>` outside
 * tokens are escaped, and list bullets become `•`.
 */
import { which as emojiWhich } from 'node-emoji';
import type { StoredMessage, StoredReaction } from '../../types/export-store';

const TOKEN_REGEX = /<[^<>]*>/g;
const USER_TOKEN_REGEX = /^<users\/([^>|]+)(?:\|[^>]*)?>$/;
const LINK_TOKEN_REGEX = /^<(https?:\/\/[^|>\s]+)(?:\|([^>]*))?>$/;
const BULLET_LINE_REGEX = /^(\s*)[*-] (?=\S)/gm;
const VARIATION_SELECTOR_REGEX = /[︎️]/g;
const SKIN_TONE_REGEX = /[\u{1F3FB}-\u{1F3FF}]/gu;
const COLON_REGEX = /^:|:$/g;

// Emoji Slack supports that the lookup library does not know (newer Unicode).
const EXTRA_SHORT_NAMES: Record<string, string> = {
  '🤍': 'white_heart',
  '🤎': 'brown_heart',
  '🧡': 'orange_heart',
  '🩷': 'pink_heart',
  '🩵': 'light_blue_heart',
  '🩶': 'grey_heart',
  '🥲': 'smiling_face_with_tear',
  '🥹': 'face_holding_back_tears',
  '🫶': 'heart_hands',
  '🫡': 'saluting_face',
  '🫠': 'melting_face',
  '🫤': 'face_with_diagonal_mouth',
  '🫣': 'face_with_peeking_eye',
  '🫢': 'face_with_open_eyes_and_hand_over_mouth',
  '🫥': 'dotted_line_face',
  '🫰': 'hand_with_index_finger_and_thumb_crossed',
  '🫵': 'index_pointing_at_the_viewer',
  '🫂': 'people_hugging',
  '🙂‍↕️': 'head_shaking_vertically',
  '🙂‍↔️': 'head_shaking_horizontally',
};

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
  const direct = emojiWhich(unicode) ?? EXTRA_SHORT_NAMES[unicode];
  if (direct) {
    return direct;
  }
  const stripped = unicode
    .replace(VARIATION_SELECTOR_REGEX, '')
    .replace(SKIN_TONE_REGEX, '');
  return emojiWhich(stripped) ?? EXTRA_SHORT_NAMES[stripped];
}
