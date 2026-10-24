# D56 — Native Windows WAL receipt replay and backup finalization tests

Date: 2026-10-24 (Asia/Bangkok). Isolated ledger-owned checkout `.worktrees/d56-native-wal-receipt-guards`, audit branch `audit/2026-10-24-d56-native-wal-receipts`, directly descended from clean/pushed D55 `a9f4570ca8a3636ed88f4f6107d0afb845a8d5cb`.

## Scope and authorization

This is a **test-only native-filesystem qualification**: added four cases in `tests/v4/recovery-native-receipts.test.ts` using the real `createV4RecoveryStore`, `recoverV4PendingState` and desktop `createV4PlatformIo.finalizeStage`. The tests create unique, bounded synthetic target/stage/backup and WAL files under the D56 worktree's `.tmp` directory and remove only their exact temporary fixture directory. No user vault, default branch, historic worktree, GitHub live test branch or release was touched. No production `src/**`, Git CAS, publication, absence semantics, cryptography, recovery policy, WAL wire layout, 8 MiB REST writer, Node native helper or GitHub Actions change.

D54–D55 already proved an independent partial replay hazard for a WAL whose early Trash mutation precedes a later missing or corrupted stage. **D56 does not fix that hazard**, attempt the D54 PoC without authorization, or choose the still pending no-WAL A/B decision. It tests a separate crash/restart boundary: recovery **receipts already marked complete** and backups that may be the only remaining copy of an original file.

## Native filesystem assertions

All four tests drive real Win32-backed filesystem operations through the project desktop implementation; only the Obsidian vault-facing adapter (list/stat/read/write/trash) is synthetic. WAL content is serialized and reloaded from a real scoped `wal/slot-*.json` file. Each test uses its own unique `.tmp/d56-wal-receipt-*` directory with enforced desktopRootPath. Files are five bytes, far below the 100,000,000-byte testing cap.

1. **Completed stage-write receipt, later user edit:** Target contains `user!`; matching stage is `new-B`; the private `.target-backup` is original `old-B`, matching the WAL's hash and the real filesystem backup mtime. A replay of the completed receipt calls the actual desktop `finalizeStage` which rejects an edited target via `V4ManualRecoveryRequiredError`. Assert byte-identical user target, original backup and new stage all remain, no stage removal, no additional vault write/Trash, no WAL receipt advancement. This prevents automatic disposal of the sole verified original backup.
2. **Completed stage-write receipt, valid staged target:** Target exactly equals staged bytes `new-B`, private backup exactly matches original and WAL's hash+mtime. The native finalizer verifies both, safely removes only the private backup, and allows stage cleanup. Target bytes remain unchanged and the recovery state transitions to `replan-required` for subsequent resync; no extra vault write/Trash.
3. **Lost receipt after successful replacement, stage no longer exists:** The target already matches the staged hash but the stage file is missing, and the private original backup remains valid. The actual recovery path notices the target matches the intended stage, writes a receipt, finalizes the backup and handles missing stage removal without reopening or overwriting target. This test demonstrates an idempotence case, not generic replay atomicity.
4. **Previously completed Trash receipt and recreated user file:** The WAL has a completed Trash operation for `user.md`, then the user recreates the file. Replay must skip the already-receipted Trash and leave recreated contents untouched, rather than deleting the note a second time.

### Fail-first refinement

The initial native fixture failed the safe-finalization case because the test inserted a *synthetic fixed mtime* into the original backup precondition, which the native `confirmBackup` correctly rejected. The fixture was fixed to use the **actual backup file's `stat.mtimeMs`**; production validation was not weakened. Targeted cases then passed **4/4**. This illustrates why native filesystem tests add independent value over in-memory mock-only tests.

## Verification

- Focused native WAL receipt cases **4/4 PASS**, Maximum Strict TypeScript **0 errors**, production build **PASS**.
- Full fast tier **602/602 PASS**; recovery **79/79**, resource **11/11**, feasibility **134/134**.
- Bounded virtual **100,000,000-byte** cryptographic soak **1/1 PASS**, 3 GitHub E2E bundles compile **PASS**, release/package validators **PASS**.
- Repeat fast tier **10 × 602/602 PASS / exit 0**: ten distinct round markers and ten 602-pass summaries verified from the completed runner.
- **No real Obsidian process launched in D56, no physical OS kill/power outage, no credentialed GitHub E2E.** Platform-I/O and WAL filesystem operations were real Windows native FS under an isolated test fixture. Last full live GitHub/Obsidian qualification and D50 controlled fault evidence remain historically relevant but were not rerun.

## Still-open release blockers and decisions

- D54–D55 **partial WAL replay hazard**: an early Trash may be applied before a later stage fails integrity/availability checks. Possible all-stage preflight or alternate rollback/replay architecture needs owner approval; the previously proposed PoC was not authorized by the user's generic “continue” request.
- D50 **no-WAL A/B decision** remains pending: A refuse mutating Pull without a recovery store (recommended), B bounded redesign of unsafe fallback.
- D38 intermittent remote-object missing and D45 pre-publish head-null remain unresolved P0, no speculative retries/recovery implemented.
- Real Mac/Linux and physical iOS/Android acceptance, independent C2/security review, line-level manual conflict UX and native crash durability/recovery testing remain open. Do not mark production ready.
