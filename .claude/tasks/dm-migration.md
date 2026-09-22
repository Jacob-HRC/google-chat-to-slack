# HighRidge Church: full-workspace Google Chat → Slack migration

Goal: migrate every user's Spaces, group DMs and DMs into a fresh Slack
workspace with real authorship and timestamps, using Slack's export-ZIP import.

Fork: https://github.com/Jacob-HRC/google-chat-to-slack (upstream markusjura).

## Status

- [x] Setup: fork, clone, upstream remote, tests green, ARCHITECTURE.md.
- [x] Phase 1: service-account auth (DWD), Directory user enumeration, user/OU filter, scope docs. Live verification blocked until delegation is granted.
- [x] Phase 2: `export-workspace` additive store with dedupe, memberships, deleted/edited history, per-user reactions, attachments + Drive links/metadata, placeholders, dry run, delta, resume; `verify --export`. Live run blocked on delegation.
- [x] Phase 3: `build-slack-archive` writes the Slack import ZIP from the store; two file strategies; delta archives; tested on a fixture store and on pilot data. Import behaviour with real Slack still to be proven in Phase 5.
- [ ] Phase 4: import runbook + `verify` command.
- [ ] Phase 5: pilot with 2-3 users and one Space.

## Setup notes

- Test suite failed at import because `src/config/index.ts` called
  `process.exit(1)` when OAuth env vars were missing. Config is now optional at
  load time; `requireGoogleOAuthConfig()` enforces it where the OAuth flow
  needs it. All 23 tests pass.
- Lint (`biome check`) and `tsc --noEmit` are clean at baseline.
- The husky pre-commit hook runs `pnpm check` (format + typecheck).

## Phase 1 plan

1. `src/services/google-auth.ts`: pick auth mode (OAuth refresh token vs
   service-account JWT with `subject`), cache one client per subject, expose
   `getGoogleAuthClient(subject?)`.
2. Refactor `google-chat.ts` to use it; OAuth path unchanged.
3. `src/services/directory.ts`: `listDomainUsers()` via `users.list`
   (`customer=my_customer`, paginated), plus pure `selectUsers()` filter by
   email list / OU.
4. Config + CLI: `GOOGLE_SERVICE_ACCOUNT_KEY_FILE` / `GOOGLE_SERVICE_ACCOUNT_KEY`,
   `GOOGLE_ADMIN_SUBJECT`, `GOOGLE_EXPORT_USERS`, `GOOGLE_EXPORT_ORG_UNIT`;
   `login google --service-account <file> --subject <email>` stores in keyring;
   new `users` command lists the resolved user set to verify delegation.
5. README + ARCHITECTURE: exact DWD scopes and Admin console steps.
6. Tests for `selectUsers()` and auth-mode resolution.

## Phase 2 notes

- New commands: `export-workspace`, `verify`. Legacy `export`/`transform`/`import` untouched.
- Store layout and merge rules are documented in ARCHITECTURE.md ("Workspace export store").
- Scopes now also include `chat.admin.spaces.readonly` and `chat.admin.memberships.readonly` (admin sweep). Jacob must grant the full list before the pilot.
- Drive metadata/download calls share the Google Chat token bucket; add a Drive bucket if quota errors appear in the pilot.
- Phase 3 should read this store, not export.json. Fields ready for Slack: `slackTs`, `threadName`/`threadReply`, `reactions[].user`, `attachmentKeys` → index records with `localPath` and Drive links, `users.json` for users.json/placeholders, `space.memberships` for dms/mpims membership.

## Pilot findings (2026-09-22, Jacob's account only)

- Delegation verified live: Directory as jacob@hrc.email (admin), Chat as the same user. All seven scopes granted. Key lives in 1Password (T3 vault, "Google to Slack Service Account", file attachment) and is stored in the OS keyring on the T3 box; a 0600 copy sits at ~/.config/googletoslack/service-account.json.
- Dry run over Jacob alone: 463 conversations (75 named Spaces, 295 group chats, 93 DMs), 42,136 messages, 115 people referenced, 51 without a directory record. Domain has 82 active users.
- Admin sweep fails with "Google Chat app not found": `spaces.search` with admin access needs a Chat app configured on the Chat API page of the Cloud project. Not blocking; the sweep only finds named Spaces nobody selected can read. Ask Jacob to configure a minimal Chat app (any name, no endpoint) when convenient.
- Membership counts match Google's `membershipCount`; the many single-member named Spaces are old project rooms where Jacob is the last member. Deleted accounts drop out of membership lists, so DM names now also use senders.
- Four conversations exported for real (two Spaces with files, one group chat, one DM): 206 messages, 61 files hash-verified (uploads and a Docs export), per-user reactions captured, delta re-run is a no-op. Two Drive attachments reference a file Google says no longer exists; they stay `failed` and `verify` keeps reporting them.
- `--refresh-users` only refreshes people referenced by the spaces in that run.

## Constraint added 2026-09-22: Slack workspace already has members

