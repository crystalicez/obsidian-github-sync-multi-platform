# Stage D409 — Fail closed on ambiguous shared stage ownership during native WAL recovery

Date: 2026-11-12 (Asia/Bangkok). Scope: existing V4 local Recovery and native Desktop staged commit/rollback, not a new feature. Audit worktree: `.worktrees/d87-owner-rekey-policy`. Release gate remains **blocked**.

## Existing gap

D408 corrected the replan/discard ordering so each mutation referencing a stage ID is considered before the stage is removed. A second safety issue remains: native Desktop `createV4PlatformIo` uses `${stagePath}.target-backup` and `${stagePath}.replacement-residue` as the only persistent names for a staged replacement's original backup and interrupted rollback. **They are keyed by stage path, not target path**. If two distinct WAL stage-write mutations reference the same `stageId`, both claim the same physical backup/residue paths. Even a validly shaped, checksum-verified V4 recovery WAL currently accepts this duplicate ID and can advance to native `commitStage`, `finalizeStage`, or `rollbackStage` without proving which target owns the sidecars.

This risk is different from D408's ordering problem. Finishing *all* rollbacks before removing the shared stage cannot prove the sidecar owner on Windows. Existing generated stages normally have unique cryptographically random IDs; failure must still be deterministic and safe when a WAL contains a collision or duplicated reference.

## Verified RED (old code)

Added two direct regression tests to `tests/v4/recovery-replay-ordering.test.ts`, reusing D408's actual persisted WAL with two stage-write mutations for different target paths and one common stage ID.

1. `D409 Native recovery refuses shared stage IDs before any target commit or receipt`: with native `preferStagedCommit` enabled, original code proceeded to `targetMatchesStage` and called `io.stat` before checking stage ownership. The test required an explicit `V4RecoveryRequiredError` before **any** file operations, and failed with an injected `local stat must not precede shared-stage ownership rejection` error.
2. `D409 Native recovery discard rejects shared stage IDs before touching any sidecar or target`: the original discard function resolved and called finalize/rollback/remove rather than refusing the unprovable mapping. The test failed with `Missing expected rejection`.

Both fail for the intended bug on prior production code, managed process `2d578e81-9c73-445e-bb28-d8cdb24fbdae`, **exit 1**.

## Narrow correction

`src/lib/v4/recovery-store.ts` now uses `assertUniqueV4RecoveryStageOwners`, validating the entire WAL's stage-write mutation list before starting any local apply. A `stageId` may only occur once: one physical staged file cannot safely supply more than one separate mutation, even in a non-native fallback that removes a stage after the first write. A collision throws `V4RecoveryRequiredError` with a Manual Recovery explanation **before** a stat, write, trash, commit, stage removal or WAL receipt.

The replan/discard path performs the same preflight for **native Desktop** (`io.preferStagedCommit`), before either finalize or rollback, since stage-derived backup/residue names cannot be assigned to two different targets. Non-native discard retains D408's two-phase rollback/finalize then unique stage deletion behavior, where the native sidecar mapping does not apply. No silent stage deletion, new automatic recovery policy, database format, migration authorization, or user-facing success status change.

## Verification

- `recovery-replay-ordering` **7/7 PASS**, including both new D409 regressions and existing D408 shared-stage non-native discard cases. Process `61a16efe-f955-460f-85c1-fd724066d57b`.
- `pnpm test:recovery` **93/93 PASS**, process `9ee26c23-6407-47b9-ae56-bd32043bbb99`.
- `pnpm typecheck:max-strict` exit 0, process `69bb823e-85fc-4f69-9833-430c074a4b4f`.
- Broader qualification, source fingerprint and disposable live GitHub acceptance are recorded in the handoff file only after complete terminal results.

## Boundaries

This change reports ambiguous ownership; it cannot prove native atomicity or simulate a physical device power loss. It does not remove backup files automatically when the WAL is ambiguous. Native helper remains unapproved for the first release. The current post-commit `V4SyncSession.cleanupStages` warning policy was intentionally left unchanged, pending owner choice. No user Vault, production/default GitHub branch, passphrase settings, Settings/Selector/Index Cutover or Wizard Execute touched. First release remains Sync+Re-encryption together with release gate `blocked`. Missing integrated installed-owner migration, stale-client multi-device safety and physical Android/iOS acceptance must be addressed independently.
