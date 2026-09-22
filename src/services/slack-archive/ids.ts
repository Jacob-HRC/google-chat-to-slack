/**
 * Deterministic Slack-shaped identifiers derived from Google ids, so that
 * building the archive twice (or building a delta later) yields the same ids
 * and names.
 */
import { createHash } from 'node:crypto';

const ID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ID_LENGTH = 10;
const CHANNEL_NAME_MAX = 80;
const NON_CHANNEL_CHARS_REGEX = /[^a-z0-9_-]+/g;
const MULTI_DASH_REGEX = /-{2,}/g;
const EDGE_DASH_REGEX = /^-+|-+$/g;
const NON_HANDLE_CHARS_REGEX = /[^a-z0-9._-]+/g;

export type IdPrefix = 'U' | 'C' | 'G' | 'D' | 'F' | 'T';

/** `prefix` plus ten characters from a hash of `seed`, e.g. `U7K3M9QX2A`. */
export function slackIdFor(prefix: IdPrefix, seed: string): string {
  const digest = createHash('sha256').update(`${prefix}:${seed}`).digest();
  let out = prefix;
  for (let i = 0; i < ID_LENGTH; i += 1) {
    out += ID_ALPHABET[digest[i] % ID_ALPHABET.length];
  }
  return out;
}

/** Slack channel names: lowercase, digits, hyphen, underscore, max 80 chars. */
export function normalizeChannelName(
  displayName: string,
  fallback: string
): string {
  const normalized = displayName
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(NON_CHANNEL_CHARS_REGEX, '-')
    .replace(MULTI_DASH_REGEX, '-')
    .replace(EDGE_DASH_REGEX, '')
    .slice(0, CHANNEL_NAME_MAX)
    .replace(EDGE_DASH_REGEX, '');
  return normalized || fallback;
}

/** Appends `-2`, `-3`… until the name is unused; registers it in `used`. */
export function uniqueName(name: string, used: Set<string>): string {
  let candidate = name;
  let counter = 2;
  while (used.has(candidate)) {
    const suffix = `-${counter}`;
    candidate = `${name.slice(0, CHANNEL_NAME_MAX - suffix.length)}${suffix}`;
    counter += 1;
  }
  used.add(candidate);
  return candidate;
}

/** Slack's own naming for group DMs: `mpdm-alice--bob--carol-1`. */
export function mpimName(handles: string[]): string {
  const sorted = [...handles].sort((a, b) => a.localeCompare(b));
  return `mpdm-${sorted.join('--')}-1`.slice(0, CHANNEL_NAME_MAX);
}

/** Slack handle: lowercase, digits, `.`, `_`, `-`; 21 characters max. */
export function normalizeHandle(value: string, fallback: string): string {
  const handle = value
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '.')
    .replace(NON_HANDLE_CHARS_REGEX, '')
    .slice(0, 21);
  return handle || fallback;
}
