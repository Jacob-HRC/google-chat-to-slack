# gchat-old- prefix and archive-everything for Spaces

## Request (Jacob, 2026-10-19)

- Every channel migrated from a Google Chat Space gets the Slack prefix
  `gchat-old-<current name>`.
- Every one of those channels is archived after it is imported. The team then
  creates new working channels by hand and assigns their membership.
- DMs are migrated as they are: no prefix, not archived.

Decisions from the follow-up questions:

- Membership of the `gchat-old-` channels stays as it is today: the Space's
  current members (posters only when nobody is left). Archived private
  channels are readable only by their members, and nobody can be added to an
  archived channel without unarchiving it, so importing them empty would hide
  the history.
- The prefix covers every channel that came from a Space, not only named ones.
- `gchat-old-` replaces the `archive-` prefix the runbook gave Vault Spaces.
  The channel purpose still says the history came from Vault.

## What counts as a Space and what counts as a DM

| Google conversation | Slack result | Prefix + archive? |
|---|---|---|
| Named Space (Chat API) | channel or private channel | yes |
| Named Space (Vault) | channel or private channel | yes |
| Meet chat, `--meeting-chats fold`, 2-9 people | folded into their DM / group DM | no (DM) |
| Meet chat, fold, 1 or 10+ people | `mtg-<series>` private channel | yes |
| Meet chat, `--meeting-chats channels` | one channel per meeting (named Space path) | yes |
| DM, 2 people | DM | no |
| Group chat, 3-9 people | group DM (mpim) | no |
| Group chat, 10+ people | `group-…` private channel | no (it is a DM in Google) |
| DM or group chat with one identifiable person | `archive-dm-…` private channel | no (it is a DM in Google) |
| `chat-import-members` | import machinery, not migrated content | no |

## Design

Two new `build-slack-archive` options, both off by default so existing
behaviour and tests are unchanged:

- `--space-prefix <prefix>` puts the prefix in front of every channel made
  from a Space (named Spaces, Vault Spaces, `mtg-` series). It combines with
  `--vault-prefix` as `<space-prefix><vault-prefix><name>`.
  - The name is normalised first and the prefix added after, so a Space whose
    name normalises to nothing (e.g. non-Latin) becomes
    `gchat-old-space-<id>` instead of a bare `gchat-old`.
  - The result is still cut to Slack's 80 characters, and `-2` suffixes still
    resolve collisions, including with existing Slack channels.
  - The prefix is checked at the CLI: lowercase letters, digits, `-` and `_`,
    starting with a letter or digit, ending in `-` or `_` (so `gchat-old`
    can't run into the name), at most 40 characters.
- `--archive-all-spaces` marks every channel made from a Space
  `archiveAfterImport` in the manifest, whatever the visibility list's
  `archive` column says. DM-derived channels are never marked. The ZIP still
  says `is_archived: false` (the importer skips archived channels), and
  `archive-channels` does the archiving after the import as before.

Nothing downstream needs changing. verify-slack, upload-files,
restore-reactions and archive-channels all read names from the sidecars of
the archive they are given, so a prefixed build stays consistent with itself.

## Tasks

1. [x] `ids.ts`: `prefixedChannelName(prefix, displayName, fallback)`.
2. [x] `conversations.ts`: `spacePrefix` and `archiveAllSpaces` options; use
   them in `planNamedSpace`.
3. [x] `builder.ts`: pass the options through; prefix and archive `mtg-`
   series channels.
4. [x] `build-slack-archive.ts`: the two flags, prefix validation, options
   recorded in the manifest.
5. [x] Tests for naming, scope (DMs, mpims, `group-`, `archive-dm-` and the
   members channel untouched), the 80-character cut, the non-Latin fallback,
   and archiving.
6. [x] Docs: runbook build command, README mapping, ARCHITECTURE,
   dm-migration decisions.
7. [x] Dry run against the real store on the T3 server: count the prefixed
   and archived channels and confirm no validation errors.

## Progress notes

### 2026-10-19

- `ids.ts`: `prefixedChannelName(prefix, name, fallback)` normalises the name
  first, then normalises prefix + name, so the fallback still applies and the
  80-character cut keeps the prefix. `--vault-prefix` now goes through it too;
  the only behaviour change without the new flags is that a Vault Space whose
  name normalises to nothing becomes `archive-space-<id>` instead of `archive`.
- `conversations.ts`: `spacePrefix` and `archiveAllSpaces` in
  `ConversationOptions`, used only by `planNamedSpace`. `planOrphanConversation`
  (`archive-dm-`), `planLargeGroup` (`group-`), DMs and mpims never read them.
- `builder.ts`: options passed through; `seriesHome` prefixes `mtg-` channels
  and sets `archived`. Folded meeting chats land in DMs/mpims and are untouched.
  Known gap, older than this change: a non-Latin series name normalises to
  `mtg`, so it never reaches the `mtg-<spaceId>` fallback.
- Manifest records `options.spacePrefix` and `options.archiveAllSpaces`. The
  report prints `Archive after import: N · public · private`. With
  `--archive-all-spaces` the visibility log says the archive column is ignored.
- `build-slack-archive.ts`: `--space-prefix`, `--archive-all-spaces`,
  `checkSpacePrefix` (exported for tests).
- Stale "archive=yes" / "quiet channels" wording fixed in archive-channels help,
  channel-archiver, slack-connect, slack-export types and the app manifest.
- Tests: `space-prefix.test.ts` (naming, scope, Vault, 80 chars, fallback,
  members unchanged, existing-name collision, prefix validation) and two
  meeting-chat tests (fold series, channels mode).
- Docs: runbook build command (no `--vault-prefix`), step 4, step 7
  (reaction-restore deadline, private-channel leftovers, members channel),
  deltas and kept pilots; README, ARCHITECTURE, dm-migration decisions.

Dry run on the T3 server against the real store (2026-10-19, same flags as the
runbook): validation clean; 360 channels, 289 prefixed and marked for
archiving (277 Spaces incl. 96 Vault, 12 `mtg-`), 109 public and 180 private;
71 unprefixed and never archived (41 `archive-dm-`, 29 `group-`, the members
channel). Longest name 61 characters. Three `-2` names (`gchat-old-simulcast-2`,
`gchat-old-dept-it-2`, `gchat-old-dept-it-internal-chat-2`) come from two
Google Spaces sharing a name, as before. Of the 180 private channels, 128
include Jacob or Ken, 145 someone already active in Slack, 35 only deactivated
members.

Review round 2 (2026-10-19): restore-reactions now reports reactions and
line edits refused with `is_archived` as "archived" instead of failures, so
reruns after step 7 don't exit 1 on the 289 archived channels forever. Runbook
delta note corrected: a public Space delta builds as `gchat-old-<name>-2`
because the roster lists archived public channels as taken. Round 4: a private
Space delta reuses `gchat-old-<name>` (the bot's roster can't see private
channels it isn't in), so it needs a hand check; the runbook says so.

Review round 3: `chat.update` reports an archived channel as `is_inactive`
("cannot be edited within a frozen, archived or deleted channel"), not
`is_archived` (which is reactions.add's code). Both now go through
`isArchivedChannelError`. Known, left as is: `restore-reactions --dry-run`
still counts reactions in archived channels as `would-add`; the real run
reports them as `archived`.
