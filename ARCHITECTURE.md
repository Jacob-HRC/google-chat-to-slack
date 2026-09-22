# Architecture

`googletoslack` is a Node.js/TypeScript CLI that moves Google Chat content into
Slack through a three-stage pipeline: **export → transform → import**. Each
stage reads and writes plain JSON on disk, so a stage can be re-run without
redoing the ones before it.

This document describes the pipeline as it exists today and records findings
from official Google and Slack documentation as the HighRidge Church DM
migration work progresses. Sections marked *(planned)* describe work that is
not merged yet.

## Commands

| Command | Module | What it does |
| --- | --- | --- |
| `login google [--service-account key.json --subject admin@…]` / `login slack` | `src/cli/commands/login.ts` | Stores credentials in the OS keyring via `src/utils/token-manager.ts`. The service-account form also verifies delegation. |
| `users [--user …] [--org-unit /X] [--include-suspended] [--json]` | `src/cli/commands/users.ts` | Lists the Workspace users a multi-user export would cover. Service account only. |
| `logout <provider>` | `src/cli/commands/logout.ts` | Deletes the stored credential. |
| `export` | `src/cli/commands/export.ts` | Pulls spaces, messages and attachments from Google Chat into `export/`. |
| `transform` | `src/cli/commands/transform.ts` | Converts `export/export.json` into `import/import.json`. |
| `import` | `src/cli/commands/import.ts` | Posts `import/import.json` into Slack via the Web API. |
| `migrate` | `src/cli/commands/migrate.ts` | Runs all three stages back to back. |

All commands are yargs `CommandModule`s registered in `src/cli/parser.ts` and
launched from `bin/googletoslack.ts`.

## Services

### `src/services/google-chat.ts` (export)

- **Auth.** Obtained from `google-auth.ts` (see below). Upstream used one
  OAuth2 user token; that flow still exists and is the default when no
  service account is configured.
- **Config.** `src/config/index.ts` loads `.env`, then
  `~/.googletoslack/config` or `~/.config/googletoslack/config`, and parses
  `process.env` with zod. All keys are optional at load time. The OAuth flow
  calls `requireGoogleOAuthConfig()` and fails with setup instructions if
  `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` are absent. (Upstream exited the
  process at import time, which also broke the test suite.)
- **Spaces.** `listSpaces()` pages through `spaces.list` for the logged-in
  user. Without a filter this returns every space the user is a member of,
  including group chats and DMs, but only the caller's own memberships.
- **Messages.** `listMessages()` pages through `spaces.messages.list`
  (1000 per page). Each message goes through `transformMessage()`, which
  rewrites `<users/123>` mention tokens into `@Display Name` using the plain
  `text` field, then applies a set of regex fixes for Google Chat's
  `formattedText` quirks (stray asterisks, bullet markup, code fences).
- **Attachments.** Drive-backed attachments are downloaded through the Drive
  API (`files.get?alt=media`); uploaded content goes through
  `https://chat.googleapis.com/v1/media/{resourceName}?alt=media`; anything
  else falls back to the `downloadUri`. Files land in `export/attachments/`
  named `<messageId>_<name>_<index><ext>` and the path is written back onto
  the attachment as `localFilePath`.
- **Users.** The export collects the set of sender IDs, then resolves each
  through Admin Directory `users.get`. The result is a flat
  `users/<id> → full name` map. Nothing else about the user (email, status)
  is kept.
- **Rate limiting.** Every Google call is wrapped in
  `withGoogleChatRateLimit` or `withGoogleDirectoryRateLimit` from
  `src/utils/rate-limiting/`, a token bucket with exponential backoff.
  `configureForExport(EXPORT_RATE_LIMITS)` tunes the buckets per command.
- **Dry run.** Limits to one space and one message, skips downloads.

### `src/services/google-auth.ts` (auth modes)

All Google calls obtain their client from `getGoogleAuthClient(subject?)`.
Two modes exist and `resolveAuthMode()` picks one:

