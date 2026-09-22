# Google Chat to Slack Migrator

[![npm version](https://badge.fury.io/js/google-chat-to-slack.svg)](https://www.npmjs.com/package/google-chat-to-slack)
[![npm downloads](https://img.shields.io/npm/dm/google-chat-to-slack.svg)](https://www.npmjs.com/package/google-chat-to-slack)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A CLI tool for migrating channels, messages, threads, attachments, and reactions from Google Chat to Slack.

<img width="958" height="520" alt="migrate-example" src="https://github.com/user-attachments/assets/9c493830-554a-40d4-ae6a-fa6b6efdb46b" />

## Features

- **Complete Migration**: Export all channels, messages, threads, attachments, and reactions
- **Whole workspace**: with a delegated service account, `export-workspace` also captures every user's DMs and group chats, deleted and edited messages, per-user reactions, Drive links and file metadata, with delta re-runs, dry runs and a `verify` command
- **Selective Migration**: Choose specific spaces/channels to migrate
- **User Mentions**: Preserves user mentions in a message (as text, not creating the users themselves)
- **Rate Limited**: Respects both Google Chat and Slack API limits
- **Channel Management**: Rename and organize channels during import
- **Three-Stage Pipeline**: Export → Transform → Import for reliability

## Installation

```bash
npm install -g google-chat-to-slack
```

## Quick Start

```bash
# 1. Authenticate with both services
googletoslack login google
googletoslack login slack

# 2. Run complete migration
googletoslack migrate

# 3. Or run individual steps
googletoslack export
googletoslack transform
googletoslack import
```

## Setup & Configuration

### Quick Reference

**Google Chat Requirements:**

- Google Workspace admin access
- APIs:
  - Google Chat
  - Admin SDK Directory
  - Google Drive
- OAuth2 scopes:
  - `chat.spaces.readonly`
  - `chat.messages.readonly`
  - `drive.readonly`
  - `admin.directory.user.readonly`
- Environment variables:
  - `GOOGLE_CLIENT_ID`
  - `GOOGLE_CLIENT_SECRET`
- Or, for a whole-workspace export, a service account with domain-wide
  delegation (see "Service account auth" below) and the extra scope
  `chat.memberships.readonly`

**Slack Requirements:**

- Slack workspace admin access
- Bot token scopes:
  - `chat:write`
  - `files:write`
  - `channels:read`
  - `channels:manage`
  - `reactions:write`
- Environment variables:
  - `SLACK_BOT_TOKEN`

### Detailed Setup Guide

#### Google Cloud Console Setup

1. **Enable Required APIs** in your Google Cloud project:
   - [Google Chat API](https://console.cloud.google.com/apis/library/chat.googleapis.com)
   - [Admin SDK Directory API](https://console.cloud.google.com/apis/library/admin.googleapis.com)
   - [Google Drive API](https://console.cloud.google.com/apis/library/drive.googleapis.com)

2. **Configure OAuth Consent Screen:**
   - Go to [APIs & Services > OAuth consent screen](https://console.cloud.google.com/apis/credentials/consent)
   - Select user type: "Internal" (for Google Workspace orgs) or "External" (for personal use)
   - In [Branding](https://console.cloud.google.com/auth/branding), fill in app name, user support email, and developer contact information

3. **Add Required OAuth Scopes:**
   - Go to [APIs & Services > Data Access](https://console.cloud.google.com/auth/scopes)
   - Click "Add or remove scopes"
   - Add these scopes (they must match the ones in Quick Reference above):
     - `https://www.googleapis.com/auth/chat.spaces.readonly`
     - `https://www.googleapis.com/auth/chat.messages.readonly`
     - `https://www.googleapis.com/auth/drive.readonly`
     - `https://www.googleapis.com/auth/admin.directory.user.readonly`
   - Click "Update" to save the scopes

4. **Create OAuth2 Client:**
   - Go to [APIs & Services > Clients](https://console.cloud.google.com/auth/clients)
   - Click "Create OAuth client ID"
   - Select "Desktop application" (for CLI tools)
   - Enter a name for your OAuth client
   - Click "Create" to get your `client_id` and `client_secret`
   - Copy both values for environment variable setup

#### Service account auth (whole workspace, domain-wide delegation)

The OAuth flow above only sees spaces that one user belongs to. To export
every user's Spaces, group chats and DMs, use a service account with
domain-wide delegation. The tool impersonates each user in turn to read their
conversations, and impersonates one Workspace admin to list users.

1. **Create the service account** in your Google Cloud project:
   - Enable the Google Chat API, Admin SDK API and Google Drive API (links above).
   - Go to IAM & Admin > Service Accounts > Create service account. No project roles are needed.
   - Open the account > Keys > Add key > Create new key > JSON. Keep the file private; it is never stored in this repo.
   - Open the account > Show advanced settings > Domain-wide delegation, and copy the **Client ID** (a long number).

2. **Authorize the scopes** in the Google Admin console:
   - Go to Security > Access and data control > API controls > Manage Domain Wide Delegation > Add new.
   - Paste the Client ID and enter these scopes, comma separated, exactly:

     ```
     https://www.googleapis.com/auth/chat.spaces.readonly,
     https://www.googleapis.com/auth/chat.messages.readonly,
     https://www.googleapis.com/auth/chat.memberships.readonly,
     https://www.googleapis.com/auth/drive.readonly,
     https://www.googleapis.com/auth/admin.directory.user.readonly
     ```

   - Click Authorize. Google says changes can take up to 24 hours but usually apply within minutes.

3. **Store the key and verify** (the key goes into the OS keyring, the subject is the admin to impersonate for Directory calls):

   ```bash
   googletoslack login google --service-account ./service-account.json --subject admin@example.com
   ```

   The command checks the Directory API as the admin and the Chat API as the
   same user, and explains the usual delegation failures (`unauthorized_client`
   means the scopes or Client ID in the Admin console do not match;
   `invalid_grant` means the subject email is wrong or suspended).

   Environment variables work too, for CI or headless machines without a
   keyring: `GOOGLE_SERVICE_ACCOUNT_KEY_FILE` (or `GOOGLE_SERVICE_ACCOUNT_KEY`
   with the JSON inline) plus `GOOGLE_ADMIN_SUBJECT`. When both a service
   account and an OAuth token exist the service account wins; set
   `GOOGLE_AUTH_MODE=oauth` to force the single-user flow.

4. **Check which users are in scope**:

   ```bash
   googletoslack users                                   # every active user
   googletoslack users --org-unit /Staff                 # one org unit and its children
   googletoslack users --user a@example.com --user b@example.com
   googletoslack users --include-suspended --json
   ```

   The same restrictions can live in config as `GOOGLE_EXPORT_USERS`
   (comma separated) and `GOOGLE_EXPORT_ORG_UNIT`; flags override them. These
   filters are what the multi-user export uses to pick whose conversations to
   read, which keeps pilot runs small.

#### Slack App Setup

1. **Create Slack App**:
   - Go to [Your Apps](https://api.slack.com/apps) → "Create New App" → "From scratch"
   - Enter app name and select your workspace

2. **Configure Bot Token Scopes**:
   - Go to "OAuth & Permissions" in sidebar
   - Under `Scopes > Bot Token Scopes`, add these [scopes](https://api.slack.com/scopes):
     - `channels:manage` (Create channels)
     - `channels:read` (View channels)
     - `chat:write` (Send messages)
     - `files:write` (Upload files)
     - `reactions:write` (Add emoji reactions)

3. **Install App**:
   - Click "Install to Workspace" at the top
   - Review permissions and click "Allow"

4. **Get Bot User OAuth Token**:
   - Go to "OAuth & Permissions" in sidebar
   - Copy the `OAuth Tokens > Bot User OAuth Token` for environment variable setup (starts with `xoxb-`)

#### Environment Variables Setup

For global npm package usage, set environment variables using one of these methods:

**Option 1: Environment variables (temporary)**

```bash
export GOOGLE_CLIENT_ID="your_google_client_id"
export GOOGLE_CLIENT_SECRET="your_google_client_secret"
export SLACK_BOT_TOKEN="xoxb-your-slack-bot-token"
```

**Option 2: Config file (persistent)**

Create a config file in the `~/.config/googletoslack` directory:

```bash
mkdir -p ~/.config/googletoslack
cat > ~/.config/googletoslack/config << EOF
GOOGLE_CLIENT_ID="your_google_client_id"
GOOGLE_CLIENT_SECRET="your_google_client_secret"
SLACK_BOT_TOKEN="xoxb-your-slack-bot-token"
EOF
```

**Verify Setup:**

```bash
echo $GOOGLE_CLIENT_ID
echo $SLACK_BOT_TOKEN
googletoslack login google  # Test Google authentication
googletoslack login slack   # Test Slack authentication
```

## Commands

### Authentication

```bash
# Login to Google (opens browser for OAuth)
googletoslack login google

# Login to Slack (interactive bot token setup)
googletoslack login slack

# Login with a delegated service account (whole workspace)
googletoslack login google --service-account ./key.json --subject admin@example.com

# List the Workspace users an export would cover
googletoslack users --org-unit /Staff

# Logout from services (removes OAuth token and stored service account)
googletoslack logout google
googletoslack logout slack
```

### Migration

```bash
# Complete migration (recommended)
googletoslack migrate

# Migrate specific channels only
googletoslack migrate --channel general --channel team-updates

# Test migration with minimal data
googletoslack migrate --dry-run

# Add prefix to channel names
googletoslack migrate --channel-prefix "gchat-"

# Rename channels during migration
googletoslack migrate --channel-rename "old-name=new-name"
```

### Individual Steps

### Whole-workspace export (DMs included)

`export-workspace` reads every selected user's Spaces, group chats and DMs
through the delegated service account and writes them into an **additive
store** (default `~/.config/googletoslack/data/workspace/`, or `data/workspace/`
in a checkout). It never deletes or truncates; re-running it produces a delta.

```bash
# Preview: users, spaces, members, message counts and what would change. Writes nothing.
googletoslack export-workspace --dry-run

# Pilot: two users and one space
googletoslack export-workspace --user a@example.com --user b@example.com --space general

# Full export (first run) or delta (later runs)
googletoslack export-workspace

# Continue an interrupted run
googletoslack export-workspace --resume

# Fast delta: only messages created after a timestamp (does not see edits or deletions of older messages)
googletoslack export-workspace --since 2026-09-01T00:00:00Z

# Also download copies of Docs/Sheets/Drive files that are merely linked in message text
googletoslack export-workspace --drive-links download --drive-export-format pdf
```

What a run does, per space, once:

1. Lists memberships (humans, bots, groups, invited members).
2. Lists every message including thread replies and **deleted messages**
   (Google returns their deletion time and reason; the last content the store
   saw is kept alongside).
3. Merges into the store: new messages are added, edited messages keep their
   previous versions in `history`, deleted ones are marked, and messages that
   vanish without a deletion marker are flagged `missingSince` rather than
   dropped.
4. Fetches **per-user reactions** for messages that have any.
5. Resolves every person referenced (members, senders, mentions, reactors)
   through the Directory API. Suspended, deleted, external and bot users get
   placeholders so their messages are never lost.
6. Indexes and downloads attachments: uploaded files via the Chat media API,
   Drive attachments via the Drive API with md5 verification, Google-native
   files (Docs/Sheets/Slides) exported as Office or PDF, attached GIFs, and
   Drive/Docs/Sheets links found in message text (metadata by default). The
   original Drive link and full Drive metadata (owner, created/modified time,
   MIME type, size, md5) are recorded for every file.

Original timestamps are kept at microsecond precision (`slackTs` is
precomputed on every message).

Users the service account cannot impersonate (suspended, deleted) are still
covered when any active member of the conversation is selected. With
`--admin-sweep` (default on, needs the `chat.admin.spaces.readonly` scope) the
run also lists every named Space in the domain and reports those that no
selected user can read in `unreachable-spaces.json`.

Every run writes `runs/<runId>.json` with per-space counts and
`logs/<runId>.log` with any warnings or errors. The command exits 0 on
success, 2 if it completed with errors (re-run to retry), 1 if it failed.

### Verify the export

```bash
googletoslack verify                # re-list every space from Google and compare, hash every file
googletoslack verify --no-live      # offline: store consistency and file hashes only
googletoslack verify --space general --json report.json
```

`verify` reports, per space, the stored active/deleted/missing counts against
Google's live listing, plus attachment records that are pending, failed,
missing on disk or whose hash changed. Exit code 1 means something needs
attention.

### Recover names for deleted accounts

```bash
googletoslack recover-names                  # report only
googletoslack recover-names --apply          # write the names in
googletoslack recover-names --json plan.json # save the plan for review
```

The Directory API knows nothing about a deleted account, so those senders start
out as `Former user 297491`. Three sources still carry their identity:

| Source | What it gives |
| --- | --- |
| `sender.displayName` on stored messages | Google's own label, when populated |
| `USER_MENTION` annotations | the `@Name` span inside the plain text of any message that mentioned them |
| Google Vault participant addresses | an email, joined back by the shape of the address |

Google substitutes the literal string "Deleted User" for these people, so that
label is rejected rather than used. An address is only attached when the match
is unambiguous: a full-name address such as `jenny.fuksa@` matches outright, a
first-name address such as `james@` only when exactly one recovered person has
that first name.

When an address spells one of the alternate names, that spelling is promoted:
`jenny.fuksa@` means the person is now Jenny Fuksa, and Jenny Munoz is kept as
the former name.

**One person, one Slack account.** Someone can appear twice in the store: once
by Chat user id from the API, once by email from Vault. Those are merged
automatically once an email is recovered. For a person who genuinely had two
accounts, pass `--aliases` with a file merging them by hand:

```json
{ "users/<old account>": "users/<account to keep>" }
```

Merged records get an `aliasOf` pointer; the Slack archive then emits one user
and maps every id through to it.

Nothing is overwritten. Only placeholders are touched, never a name the
Directory supplied, and an email already in the store wins over a matched one.
Anyone who cannot be named is identified by their email address instead.

### Fold a Vault export into the store

```bash
# Parse and report without writing
googletoslack import-vault --mbox data/vault-exports/.../chat-orphan-spaces_0.mbox --dry-run

# Merge it in
googletoslack import-vault --mbox data/vault-exports/.../chat-orphan-spaces_0.mbox
```

Vault renders conversations as HTML rather than exporting data, so this
recovers message id, sender email, second-precision timestamp, text,
attachments and a reply count. Threads, reactions, edits and sub-second
timestamps are not in the export to recover.

**The Chat API always wins.** Spaces it already covers are skipped, a message
it already provided is never replaced, and if the API later returns a message
Vault had supplied, the API copy supersedes it. Nothing is duplicated. Every
record is tagged with its source.

The largest documents run to 200 MB, so raise the heap for a full export:

```bash
node --max-old-space-size=6144 -r ts-node/register/transpile-only \
  bin/googletoslack.ts import-vault --mbox <path>
```

In the Slack archive, Vault-recovered channels say so in their purpose.
`--vault-prefix archive-` also renames them if you want them visually separate.

### Build the Slack import archive

```bash
googletoslack build-slack-archive --dry-run                 # report only
googletoslack build-slack-archive                           # ZIP under data/slack-archive/
googletoslack build-slack-archive --space general --unpacked ./check   # one Space plus a readable copy
googletoslack build-slack-archive --user-overrides overrides.json      # name former staff placeholders
```

`build-slack-archive` reads the workspace store (never Google) and writes the
archive format Slack's importer expects: `users.json`, `channels.json`,
`groups.json`, `dms.json`, `mpims.json` and one JSON file per conversation per
day, plus `archive-manifest.json` (Google id → Slack id mapping) and, by
default, `files-to-upload.json`.

How Google conversations map to Slack:

| Google | Slack | Notes |
| --- | --- | --- |
| Named Space | private channel (`--space-visibility public` for public) | Slack can only merge into existing *public* channels. |
| DM, or group chat with 2 people | direct message | Both people must be in `users.json`; former staff are deactivated placeholders. |
| Group chat with 3 to 9 people | group DM (mpim) | Slack's group DM limit is 9. |
| Group chat with more than 9 | private channel `group-…` | |
| DM whose other person cannot be identified | private channel `archive-dm-…` | A Slack DM needs two members. |
| DM with a Chat app or bot | skipped (`--include-bot-dms` to keep) | |

Messages keep their original timestamps to the microsecond, thread structure,
edits, per-user reactions (Slack short names), @mentions as real Slack mentions
for people in `users.json`, and quoted messages as a quote block. Deleted
messages follow `--deleted tombstone|content|omit`.

**People.** Each row in `users.json` carries only a name and email so that the
importer's mapping step can merge it into an existing member without touching
their profile. Suspended, deleted, external and bot accounts are marked
deactivated. `--user-overrides` takes a JSON object keyed by Google user id
(`users/<id>`) with `name` and/or `email` for placeholders you can identify.

**Files.** Slack exports carry file links, not bytes. Two strategies:

- `--files manifest` (default): messages carry no files; `files-to-upload.json`
  lists every downloaded file with its conversation, message timestamp and
  thread, for the post-import uploader (Phase 4) to attach in place.
- `--files hosted --files-base-url https://…`: messages carry `files[]` entries
  pointing at a web host serving the store's `attachments/files` directory,
  for Slack to fetch during import.

Google Drive files that were only linked keep their link in the message text;
downloaded Drive copies get both the copy and the original link.

**Delta archives.** `--messages-since <RFC 3339>` or `--first-seen-after
<export run id>` restrict the archive to new messages, for a second import into
a workspace that already received the first one. A second import cannot apply
edits or deletions.

### Recover spaces with no remaining members (Google Vault)

The Chat API can only reach a space through one of its members. When every
member of a Space has been deleted, the messages still exist in Google's
retained copy but no account can be impersonated to read them. Vault's `ROOM`
search addresses spaces by id instead, which is the only documented way in.

```bash
googletoslack vault matters                    # list Vault matters (read-only)
googletoslack vault probe                      # report the member-less spaces and open a matter
googletoslack vault export --matter <matterId> # start MBOX exports for them
googletoslack vault status --matter <matterId> # check progress
```

Requirements:

- A Workspace edition that includes Vault (Business Plus, Enterprise Standard
  or Plus, Education Plus).
- The scope `https://www.googleapis.com/auth/ediscovery` added to the service
  account's domain-wide delegation entry. It is kept out of the main scope list
  on purpose: a JWT is refused outright if any requested scope is unauthorized,
  so folding Vault in would break every Chat and Drive call the moment the
  Vault scope was missing.
- The impersonated user needs Vault privileges in the Admin console.

The space list comes from the admin sweep in `export-workspace`, read from
`unreachable-spaces.json` or, if that is absent, from the newest run report.

Vault exports arrive as MBOX or PST with XML and CSV metadata, which is a
different shape from the Chat API. Folding them into the workspace store needs
a parser that does not exist yet, so today this path produces the export for
manual review rather than Slack-ready data.

#### Export

```bash
# Export all Google Chat data
googletoslack export

# Export specific spaces
googletoslack export --channel SPACE_ID

# Test export with minimal data
googletoslack export --dry-run

# Custom output directory
googletoslack export --output /custom/path
```

The export creates:

- `~/.config/googletoslack/data/export/export.json` - Complete message data
- `~/.config/googletoslack/data/export/attachments/` - Downloaded files
- `~/.config/googletoslack/data/export/avatars/` - User profile images

#### Transform

```bash
# Transform exported data for Slack
googletoslack transform

# Test transformation
googletoslack transform --dry-run

# Custom directories
googletoslack transform --input /custom/export --output /custom/import
```

#### Import

```bash
# Import all channels to Slack
googletoslack import

# Import specific channels only
googletoslack import --channel general --channel team-updates

# Test Slack connection
googletoslack import --dry-run

# Add channel prefix
googletoslack import --channel-prefix "gchat-"

# Rename channels
googletoslack import --channel-rename "old-name=new-name"
```

## Rate Limits & Performance

- **Google Chat**: Sequential API calls to respect rate limits
- **Slack**: 1 message per second per channel
- **Large migrations**: May take several hours depending on data volume
- **Progress tracking**: Visual progress bars for all operations

## Data Handling

- **Attachments**: Downloaded to `~/.config/googletoslack/data/`, then uploaded to Slack
- **User mentions**: Mapped via Google Directory API
- **Timestamps**: Preserved when possible (Slack API limitations apply)
- **Reactions**: Migrated with closest Slack emoji equivalent
- **Threads**: Full thread structure maintained
- **Data location**: All migration data stored in `~/.config/googletoslack/data/` (export and import directories)

## Contributing

### Development Setup

```bash
# Clone repository
git clone https://github.com/markusjura/google-chat-to-slack.git
cd google-chat-to-slack

# Install dependencies
pnpm install

# Run in development mode
pnpm start <command>

# Run tests
pnpm test

# Format, lint, and typecheck based on ultracite (biome)
pnpm check
```

### Project Structure

```
src/
├── cli/commands/    # CLI command definitions
├── services/        # Core business logic
├── types/           # TypeScript type definitions
└── utils/           # Utilities (logging, rate limiting, etc.)
```

### Testing

```bash
# Run unit tests
pnpm test --run

# Test with real data (minimal)
pnpm start export --dry-run
pnpm start transform
pnpm start import --dry-run
```

### Publishing

This package is published to [npmjs.com](https://www.npmjs.com/package/google-chat-to-slack) with automated releases.

#### Creating a Release

1. Update version and create git tag:

   ```bash
   npm version patch
   ```

2. Push the tag to trigger automated publishing:

   ```bash
   git push --tags
   ```

The GitHub Actions workflow will automatically build, test, and publish to npm.

## License

MIT - See [LICENSE](LICENSE) file for details.
