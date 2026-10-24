# D54 — WAL slot integrity and replay partial-mutation audit

Date: 2026-10-24 (Asia/Bangkok). Isolated host-owned worktree `.worktrees/d54-recovery-replay-boundaries`, audit branch `audit/2026-10-24-d54-recovery-replay-boundaries`, direct child of clean/pushed D53 `b6143d478ee8ab9032c1c23c5e0134806fef2ecd`.

## Scope and prior evidence

No production `src/**` changes, protocol/encryption/format change, GitHub CAS or retry modification, recovery/deletion policy, native helper, default/release merge, GitHub Actions or live personal-vault access. Original root and historical worktrees, especially D45's inherited unstaged test edit, are out of scope. Physical file-test maximum remains 100,000,000 decimal bytes; REST writer 8 MiB per part unchanged.

D50 exposed that a synthetic **no-WAL MemoryVault**, whose trash is a destructive Map.delete, can delete the previous generation before encountering a later immutable remote missing-object read. Production Runtime passes a recoveryStore and Obsidian fileManager Trash is recoverable; D50 WAL pre-stage test passed a controlled credentialed fault. D51–D53 added multi-Pull staged-read order, local snapshot hashes and ambiguous WAL save-retention tests. None of those prove every restart replay sequence is all-or-nothing.

## New D54 tests: actual recovery store + replay

New `tests/v4/recovery-replay-boundaries.test.ts` covers four actual implementation paths, without production source changes:

1. **No WAL vs unreadable WAL:** Empty slots return `null`. A present slot whose JSON is torn/corrupt must raise `V4RecoveryRequiredError`, including on subsequent save. It must never be misclassified as absence.
2. **Newest slot torn:** Save two valid generations to distinct slots; intentionally tamper with newer slot's integrity. The reader ignores invalid latest, reloads *older intact generation*, and subsequent saved generation uses its verified predecessor. This is the existing two-slot resilience contract, not proof that the stale fallback can always continue mutations safely. Remote-head and local-precondition gates still matter.
3. **Wrong encrypted recovery key:** Two intact WAL generations encrypted under one key, loaded under another key, must fail closed with `V4RecoveryRequiredError`, not use an unauthenticated fallback.
4. **Missing future stage during WAL replay (SAFETY FINDING):** Save a real integrity-checked `remote-verified` WAL with **trash A first, stage-write B second**, both with exact hashes and local preconditions, and a **missing stage B**. Invoke real `recoverV4PendingState` with matching remote commit and an explicitly destructive synthetic `V4LocalIo.trash` (`Map.delete`). It (a) applies Trash A and saves a `local-committing` receipt naming A; (b) then fails opening missing B stage; (c) leaves B unchanged; (d) has no ability to put A back in the mock. The retained WAL proves partial progress, not full transaction atomicity.

### Meaning / risk

This fourth test is a **deterministic characterization of production recovery sequencing with synthetic filesystem behavior**. It is a genuine **partial replay hazard** when an earlier mutation is applied and a later referenced stage cannot be opened. It does **not** establish permanent data loss in Obsidian's real Trash-backed `trashFile`, or identical behavior on mobile, physical crash, disk corruption, interrupted filesystem operations or production staging cleanup. The error remains surfaced; no silent success/HEAD advancement is claimed.

Treat this as a **release-blocking recovery design investigation**, not a proven remote-cause P0 fix. A possible policy/design is a read-only preflight of every outstanding staged object (identity, availability, size/hash) and every target before any local mutation, while preserving in-progress WAL receipts and a recoverable failure path. That may require extra I/O, validation of a 100 MB maximum physical fixture, and mobile-specific bounded memory. The alternative is an explicitly recoverable, operation-by-operation replay/rollback design. **Do not integrate either without user architecture approval**; both change recovery semantics. Also do not equate falling back to an older valid WAL slot with a guarantee that replay is safe after newer-slot truncation.

## Verification

- Four new focused tests **4/4 PASS** (the fourth asserts the observed risk, it is **not** a green safety guarantee).
- Maximum Strict TypeScript **0 errors**, production build PASS.
- Full fast **595/595 PASS**, recovery **79/79**, resource **11/11**, feasibility **134/134**, virtual 100,000,000-byte soak **1/1 PASS**.
- All three GitHub E2E bundles compile PASS, release metadata/package validators PASS.
- Full fast repeat **10 × 595/595 PASS / exit 0**, verified ten distinct round markers and ten separate 595-pass summaries in the completed runner output.
- No new credentialed real GitHub E2E nor native Obsidian acceptance in D54; the tests use controlled in-memory adapters and production recovery implementation. D50 last scoped real GitHub injection and D46 last physical encrypted 100 MB/full live matrix remain historical evidence only.

## Outstanding release gates and user decisions

1. D38 intermittent GitHub `Missing V4 remote object` and D45 intermittent branch HEAD 404/`observedHeadSha=null` remain OPEN; neither root cause proven.
2. **New D54 recovery replay preflight/rollback decision:** Authorize an isolated audit/PoC first, or implement after reviewing stage availability and native Trash semantics. No automatic adoption in production without approval.
3. **D50 no-WAL policy A/B remains undecided:** A = reject mutating Pull without recoveryStore (recommended); B = redesign safe bounded fallback. D54 has not chosen or implemented either.
4. Cross-platform real macOS/Linux, physical Android/iOS, independent security/C2 review, audited manual per-line merge UI and real power-loss durability/restart remain open.
