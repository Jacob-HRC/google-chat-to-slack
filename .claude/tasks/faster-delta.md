# Faster delta exports

## Problem (measured 2026-10-19)

The `--since 2026-09-24T12:40:00Z` delta took ~4.4 s per conversation, about
9 hours for 7,201, though only ~370 conversations had any activity. Sampling
the running process for 60 s: 14 conversations, 82 CPU-seconds, 5.4 GB
written. By 5,469 conversations it had written 1.7 TB to the export SSD.

- `attachments/index.json` is 202 MB (51,863 records) and is written twice
  per conversation: `saveAttachmentIndex` in `syncSpace` and the
  unconditional `ctx.save()` at the end of `syncAttachments`, even with zero
  keys. `syncAttachments` also walks all 51k records to build `claims` first.
- Every conversation is listed, merged and rewritten (`saveMessages` twice),
  even when Google says it has had no activity since the cutoff.

Not the problem: Chat API calls (`--since` already filters server-side with
`createTime > since`), JWT clients (cached per subject).

## Fixes (Jacob asked for all of them)

1. **Attachment index only when it changed.** `syncAttachments` returns early
   with no keys and saves at the end only if it processed a record.
   `syncSpace` saves the index only when `indexAttachments` added a record.
   `syncSpaceAttachments` doesn't call `syncAttachments` without pending keys.
2. **Skip inactive conversations in `--since` runs** (`--skip-inactive`,
   default on; `--no-skip-inactive` to turn off). Skip when the store already
   has the conversation complete, Google's `lastActiveTime` (from this run's
   listing) is before the cutoff, and `membershipCount` is unchanged. The
   space record still gets the fresh listing (readers, raw) saved, with no
   message listing or rewrite (named Spaces later also refresh members). Checked on real data: of 362 conversations with
   messages after the cutoff, all had `lastActiveTime` after it, or got their
   messages after the listing was taken.
3. **Relative `--since`**: `30d`, `2w`, `12h` as well as RFC 3339, so a
   routine delta can re-check the last month (catching edits, deletions and
   reaction changes there) without touching older history.
4. **Reaction removals**: the content hash already includes
   `emojiReactionSummaries`, so a reaction change is an update and triggers
   a re-fetch. Missing case: all reactions removed (`hasReactions` false), so
   stored reactions stay stale. Re-fetch when the stored message had any.
5. **No message rewrite without a change**: `MergeDiff.changed` is set by any
   path that alters a stored message beyond its last-seen stamps (added,
   updated, deleted, newly missing, reappeared, re-hashed, reactions needed).
   `syncSpace` skips the first `saveMessages` when nothing changed (it also
   runs when indexing added attachment keys), and the second unless reactions
   were fetched.
   No code reads `lastSeenRun`/`lastSeenAt`; they now mean "last run that
   rewrote this message", as do the `history[].runId/seenAt` copied from them.

Also: a resumed `--since` run listed full histories, because `since` was only
applied in `delta-since` mode. It now applies whenever `--since` is given.

## Tasks

1. [x] export-store: `MergeDiff.changed`, reaction-removal refresh.
2. [x] attachments: early return and conditional save.
3. [x] workspace-export: `isInactiveSince` (pure), skip path, conditional
   saves, `since` on resume, skipped count in the summary.
4. [x] CLI: `--skip-inactive`, relative `--since` (`parseSinceArg`, pure).
5. [x] Tests for each pure piece.
6. [x] Docs: README export section, ARCHITECTURE, dm-migration notes.
7. [ ] Restart the delta on the T3 box with the new code.

## Progress notes

### 2026-10-19

- `export-store.ts`: `MergeDiff.changed`, set by added, updated, deleted,
  reappeared, newly missing, re-hashed, or reactions needed. Unchanged
  branch moved to `mergeUnchanged` (complexity). The updated branch now
  refreshes reactions when the stored message had any, so a removal clears
  them.
- `attachments.ts`: `syncAttachments` returns before building claims when no
  key is in the index, and saves at the end only if a record was processed
  since the last save. Claims lookup uses a Set.
- `workspace-export.ts`: `isInactiveSince` (pure) and `skipInactiveSpace`;
  `since` comes from `options.since` in every mode (resume included);
  messages saved only when `diff.changed`, again only for reactions or new
  attachment keys; index saved only when `indexAttachments` added a record;
  `syncSpaceAttachments` returns early without pending keys.
- `export-workspace.ts`: `--skip-inactive` (default on), `--since` accepts
  `30d`/`2w`/`12h` via `parseSinceArg` (timestamps.ts) and prints the
  resolved time.