- **OAuth** (upstream behaviour): refresh token in the keyring under the
  `google` account, one user, no impersonation. `subject` is rejected.
- **Service account with domain-wide delegation**: a JSON key plus a default
  subject (the Workspace admin). The key comes from `GOOGLE_SERVICE_ACCOUNT_KEY`,
  `GOOGLE_SERVICE_ACCOUNT_KEY_FILE`, or the keyring accounts
  `google-service-account-key` / `google-service-account-subject` written by
  `login google --service-account`. Each distinct `subject` gets its own cached
  `JWT` client so tokens are reused across the export.

A configured service account wins over an OAuth token; `GOOGLE_AUTH_MODE`
forces either. `verifyServiceAccountAccess()` runs one Directory call as the
admin and one `spaces.list` as the chosen subject and translates the usual
delegation errors into hints (`describeGoogleError()`).

Scopes are listed once in `GOOGLE_SCOPES` and must match the Admin console
entry exactly. Compared with upstream the list adds
`chat.memberships.readonly`, needed to record who is in each DM.

### `src/services/directory.ts` (user enumeration)

`listDomainUsers(selection)` returns `DomainUser[]` (`id`, `email`,
`fullName`, `suspended`, `archived`, `orgUnitPath`). With an explicit email
list it calls `users.get` per address and fails loudly on unknown ones;
otherwise it pages `users.list` with `customer=my_customer` and a query built
by `buildUserQuery()` (`orgUnitPath=/X isSuspended=false`). `selectUsers()`
re-applies the selection client-side so both paths agree. The Directory `id`
is the same number Chat uses in `users/<id>`, which is how later phases map
senders to emails.

`resolveUserSelection()` merges `--user` / `--org-unit` /
`--include-suspended` with `GOOGLE_EXPORT_USERS` and `GOOGLE_EXPORT_ORG_UNIT`.
The `users` command prints the result so a pilot scope can be checked before
exporting anything.

### `src/services/transformation.ts` (transform)

Pure data reshaping plus attachment copying:

- Builds `UserMapping[]` (`google_chat_id → display_name`) from senders.
- Each space becomes a `SlackImportChannel`: `name` is the display name
  lower-cased and squashed to `[a-z0-9-_]`, `is_private` is true when
  `spaceType === 'DM'`, `purpose` comes from the space description.
- Each message becomes a `SlackImportMessage` with `text`, `display_name`,
  ISO `timestamp`, `threadId` (the Google thread name), `threadReply`,
  `attachments` (copied into `import/attachments/`), `reactions` (unicode
  emoji mapped to Slack short names by a hard-coded table) and `mentions`.
- Messages whose sender could not be named are dropped.

### `src/services/slack.ts` (import)

- **Auth.** A bot token from `SLACK_BOT_TOKEN` or the keyring.
- For each channel: find-or-create via `conversations.list` /
  `conversations.create`, set the purpose, then post messages sequentially.
- Each message is posted with `chat.postMessage` as the bot. The original
  sender and time are prepended to the text as `*Name* at _date_`. Slack
  therefore shows the bot as the author and the import time as the message
  time.
- Threads: the first message seen for a `threadId` becomes the parent; later
  ones reply with `thread_ts`.
- Attachments use `files.getUploadURLExternal` → upload →
  `files.completeUploadExternal`, posted as a reply to the text message.
- Reactions are added with `reactions.add` by the bot user.
- Per-channel, per-endpoint token buckets follow Slack's rate-limit tiers.

## Data directory

`src/utils/data-directory.ts` picks the base directory:

- Running from a checkout (a `package.json`, `src/` and `tsconfig.json` are
  present in the working directory): `./data/` inside the repo. This path is
  git-ignored.
- Installed globally: `~/.config/googletoslack/data/`.

Files written under that base:

