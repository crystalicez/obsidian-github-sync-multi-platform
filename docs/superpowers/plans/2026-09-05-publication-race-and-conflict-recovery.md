# Publication Race & Conflict Recovery Implementation Plan

**Date:** 2026-09-05
**Branch:** `child-c-publication-race-conflict-recovery`
**Design:** `docs/superpowers/specs/2026-08-30-publication-race-and-conflict-recovery-design.md`
**Baseline:** `f0cf947b66471ac15e1f2f3060473e3bb0206e91`

## Goal

Implement Child C exactly to the approved design: replace publication message heuristics with structured Git-state evidence, make reconciliation fail closed on incomplete ancestry evidence, recover empty-repository/config races by whole-operation replanning, preserve Copy recovery identity/stages safely, and prove folder-event causality before changing core causality.

## Task 1 — Structured publication race + reconciler evidence

1. Add focused failing tests for:
   - typed publication-race shape/predicate,
   - traversal-limit -> `indeterminate`,
   - ancestry read failure -> `indeterminate`,
   - exact candidate / candidate ancestry / marker-equivalent / expected-head mappings,
   - current-head read failure propagating rather than inventing a race,
   - recovery not writing `verifiedRemoteHead` from indeterminate or advanced-only history.
2. Add a shared `V4PublicationRaceError` module.
3. Update `publish-reconciler.ts` to distinguish complete negative evidence from incomplete evidence and record an indeterminate reason.
4. Update recovery reconciliation to keep `verifiedRemoteHead` only for exact current-head verification.

## Task 2 — Publication path + runtime retry + bootstrap races

1. Add failing tests for:
   - pre-publish mismatch -> typed race/no mutation,
   - failed mutation reconciles candidate-head -> success,
   - candidate-ancestor/marker-equivalent -> typed race with `publicationOutcome="published"`,
   - expected head unchanged -> original failure preserved and one low-level retry only for unknown-outcome failures,
   - advanced/indeterminate current head -> typed race with `publicationOutcome="unknown"`, preserving cause,
   - definitive competing ref failure also reconciles,
   - empty create-ref competing initializer -> `bootstrap-publish`,
   - generic stale-ref wording does not trigger outer retry,
   - typed race retries independent of operation, max three outer attempts,
   - recovery-replan remains Normal-only.
2. Change `git-tree-writer.ts` so all publication-race classification comes from structured evidence.
3. Add speculative-config provenance in runtime/session startup.
4. Before using speculative empty-remote config for remote decode/decrypt, re-observe config; valid newly appearing V4 state -> `bootstrap-config` typed race.
5. Preserve existing migration/Force Push errors for malformed/non-V4 state.
6. Replace runtime message regex with the typed predicate and retain concise terminal UX.

## Task 3 — Recovery / Copy integration

1. Add recovery-tier regression covering Copy conflict reservation/staging, publication race, outer replan, exactly one conflict copy, terminal recovery boundary, and fresh-device convergence where the harness supports it.
2. Keep logical Copy path/file identity stable within one `runState`.
3. Discard invalid stale recovery stages without discarding safe same-run conflict-copy reservations/stages.
4. Ensure indeterminate publication history never becomes `verifiedRemoteHead`.

## Task 4 — Folder causality evidence + live E2E consumers

1. Add deterministic tests using actual queued `folderRename` / `folderDelete` events with edited + untouched descendants for:
   - rename vs stale edited descendant,
   - delete vs stale edited descendant,
   - delete vs stale delete/recreate descendant,
   - nested rename chain,
   - case-only rename,
   - NFC/case namespace collision.
2. Run them against current production behavior first. If they pass, do not change V4 causality. If any fail, make only the smallest demonstrated correction.
3. Migrate both live E2E wrappers from stale-head regex matching to the shared publication-race predicate while preserving Normal-only harness retry policy.
4. Verify the CI precompile path bundles the shared predicate.

## Verification

Attempt locally where the sandbox permits. Because this environment cannot clone GitHub directly, use repository-backed review/static checks here and provide exact repository test commands for any test scope that cannot execute locally.

Target commands after implementation:

```bash
pnpm test -- tests/recovery/v4-publish-reconcile.test.ts
pnpm test -- tests/v4/git-tree-writer.test.ts
pnpm test -- tests/v4/runtime-retry.test.ts
pnpm test -- tests/v4/sync-session.test.ts
pnpm test -- tests/v4/conflict-contract-session.test.ts
pnpm test -- tests/recovery
pnpm test -- tests/v4
pnpm test -- tests/feasibility/github-e2e-compile-cli.test.mjs
pnpm typecheck
```

Live GitHub E2E remains outside local execution unless the agreed live-E2E credentials/safety scope is explicitly available.
