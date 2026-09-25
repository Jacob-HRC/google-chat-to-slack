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

## Paused 2026-09-22: full export stopped, Vault export running

Full Chat export paused at Jacob's request after 2568 of 7194 conversations
(65 GB, projected ~200 GB total). Stopped by killing the process; writes are
atomic so nothing is partial. Spot-checked 400 store files, all parse;
users.json 115 entries, attachments/index.json 10354 entries.

Resume with (nothing is lost, it continues the same run):

    pnpm start export-workspace --resume

The manifest still records run 20260922T145007Z as "running", which is what
--resume looks for. Spaces already marked complete in that run are skipped.

Vault export of all 96 member-less Spaces started:
- matter 76f80a78-5dcb-4ff7-b68c-1652fe110dcf ("Google Chat to Slack migration")
- one export "chat-orphan-spaces", MBOX, 96 spaces (under the 500 limit)
- detached poller logs status every 5 min to data/vault-exports/poll.log
- earlier single-space probe lives in matter
  94616089-048b-4a83-814e-c01538fe2fec and can be deleted once the big one
  lands.

Blocked on Jacob: add https://www.googleapis.com/auth/devstorage.read_only to
the delegation entry, then `pnpm start vault download --matter 76f80a78-5dcb-4ff7-b68c-1652fe110dcf`.
Until then the export can be downloaded by hand from the Vault console.

## Vault export completed and inspected (2026-09-22)

Matter 76f80a78-5dcb-4ff7-b68c-1652fe110dcf, export "chat-orphan-spaces":
COMPLETED, 2196 documents, 2359.5 MB, downloaded to
data/vault-exports/chat-orphan-spaces/ (devstorage.read_only scope added and
working).

Measured contents: all 96 spaces present, ~9,979 individual messages, 6,651
attachment parts with original filenames. Format is rendered HTML inside an
mbox plus an XML metadata sidecar; see ARCHITECTURE "Vault export format,
measured". No threads, reactions, edits or sub-second timestamps survive.

Decision pending from Jacob: write a Vault parser (HTML + MIME) to fold these
into the store as archival-quality conversations, or leave the export as a
downloadable archive. Roughly 10k messages against 42k+ in Jacob's account
alone, so a small but real slice.

## Import decisions (2026-09-22)

Settled with Jacob, to be used on the real build:

- **Placeholder address domain: `chat-archive.hrc.email`.** Pass
  `--placeholder-email-domain chat-archive.hrc.email` to every real
  `build-slack-archive` run. Slack imports a DM only when every participant is
  imported, and it maps by email, so anyone without an address takes their DMs
  down with them. The domain is a subdomain of one HRC owns, has no mailboxes,
  and must NOT be added to Google Workspace, or Google would try to route the
  mail. It does not need to resolve: Slack's import never checks
  deliverability. The addresses are permanent account identities, so changing
  the domain later means editing each account by hand.
- **Everyone not already in Slack is imported as deactivated.** The migration
  cannot be announced yet. `slack-members` snapshots the workspace and
  `build-slack-archive` emits every unmatched person with `deleted: true`.
- **Reactivation one account at a time in the UI is acceptable**, so SCIM and
  the Slack plan tier no longer need checking.
- **Still to prove:** that "import as deactivated" sends no mail. Test with an
  address Jacob controls, on a throwaway workspace, not HighRidge Church.

## After the export finishes

1. `recover-names --aliases data/vault-exports/aliases.json --apply`. Do not
   run it while the export is running: both write `users.json`, and the
   export's placeholder self-heal can overwrite recovered names.
2. `slack-members` again, in case the Slack roster changed.
3. `build-slack-archive --dry-run --placeholder-email-domain chat-archive.hrc.email`
   and check that the report shows no conversations at risk.

## Moving attachments to an external drive

Jacob is adding an external drive on the morning of 2026-09-23 because the
root filesystem may not hold the rest of the export. Attachments are the whole
cost, 125 GB of the store so far.

Move `attachments/files` to the drive and symlink it back. Two facts make this
safe, both checked against the code on 2026-09-22:

- `streamToFile()` in `src/services/chat-reader.ts` does `mkdir -p` on the
  destination directory and streams straight to the final path. There is no
  temp file and no `rename()`, so there is no cross-device `EXDEV` failure.
- `attachments/index.json` stores `localPath` as an absolute path under
  `data/workspace/attachments/files/`. Symlinking keeps every recorded path
  valid, so nothing in the store has to be rewritten. Moving the store to a
  different path instead would invalidate all of them.

