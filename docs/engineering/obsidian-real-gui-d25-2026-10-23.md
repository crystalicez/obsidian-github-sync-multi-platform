# Stage D25 — Actual Windows Obsidian two-instance encrypted acceptance; telemetry gap exposed

Date: 2026-10-23. Scope: Node.js plugin product source `f261b3e99c358663bbcf23298b098ac706e8a021`; user-approved **test repo only** `diamond-crystal/test-vault-obsidian-encrypted-github-sync-multi-platform`, numeric ID **1284153873**. Native OS helper / [TOCTOU Issue #9](https://github.com/crystalicez/obsidian-github-sync-multi-platform/issues/9) remains explicitly **DEFERRED**, not touched.

## Clean, unambiguous test baseline

A detached, isolated, clean linked worktree at `.tmp/staged-production-6c67c8a/.tmp/d25-clean-obsidian-f261` was created at exact source SHA `f261b3e99c358663bbcf23298b098ac706e8a021` without modifying user's Zed root checkout or the audit worktree's concurrent untracked scripts. Local `pnpm install --offline --frozen-lockfile` reused 122 cached dependencies with 0 downloads; `pnpm build` and TypeScript compile passed; `git status --porcelain` empty. Installed Windows Obsidian executable exists. Runner `scripts/run-obsidian-live-github-ui.mjs` creates random synthetic vault, isolated profile and CDP ports, refuses attaching to nonmatching vault/window, copies **compiled product plugin** into synthetic vault and uses a random GitHub branch. Injected pinned repo ID via ignored **non-secret** `.tmp/d25-repository-id.env`; original root ignored `.env.github-e2e` never changed or printed. Physical file test well below 100 MB. No GitHub Actions, master, tag, release or personal vault.

Preflight only on new branch: **PASS**, target repo ID1284153873, default branch `main`, source SHA exact, requested encrypted mode, branch absent.

## Strict metrics acceptance found genuine missing functionality

First real encrypted two-Obsidian journey with `--mode=encrypted --verify-peer --journey --assert-diagnostics`:

- GitHub Force Push and subsequent Sync Center interaction had already changed remote HEAD; encrypted remote tree/opaque AES-GCM content proof was **PASS**, `uiExceptions:0`.
- Strict UI telemetry failed at `captureSyncedCenter`: `progressSnapshot.diagnostics` returned **null** and labels for Upload API / GitHub API / in-flight requests / Peak renderer RAM were **absent**. Runner stopped before second-device recovery, reported FAIL exit 1. **Branch cleanup `absent-verified`**. Do not count strict diagnostics/telemetry acceptance as green.
- Source confirmation: `src/lib/v4/progress.ts` has no `diagnostics` field on `V4SyncProgressSnapshot`; `src/views/sync-center.ts` renders phase timings and push/pull count but has **no throughput/latency/RAM rows**; `src/lib/v4/transport-metrics.ts` and `src/lib/github-api.ts` collect some request counts/bytes only for the GitHub client, but do not currently expose a per-run telemetry snapshot in the Sync Center or capture API latency and peak renderer RSS. This is **functional telemetry work to implement**, not a UI test naming issue alone. The user's previously requested Upload / Download / Encryption / Hashing / GitHub API latency / Peak RAM and actual GitHub network speeds are not fully delivered in this product SHA.

## Main encrypted Obsidian two-device journey verified

Second real GUI run on a fresh, absent-first disposable branch **without only the optional `--assert-diagnostics` gate**, otherwise `--mode=encrypted --verify-peer --journey`, exited **0 PASS**:

- `remoteHeadChanged:true`, `remoteEncryptionVerified:true`, `peerRestored:true`, `uiExceptions:0`, `screenshotCaptured:true`; real Windows Obsidian UI from both independent processes and synthetic vaults.
- Journey: nested Unicode and scratch notes; rename, modify and delete in a batch; recreate deleted note; a two-device simultaneous Copy conflict **retained both revisions**. Device B restored/decrypted GitHub remote data and returned a peer screenshot.
- No-op warmed small vault: `no-change`, 0 pushed, 0 pulled, `~2,270ms` observed (not a throughput benchmark). The peer download segment showed a measured wall time around `6,952ms` but not a per-request speed/latency metric.
- Test helper reported `cleanup:absent-verified`. Separate read-only checker `scripts/check-github-e2e-branch-absence.mjs` from audit worktree rechecked that exact branch **absent twice** with correct repository ID 1284153873; exit 0. Synthetic test vaults and profiles disposed by the test runner after process termination. Screenshots were stored only in ignored `.tmp` as synthetic evidence; no user vault data.

## Correct readiness conclusions

- Latest Node.js plugin SHA now has additional **actual Obsidian Windows two-instance encrypted acceptance**, not just in-memory GitHub E2E. Good supporting evidence for conflict, recovery, UI exceptions and encryption on this OS/build.
- **Sync Center telemetry remains a reproducible product gap**. Do not hide it or label the strict UI metrics test passing. Implement per-run metrics with truthful labels and safe desktop/mobile capabilities before re-running strict diagnostics.
- Does not prove macOS/Linux/iOS/Android, network-drive durability, raw power loss, native OS TOCTOU, all conflict merge UI cases, C2 cross-device protocol coordination or final production release. Issue #9 remains parked until user explicitly reopens it. No code/remote protocol change made in D25.
