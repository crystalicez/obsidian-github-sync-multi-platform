# D52 — WAL content identity guards under same-stat user edits

Date: 2026-10-24 (Asia/Bangkok). Owner-ledger isolated checkout `.worktrees/d52-wal-target-snapshot-guards`, branch `audit/2026-10-24-d52-wal-target-snapshot-guards`; direct child of clean pushed D51 `a0fcb7f2a1d13f04373cff60a16e9ec20a0f748b`.

## Scope and safety

**No production `src/**` files were changed.** D52 adds only regression tests and this engineering/handoff evidence. No GitHub Actions, source branch/default merge, user vault access, native helper, protocol/encryption change, CAS/retry/recovery policy change, 8 MiB writer-part adjustment or live disposable GitHub branch was used. The user has **not** decided whether to fail-closed without recovery store (option A) or redesign the fallback (option B); do not implicitly choose either.

D50 established that a synthetic **no-WAL** fallback can remove a local previous-generation file before a later immutable read failure (the in-memory mock `trash` is destructive). With a WAL/staging-backed test fixture, the same injected remote miss aborted safely. D51 extended that to a three-Pull batch, including a completed good stage discarded before any local mutation when a later remote object went missing.

## Further D52 correctness assertion

The implemented `V4SyncSession.prepareRecoveryLocalPayload` already validates hashes of **all** existing local mutation targets prior to persisting a WAL. A same-length, same-mtime concurrent edit may slip through a stat-only guard; an independent plaintext SHA-256 check must block it.

Two new deterministic regression cases in `tests/v4/sync-session.test.ts` exercise the real engine:

- Publish an original `A-target.md` and `B-later.md`, sync both to the peer and preserve its exact prior local index.
- Publish a new immutable commit with `B-later.md` modified, and either **delete** or **modify** `A-target.md`. These are separate cases.
- While the peer's B remote object is being fetched (after local snapshot scan), simulate an external user modification to local A changing `abcde` to `edcba` **without changing byte length or modification timestamp**.
- All remote bodies that require staging are available and verified before the WAL target-hash validation. The actual pre-WAL SHA-256 comparison raises typed `V4LocalTargetChangedError("A-target.md")`.
- Verify completed stages are discarded (one for delete target case, two for modify target case), **zero WAL saves**, **zero local trash/write/commit**, user-edited bytes `edcba` untouched, B old bytes preserved, local index unchanged, and remote HEAD unmodified by failing peer.

This does not demonstrate a full real filesystem race after the final precondition check, native crash/restart, macOS/Linux/physical Android/iOS support or root-cause remediation for D38/D45. Those need independent qualification. It does guard against a real same-stat source mutation class in the WAL preparation path.

## Validation

- Focused sync-session **91/91 PASS**, including both new D52 cases.
- Full fast **589/589 PASS**.
- Maximum Strict TypeScript **0 errors**, production build PASS, GitHub E2E 3 bundle compile PASS.
- Recovery **79/79**, resource **11/11**, feasibility **134/134**, virtual 100,000,000-byte soak **1/1**, package/release metadata validators PASS.
- Fast repeat **10 × 589/589 PASS, exit 0**; verified ten distinct repeat-round markers and ten 589-pass summaries from the completed runner.
- No new credentialed GitHub scenario nor real native Obsidian test in D52: all production `src/**` code and the D50 runner remain identical. Prior D50 exact-SHA scoped GitHub fault, D46 exact-production-source native 100 MB/full matrix are inherited evidence, not rerun validation.

## Release blockers

D38 intermittent missing immutable Git object and D45 intermittent `observedHeadSha=null` are still OPEN pending causal identification; no publication retry, remote absence interpretation, recovery, conflict or user-note deletion policy is changed. Cross-platform native acceptance, vetted manual line merge and independent security/C2 review also remain pending. Production ready **not** declared. The only current user-needed architectural choice remains **A vs B on the unsafe no-WAL fallback**.