```
data/
├── export/
│   ├── export.json          # ExportData: export_timestamp, users, spaces[]
│   └── attachments/         # downloaded files, <messageId>_<name>_<i><ext>
├── import/
│   ├── import.json          # SlackImportData: export_timestamp, channels[]
│   └── attachments/         # copies of the export attachments
└── logs/
    └── output.log           # errors and warnings from the last run
```

`export` and `transform` delete and recreate their output directory on every
run. Nothing is resumable today.

The README mentions an `avatars/` directory. No code writes it.

### `export.json` shape

```jsonc
{
  "export_timestamp": "2025-07-26T09:04:44.275Z",
  "users": { "users/1018735…": "Markus Jura" },
  "spaces": [
    {
      "name": "spaces/AAAAnJnF0Os",
      "displayName": "general",
      "spaceType": "SPACE",            // Google also returns GROUP_CHAT and DIRECT_MESSAGE
      "spaceDetails": { "description": "…" },
      "messages": [
        {
          "name": "spaces/AAAAnJnF0Os/messages/c7pp….c7pp…",
          "sender": { "name": "users/1018735…" },
          "createTime": "2025-01-31T12:49:46.637839Z",
          "text": "…", "formattedText": "…",
          "thread": { "name": "spaces/AAAAnJnF0Os/threads/c7pp…" },
          "threadReply": true,
          "attachment": [{ "contentName": "…", "contentType": "…", "driveDataRef": { "driveFileId": "…" }, "source": "DRIVE_FILE", "localFilePath": "…" }],
          "emojiReactionSummaries": [{ "emoji": { "unicode": "👋" }, "reactionCount": 1 }],
          "annotations": [{ "type": "USER_MENTION", "userMention": { "user": { "name": "users/…" } } }]
        }
      ]
    }
  ]
}
```

The raw Google `Space` object is spread into each entry, so extra fields such
as `spaceThreadingState`, `membershipCount` and `spaceUri` are present even
though `src/types/google-chat.ts` does not declare them.

## Gaps for a full-workspace DM migration

These are the reasons the upstream tool cannot move HighRidge's DMs as-is:

1. **Single-user visibility.** Export only sees spaces the OAuth user belongs
   to. Other people's DMs and group chats are invisible.
2. **No membership data.** Export records message senders only, so a DM where
   one side never wrote anything loses that member. Nothing records who is in
   a group DM.
3. **`spaceType` is mistyped.** The code checks for `'DM'`; the API returns
   `SPACE`, `GROUP_CHAT` or `DIRECT_MESSAGE`. DMs are therefore treated as
   public channels named after their (empty) display name.
4. **Import posts as a bot.** `chat.postMessage` cannot write into a DM
   between two other users, cannot attribute a message to them, and cannot
   backdate it. Real DMs with history require Slack's export-ZIP import.
5. **Users are name-only.** No email is captured, so there is nothing to
   match against Slack accounts.
6. **No resume.** A crash restarts the whole export.

## Workspace export store (Phase 2)

`export-workspace` (`src/services/workspace-export.ts`) is a second export
path that does not touch the legacy `export.json`. It writes an additive store
whose shapes are declared in `src/types/export-store.ts`:

```
data/workspace/
├── manifest.json                 store version, run history, last run status
├── users.json                    users/<id> → StoredUser (email, name, status, placeholder)
├── spaces/<spaceId>/
│   ├── space.json                raw Space, memberships, readers, readerSubject
│   ├── messages.json             StoredMessage[] sorted by createTime
│   └── state.json                sync status, counts, maxCreateTime
├── attachments/
│   ├── index.json                key → AttachmentRecord (status, sha256, Drive metadata)
│   └── files/<spaceId>/<messageId>/<original name>
├── unreachable-spaces.json       named spaces no selected user can read (admin sweep)
├── runs/<runId>.json             RunReport: per-user, per-space counts
└── logs/<runId>.log
```

### Run flow

1. `listDomainUsers(selection)` picks the subjects to impersonate (active
   users only; suspended users cannot be impersonated).