- Tests: merge `changed` across every path, reaction removal, empty partial
  listing; `isInactiveSince` cases; `parseSinceArg`; `syncAttachments`
  saves.
- Docs: README export section, ARCHITECTURE run flow and merge rules.

Review round 1 (two reviewers, 2026-10-19). No persistence path loses data.
Fixed:
- Skipped conversations stopped retrying downloads: `isRetryable` (pending,
  or failed with attempts left) now drives `pendingAttachmentKeys`, and a
  space with a retryable record is never skipped (`retryableSpaces`, built
  once per run). Exhausted failures no longer force a 202 MB index save.
- A conversation never listed in full is listed without the cutoff, and
  `isInactiveSince` requires `lastFullListingAt`, so a `--since 30d` run
  can't store only a window and then skip the conversation for good.
- `isInactiveSince` also refuses when the newest stored message is after the
  cutoff (guards against `lastActiveTime` moving back after a deletion).
- Skipped named Spaces refresh their members (one call; swaps keep the
  count). Group-chat swaps still need a run without the skip.
- The cutoff is saved on the run pointer; `--resume` reuses it and warns if
  a different one is given.
- `parseSinceArg`: case-insensitive units, out-of-range spans rejected,
  clearer error.
- Docs: what the last-seen stamps mean now; Vault-delta overlap note.
- New end-to-end tests (workspace-export-run.test.ts, Google mocked): skip
  path, window listing, no rewrite of an unchanged history, reactions saved,
  full listing for a never-fully-listed conversation, resume cutoff.

Review round 2 (2026-10-19). No data-loss path in the change. Fixed:
- Gap risk (`--since 30d` after 45 days would never list days 31-45):
  replaced by a per-conversation cutoff, `listingCutoff` = the earlier of
  `--since` and an hour before the conversation's own `lastMessagesSyncAt`.
  `isInactiveSince` compares against that cutoff too. This also covers
  partial `--space` runs, failed spaces (they keep their last good
  `lastMessagesSyncAt`) and resumed runs, so no run-level guard is needed.
- Pre-existing crash window: new messages saved before their attachments
  were indexed lost their keys for good if the process died in between.
  `indexAndSaveMessages` now indexes first, and re-indexes every message of a
  space whose previous state isn't `complete`.
- `--resume` help text matches the saved-cutoff behaviour.
- Tests: per-conversation cutoff (unit and end to end), index and history
  untouched on an unchanged run with attachments, attachment keys stored with
  new messages, pending downloads block the skip, half-synced repair.
Left: a resumed run's pointer still gets the resume time as `startedAt`
(pre-existing, cosmetic now that cutoffs are per conversation).

Review round 3 (2026-10-19). No data-loss path; every end-to-end test
proves its claim. Fixed:
- A failed member listing now keeps the stored `membershipCount`
  (`rawWithKnownMembers`), so a later skip can't freeze a stale member list.
- Re-index in full also when a conversation has no state (old code saved
  messages before its first state), and fetch every unfetched reaction of a
  part-way conversation (`reactionsToFetch`).
- `messageLimit` (test hook) keeps the previous `lastMessagesSyncAt`.
- Wording: last-seen stamps, item 5 above, `--since` help.
- Test: a skipped conversation leaves its state untouched.

Review round 4 (2026-10-19). No data-loss path. Fixed:
- A new space whose first member listing fails stores no member count, and
  a space with no stored members is never skipped.
- Members refreshed on a skipped named Space are resolved into users.json.
- A failed reaction fetch unsets `reactionsFetchedRun`, and an unchanged
  message is refetched when it has stored reactions but no successful fetch,
  so a removed or swapped reaction can't stay stale after a failure.
- Restart plan: start a fresh `--since 2026-09-24T12:40:00Z` run, not
  `--resume` (the stopped run was started by the old code and saved no
  cutoff).

Review round 5 (2026-10-19). No data-loss path. Fixed:
- An update queued for a reaction refetch unsets `reactionsFetchedRun`, so a
  crash before the fetch can't leave the old reactions looking current; the
  part-way repair also picks up messages with stored reactions.
- No reaction refetch for deleted messages (round 4 had made a failed fetch
  on one repeat forever).
- Skipped named Spaces recompute `derivedDisplayName` (renames).
Checked: only 5 stored API conversations have no stored members, so the
round-4 guard costs nothing.

Review round 6 (2026-10-19). Nothing at medium or above. One low note
fixed: a conversation whose previous state was `complete` is marked
`messages-synced` (keeping its previous sync times) before the first write,
so a crash between writes triggers the part-way repair next run.

