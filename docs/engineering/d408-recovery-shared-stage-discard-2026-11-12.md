# Stage D408 — Discard every recovery target before deleting a shared stage

Date: 2026-11-12 (Asia/Bangkok). Scope: an existing V4 crash-recovery replan/discard path, not a new feature. Work performed only in inherited dirty audit worktree `.worktrees/d87-owner-rekey-policy`. First public release gate remains **blocked**.

## Existing defect and risk

When a prior WAL must be discarded after remote-head replan, `V4PluginRuntime` calls `discardV4RecoveryStages(snapshot, io, keepStageIds)`. Its previous implementation deduplicated `stageId` **before** calling `rollbackStage` or `finalizeStage` for individual target mutations:

```ts
if (keepStageIds.has(id) || processed.has(id)) continue
processed.add(id)
await rollbackOrFinalize(mutation)
await remove(stage)
```

`createV4RecoveryStore` accepts distinct `stage-write` mutation IDs and paths that reference one shared staged file. Thus a valid WAL can contain multiple targets sharing a `stageId`. The former discard path silently skipped all but the first target and removed the stage while another target's original backup might still require rollback. This is a potential loss of recovery evidence, not merely a wrong status message.

## Before-fix RED evidence

New real WAL validation/recovery regression tests in `tests/v4/recovery-replay-ordering.test.ts` construct a validated persisted V4 WAL with two target mutations and the same stage ID:

1. `D408 shared recovery stage must finish each target rollback/finalize before deleting the stage`: original implementation produced `finalize:first.md, remove:shared-stage` instead of `finalize:first.md, rollback:second.md, remove:shared-stage`.
2. `D408 recovery discard retains shared stage when a later target rollback fails`: original implementation falsely resolved the discard, because it never attempted the second rollback that was configured to fail.

Both were **RED**, process `8e46d34e-3f51-4232-b727-2329b2b6cb2f`, exit 1. These test the original production function rather than a duplicated algorithm.

## Repair

`src/lib/v4/recovery-store.ts` now uses a two-phase cleanup: (1) process rollback/finalize for **every** stage-write target, excluding `keepStageIds`; (2) only after all target operations succeed, remove each unique stage file once. If any rollback/finalization rejects, the procedure exits without removing any staged files scheduled for discard, retaining recovery evidence. This does not change success, index, GitHub publication or manual recovery policy. The pre-existing best-effort `io.staging?.remove` behavior remains unchanged; its user-facing status semantics require a separate approved decision.

## Initial verification

- Focused full `recovery-replay-ordering` suite **5/5 PASS**, including both D408 tests, process `61eb1323-2c0b-4686-b7ab-5068d39cda44`.
- Existing Recovery suite `pnpm test:recovery` **93/93 PASS**, process `fe8b183c-47f4-49d4-8222-aaf295753fc1`.
- Maximum Strict TypeScript `pnpm typecheck:max-strict` exit 0, process `509fbfe1-ef0b-4dcf-84b7-19baf1687fc0`.
- Final production build, broader test matrices, source-fingerprinted full Fast and disposable GitHub acceptance are recorded in `HANDOFF-NEXT-SESSION.md` once terminal outcomes are confirmed.

## Explicit non-goals

No automatic deletion of unknown/foreign staged files. No change to post-commit `V4SyncSession.cleanupStages` policy, which the owner has not selected. No Settings/Selector/Index Cutover or Wizard Execute; no claims of physical crash-safe durability. Keep release gate `blocked` pending the existing end-to-end installed Re-encryption, multi-device stale-client and physical Android/iOS acceptance.