2. `listSpacesAs(subject)` for each subject, then `dedupeDiscoveredSpaces()`
   keys spaces by id and records every subject that can read each one. A DM
   between two selected users therefore appears once with two readers.
3. Optional admin sweep: `spaces.search` with `useAdminAccess` lists every
   named Space in the customer; those not discovered in step 2 are reported
   with their members. DMs cannot be found this way (the API only returns
   `spaceType = "SPACE"`).
4. Per space, sequentially: memberships → messages → merge → reactions →
   user resolution → attachment index → downloads → state `complete`.
   Each step persists before the next starts, so a crash costs at most one
   space's partial work; `--resume` reuses the interrupted run id and skips
   spaces already complete in it.

### Merge rules (`mergeMessages`, pure, tested)

- Keyed by message resource name. Content hash covers text, formattedText,
  lastUpdateTime, deleteTime, attachments, GIFs, annotations, reaction
  summaries, quoted message and thread.
- New → added. Hash changed → updated; the previous `raw` goes into `history`.
- Google reports `deleteTime` → marked deleted; content is no longer returned
  by the API, so the last stored `raw` is kept and the deletion recorded next
  to it.
- Present in store, absent from a **complete** listing, no deletion marker →
  `missingSince` set. Never removed. A later listing that returns it clears
  the flag (`reappeared`).
- `--since` listings are partial: nothing is marked missing.
- Reactions are re-fetched when the reaction summary changes or was never
  fetched.

### Timestamps

`toSlackTs()` converts RFC 3339 to `seconds.microseconds` with integer
arithmetic (no floating point) and truncates nanoseconds. The original
`createTime`, `lastUpdateTime` and `deleteTime` strings stay in `raw`.

### Attachments

`buildAttachmentRecords()` indexes, per message: `attachment[]` entries
(`UPLOADED_CONTENT` via the Chat media endpoint, `DRIVE_FILE` via Drive),
`attachedGifs[]` (public URLs), and Drive ids found by `extractLinks()` in
rich-link annotations or message text (`DRIVE_LINK`, metadata only unless
`--drive-links download`). Downloads stream to disk while hashing (sha256 and
md5); Drive binaries are checked against `md5Checksum`. Google-native files
are exported (`chooseExportFormat()`: docx/xlsx/pptx or pdf); folders,
shortcuts and forms stay link-only. Drive access is tried as the reader, then
the sender, then other active selected members (`withSubjectFallback()`),
because Drive permissions are per user. Every record keeps the full Drive
metadata (owner, timestamps, MIME type, size, webViewLink).

### People

`resolveChatUsers()` maps `users/<id>` to Directory records by id. Missing
records become placeholders: `deleted`, `external` (by membership
affiliation), `bot`, or `unknown` (lookup error; retried next run). Chat's
`displayName`, when Google populates it, is kept as the placeholder name.

### Verification (`verify`)

`verifyExportStore()` re-lists each space as its reader and compares message
name sets and deleted counts; checks each attachment record's file exists and
re-hashes it; counts unresolved people. `--no-live` runs offline.

## Slack archive writer (Phase 3)

`build-slack-archive` (`src/services/slack-archive/`) reads the workspace
store and produces the archive Slack's importer expects. All transforms are
pure functions over store records; the only I/O is reading the store and
writing the ZIP (`yazl`).

