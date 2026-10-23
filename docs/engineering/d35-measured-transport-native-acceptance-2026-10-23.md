# D35: measured transport and Sync Center telemetry acceptance

2026-10-23, isolated worktree `.worktrees/d35-measured-transport-progress`, branch `audit/2026-10-23-d35-measured-transport-progress`. Product implementation based on D34 `b9d57b5e4a3c904520d9035ce211b416a6c168d9`, Node.js+Obsidian API. No GitHub Actions, release/master, native helper Issue #9, personal vault or physical test file above 100 MB.

## What is actually measured

The existing `GitHubClient` HTTP transport collector now records monotonic elapsed request time, including errors and concurrent in-flight request count/oldest duration. Sync runtime pins client and baseline to derive **HTTP request/response body bytes observed while a Sync run was in progress** (which can include unrelated concurrent client calls), request counts, network+5xx failures and cumulative per-request API duration (which may overlap). These are not wire-level socket bytes, TCP bandwidth or exclusively the cost of the logical file payload. The Sync Center labels rate as `run avg`, computed from total Sync time, **not instantaneous GitHub network speed**. It refreshes the rate when elapsed time changes without additional bytes.

On desktop only, the runtime samples `process.memoryUsage().rss` when progress snapshots are consumed and keeps the maximum observed sample; if unsupported the UI prints `unavailable`. This is a sampled process RSS peak, not a proof of absolute peak or an allocation-by-subsystem breakdown. The UI explicitly prints `not measured` for Hashing and Encryption until those operations are independently instrumented. Neither credentials nor paths are retained in metrics.

## Deterministic tests

- Regression tests were added fail-first: absent diagnostics test target, Sync Center failing 6/7, then green after implementation; later `run avg` stale across a timing tick reproduced fail-first and was fixed.
- Final local gates: `pnpm build` PASS, `pnpm test:fast` **529/529**, `pnpm test:repeat` **10 x 529/529**, `pnpm test:recovery` **79/79**, `pnpm test:resource` **11/11**, `pnpm test:feasibility` **133/133**, virtual bounded `pnpm test:soak` **1/1** 100,000,000 logical bytes, `pnpm test:github-e2e:compile` **three bundles**, metadata/package validations PASS.
- GitHub API focused regression `24/24`; new transport diag `2/2` and final Sync Center `8/8`.

## Live Windows Obsidian evidence

Approved disposable repository `diamond-crystal/test-vault-obsidian-encrypted-github-sync-multi-platform`, numeric repository ID **1284153873**; unique absent-first branch per attempt, profile and synthetic vault only.

The first strict native GUI on clean `4a01b93db59dc600511603c48b5adf479175610f` encountered an opaque GitHub GraphQL CAS server error during manual UI publish (before diagnostics assertion). The test exited 1; branch cleanup `absent-verified` plus independently read-only `READ_ONLY_CLEANUP_VERIFIED_TWICE` exit 0. Retry or publish semantic policy was **not** changed.

The next strict native encrypted UI journey on the same source commit **passed** with observed diagnostics (rows visible), encrypted tree, Unicode rename/delete/recreate, no-op, UI exceptions **0**, exit 0. The reported observed values were **4809 B request body**, **13755 B response body**, **18 requests**, **0 network/server failures**, **10706.5 ms cumulative API duration**, **0 in-flight**, **199921664 B sampled peak RSS**. The disposable branch was independently confirmed absent twice.

After a small, fail-first UI elapsed-rate refresh fix, the **final code SHA** `fb189b9123eaf0de3af90ab5d8472758cde2f67c` was also tested through the **same real native GUI strict journey**, `--mode=encrypted --journey --assert-diagnostics --expected-repo-id=1284153873` (no peer and no 100 MB load): **PASS exit 0**, `rowsVisible:true`, `remoteEncryptionVerified:true`, Unicode create/rename/delete/recreate, no-op with `uploadBytes:0`, **0 UI exceptions**, screenshot captured and disposed without leaking paths or tokens. Final diagnostics: **4809 B sent**, **13755 B received**, **18 requests**, **0 network/server failures**, **9727.4 ms cumulative API duration**, **0 in flight**, **198070272 B maximum observed renderer RSS sample**. Final disposable branch `obsidian-sync-e2e/local-fb189b9123ea-0dde5c63c841f1a5` was absent after test and **independently verified absent twice**, exit 0. No personal vault or original checkout was used.

## Unmet release gates

This is **partial diagnostics acceptance**, not full performance telemetry. The strict native UI test was run **without** `--verify-peer` and `--native-100mb`; standalone hash, encryption and decryption operation timings are not yet captured. True upload/download transport throughput at the network socket layer is unavailable; whole-run HTTP-body average is labeled precisely. Need next isolated instrumentation pass for crypto/hash/decrypt, 100 MB strict GUI with real Windows Obsidian peer, plus Linux/macOS/mobile, C2 format/interoperability, independent security and crash/network storage qualification. Do not revisit native helper/Issue #9 or change deletion/conflict semantics without user's explicit request/decision.