Jacob: "we have some users in slack already so we can't do anything that will
overwrite them." Phase 3/4 must treat the Slack workspace as populated:
- The ZIP writer emits users.json for mapping only; import must merge to
  existing members by email, never create duplicates or touch profiles.
- Phase 4 runbook must use the import's per-user mapping step and document
  which option is safe; verify must confirm no existing member changed
  (snapshot users.list before and after).
- Dry-run of the Slack import: generate a mapping report (imported user →
  existing member / new deactivated placeholder / skipped) before uploading.

## Phase 3 plan: Slack export-ZIP writer (`build-slack-archive`)

Reads the workspace store; never touches Google. Pure transforms in
`src/services/slack-archive/*`, tested on a fixture store.

Research (official docs, 2026-09-22):
- Export layout: channels.json, groups.json (private), dms.json, mpims.json,
  users.json, one `<conversation>/<YYYY-MM-DD>.json` per day.
- Exports carry file *links* only. Importer imports files only when sharer and
  conversation are both imported (Slack-to-Slack). Google Drive/Box app files
  "will not be imported". DMs import only when every participant is imported;
  "Import as deactivated" counts as imported. Cannot merge into existing
  private channels; only public ones. Pinned messages import with channels.
  Custom emoji must exist in the destination first.

Design decisions:
- IDs deterministic from Google ids (hash → Slack-shaped id) so repeated
  builds and delta archives agree.
- users.json: every referenced person. Existing Slack members are matched by
  email at import time (their row carries email + name only, no profile extras
  that could merge over an existing profile). Deleted/external/bot people:
  `deleted: true` placeholders. `--user-overrides` JSON lets Jacob name a
  placeholder (id → {name, email}).
- Conversations: SPACE → private channel (default; `--space-visibility public`)
  ; DIRECT_MESSAGE with 2 known people → dm; GROUP_CHAT 2 people → dm, 3-9 →
  mpim, >9 → private channel; DM/group with only one known person → private
  channel `archive-dm-<name>` (Slack DMs need two members); bot DMs skipped by
  default.
- Messages: ts = stored slackTs, made unique per conversation by +1µs on
  collision. Threads from Google thread name: parent = first message of the
  thread, replies get thread_ts/parent_user_id, parent gets reply_count,
  reply_users, replies, latest_reply. Edits → `edited`. Deleted → policy
  `--deleted tombstone|content|omit` (default tombstone). Reactions → per-user
  `reactions[]` with node-emoji short names; custom emoji by name (reported).
  Quoted messages rendered as `> quote` prefix. Mentions `<users/id>` →
  `<@U…>`; unknown → plain @Name.
- Text: Google formattedText markup is near-identical to mrkdwn (*_~`); escape
  & < > outside tokens; `<url|text>` kept.
- Files, two strategies, pilot decides: `--files hosted --files-base-url URL`
  writes `files[]` with url_private pointing at a static host of
  attachments/files (Slack fetches on import if it works); `--files manifest`
  (default) omits files from messages and writes `files-to-upload.json`
  (conversation, ts, thread_ts, local path, title) for a Phase 4 uploader that
  posts them via files.uploadV2 into the imported thread. Drive link-only
  records become `<webViewLink|name>` text; downloaded Drive copies get both.
- Delta archives: `--first-seen-after <runId>` / `--messages-since <ISO>`
  include only new messages, because a second import cannot edit or delete.
- Output: ZIP (yazl) plus `--unpacked <dir>`, and `archive-manifest.json`
  mapping Google ids → Slack ids/names/files for Phase 4 verify.
- `--dry-run` prints the same report without writing.

## Google Vault path (2026-09-22)

Reason: 96 named Spaces have zero members left, so the Chat API cannot reach
them. Vault's ROOM search takes space ids directly.

Done:
- `src/services/vault.ts` + `vault <probe|export|status|matters>` command.
- `getScopedAuthClient()` in google-auth.ts gives Vault its own JWT scope set,
  so an unauthorized Vault scope cannot break Chat/Drive auth.
- Live-verified as jacob@hrc.email: the ediscovery scope works, matters list
  returns 3 pre-existing matters (Test, HVAC Research, Heather Offboarding —
  do not touch).

Findings:
- `matters.count` rejects Chat: "Corpus type HANGOUTS_CHAT is not supported."
  Matches the schema (no hangoutsChatCountResult). Export is the only probe.
- A single-space MBOX export was accepted and ran IN_PROGRESS. Matter for
  migration probing: 94616089-048b-4a83-814e-c01538fe2fec ("Chat migration
  probe"), space AAAAA6HZ1qY (dept-it-internal-chat).

Open:
- Wait for that export to reach COMPLETED and inspect the MBOX/XML/CSV shape.
- Downloading from Cloud Storage needs the devstorage.read_only scope, not yet
  requested. The Vault console download works without it.
- No MBOX parser exists. Deciding whether to write one depends on whether the
  96 spaces hold anything worth migrating, which the first export will show.