| Module | Responsibility |
| --- | --- |
| `ids.ts` | Deterministic Slack-shaped ids (`U…`, `C…`, `G…`, `D…`, `F…`) from Google ids via SHA-256, channel-name normalisation, `mpdm-a--b--c-1` names. |
| `users.ts` | `users.json` rows: name + email only; deactivated for anyone not active in Google; overrides for placeholders. |
| `conversations.ts` | Space → channel/group/dm/mpim decision, member lists (members ∪ senders), creator, created time. |
| `text.ts` | Google formattedText → mrkdwn: `<users/id>` → `<@U…>`, `<url|label>` kept, `& < >` escaped outside tokens, bullets → `•`; reaction short names via `node-emoji` plus a table for newer emoji. |
| `messages.ts` | Per conversation: include/omit (deleted policy, delta cut-offs), unique `ts` (+1µs on collision), threads (`thread_ts`, `reply_count`, `replies`, `parent_user_id`), `edited`, reactions, quoted messages, files (manifest or hosted), Drive links, day bucketing (UTC). |
| `builder.ts` | Loads the store, collects referenced people, runs the above, fills `archive-manifest.json`. |
| `writer.ts` | Stable entry order, ZIP + unpacked output, console report. |

### Google Vault path (member-less spaces)

`src/services/vault.ts` plus the `vault` command reach Spaces that the Chat
API cannot return because every member has been deleted. Vault's `ROOM` search
method takes space ids directly.

Auth is deliberately separate. `getScopedAuthClient(scopes, subject)` mints a
JWT for an explicit scope set and caches it per subject and scope list, so the
Vault scope lives in `VAULT_SCOPES` rather than `GOOGLE_SCOPES`. A JWT is
refused entirely if any requested scope is unauthorized, so a missing Vault
grant must not be able to break Chat and Drive access.

#### Vault export format, measured (2026-09-22)

The 96 member-less Spaces were exported and inspected. What Vault actually
delivers, as opposed to what the docs imply:

```
chat-orphan-spaces-1.zip          2.4 GB
  └── chat-orphan-spaces_0.mbox.zip
        └── chat-orphan-spaces_0.mbox      3.3 GB
chat-orphan-spaces-metadata.xml   3.6 MB
chat-orphan-spaces-errors.csv     1 row
```

- The mbox holds **2195 documents**, one per space per 24-hour block, covering
  all 96 spaces. Vault's "2196 messages" counts documents, not chat messages.
- Each document is **rendered HTML**, not structured data. Individual messages
  appear as `<div data-id="<messageId>">` with the sender's **email** in bold,
  a human-readable timestamp, and the text. About **9,979** individual
  messages across the set.
- **6,651 attachment parts** are embedded as MIME attachments with their
  original filenames, so the files come back.
- `metadata.xml` carries per document: `RoomID`, `RoomName`,
  `ConversationType`, `Participants` (emails), and
  `#DateFirst/LastMessageSent/Received` at millisecond precision.
- `errors.csv` reported one failure: space `team-youth` had a topic containing
  a message larger than the file size limit.

Fidelity against the Chat API path:

| | Chat API | Vault |
| --- | --- | --- |
| Text, sender | yes (user id) | yes (email, which maps to Slack directly) |
| Timestamp | microsecond | second, from rendered text |
| Threads | thread id and replies | flattened |
| Reactions | per user | absent |
| Edits, deletions | recorded with history | absent |
| Attachments | downloaded, Drive metadata | embedded MIME parts |

A Vault-sourced conversation can therefore be imported as readable history
with real senders and files, but not with threading, reactions, or exact
timestamps. Parsing it means HTML scraping plus MIME extraction, not JSON.

## Vault import (`import-vault`)

`src/services/vault-import/` folds a Vault Chat export into the same store the
Chat API writes, so the Slack archive builder needs no special case beyond a
provenance label.

| Module | Responsibility |
| --- | --- |
| `mbox.ts` | Streams documents out of the multi-gigabyte mbox in 4 MB chunks, splitting on `From <spaceId>-MBI-FLAT:…`. Keeps at most one document in memory. |
| `mime.ts` | Focused MIME reader: finds the header block by index rather than splitting the document, then decodes the HTML part and base64 attachments. |
| `html.ts` | Depth-aware reader for Vault's rendered conversation HTML. |
| `metadata.ts` | XML sidecar: `RoomID`, `RoomName`, `ConversationType`, `Participants`. |
| `importer.ts` | Merges into the store with the Chat API taking precedence. |

### What the HTML gives back

