# Slack import runbook

How to take the exported Google Chat store into the HighRidge Church Slack
workspace without losing anything or changing anyone who is already there.
Run the steps in order. Each step says what to check before you move on.

Slack's import runs in the admin UI and has no API outside Enterprise Grid,
so steps 3 and 4 are done by hand. Everything around them is scripted.

## What the import does, and what can go wrong

- People are matched by email. An address that already belongs to someone in
  Slack merges into that account. Everyone else is created **deactivated**:
  they can't sign in, aren't billed, and get no invitation. Reactivate them one
  at a time when the migration is announced.
- Slack imports a DM only when every person in it is imported. Anyone without
  an address gets a placeholder at `chat-archive.hrc.email`, so their DMs come
  through too.
- Files: messages point at each file by URL, and Slack downloads them while
  the import runs. The URLs are served from this box by `serve-files`, behind
  Tailscale Funnel on port 8443. Slack stores whatever the URL returns, so the
  server answers only the exact files in the archive and refuses to start if
  any file is missing or the wrong size.
- An import can be undone with **Reverse Import** (Import/Export Data page).
  That removes the imported messages, files and new channels. Accounts it
  created stay, deactivated.

## 0. Before you start

- [ ] The export has finished: `pnpm start verify --export` is clean, or its
      failures are understood (files deleted from Drive, for example).
- [ ] Names recovered: `pnpm start recover-names --aliases data/vault-exports/aliases.json --overlay data/vault-exports/users-overlay.json`.
      Addresses supplied by hand live in `data/vault-exports/manual-addresses.json`
      (checked against the Google directory and the Slack roster first, so no
      address belongs to someone else).
- [ ] Channel visibility reviewed: `pnpm start channel-visibility` adds any new
      Spaces to `data/slack/channel-visibility.csv` (decisions already made are
      kept); check every `public` row. A public channel shows its whole
      history to the whole workspace. Unlisted Spaces are built private.
      The same list carries `last_message` and `archive`. `--archive-before
      <date>` fills `archive` for rows with no decision yet (last message
      before the date, or none). Rows marked `yes` still import active,
      because Slack's importer skips a channel the export marks archived;
      they are archived after the import (step 5b).
- [ ] A fresh roster: `pnpm start slack-members`. Take it right before the
      build. Anyone who joins Slack after this point is treated as new.
- [ ] Optional, for checking your own DMs: a user token. Reinstall the Chat
      Migration app with the user scopes in `docs/slack-app-manifest.yaml`,
      then store the User OAuth Token in the keyring as `slack-user` (or set
      `SLACK_USER_TOKEN`).

## 0b. Move files too large for Slack to Google Drive

Slack's importer never fetches files over about 100 MB (the pilot saw it take
up to 62.6 MB) and refuses anything over 1 GB. Those go to a private Drive
folder, once per distinct file, well before cutover (116 GB took hours):

```bash
node --max-old-space-size=6144 -r ts-node/register bin/googletoslack.ts stage-large-files --dry-run
node --max-old-space-size=6144 -r ts-node/register bin/googletoslack.ts stage-large-files
```

Pass `--shared-drive <id>` to keep the folder in a Shared Drive rather than
the admin's My Drive (and pass it again with `--share`). Every member of that
Shared Drive can open every file, including attachments from private DMs, so
choose one with few members. My Drive needs
`https://www.googleapis.com/auth/drive.file` on the service account's
domain-wide delegation; a Shared Drive needs
`https://www.googleapis.com/auth/drive`. Reruns skip files already uploaded. The files stay
private until announcement day, when `--share` grants access silently (no
emails): domain-wide for files from public channels, otherwise each active
participant of the conversations the file appeared in.

## 1. Build the archive

Pick a random path segment so nobody can guess the file URLs:

```bash
TOKEN=$(openssl rand -hex 16)
BASE="https://server.tail3620c0.ts.net:8443/$TOKEN"

node --max-old-space-size=6144 -r ts-node/register bin/googletoslack.ts \
  build-slack-archive \
  --files hosted --files-base-url "$BASE" \
  --placeholder-email-domain chat-archive.hrc.email \
  --deleted tombstone \
  --meeting-chats fold \
  --large-files data/slack/large-files.json \
  --channel-visibility data/slack/channel-visibility.csv \
  --vault-prefix archive- \
  --users-overlay data/vault-exports/users-overlay.json \
  --user-overrides data/vault-exports/manual-addresses.json \
  --output data/slack-archive/hrc-full.zip
```

The larger heap is needed for the full store; `pnpm start` is fine for a
`--space` pilot. Check the report:

- **Validation** must say the archive matches the importer's rules. Errors
  block the write.
- **People** should show 0 with no address and no DMs at risk.
- **Files** shows how many are hosted and how many Drive items stay as links.

Beside the ZIP you get `hrc-full.archive-manifest.json`,
`hrc-full.message-index.json`, `hrc-full.members-before.json` and
`hrc-full.hosted-files.json`. Keep them with the ZIP. Verification needs them.

## 2. Serve the files

```bash
pnpm start serve-files --hosted-files data/slack-archive/hrc-full.hosted-files.json --check-only
pnpm start serve-files --hosted-files data/slack-archive/hrc-full.hosted-files.json
# in another terminal:
tailscale funnel --bg --https=8443 http://127.0.0.1:8787
```

Use port 8443, not 443. Port 443 on this box carries T3 Code, and turning
Funnel on there would publish it.

