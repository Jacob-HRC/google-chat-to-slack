# archive-channels: find imported channels by the ZIP's created time

## Why (2026-10-20 channel test)

The gchat-old- channel test imported 3 private Spaces plus the members
channel. verify-slack passed. archive-channels then reported all 3 as
`needs-member` even though Jacob (connected, groups:write) was in them.

Cause: the guard against archiving a pre-existing namesake accepted only
channels whose Slack `created` was at or after the manifest's `builtAt`.
Slack's importer keeps the `created` the ZIP gives each channel, to the
second (ZIP 1663698678 → Slack 2022-09-20T18:31:18Z), and the build gives a
Space the earlier of its creation and its first message. So every imported
Space channel was rejected, and the full import would have hit the same wall
on all 289 gchat-old- channels.

## What changed

- `readArchiveCreated` reads `created` per name from the ZIP root
  channels.json and groups.json.
- `createdByImport`: when the ZIP has a time, only an exact match counts;
  the after-build rule applies only when it has none (an `mtg-` series whose
  first meeting has no createTime).
- Private targets go through the pure `planPrivateArchives`:
  `archive`, `not-imported` (a namesake with another created: left alone and
  kept off the admin list), `needs-member` (admin list, with the expected
  created in UTC or "created after <builtAt>"), and `check-delta` (any other
  private target in a delta build: never archived, never listed, since a
  delta reuses the full import's name and created time).
- A missing ZIP gives a clear error.
- Builder, found in review: an `mtg-` series channel replaced its member
  array when a later meeting joined, but groups.json held the first array,
  so later meetings' people weren't members in Slack. It now grows in place,
  from a copy so the first meeting's own manifest entry keeps its people.
- Runbook: how the match works, the admin-list check, reverse the channel
  test before the full import, a fresh roster before a delta, UTC times.

## Verified live

Run from a side checkout on the T3 server (main checkout untouched): dry run
picked exactly the 3 channels, the real run archived them with Jacob's
token, and later dry runs report them `already`.

## Open

- Public channels keeping `created` is unconfirmed (the test had none). If
  they come back `not-imported`, compare one with channels.json.
- No CLI-level test of `archivePrivate`'s wiring.

Reviews: five Claude rounds (findings fixed each time), then Codex: approve.
