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
- [ ] A fresh roster: `pnpm start slack-members`. Take it right before the
      build. Anyone who joins Slack after this point is treated as new.
- [ ] Optional, for checking your own DMs: a user token. Reinstall the Chat
      Migration app with the user scopes in `docs/slack-app-manifest.yaml`,
      then store the User OAuth Token in the keyring as `slack-user` (or set
      `SLACK_USER_TOKEN`).

## 1. Build the archive

Pick a random path segment so nobody can guess the file URLs:

```bash
TOKEN=$(openssl rand -hex 16)
BASE="https://server.tail3620c0.ts.net:8443/$TOKEN"

node --max-old-space-size=6144 -r ts-node/register bin/googletoslack.ts \
  build-slack-archive \
  --files hosted --files-base-url "$BASE" \
  --placeholder-email-domain chat-archive.hrc.email \
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

Then turn Funnel off and stop the server:

```bash
tailscale funnel --https=8443 off
```

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
- Later deltas: `--first-seen-after <runId>` or `--messages-since <time>`.
  Private channels can't be merged into, so a delta for a private channel
  arrives as a new channel. Deltas are clean for DMs only if Slack appends to
  the existing DM, which the pilot should confirm.