Each message is a `div[data-id]` holding the sender's email, a
second-precision timestamp, the text, and trailing blocks for filenames or link
previews. Threaded messages insert a leading `N Replies` marker ahead of the
header, which is the only trace of threading Vault keeps: the count survives,
not which messages the replies were. The header is therefore located by looking
for the child that parses as a timestamp, not by position.

Trailing blocks that match a MIME part filename become attachments; the rest
are quoted or preview text and are folded into the message body so nothing is
dropped. App-relayed posts (`* Via User(Name) *`) keep that attribution.

### Chat API precedence

Jacob's requirement is full-fidelity data first and no duplicates. Three
guards enforce it:

1. Spaces already holding `chat-api` messages are skipped before their
   documents are parsed, so no work or disk is spent on them.
2. Within a space, a message id already present is never replaced.
3. `mergeMessages` keys on `messageIdentity()`, which collapses the API's
   `abc.abc` and Vault's bare `abc` to one key. When the API later returns a
   message that Vault supplied, the API record supersedes it rather than
   sitting beside it or being logged as an edit.

Every record carries `source: 'chat-api' | 'vault'`; absent means `chat-api`
for records written before sources were tracked.

### Memory

Two faults surfaced only against the real 2.4 GB export, both fixed:
splitting whole 200 MB documents into lines to read a few headers, and
buffering attachment bodies until the end rather than writing each one as its
document is parsed. The largest document is 200 MB, so the import still wants
a raised heap:

```bash
node --max-old-space-size=6144 -r ts-node/register/transpile-only \
  bin/googletoslack.ts import-vault --mbox <path> --dry-run
```

## Name recovery (`recover-names`)

`src/services/name-recovery.ts` is pure and gives deleted accounts their names
back. Measured against the real store: of 50 placeholders, 26 are named and 10
of those also gain an email.

Evidence is weighted, not taken first-wins, because scraped mention spans are
occasionally shifted by a character (`avannah Emert I` alongside
`Savannah Emert`). `sender.displayName` carries weight 5, a mention span
weight 1, and the winner is chosen by total weight with the rest kept as
alternates. Confidence is `high` when Google's own field supplied the name or
the winner doubles the runner-up, otherwise `medium`.

Two traps found by running it:

- Google's display name for a deleted account is the literal string
  `Deleted User`, which outweighed every real name until it was rejected via
  the shared `isGenericDisplayName()`.
- External people are identified by address alone, and the name cleaner turned
  `amarabrock22@gmail.com` into `amarabrock22 gmail com`. Email-shaped values
  are now kept verbatim.

Email matching only accepts an unambiguous join: a full-name address, or a
first-name address when exactly one recovered person has that first name. This
guard earned its keep: `jenny@hrc.email` belongs to a different, active Jenny,
and was correctly left alone. When the address spells an alternate name, that
spelling is promoted, since it is the person's current one.

### One person, one record

`planAliases()` finds records that are the same human twice. A Vault import
keys people it cannot match by email, while the API knows them by user id; once
an email is recovered for the API record, the two provably describe one person
and the email-keyed one is retired. On the real store this merged 10 people.
A manual alias file covers the other case, someone offboarded and re-onboarded
with a second account.

Merged records carry `aliasOf`. `buildUsers()` skips them and then points every
merged id at the surviving person's Slack user, so one human never becomes two
Slack accounts. `resolveAlias()` follows chains and is cycle-safe.

## Research notes: Vault

- Vault UI cannot reach these spaces: "To select spaces and group
  conversations, you enter the account of a member of the space. You can't
  search across all spaces."
  (knowledge.workspace.google.com/vault/search/use-vault-to-search-google-chat)
- The API can: `searchMethod: ROOM` is "Search messages in the Chat spaces
  specified in HangoutsChatInfo", and `HangoutsChatInfo.roomId` is "A list of
  Chat spaces IDs, as provided by the Chat API. There is a limit of exporting
  from 500 Chat spaces per request."
  (developers.google.com/workspace/vault/reference/rest/v1/Query)
