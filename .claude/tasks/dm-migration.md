# HighRidge Church: full-workspace Google Chat → Slack migration

Goal: migrate every user's Spaces, group DMs and DMs into a fresh Slack
workspace with real authorship and timestamps, using Slack's export-ZIP import.

Fork: https://github.com/Jacob-HRC/google-chat-to-slack (upstream markusjura).

## Status

- [x] Setup: fork, clone, upstream remote, tests green, ARCHITECTURE.md.
- [x] Phase 1: service-account auth (DWD), Directory user enumeration, user/OU filter, scope docs. Live verification blocked until delegation is granted.
- [x] Phase 2: `export-workspace` additive store with dedupe, memberships, deleted/edited history, per-user reactions, attachments + Drive links/metadata, placeholders, dry run, delta, resume; `verify --export`. Live run blocked on delegation.
- [ ] Phase 3: Slack export-ZIP writer (channels/groups/users/dms/mpims + per-day files).
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
