# Stage D410 — Validate stage ownership before the first WAL save or remote publication

Date: 2026-11-12 (Asia/Bangkok). Scope: an existing V4 Sync producer that assembles local recovery mutations before GitHub publication. Work confined to the inherited dirty D87 audit worktree; release gate remains **blocked**.

## Incomplete existing behavior

D409 prevents native V4 Recovery from applying a WAL in which two distinct stage-write mutations reference one opaque `stageId`. But the normal V4 Sync producer `V4SyncSession.prepareRecoveryLocalPayload()` did not enforce the same invariant **before** writing the WAL or publishing GitHub refs. A reused opaque ID could be persisted as a recovery payload that later replay would refuse, forcing avoidable Manual Recovery. This is a real correctness gap even though properly functioning production stages generate random IDs with very low collision probability.

Another existing path, `runState.conflictCopyStages`, unconditionally skipped a carried conflict-copy mutation when its `stageId` was already present in a set, even if that ID belonged to **another target path**. That silently removed a required target mutation from the WAL, potentially allowing a published remote commit and an incomplete local copy.

## Reproduction

1. Added `D410 WAL producer refuses duplicate staged target IDs before saving WAL or publishing` to `tests/v4/sync-session.test.ts`. A real two-file remote Pull with WAL intentionally returns the same stage ID from the test staging adapter for two separate target files. Before this change the real Sync pipeline called the recovery store's `save()` rather than rejecting the collision; the injected `duplicate stage must never enter WAL` error proves the wrong ordering (RED process `fa9334c2-3d11-4b24-9f85-cb26fb1439a5`, exit 1).
2. Added `D410 carried conflict-copy stage collision cannot silently omit its WAL target`. It seeds a carried conflict copy for an independent path with the same physical `stageId` as an incoming remote Pull and requires a fail-closed error before WAL save, local mutation, or remote publication. The missing-target skip was directly verified in source before repair.
3. The two focused tests **2/2 PASS** on repaired code, process `842afaa8-58b5-43f6-8c89-4982f72ddb50` exit 0.

## Narrow repair

- Reuse one shared `assertUniqueV4RecoveryStageOwners` invariant, exported from `src/lib/v4/recovery-store.ts`, in both WAL replay (D409) and the Sync WAL producer.
- Validate the complete stage-write mutation list in `prepareRecoveryLocalPayload()` before original-target precondition hashing, any WAL save, remote publication, or local target mutation. If stage IDs are ambiguous, throw `V4RecoveryRequiredError`; do not issue a WAL receipt for data Recovery will reject.
- In the carried conflict-copy loop, coalesce the existing stage only when the **target path and stage receipt (hash/size/mtime) are identical**. If another path or receipt claims the same ID, fail closed rather than silently omit the conflict-copy mutation. Tracked stage identities are updated as carried copies are appended.
- The WAL schema, ciphertext format, GitHub transport, successful normal conflict-copy workflow, and post-commit Sync status policy are not changed. No automatic cleanup of ambiguous/reused staged artifacts is authorized.

## Scope of proof

The tests exercise real memory-backed V4 Sync behavior with injected identity collisions, not a claim that normal random generation often collides. They assert **zero WAL saves, zero local target writes and zero GitHub ref updates**, with unchanged local index, even when multiple remote files were staged. The D410 carried-copy test is a GREEN boundary regression; RED evidence explicitly measured for the separate two-file producer case. Broad qualification and disposable live E2E terminal outcomes are in `HANDOFF-NEXT-SESSION.md`.

## Remaining

WAL files that were already persisted with duplicate IDs remain rejected safely by D409; this does not silently rewrite old journals. Release gate `docs/release-gates/reencryption-wizard.json` remains `blocked` pending full installed owner migration, multi-device stale-client safety, and physical Android/iOS acceptance. No real user Vault or production/default GitHub branch touched; no commit, push, merge or release.