- **Counting Chat is not supported.** `CountArtifactsResponse` carries only
  `mailCountResult` and `groupsCountResult`, and a live `matters.count` with
  `corpus: HANGOUTS_CHAT` returns "Corpus type HANGOUTS_CHAT is not
  supported." Verified against the API on 2026-09-22. Export is the only way
  to learn what Vault holds for a space.
- Export format is MBOX or PST plus XML and CSV metadata. The Chat metadata
  carries "RoomID–Space, group chat, or DM identifier that the message belongs
  to", Participants, ConversationType ("Room", "1:1 Direct Message", "Group
  Direct Message"), space name, and "when the sender edited or deleted a
  message". Exports include "Messages and their attachments".
  (knowledge.workspace.google.com/vault/exports/vault-export-contents)
- Vault ships with Business Plus, Enterprise Standard and Plus, and Education
  Plus. HighRidge is on Enterprise.
- Retention caveat: Vault "can retain messages only in spaces (including
  meeting conversations) that have history turned on". All 96 member-less
  Spaces here have history on.

## Research notes: Slack import

- Export layout and message fields: developers.google.com is not involved;
  see slack.com/help/articles/220556107 ("How to read Slack data exports").
  "Slack export files in JSON format do not contain any files from the
  workspace. They include a series of file links."
- Import behaviour (slack.com/help/articles/201748703 and the FAQ
  360049597673): users are mapped by email with defaults "Merge users" for
  matches, "Import as deactivated" for deactivated users without a match,
  "Import just their messages" for active users without a match. "In order
  for a DM to be imported, all the users in the DM must be imported."
  "It is not possible to merge channels with an existing private channel."
  "To be imported, both the user who shared the file and the conversation
  where it was shared must be imported." Google Drive/Box app files "will
  not be imported". Pinned messages import with channels; custom emoji must
  exist in the destination first; "There isn't a maximum amount of data".
- Whether Slack fetches `url_private` from a non-Slack host during import is
  not documented. The writer therefore supports both `hosted` and `manifest`
  file strategies; the pilot import decides.
- Field usage cross-checked against Zulip's Slack import reader
  (zerver/data_import/slack.py): `thread_ts`, `reply_count`, `replies`,
  `parent_user_id`, `reactions[].name/users`, `files[].url_private`,
  `edited`, `subtype` values, day files named `<conversation>/<YYYY-MM-DD>.json`.

## Research notes

Findings from official documentation, kept here so the code does not rest on
guesses. Each item cites where it came from.

### Google Chat API

- **Domain-wide delegation is user auth.** "Although a service account is
  used for authentication, domain-wide delegation impersonates a user and is
  therefore considered user authentication." Anything that works with user
  auth works when impersonating that user.
  (developers.google.com/workspace/chat/authenticate-authorize-chat-user)
- **`useAdminAccess`** exists for admins on some methods, but it only covers
  named spaces (`spaces.search`), not DMs. DMs require impersonating a member.
- **`spaces.list`** returns spaces the caller is a member of. Filter syntax:
  `spaceType = "SPACE" OR spaceType = "GROUP_CHAT" OR spaceType = "DIRECT_MESSAGE"`.
  Page size max 1000. "Group chats and DMs aren't listed until the first
  message is sent." User scopes: `chat.spaces.readonly` or `chat.spaces`.
  (…/api/reference/rest/v1/spaces/list)
- **`spaces.members.list`** returns `Membership` objects with `member.name`,
  `member.type` (`HUMAN`/`BOT`), `state` and `role`. Page size max 1000.
  User scope: `chat.memberships.readonly`.
  (…/api/reference/rest/v1/spaces.members/list)