Procedure:

    # 1. Stop the export cleanly. The store is additive and atomic.
    pkill -f export-watch.sh
    pkill -f "googletoslack.ts export-workspace"

    # 2. Move the files (125 GB+, so this takes a while) and symlink back.
    mv data/workspace/attachments/files /mnt/<drive>/gcts-attachment-files
    ln -s /mnt/<drive>/gcts-attachment-files data/workspace/attachments/files

    # 3. Point the watcher's free-space check at the drive, not /home.
    #    /tmp/export-watch.sh currently runs: df --output=avail -BG /home

    # 4. Resume.
    pnpm start export-workspace --resume

A download killed part-way leaves a file with no recorded `sha256`, and
`alreadyOnDisk()` re-downloads it, so an interrupted attachment is not
mistaken for a complete one.

## Phase 4 plan (2026-09-23)

Goal: take a built archive through Slack's importer with nothing lost and
nothing overwritten, and prove it afterwards. Slack's import itself has no
API (non-Grid), so Jacob uploads the ZIP in the admin UI; everything around
that step is tooling.

The hard constraint shaping files: a bot cannot post into a DM between two
other people, and DMs are most of the data. So files have two routes:

1. **Hosted (preferred, true fidelity).** Messages carry `files[]` whose
   `url_private` points at `serve-files`, a small allowlist-only HTTP server
   exposed through a tunnel for the duration of the import. If Slack's
   importer fetches them, files land on the original message, from the
   original sender, at the original time. Undocumented; the Jacob–Ken DM test
   decides. The server logs every fetch, so the test answers the question
   unambiguously.
2. **Uploader (fallback).** `upload-files` posts each file as a thread reply
   to its imported message: the bot in channels, a participant's user token
   in that person's own DMs. Other people's DMs cannot be reached this way.

Tasks:

- [x] Keep `archive-manifest.json` and `files-to-upload.json` out of the ZIP
      (the importer has no reason to see them, and they hold every address);
      write them beside it. Add a `hosted-files.json` sidecar for the server.
- [x] `validate`: structural checks on the model before anything is written
      (every referenced user exists, unique ts, thread parents exist, reply
      counts, DM member counts, channel name rules and collisions, duplicate
      emails). Build refuses to write an archive with errors.
- [x] `slack-members` also snapshots channel names, for collision checks.
- [x] `serve-files`: allowlist server with a request log and progress.
- [x] `upload-files`: resumable, dry-run, ledger of uploaded files.
- [x] `verify-slack`: members before/after diff (no existing member changed,
      every new account deactivated), per-conversation ts comparison for
      every conversation the tokens can read, files present.
- [x] Runbook: `docs/import-runbook.md`.
- [ ] Test archive for the Jacob–Ken DM (2faP7UAAAAE), approved by Jacob.

### Progress notes (2026-09-23)

- Sidecars: `<zip>.archive-manifest.json` plus `<zip>.files-to-upload.json`
  (manifest strategy) or `<zip>.hosted-files.json` (hosted). The unpacked copy
  still carries all of them for inspection.