Check one URL from outside (a phone off Wi-Fi works): copy any `url` from
`hosted-files.json` into a browser. The file should download.

## 3. Upload the ZIP to Slack

Slack admin → **Tools & settings → Workspace settings → Import/Export Data →
Import → Slack**. Upload the ZIP (not the sidecars).

## 4. The mapping screen

- **Users:** match the counts to the build report. The "merge" people are
  the members already in Slack. For everyone else choose **Create as
  deactivated users** (it can be applied to all unmapped users at once).
  Never pick "Invite" or "Create as active".
- **Channels:** imported Spaces are private channels. Names already taken in
  Slack were renamed at build time (`general` → `general-2`), so nothing
  merges into an existing channel.
- Start the import. Leave `serve-files` running and watch its progress line.
  The count of fetched files should climb toward the total.

## 5. Verify

When Slack reports the import complete:

```bash
pnpm start verify-slack --archive data/slack-archive/hrc-full.zip
```

It checks:

- every existing member is unchanged (name, email, state, guest flag);
- every new account is deactivated. Any active new account is a failure;
- every person landed as planned (merged into the right account, or created);
- every message is present at its original timestamp, replies are in their
  threads, and hosted files arrived at the right size, for each conversation
  the tokens can read.

A bot can't read other people's DMs, so those are reported as not readable,
never as passed. Spot-check a few in the UI. The full report is written
beside the ZIP as `hrc-full.verify-<time>.json`.

## 5b. Archive the quiet channels

```bash
pnpm start archive-channels --archive data/slack-archive/hrc-full.zip --dry-run
pnpm start archive-channels --archive data/slack-archive/hrc-full.zip
```

The bot joins and archives each public channel marked `archive=yes` (the app
needs `channels:manage`). It cannot join private channels, so each of those is
archived with the token of a member who approved the app for the reaction
restore (step 6; the approval includes `groups:write`). Slack shows that
member as having archived the channel. Run it again after the announcement as
people approve; whatever no connected member can reach is listed in
`hrc-full.archive-private.txt`.

Then turn Funnel off and stop the server:

```bash
tailscale funnel --https=8443 off
```

## 6. After the announcement: restore reactions

Slack's importer drops reactions, so the archive writes them into each
message as a line (`_Reactions: :+1: Ken Kicker_`). Real reactions can come
back only one way: each person approves the app once, and their own token
re-adds the reactions they made. Nobody else's token can add them.

Setup, once:

- The app has the user scopes and redirect URL in
  `docs/slack-app-manifest.yaml` (reinstall after adding them).
- The app's Client ID and Client Secret are in the keyring as
  `slack-client-id` and `slack-client-secret`, or set as `SLACK_CLIENT_ID`
  and `SLACK_CLIENT_SECRET`.

Then:

```bash
pnpm start slack-connect            # add --allow <SlackId>… for a test
tailscale funnel --bg --https=8443 --set-path=/slack http://127.0.0.1:8788/slack
# send people https://server.tail3620c0.ts.net:8443/slack/connect
pnpm start slack-connect --list     # who has connected
pnpm start restore-reactions --archive data/slack-archive/hrc-full.zip --dry-run
pnpm start restore-reactions --archive data/slack-archive/hrc-full.zip
```

Rerun `restore-reactions` as more people connect. It only adds reactions
(one already there counts as done). Where a message's author has connected,
it also edits the text line so it names only the people still missing, and
removes the line once none are missing. Slack shows those messages as
"(edited)". Only an author can edit their own message, so lines on messages
from people who never connect stay as they are. What each run did is kept in
`hrc-full.reactions-restored.json`, so `--only` batches build on each other.

The line is edited only while it is exactly as the archive wrote it, at the
end of the message; a message someone edited in Slack is left alone and
counted. Progress is saved after each person, and the ledger is tied to the
build: after a Reverse Import and re-import, move
`hrc-full.reactions-restored.json` aside before running again.

Tokens live in the keyring as `slack-user:<SlackId>`. Turn Funnel off when
people are done connecting.

## If files did not arrive

If `serve-files` logged no fetches, or `verify-slack` reports file problems,
Slack did not take the files from the URLs.

1. Reverse Import.
2. Rebuild with `--files manifest` instead of `--files hosted`.
3. Import again, then attach files as thread replies:

```bash
pnpm start upload-files --archive data/slack-archive/hrc-full.zip --dry-run
pnpm start upload-files --archive data/slack-archive/hrc-full.zip
```

The uploader resumes where it stopped (`hrc-full.uploaded.json`). It can post
in channels, and in the token owner's own DMs with a user token. **It can't
reach anyone else's DMs.** That limit is the reason the hosted route comes
first.

## Pilots and later imports

- A pilot imports one conversation with `--space <id>`. If you keep the
  pilot, build the full archive with `--exclude-space <id>` so it isn't
  imported twice. Whether Slack de-duplicates a re-imported DM isn't
  documented. Don't rely on it.
- After a Reverse Import and a re-import of the same archive, the desktop app
  can keep showing the reversed copies of files as "This file was deleted".
  Reload the app (Cmd+Shift+R) before assuming anything is missing.
- Later deltas: `--first-seen-after <runId>` or `--messages-since <time>`.
  Private channels can't be merged into, so a delta for a private channel
  arrives as a new channel. Deltas are clean for DMs only if Slack appends to
  the existing DM, which the pilot should confirm.
