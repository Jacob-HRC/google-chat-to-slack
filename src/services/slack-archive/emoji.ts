/**
 * Unicode emoji → Slack short name. Slack's names come from iamcal's
 * emoji-data (published as emoji-datasource), which differs from GitHub's
 * names in places: 🧐 is `face_with_monocle` in Slack, not `monocle`, and 🤣
 * is `rolling_on_the_floor_laughing`, not `rofl`. A wrong name renders as
 * literal text and cannot be added as a reaction.
 */

interface EmojiEntry {
  unified: string;
  non_qualified: string | null;
  short_name: string;
  skin_variations?: Record<string, unknown>;
}

// Plain JSON; loaded once. (The project is CommonJS without resolveJsonModule.)
const emojiData: EmojiEntry[] = require('emoji-datasource/emoji.json');

const SHORT_NAME_REGEX = /^[\w+'-]+(?:::skin-tone-\d)?$/;
const VARIATION_SELECTOR = 'FE0F';
const SKIN_TONES = ['1F3FB', '1F3FC', '1F3FD', '1F3FE', '1F3FF'];
/** Slack numbers skin tones 2–6; 1 is the default yellow. */
const FIRST_SKIN_TONE_NUMBER = 2;

function codepoints(unicode: string): string[] {
  return [...unicode]
    .map((char) => (char.codePointAt(0) ?? 0).toString(16).toUpperCase())
    .map((hex) => hex.padStart(4, '0'));
}

function withoutSelectors(points: string[]): string {
  return points.filter((p) => p !== VARIATION_SELECTOR).join('-');
}

const byCodepoints = ((): Map<string, EmojiEntry> => {
  const map = new Map<string, EmojiEntry>();
  for (const entry of emojiData) {
    map.set(withoutSelectors(entry.unified.split('-')), entry);
  }
  return map;
})();

/** Slack's short name for a Unicode emoji, with `::skin-tone-N` when it has one. */
export function slackEmojiName(unicode: string): string | undefined {
  const points = codepoints(unicode);
  const exact = byCodepoints.get(withoutSelectors(points));
  if (exact) {
    return exact.short_name;
  }
  const tones = points.filter((p) => SKIN_TONES.includes(p));
  const base = byCodepoints.get(
    withoutSelectors(points.filter((p) => !SKIN_TONES.includes(p)))
  );
  if (!base) {
    return;
  }
  const [tone] = tones;
  if (tone === undefined) {
    return base.short_name;
  }
  // Slack names one tone per emoji. Mixed tones (👨🏻‍❤️‍👨🏿) have no faithful
  // name, so the caller keeps the original character instead.
  const single = tones.every((t) => t === tone);
  return single && base.skin_variations
    ? `${base.short_name}::skin-tone-${SKIN_TONES.indexOf(tone) + FIRST_SKIN_TONE_NUMBER}`
    : undefined;
}

/**
 * How a reaction shows in message text: `:name:` for a Slack short name, or
 * the character itself for an emoji too new for Slack's list.
 */
export function reactionEmoji(name: string): string {
  return SHORT_NAME_REGEX.test(name) ? `:${name}:` : name;
}
