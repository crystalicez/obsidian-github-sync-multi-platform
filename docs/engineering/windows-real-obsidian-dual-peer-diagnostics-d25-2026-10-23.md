# Stage D25 — Windows native Obsidian dual-instance encrypted acceptance and missing diagnostics finding

Date: 2026-10-23. User retains **Node.js + Obsidian API primary**. The intentionally deferred [filesystem OS-level TOCTOU Issue #9](https://github.com/crystalicez/obsidian-github-sync-multi-platform/issues/9) remains untouched. This stage made **no production code, WAL, remote protocol, native binary, master, release or GitHub Actions change**.

## Immutable test source and safe isolation

- Exact product code SHA `f261b3e99c358663bbcf23298b098ac706e8a021` (D24 test-only audit commit, product `src/` equivalent to D22).
- Detached, clean Windows worktree `.tmp/d25-windows-ob-ui-f261b3e-20261023`, **not** the user's Zed root checkout. `pnpm install --offline --frozen-lockfile --ignore-scripts` PASS (122 cached packages, no download); `pnpm build` PASS; Obsidian Windows executable present at `C:\Program Files\Obsidian\Obsidian.exe`.
- Manual entrypoint `scripts/run-obsidian-live-github-ui.mjs` uses independent randomized Obsidian profiles/vaults, CDP ports, ephemeral passphrase and screenshots of synthetic content only. Hardcoded test GitHub repo identity **1284153873**, repository `diamond-crystal/test-vault-obsidian-encrypted-github-sync-multi-platform`; per-run `obsidian-sync-e2e/local-*` branch absent-first. No physical file above 100,000,000 bytes, no personal vault, no canonical repo/default branch mutation.
- The ignored `.env.github-e2e` file remains unchanged. The numeric expected test ID was set **only in the ephemeral test process**; never printed secrets. `--preflight-only --mode=encrypted --verify-peer --journey --assert-diagnostics` PASS, verified default `main`, clean source tree and fresh branch absence.

## Native encrypted sync functionality: PASS

Real Windows Obsidian two-instance encrypted journey using new vaults and remote branch `obsidian-sync-e2e/local-f261b3e99c35-7fdf3ed0046f1dfc`:

- Entry `--mode=encrypted --verify-peer --journey` exited **0**, status **PASS**, native UI screenshot capture PASS, **0 UI exceptions**.
- `remoteHeadChanged=true`, `remoteEncryptionVerified=true` and `peerRestored=true`: the main vault published encrypted data, the second real Obsidian instance read/decrypted and restored it from GitHub. `peerPullWallMs=6707` (single observed run, not throughput SLA).
- End-to-end synthetic journeys: nested Unicode and scratch notes; rename/modify/delete together; recreate deleted note; two-device simultaneous conflict preserving **both** local and peer text revisions. Warm small-vault repeat returned **no-change** (0 file changes; ~2101 ms).
- Test runner reported GitHub branch cleanup `absent-verified`; an **independent read-only** `scripts/check-github-e2e-branch-absence.mjs` also independently verified the exact branch absent **twice**, pinned repo 1284153873 (exit 0). Source Vault/profile were managed as ephemeral synthetic fixtures and cleanup was part of the test's success path.
- These results are real Windows GUI testing at this SHA and strong evidence for the Node.js engine, but do not qualify macOS, Linux, mobile, real SMB or physical power-loss.

## Separate Diagnostics acceptance: FAIL (confirmed actual missing feature)

Two independent real Windows Obsidian runs with `--assert-diagnostics` produced:

- A successful encrypted remote upload, proven remote encryption, `remoteHeadChanged=true`, zero UI exceptions and safe remote branch cleanup `absent-verified`.
- **FAIL** at the Sync Center metrics assertion: `progressSnapshot.diagnostics === undefined` (logged `metrics:null`), UI row markers `Upload API`, `GitHub API`, `GitHub in flight`, `Peak renderer RAM` not rendered (`rowsVisible:false`); no peer restore attempted after this early strict UI assertion.
- Code audit corroborates: `src/lib/v4/progress.ts`'s `V4SyncProgressSnapshot` has no diagnostics field; `src/views/sync-center.ts` renders only directional counts and generic phase timings; `src/lib/v4/runtime.ts` exposes that progress snapshot unmodified. The `GitHubClient` already collects transport counts and bytes in `V4TransportMetrics` / `transportMetricsSnapshot` but it is **not wired into the live user-facing Sync Center**, and no renderer Peak RAM/API latency/hashing/encryption breakdown is exposed.
- Therefore this is **a concrete production UX/diagnostics implementation gap**, not merely mismatched test labels. Do not hide it by disabling assertions in the strict diagnostics gate. Previous user requirement asked to show upload/download speed, encryption, hashing, GitHub API latency and peak RAM; these require genuine measurements, careful cross-platform adapters and accessible bounded UI rendering. Values must not be fabricated or inferred from total time.

## Acceptance and next actions

- **Functional encrypted Windows dual-instance smoke: PASS** for one complete session on immutable D24 code.
- **Strict diagnostics/UI acceptance: FAIL**; new scoped task required to instrument authentic upload/download throughput, separate crypto/hash timing and API latency, Peak RAM where supported (desktop), as well as clear unsupported/unavailable values on mobile. Do not change remote format, WAL or user conflict policy for this.
- **Scoped real GitHub in-memory-vault E2E: PASS 3 full independent rounds** in D24, separately documented. These and D25 do not equal release readiness.
- Remaining release gates include diagnostics integration/re-test, C2 coordinated remote schema, line-level conflict UI, macOS/Linux/mobile acceptance, best-effort network drive boundaries and independent security review.
