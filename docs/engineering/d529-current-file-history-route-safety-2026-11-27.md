# D529 — Current-file History migration route safety (2026-11-27)

Starting audit HEAD 4058dc0. D528 guarded ordinary Sync but fileIdForPath still directly sampled the active route after loading remote Config and silently selected the ordinary Source Index on absence. A pending fence or an unstable adapter could therefore return a stale identity or a misleading no-history result.

RED 37bffc17-f210-428c-93c7-16932d457821: pending fence still returns an existing File ID. Fix: reuse D528 strict route/backing checks before any remote Config read; pin route presence/absence, live Settings and GitHub client, credential/save generations; recheck after Config, resolve through authenticated active route or verified ordinary fence, recheck after reading Index. Never start Sync or modify files from this read-only path. Commit history browsing unchanged. Sync Center Current file shows fixed migration-recovery guidance instead of the generic connection error.

Six fixture cases: pending fence, missing or swapped backing, nonboolean active route probe, route appearing during Config read or Index read. Each first proves successful normal file lookup, then rejects uncertain lookup without upload or note changes and retains existing Sync status. The physical isolated installed Runtime rehearsal also removes the active marker after a verified Destination sync and checks that file history rejects rather than falling back to Source. UI test verifies guidance and no automatic Sync. First UI test attempt incorrectly counted listCommits as Sync; corrected the fixture to count runManualSyncFromUi.

Validation (all final exit 0):
- Settings/Runtime 80173a1a-e7e5-45ed-ba64-ef7cb7586d68: 82/82.
- Sync Center d550e37e-1d62-4c2d-8b60-18720c7197cc: 45/45.
- Installed rehearsal fe4ef284-739e-4ae1-866e-4447bae78303: 6/6.
- Publication race contract 502aeedf-ab0a-43ef-9cb6-474a46ed02d7: 12/12.
- Maximum strict 8d685bce, production build 82be719a, metadata e6ff2558, package 6531b584.

Limitations: cooperative sampled checks, not an OS-wide lock; no new migration or native-device authority. D528 blocked publication-mutation-race validation remains outstanding; current exact-source Full Fast, native cutover/peer and Android migration, protected operations, public Execute and release remain gated. No personal Vault, default branch, tag or release writes.
