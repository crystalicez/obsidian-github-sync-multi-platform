# D493 — Clean-source installed Obsidian / live GitHub encrypted peer acceptance

Date: 2026-11-24. User explicitly approved a separate clean detached worktree. Tested source SHA `e5b90af83185651919cbd5a531f673ed086048cd`, worktree `.worktrees/d493-native-live-qualification`. Original audit checkout's unrelated Re-encryption WIP was preserved. `git status --porcelain` empty before build and before live run. `pnpm install --frozen-lockfile --offline` reused all 122 packages; production `pnpm build` exit 0.

## Actual installed application, real transport — PASS

Command (from clean worktree):

```sh
node --env-file-if-exists=../../.env.github-e2e scripts/run-obsidian-live-github-ui.mjs --mode=encrypted --verify-peer --journey --assert-diagnostics --expected-repo-id=1284153873
```

Read-only preflight passed separately. Live task `e0d97ee9-9203-4ad3-b225-9e0cd9837d8e`, exit 0, 2026-11-24 12:55:33–12:57:55 UTC. Disposable repository ID 1284153873; absent-first branch `obsidian-sync-e2e/local-e5b90af83185-fb7d76fa1b407c97`. Final runner output: status PASS, cleanup absent-verified, remoteHeadChanged true, remoteEncryptionVerified true, peerRestored true, screenshotCaptured true, uiExceptions 0. Screenshots and synthetic Vault/profile cleaned by runner; no retained screenshot to inspect. Credentials consumed from existing ignored root env without displaying or persisting them in tracked files.

| Verified journey | Outcome |
|---|---|
| Initial normal Sync to absent branch, no Force Push | PASS |
| Modify actual Obsidian note, click Sync now | PASS; HEAD advanced |
| Inspect immutable GitHub encrypted tree and ciphertext | PASS; opaque-stable V4 AES-GCM config, no logical note path or tested plaintext substring |
| Warm no-op Sync | PASS; zero changed files, zero upload, unchanged HEAD |
| Create nested Unicode and scratch notes | PASS |
| Rename, modify and delete together | PASS |
| Recreate deleted note | PASS |
| Independent installed peer Force Pull | PASS; exact expected note text, renamed original absent, visible editor |
| Peer competing edit, stale source edit | PASS; source preserved both conflict revisions |
| Disposable branch cleanup | PASS; absent-verified |

## Observed measurements (individual runs, not suite totals)

| Metric | Source UI Sync | Peer restore |
|---|---:|---:|
| GitHub API requests | 19 | 26 |
| API failures | 0 | 0 |
| Upload bytes | 4,845 | 0 |
| Download bytes | 22,271 | 57,533 |
| Peak renderer RSS bytes | 190,906,368 | 196,804,608 |
| In-flight API requests at end | 0 | 0 |

Peer restore wall time 11,628.7 ms. Warm no-op wall time 1,990.8 ms, 5 API requests, 0 failures, 0 upload bytes, push/pull 0/0 and unchanged HEAD. Metrics are single small-fixture observations, not performance guarantees.

## Boundaries and remaining gates

Actual two Windows Obsidian instances, separate real synthetic Vaults, production bundle and actual GitHub API. Not simulated Vault adapters or fake engine. Most actions use CDP and actual Vault API; source Sync now button clicked in real UI. Setup and other sync actions are programmatic. Peer pull uses Force Pull; conflict verification is on the source Vault after competing peer commit, not an additional peer catch-up proof. No actual network interruption, Auto Sync local-event/debounce journey, live restart, large attachment/bulk workload, plaintext native peer journey, or physical mobile testing in this run. Prior D492 offline native and process recovery evidence remains separate. No release/tag/merge or personal Vault writes. Original unrelated WIP retained; clean detached worktree retained for further qualification.

Next: expand the actual native journey with Auto Sync and controlled transport interruption/recovery, then verify both Vaults converge; separately qualify physical Android/iOS and release candidate.
