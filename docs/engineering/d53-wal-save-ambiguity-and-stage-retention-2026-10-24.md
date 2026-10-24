# D53 — WAL save ambiguity and stage-retention contract

Date: 2026-10-24 (Asia/Bangkok). Host-owned isolated worktree `.worktrees/d53-wal-save-failure-contract`, branch `audit/2026-10-24-d53-wal-save-failure`, direct descendant of clean pushed D52 SHA `452e207f3b0a16297ac7986e2fb413a442e10a33`.

## Scope

**Test-only and documentation-only. No production `src/**` change**, publication retry/CAS, recovery/conflict/delete interpretation, SHA-256 engine, wire layout or 8 MiB REST writer change. No edits to root/Zed, D45 or other historic worktrees, default branch, live personal vault, native OS helper, GitHub Actions or release. Explicit owner decision A/B on no-WAL fallback still pending; no policy decision inferred.

## Motivating boundary

D50–D52 qualified three safety phases: incomplete remote read blocks local mutations; all Pull content is staged before local deletes; and a same-size/same-mtime user edit is caught via independent SHA-256 before a mutating WAL is saved. D53 examines the next boundary: **all remote content has been downloaded and hash-verified but `recoveryStore.save(remote-verified)` rejects**.

The real source currently sets `preserveStagesForRecovery = recoveryPlan.payload.mutations.length > 0` immediately *before* calling `save` on a Pull-only run. It cannot assume that an exception from local adapter `write` means the WAL was not persisted. Deleting staged files would risk leaving a valid persisted recovery record with dangling stage references. Conversely, preserving a stage on a definite pre-write error can leave extra private staging bytes until later cleanup. **This is a deliberate safety/disk-resource tradeoff**, not proof that indefinite retention is ideal. Do not implement cleanup or alter the commit/recovery boundary without independent recovery design review and user approval.

## New tests using actual recovery serialization

Added two cases to `tests/v4/sync-session.test.ts`, via real `V4SyncSession`, `createV4StagingStore`, `createV4RecoveryStore` and a deterministic in-memory `V4LocalIndexAdapter`:

1. Both peers initially hold `A-delete.md` and `B-update.md` with original bytes/mtime. One peer publishes a new immutable Git commit deleting A and replacing B. A second stale peer performs a WAL-enabled Pull. **Both remote bodies are available** (B successfully stages, while A is a delete). No fault is injected into GitHub and no remote publication occurs on the failing peer.
2. **Definite-before-write:** intercept the first `save(remote-verified)` and throw the exact intentional I/O failure before calling the real WAL store. Verify `createV4RecoveryStore.load()` finds *no* persisted slot.
3. **Write-may-have-persisted:** allow the **real** `createV4RecoveryStore.save` to serialize a valid integrity-protected WAL into its two-slot adapter, then throw the identical I/O failure *after* adapter write. Independently call the **real** `load()`, validating slot integrity, `remote-verified` phase, verified Git commit SHA, the exact `trash:A-delete.md` and `stage-write:B-update.md` mutations, and matching staged file ID.
4. For both cases, confirm the original I/O failure is propagated unchanged, one WAL save attempt, the new B stage is valid/readable, stage remains available (no automatic remove), **zero** local delete/write/commit, all prior user bytes and mtimes intact, original local index/base unchanged and no new GitHub HEAD.
5. The ambiguous case models a synchronous in-memory adapter write followed by an exception. It is **not** a filesystem durability/fsync/restart test. The direct in-memory test is not sufficient to establish that WAL write can never tear or that native Obsidian Trash is recoverable. Those are independent release gates.

No production source was changed. The tests make the current conservative behavior visible and resistant to accidental cleanup refactors.

## Verification

- Focused sync-session **93/93 PASS** including both new cases.
- Maximum Strict TypeScript **0 errors**, production bundle PASS, GitHub E2E 3 compile bundles PASS.
- Earlier D53 test-only snapshot: fast **591/591**, recovery **79/79**, resource **11/11**, feasibility **134/134**, virtual bounded **100,000,000-byte soak PASS**, release/package validators PASS.
- Final test-only revision **fast 591/591 PASS**; ten repeats **10 × 591/591 PASS / exit 0** (ten independent round markers and ten 591-pass summaries verified). No credentialed GitHub mutation or native Obsidian run was repeated because production `src/**` is identical to D52/D46 and the synthetic E2E harness was unchanged.

## Outstanding questions and release criteria

The original D38 intermittent GitHub `Missing V4 remote object` and D45 intermittent REST `observedHeadSha=null` both remain **OPEN without proven root cause**. No production publication/CAS/recovery change was made. Full native macOS/Linux and physical Android/iOS, independent security/C2 review, vetted line-by-line merge UX, and a crash/disk-failure audit remain outstanding.

**User decision still required:** A: fail closed for any mutating Pull without a recovery store; B: retain no-WAL fallback but redesign safe bounded all-body staging, especially for mobile. Do not choose on the user's behalf. This test validates only the WAL-enabled path.