Codex (GPT-6.1 Sol) round 1 (2026-10-19): request changes, three findings,
each reproduced against the exporter. Fixed:
- P1: `lastMessagesSyncAt` (and `lastFullListingAt`) was stamped after the
  listing and save, so a stall over an hour could claim coverage the listing
  never had. Now the listing's start time (`listedAt`).
- P1: a failed reaction fetch left the conversation complete, and later
  deltas skipped it; reactions outside the window were never retried.
  `state.reactionsPending` (from `pendingReactions`) blocks the skip, and
  `reactionsToFetch` always includes stored pending reactions. Older states
  without the field are counted once from their messages (9 s over the whole
  store; it currently has none pending) and the count saved.
- P2: refreshed members were saved before the conversation was marked
  part-way, so a crash could leave them behind a complete state and later
  skips never resolved them. `markPartWay` now runs before the space is
  saved (replacing the later marker), and skipped spaces resolve any stored
  member missing from users.json.

Full Claude re-review after Codex (two reviewers, 2026-10-19). No data-loss
path in the fixes. Fixed:
- Coverage moved to a new `listedThrough` field: old-code `--since` runs
  stamped `lastMessagesSyncAt` after listing only a window, so trusting it
  could hide a hole between a conversation's last full listing and that
  cutoff. Older states fall back to `lastFullListingAt`. Checked on the real
  store: no conversation is in that position today.
- Reaction fetches capped at three failures (`reactionFetchAttempts`), so a
  permanently failing fetch can't block skips and force rewrites forever;
  new content earns fresh attempts.
- The space record is saved before the state turns complete, so a crash
  can't leave a DM's derived name stale behind a skip.
- Tests: write order proved at the first `saveSpace`; an older state with
  unfetched reactions isn't skipped; a skipped DM resolves members missing
  from users.json; the reaction retry cap.
- Docs: run-flow order, skip description, coverage field.
Checked: every Google-listed conversation in the store has `lastActiveTime`,
so a missing one costs nothing in practice.

Post-Codex Claude round 2 (2026-10-19): nothing at medium or above. Fixed
the low items:
- Skipped conversations no longer retried failed user lookups (13 users are
  `unknown` in the store). `retryUnresolvedUsers` retries them once per run
  after the spaces and keeps only a directory match (a stored record can't
  tell deleted from external).
- `users.json` is saved only when a referenced person changed.
- Docs: the reaction retry cap is permanent until content changes; the
  `--refresh-users` help says it needs `--no-skip-inactive` to reach
  skipped conversations.

Post-Codex Claude round 3 (2026-10-19): nothing at medium or above. Fixed:
users.json saving is driven by `usersDirty`, cleared only after a save
succeeds, so a failed save (full disk) is retried by the next conversation
or the end-of-run retry instead of being forgotten. The retry keeps a
hand-made `aliasOf` when it takes a directory match.

Post-Codex Claude round 4 (2026-10-19): nothing at medium or above in the
diff. One pre-existing low finding fixed: `fromDirectory`/`asPlaceholder`
(user-resolver.ts) dropped `aliasOf` on re-resolution, so a `--refresh-users`
run or a retried `unknown` lookup could undo a recover-names merge. Both now
keep it. Real store: 11 aliased records, all `deleted`, so not hit today.

Codex (GPT-6.1 Sol) round 2 (2026-10-19): request changes, two P1s, both
reproduced. Round-1 fixes, write order, dirty users and alias kept were
confirmed. Fixed:
- P1: the three-failure reaction cap abandoned reactions that exist in
  Google (a temporary outage for three runs = lost reactors for good, even
  for a full listing). Replaced by backoff (`reactionRetryDelayMs`: 1 h
  doubling to a week, `reactionRetryAfter` per message, never given up).
  `reactionsDueAt` on the state lets a conversation be skipped while it
  backs off and visited once due; the merge queues a refetch only when due.
- P1: older states' `lastFullListingAt` was stamped after saving, so a stall
  during the old code's save could claim coverage the listing never had.
  `legacyCoverage` bounds it by the start of the latest recorded run that
  began no later than the stamp (the listing ran inside that run); with no
  such run the conversation is listed in full. On this store that moves the
  first cutoffs to about an hour before the 2026-09-24 run's start.

Full Claude re-review after Codex round 2 (2026-10-19): nothing at medium or
above. One low, theoretical finding fixed: `legacyCoverage` is given the
recorded runs other than the current one (`earlierRuns`), so a clock stepped
back can't make the current run's start the bound. Informational, by design:
messages with stored reactions that a full listing no longer returns keep
retrying weekly.