- `validate.ts` runs on every build; errors block the write, dry runs report.
- Existing Slack channel names (#general, #random today) are seeded into the
  name allocator, so a Space called "general" becomes `general-2` rather than
  merging into the live channel.
- Full-store build fixes, found on the first full-size dry run:
  - The build held every conversation's raw messages at once and ran out of
    heap. It now streams conversations in two passes (who is referenced, then
    build).
  - Thread linking scanned every upload in the archive for each reply
    (quadratic). Now indexed per conversation.
  - The attachment index is 183 MB of JSON (47k records, mostly the raw
    Google object). The build drops `raw` and `thumbnailUri` after loading,
    but parsing still peaks high; run the full build with
    `node --max-old-space-size=6144 -r ts-node/register bin/googletoslack.ts`.
  - Not yet re-measured: Jacob asked to hold full builds until the export
    finishes, because they made the box lag. The last attempt was killed
    (exit 137), probably by the kernel OOM killer while the export was also
    holding ~2 GB.
- Research findings (Slack docs plus third-party reports) are recorded in
  ARCHITECTURE "Research notes: Slack import" once confirmed by the test.
  Headline: Reverse Import exists, so a test in the real workspace can be
  undone; the importer fetches `url_private_download` and stores whatever
  comes back, even an error page.

### Phase 4 built (2026-09-23)

- `serve-files`, `verify-slack`, `upload-files`, `--exclude-space`, user-token
  support (`SLACK_USER_TOKEN` or keyring `slack-user`), user scopes in the
  manifest, `docs/import-runbook.md`.
- Tunnel: Tailscale Funnel is allowed on this node for ports 443, 8443 and
  10000. 443 carries T3 Code (tailnet-only), so file hosting uses 8443.
  itadmin is the Tailscale operator, so no sudo.
- Left: the Jacob–Ken pilot. Build it once the export finishes (Jacob asked
  to keep heavy work off the box until then). It answers the open questions:
  does Slack fetch hosted files, are ts values preserved, what do merged
  members see, and is a re-imported DM de-duplicated.

### Vault deltas (2026-09-23)

`vault delta [--dry-run] [--refresh]` then, once exports complete,
`vault sync`. See ARCHITECTURE "Vault deltas". The ledger
`data/vault-exports/imported.json` was seeded by hand with the original
`chat-orphan-spaces` export (exportly-db5b6df5…), already imported on
2026-09-22 as run vault-20260922T203043Z, so sync does not re-import 3.3 GB.
Today's dry run: all 96 spaces up to date, nothing to export or import.
Run `vault delta` again at cutover: anyone offboarded between now and then
can orphan more spaces.

### Recovery without waiting for the export (2026-09-23)

`recover-names --overlay <file>` writes what recovery changed (name, email,
alias) to its own file instead of users.json, and `build-slack-archive
--users-overlay <file>` lays it over the store for that build. So recovery
no longer waits for the export. Run today:

    recover-names --aliases data/vault-exports/aliases.json \
      --overlay data/vault-exports/users-overlay.json

25 s. People with no address: 44 → 37. Of the 37: 12 deleted former staff
with names (Jonathan Emert, Grace Chumley, Taryn Gilman, Sabrina Shelpuk,
May Coulter, Derek Hinners, Debbie Burgess, Gilbert Cashion, Jonathon
Howard, Dortha Hall, Charlotte Reber, Felecia McCarthy), 9 "unknown"
(Directory cannot see them), 6 external, and the rest unnamed. One is a
second, deleted "Jacob Neudorf" account (users/108503210910403416808).
Next ideas: Admin/Chat audit logs via the Reports API (needs
admin.reports.audit.readonly) map ids to emails for anyone active in the
last ~6 months; a name→address list from Jacob, checked against the
Directory and the Slack roster so a guess can never merge into the wrong
account.

### Addresses from Jacob (2026-09-23)

`data/vault-exports/manual-addresses.json` (git-ignored; `--user-overrides`)
holds 17 addresses Jacob supplied or the data showed, each checked first:
no Google user holds it (grace@ and gracec@ are Google Groups now) and no
Slack member holds it. jonathan@hrc.email was reassigned to Jonathan
Klingenberg, so Jonathan Emert gets jonathan.emert@chat-archive.hrc.email;
using the real one would merge Emert's history into Klingenberg's account.
highridgegr.com (HireGR) is a separate Google organisation. The second
"Jacob Neudorf" (users/108503210910403416808) was a throwaway test account,
named "Jacob Neudorf (test account)" and left on a placeholder address.
No real address: 44 → 21.
Open with Jacob: is gracec@hrc.email (Vault, 75 messages 2022–2024, only in
Vault spaces) Grace Chumley? The remaining "unknown" people (Mateo
Escanuelas, Tessa Boenisch, Candice Kidd, Ellen Fischer, Johanna Moore,
Jordan Farmer) look like more HireGR accounts.

### Audit-log addresses and corrections (2026-09-23)

Jacob added admin.reports.audit.readonly. `find-addresses` found 7 more
(Kortny Pendergrass for a nameless record, plus Mateo Escanuelas, Candice
Kidd, Jordan Farmer, Jennifer & Lauren, William Howard, Kelly Miller) and
independently confirmed the addresses Jacob gave for Kyle, Grace Nguyen and
Tara. Corrections from Jacob: grace@hrc.email was Grace Nguyen's old address
(now gnguyen@highridgegr.com); Grace Chumley was always gracec@hrc.email, so
the Vault gracec@ record is aliased into hers. William Howard's Google guest
account (will.howard@live.com) is aliased into his main record, which keeps
willz06jw@gmail.com. Felecia is not active; she stays deactivated.
No real address: 44 → 14 → 11 (Jacob confirmed johanna@highridgemw.com, efischer@ and tboenisch@highridgegr.com). Left: 8 nameless deleted accounts older than the
logs, Jacob's test account (intentional), Jennifer Mitchell and Nicholas
Negaard (outside), and Ellen Fischer, Tessa Boenisch (highridgegr.com) and
Johanna Moore (highridgemw.com) whose exact addresses are unknown.

### Jacob's import decisions (2026-09-23)

- Meeting chats: fold.
- Named Spaces: public by default, finance and similar private. Implemented
  as a reviewed list: `channel-visibility` → data/slack/channel-visibility.csv
  (277 Spaces; suggested 152 public, 125 private: 37 by name, 88 because only
  one or two members remain). Build with --channel-visibility; unlisted
  Spaces are private. Jacob to review the list.
- Vault-recovered Spaces: --vault-prefix archive-.
- Deleted messages: placeholder ("This message was deleted in Google Chat"), i.e. --deleted tombstone (the default).
- Visibility review Sheet (in Jacob's Drive, 2026-09-23):
  https://docs.google.com/spreadsheets/d/1tOMUH-GFNtuhCBZqA7FlwPAUK7AmHzzciUVGLdXRcP4/edit
  Tab "Channels": Space, Visibility (dropdown), reason, members, messages,
  source, Space ID. When Jacob is done, read it back into
  data/slack/channel-visibility.csv by Space ID.

### Pilot plan (agreed 2026-09-23)

Two conversations, built once the export's second pass finishes:
- 2faP7UAAAAE: Jacob–Ken DM (3,654 messages, ~566 files). Tests hosted
  file fetch, exact ts, threads, and importing into a DM that already has
  messages in Slack (D0AQ3GYK0FM).
- 6n5EcMAAAAE: Jacob ↔ his old throwaway account (14 messages). The
  throwaway (users/108503210910403416808) is overridden to
  "Jacob Neudorf (test account)" <jacob+slacktest@hrc.email> and imported
  deactivated. Jacob watches that inbox: any mail from Slack means
  "import as deactivated" is not silent, and the full import must wait for
  the announcement.
Then: verify-slack with both tokens, and try Reverse Import. If the pilot is
kept, build the full archive with --exclude-space for both.

### Dropped thread replies: found and repaired (2026-09-24)

Google names messages `<thread>.<message>` (starter `abc.abc`, replies
`abc.xyz`). `messageIdentity()` (added with the Vault importer, 2265f4b)
kept only the part before the dot, so the merge treated every reply as a
duplicate of its thread starter and dropped it. Every export pass since then
lost the replies of each conversation it synced. Measured from the full run
20260924T124013Z: 13,615 replies across 325 conversations (staff-all 5,576
listed vs 3,423 kept). Noticed because the store's total (450,208) was below
the main run's (458,455) with no deletions reported.

Fixed in 8d90f3d (full id is the identity; only abc.abc folds to abc).
Guard in 5927a61: the export refuses to save a conversation if any listed
message is missing from the merge result. Repair: export-workspace with
--space=<id> for the 325 conversations (ids beginning with "-" must use the
= form). Replies are still in Google, so they come back in full; edit history
recorded for replies before the loss is not recoverable. Files were already
on disk and are not re-downloaded.

### Attachment overwrites: found and repaired (2026-09-24)

verify --export --no-live (hashes every file, ~13 min; the default --live
re-lists everything from Google and takes as long as an export) found 169
hash mismatches. Two causes:

- Bug: files were saved as <message>/<original name>, so two pasted
  screenshots named image.png in one message overwrote each other. 106
  Chat API uploads and 36 Vault-extracted files. Fixed in e8b9bb4 (downloads
  claim unique paths, "image (2).png") and in the Vault importer (never
  overwrite different bytes). Repaired: the 106 re-downloaded by an export of
  their 34 conversations; the 36 re-extracted from the mbox with
  repairVaultAttachments() (keys follow the importer's fixed numbering).
  Index backup: attachments/index.json.bak-20260924-overwrite-fix.
- Harmless: 119 Google Docs/Sheets attached and linked in the same message,
  exported twice; the bytes differ by export timestamp. Records re-synced to
  the file on disk.

Failed downloads that cannot be fixed on our side: 1,155 Drive files since
deleted, 266 Docs Google refused to export (size limit), 4 × 404.