- **`spaces.messages.list`** filter syntax: `createTime > "2012-04-21T11:30:00-04:00"`
  (RFC 3339 in double quotes), `thread.name = spaces/{space}/threads/{thread}`,
  joined with `AND`. `orderBy` is `createTime ASC|DESC`. Page size max 1000.
  With `showDeleted=true`, deleted messages are returned with "deleted time and
  metadata about their deletion, but message content is unavailable."
  (…/api/reference/rest/v1/spaces.messages/list)
- **Message resource** carries `createTime` (nanosecond RFC 3339),
  `lastUpdateTime`, `deleteTime`, `deletionMetadata.deletionType`
  (CREATOR, SPACE_OWNER, ADMIN, APP_MESSAGE_EXPIRY, CREATOR_VIA_APP,
  SPACE_OWNER_VIA_APP, SPACE_MEMBER), `attachment[]`, `attachedGifs[]`,
  `annotations[]` with `RICH_LINK` → `driveLinkData.driveDataRef.driveFileId`
  and `mimeType`, `emojiReactionSummaries[]`, `quotedMessageMetadata`,
  `threadReply`. (…/api/reference/rest/v1/spaces.messages)
- **`spaces.messages.reactions.list`** returns per-user reactions
  (`user.name`, `emoji.unicode` or `emoji.customEmoji.uid`). Accepts
  `chat.messages.readonly`, so no extra scope is needed. Page size max 200.
  (…/api/reference/rest/v1/spaces.messages.reactions/list)
- **`spaces.search`** with `useAdminAccess=true` needs the admin subject to
  hold the "manage chat and spaces conversations" privilege and
  `chat.admin.spaces.readonly`. Query must be
  `customer = "customers/my_customer" AND spaceType = "SPACE"`; only named
  spaces are returned. (…/api/reference/rest/v1/spaces/search)
- **Membership resource**: `state` JOINED/INVITED/NOT_A_MEMBER, `role`,
  `affiliation` INTERNAL/EXTERNAL/MANAGED_EXTERNAL, `member` (User) or
  `groupMember` (Group). The docs do not promise `displayName` for humans
  under user auth, so names come from the Directory.
  (…/api/reference/rest/v1/spaces.members)

### Google Drive API

- **Export formats**: Docs → docx/odt/rtf/pdf/txt/html/epub/md; Sheets →
  xlsx/ods/pdf/csv/tsv; Slides → pptx/odp/pdf/txt; Drawings → pdf/jpeg/png/svg;
  Apps Script → json. Forms, Sites, Jamboard and folders have no export.
  (developers.google.com/workspace/drive/api/guides/ref-export-formats)

### Admin SDK Directory API

- **`users.list`** takes `customer=my_customer` (or `domain`), `maxResults`,
  `pageToken` (valid for three days), `showDeleted`, and a `query` string.
  Read scope: `admin.directory.user.readonly`.
  (developers.google.com/workspace/admin/directory/reference/rest/v1/users/list)
- **Query syntax.** Clauses separated by spaces are ANDed. `orgUnitPath=/X`
  "matches all org unit chains under the target", so it is a subtree match.
  `isSuspended=true|false` and `isArchived=true|false` take `=` only.
  (developers.google.com/workspace/admin/directory/v1/guides/search-users)

### Domain-wide delegation setup

- Cloud console: IAM & Admin > Service Accounts > (account) > Show advanced
  settings > Domain-wide delegation > copy the **Client ID**.
- Admin console: Security > Access and data control > API controls > Manage
  Domain Wide Delegation > Add new > paste the Client ID and a comma-separated
  scope list > Authorize. "Changes can take up to 24 hours but typically
  happen more quickly."
  (developers.google.com/workspace/guides/create-credentials)
- Observed live: user-auth calls through delegation (`spaces.list`,
  `members.list`, `messages.list`, media download, Drive) work without a
  Chat app configured. `spaces.search` with `useAdminAccess` does not: it
  fails with "Google Chat app not found. To create a Chat app, you must turn
  on the Chat API and configure the app in the Google Cloud console." The
  admin sweep is therefore optional until a Chat app is configured.
