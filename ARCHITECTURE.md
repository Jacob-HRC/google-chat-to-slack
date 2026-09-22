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
- The Chat authentication guide does not say a Chat app must be configured
  for user-auth calls made through delegation. If a 403 mentions app
  configuration, the fallback is to configure a Chat app in the Cloud
  console's Chat API page; that has not been needed so far.
