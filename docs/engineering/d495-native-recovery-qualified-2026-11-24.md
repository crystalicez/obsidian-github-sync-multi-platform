# D495 — Native Auto Sync and open-editor recovery qualified

2026-11-24. D494 follow-up. Explicit user authorization to remove only the residual disposable branch `obsidian-sync-e2e/local-5b3d83a29ef1-a6d50913c3cea459` in pinned repository ID 1284153873. Existing cleanupE2EBranch helper and two independent ref readbacks succeeded (task 7c0fb1ea-9394-4d39-b36d-7f277f6ab8ec, exit 0). No other branches removed by the authorized cleanup.

## Clean native live acceptance — PASS

Clean detached checkout `.worktrees/d493-native-live-qualification` at `7eb07b7c6eda2d61cd5755050a8714a91ed933f2` (only test diagnostics and documentation changed since production build from `5b3d83a29ef10db00f6c269fee0fcdf44d40cbfe`). Reused that successful production bundle, no new product changes. Node syntax and scoped diff checks passed. Peer publication now asserts completed/manual/success and positive changedFiles, reporting bounded runtime-redacted error and API metrics on failure.

```sh
node --env-file-if-exists=../../.env.github-e2e scripts/run-obsidian-live-github-ui.mjs --mode=encrypted --verify-peer --journey --auto-journey --assert-diagnostics --expected-repo-id=1284153873
```

Task 0fe31c37-4faf-4de6-995e-e3165f7fad04, 13:48:35–13:51:36 UTC, exit 0. Actual Windows Obsidian instances, independent synthetic Vaults, real GitHub, no mock engine or Vault adapter. Branch `obsidian-sync-e2e/local-7eb07b7c6eda-a667da08627154ec`: absent-first, PASS, cleanup absent-verified; independent read-only checker task 8cf865df-f187-45de-a6c6-5d5d22ccdda4 returned READ_ONLY_CLEANUP_VERIFIED_TWICE, exit 0. All D494/D495 test branches now verified absent.

- Actual Sync now button, encrypted tree readback, Unicode create/rename/modify/delete/recreate passed.
- Auto local create/modify event: waiting/debounce observed, trigger localChange, new remote HEAD, pending 0, 19 API requests, 0 failures.
- Competing peer edit and source edit preserved both revisions. Open-editor guard, original bytes, recovery guidance, paused automatic Sync verified.
- Closing only the synthetic editor and normal manual Sync recovered the previously failing path collision, unpaused automatic Sync. No Force Pull used for recovery (initial peer setup still uses Force Pull).
- Exact final inventory equality by path, byte length and SHA-256: 5 files across both real Vaults.
- Source and peer no-op, unchanged HEAD, zero upload. UI exceptions 0.
- Source UI sync 19 API requests/0 failures; peer initial restore 29 requests/0 failures, 69,135 download bytes, 24.57s. Small fixture only; not a benchmark. Source warm no-op 2.22s; after Auto Sync 2.33s; after conflict 2.14s.

D494 earlier failed runs retained in their evidence document; this pass proves the scoped post-fix path, not universal correctness. Previous D494 regression 78/78 incl edited copy negative, editor guard 4/4, max-strict and production build remain valid for unchanged product code. No personal Vault writes, global networking changes, release/tag/merge or unrelated Re-encryption WIP changes. Actual transport interruption, native online restart, larger attachments/bulk, physical Android/iOS, full clean release qualification remain untested.
