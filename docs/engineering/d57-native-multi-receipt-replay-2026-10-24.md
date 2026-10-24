# D57 — Native multi-receipt WAL replay ordering and target-safety qualification

Date: 2026-10-24 (Asia/Bangkok). An isolated, ledger-owned checkout `.worktrees/d57-multi-receipt-native-replay`, audit branch `audit/2026-10-24-d57-multi-receipt-native`, spawned directly from clean/pushed D56 `8d315499ae167eb6b23b730716fd44e2509b6788`.

## Scope / safety boundary

D57 adds **one test-only file** `tests/v4/recovery-multi-receipt-native.test.ts`, this report and the canonical handoff; production `src/**` remains unchanged. No default/release merge, GitHub Actions, credentialed test branch, personal vault, D45 inherited WIP, native helper, protocol/crypto change, no-WAL policy, GitHub publish/CAS retry or recovery semantics change.

The three synthetic scenarios run against **real Windows filesystem files** under separate worktree-local `.tmp/d57-receipt-*` directories, and use actual V4 recovery-store slot serialization and `createV4PlatformIo.finalizeStage`. The Obsidian vault-facing adapter remains synthetic; no real Obsidian process/power cut/native cross-platform acceptance was performed. The test removes only its own fresh temporary fixture directory.

## Motivating gap

D56 tested a single completed WAL receipt with a native target/backup/stage: edited target is preserved, valid target safely finalizes private backup, lost receipt may be regenerated, completed Trash never deletes a recreated user note. D54–D55 separately proved an **uncompleted** WAL mutation may cause partial local changes when the next stage is missing or corrupted. D57 asks what happens when a **multi-mutation WAL already has one stage-write receipt** before the remaining item encounters missing stage or concurrent user edit.

## Three new exact-implementation tests

1. **Completed A receipt + concurrent user-edited pending B:** A contains the intended five-byte staged replacement, with the original backup intact and hash/actual backup mtime matching WAL precondition. B's original file is edited to another five-byte string `user!` after the assumed scan. For B only, the synthetic vault stat seam returns the prior mtime to explicitly force the hash precondition to detect the same-stat edit; actual file contents and native A finalize use real Windows files. The real replay finalizes A, deletes A's verified backup and stage, then refuses to overwrite B and records `replan-required` while retaining B's user-edited bytes and its staged replacement. **This establishes safety of B, but not atomicity across A and B.**
2. **Completed A receipt + missing pending B stage:** A is finalized and its verified backup/stage cleaned first. The reader then fails opening B's missing stage with an `ENOENT` error. B's original user file is unchanged, and the real persisted WAL remains `local-committing` with only A's receipt. This demonstrates the **remaining non-atomic replay lifecycle** even with a completed earlier receipt. It is NOT proof that all original versions can be recovered after later failures.
3. **Completed A receipt + stale remote HEAD:** If the HEAD observed by recovery differs from the WAL's immutable verified remote commit, the engine records `replan-required` and calls **no native finalization or staged cleanup**. A's verified backup remains, A's stage remains, and B's original file remains unchanged. Runtime later cleanup semantics are separate; the test covers the explicit recovery method's remote-head guard.

The tests are behavior characterizations of the existing implementation; **passing them does not close D54/D55 partial replay exposure**.

## Verification

- Targeted new tests **3/3 PASS**, Maximum Strict TypeScript **0 errors**, production build PASS.
- Fast tier **605/605 PASS**, recovery **79/79**, resource **11/11**, feasibility **134/134**.
- 100,000,000-byte virtual cryptographic soak **1/1 PASS**, three GitHub E2E bundles compile PASS, package/release metadata validations PASS.
- Fast repeat **10 × 605/605 PASS / exit 0**, with ten individual round markers and ten corresponding 605-pass summaries verified in the completed runner.
- No new live GitHub E2E or physical Obsidian launch because production source and live scenario scripts remain identical to D56; earlier live evidence cannot be relabeled as a D57 test.

## Blockers and owner decisions

- D54–D57 **multi-mutation partial replay** remains open. The previously proposed read-only all-stage preflight PoC is **not authorized** by generic “continue” requests. Any modification to replay semantics, backup retention/rollback, bounded mobile preflight or atomic commit design requires user approval.
- D50 no-WAL **A** (fail closed on mutating Pull without a recovery store, recommended) versus **B** (bounded fallback redesign) remains undecided; D57 does not choose.
- D38 intermittent missing immutable object and D45 pre-publish head-null P0s remain open and causally unresolved.
- Physical macOS/Linux/Android/iOS, real crash/power-loss, independent security/C2 review and integrated manual line-merge UX still block production release.
