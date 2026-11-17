# Stage D407 — Preserve original streaming errors across staging cleanup

Date: 2026-11-12. Scope: existing V4 Sync pull and Staging Store code in the inherited dirty D87 audit worktree. First public release gate remains **blocked**.

## Incomplete behavior found

D406 made `V4StagingCleanupError` observable when removal of an incomplete stage cannot be verified. However its two production streaming consumers still used:

```ts
} catch (error) {
  await sink.abort()
  throw error
}
```

If a source read/write error occurred and `abort()` also failed, the latter rejection replaced the original fault; if the sink had already failed a partial cleanup and the later abort succeeded, the caller still reported the stale cleanup warning instead of the underlying source/write error. Both cases obscure the precise recovery action.

Affected locations:
- `createV4StagingStore().stageSource()`: used for temporary streams and staged content
- `V4SyncSession.stageRemotePull()`: used for WAL-first remote pulls and chunked remote records

## Reproduced before fixing

1. `D407 stageSource preserves both source failure and failed abort cleanup`: an interrupted chunk source left an incomplete staged file, and the backend refused to remove it. The original code returned a `V4StagingCleanupError` **without** the source exception in `stageFailure`. RED process `ef07cde1-53d4-4930-8179-652e21e64df7` exit 1.
2. `D407 stageSource reports its original write failure after abort successfully recovers a failed first cleanup`: a write partially persisted and failed; first removal failed, but second removal from `abort()` succeeded. The original caller still threw the now-stale initial cleanup error, not the original write failure. RED in the same focused process.
3. `D407 Sync remote pull preserves write and cleanup failures without applying data`: V4 Sync with a recovery store uses actual `stageRemotePull()` before any WAL save or local mutation. An injected partial stage write failure plus repeated removal failure produced a nested cleanup failure, hiding the underlying write error. RED process `f18c637b-5abc-40b0-9950-d746e5fb8b91` exit 1. An initial variant of this regression used small-file pull without a recovery store and did not exercise staging; the revised regression explicitly uses the WAL-enabled path.

## Narrow correction

Exported `abortV4StageAfterFailure(sink, failure)` in `staging-store.ts`, used by both existing callers. It:
- unwraps the original `stageFailure` when the initial error is a cleanup error raised by the sink
- requests an abort before allowing the caller to continue
- if abort cleanup fails with the typed `V4StagingCleanupError`, throws a single typed cleanup error with the *current* unresolved cleanup failure and the original stream/write fault, plus the exact private partial stage path
- if abort throws an unexpected non-staging error, throws an `AggregateError` retaining both exceptions
- if abort succeeds, rethrows the original stream/write exception, not a resolved stale cleanup warning

No automatic recovery, remote ref writes, format change, new UI or authorization to cut over. The existing `SyncSession.cleanupStages` best-effort cleanup in its `finally` remains unchanged because success-vs-cleanup semantics after a *published* commit are a separate policy-sensitive boundary.

## Verification

- Before fix: 2 focused Staging tests RED and WAL-backed Sync pull test RED for the intended loss of original errors.
- After fix: Staging **18/18 PASS**, Sync Session **138/138 PASS**, maximum-strict TypeScript exit 0.
- Broader Recovery, Resource, Feasibility, production Build, full fingerprinted offline Fast and disposable encrypted GitHub E2E verification are recorded in `HANDOFF-NEXT-SESSION.md` after terminal outcomes.
- No actual user Vault or production/default GitHub branches touched. Only approved disposable GitHub test branches may be written, and every such ref must be preflight-absent and cleaned with double verification.

## Remaining risks

A failed OS-level delete may leave bytes in the plugin-private staging directory despite a correct error report. This fix proves *visibility*, not atomic deletion or power-loss crash safety. Review of the post-publication `cleanupStages` policy, physical Android/iOS capability and full installed-owner Re-encryption Cutover remain outstanding. The release gate must not be unblocked based on D407 alone.
