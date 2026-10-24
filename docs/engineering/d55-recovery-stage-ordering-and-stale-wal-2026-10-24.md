# D55 — Corrupt-stage replay ordering and stale-WAL remote-head guards

Date: 2026-10-24 (Asia/Bangkok). Isolated ledger-owned worktree `.worktrees/d55-replay-ordering-evidence`, audit branch `audit/2026-10-24-d55-replay-ordering-evidence`, based on clean/pushed D54 `751d9a8842f4fbffa62d136f1f7a8a19f90b0f2c`.

## Scope

No production `src/**` change or altered replay/recovery policy, GitHub CAS, publication retry, absence interpretation, encryption, on-wire format, 8 MiB REST writer, native helper, or no-WAL fallback. No GitHub Actions, default/release branch work, real personal vault access, or historical D45 WIP touch. **The owner has not authorized D54 proposed preflight PoC or decided D50 no-WAL option A/B.** This iteration characterizes existing behavior in tests only.

## New deterministic tests

Added `tests/v4/recovery-replay-ordering.test.ts` using real `createV4RecoveryStore`, `recoverV4PendingState` and `createV4StagingStore`, in-memory adapters and explicit synthetic destructive local Trash. Three test cases:

1. **Corrupted stage before Trash:** A valid, integrity-checked WAL describes stage-writing B from a five-byte blob and then deleting A. The synthetic stage backend returns five bytes different from the signed stage SHA-256 (`bad-B` vs `new-B`). The real recovery logic throws typed `V4RecoveryRequiredError` on hash mismatch, writes neither file, does not trash A, and leaves the WAL in `remote-verified` without completed mutation receipts. This proves content hash verification works for small-file replay when it is the FIRST mutation.
2. **Trash before corrupted stage:** Reverse the WAL mutation order, with the same authenticated, same-size stage corruption. The real recovery logic trashes A and persists a `local-committing` receipt for A, THEN checks B and throws typed hash-mismatch. B is unchanged and never written. This extends the D54 missing-stage result: **even when staged bytes exist but their hash is wrong, WAL replay is vulnerable to partial local mutation if an earlier delete is ordered first**. The mock Trash is destructive; actual Obsidian Trash is designed to be recoverable, and this test does NOT prove permanent loss on a native vault.
3. **Torn latest generation and stale recovered remote HEAD:** Write valid recovery WAL generations 1 and 2, corrupt the most recent slot, reload the previous integrity-verified generation, and supply a changed immutable remote HEAD. The production `recoverV4PendingState` transitions to `replan-required` **without calling any local IO** or applying its stale Trash mutation. The test confirms an important existing safety gate. It is not evidence of full replay atomicity for matching HEADs, nor a disk crash/tear durability test.

The two ordering tests are **behavior characterizations**, not regression guarantees that replay is now safe. A green assertion confirms this hazard remains; this must not be reported as P0 fixed.

## Verification

- New focused cases **3/3 PASS**.
- Maximum Strict TypeScript **0 errors**, production build PASS, GitHub E2E **3 bundle compile PASS**.
- Full fast tier **598/598 PASS**, recovery **79/79**, resource **11/11**, feasibility **134/134**, virtual cryptographic 100,000,000-byte soak **1/1 PASS**, release metadata and package validation PASS.
- Fast repeat **10 × 598/598 PASS / exit 0**; ten repeat-round markers and ten 598-pass summaries independently verified from completed runner output.
- No credentialed GitHub mutation or native Obsidian acceptance performed in D55 because production code and live harness are unchanged. Historical D50 scoped live fault E2E and D46 physical 100MB encrypted test are not attributed as D55 runs.

## Decisions / release blockers

- **D54/D55 recovery replay design risk:** A read-only stage availability and hash preflight before *any* mutation or an explicitly recoverable transaction/rollback strategy is a potential design direction. Either changes recovery/IO and mobile performance semantics. **Do not integrate or even begin the previously proposed PoC without explicit owner permission.** Require bounded IO, cancellation and race/freshness auditing before adopting an approach.
- **D50 no-WAL policy still pending:** A = fail closed on mutating Pull when recovery store absent (conservative recommendation); B = keep but redesign bounded safe fallback. No selection in D55.
- **P0 remain open:** D38 intermittent missing immutable remote object and D45 branch-head 404 / pre-publish `observedHeadSha=null`, with no verified root causes.
- Other gates: independent security/C2 review, physical Mac/Linux/Android/iOS and power-loss replay/Trash testing, line-level conflict UI integration. Not production ready.
