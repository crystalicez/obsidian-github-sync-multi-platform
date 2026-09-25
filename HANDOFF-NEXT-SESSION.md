# HANDOFF — NEXT SESSION

> Persistent handoff for the `obsidian-sync` project.
>
> **Mandatory workflow rule:** Every AI session that makes a material change to code, tests, design decisions, branch/PR state, verification status, or next steps MUST update this file before ending or handing work off. Treat this file as the first document to read when resuming work.

## Repository

- Repository: `crystalicez/obsidian-github-sync-multi-platform`
- Source of truth: GitHub
- Active final integration branch: `child-d-immutable-git-read-fallback`
- Child D PR: #7, stacked on Child C
- Child C branch: `child-c-publication-race-conflict-recovery`
- Child C PR: #6, stacked on `master`
- Child C baseline: `f0cf947b66471ac15e1f2f3060473e3bb0206e91`
- Latest code/test heads before the current handoff-document update:
  - Child C: `3c5008948f45d00fed72927183e1647c6572e7c3`
  - Child D merge head: `4595ec537546bd9178cdb682d63b99abc49f0c2f`
- Do **not** assume the current branch HEAD equals the hashes above; this handoff file itself may advance the branch. Run `git rev-parse HEAD` after checkout.

## User instruction

The user asked that `HANDOFF-NEXT-SESSION.md` always be updated from now on so a new AI session can resume immediately if the current session is lost.

Memory is disabled in this project, so this repository file is the durable handoff mechanism.

## Current implementation status

### Child C — publication race / conflict recovery

The red-team findings discovered before final acceptance were addressed in source/tests:

1. Copy conflict stale-stage race:
   - Conflict-copy reservation identity (`path`, `fileId`) remains run-scoped.
   - Conflict-copy stage references are plan/remote-snapshot-scoped.
   - On a publication-race outer retry, `conflictCopyStages` is invalidated while reservation identity is retained.
   - Physical recovery stages are not deleted at that point; recovery reconciliation/discard remains cleanup authority.
   - Recovery regression now covers `R1 -> publication race -> same remote competitor changes to R2 -> retry`, stable reservation identity, refreshed stage, exactly one final copy, and fresh-device convergence.

2. Dual recovery-key / generation selection:
   - Recovery store now chooses the newest structurally valid generation by header/integrity before decoding/decrypting its payload.
   - If the newest generation cannot be decrypted with the current key, it fails closed with `V4RecoveryRequiredError` so existing bootstrap-key fallback can try the same newest generation.
   - Older payloadless terminal generations can no longer hide a newer pending encrypted generation.

3. Stale `replan-required` recovery:
   - A successful fresh session can supersede old `replan-required` state.
   - Terminalization happens only after successful local index save.
   - No repurposing of `verifiedRemoteHead`.

4. Cancellation precedence:
   - Cancellation during publication reconciliation/read failures is canonicalized to `V4CancelledError`.
   - Original mutation/network errors no longer mask a user cancellation.
   - Recovery WAL remains the safety mechanism if remote mutation outcome is uncertain.

5. Empty-repo / configured non-default branch bootstrap race:
   - Added `V4RepositoryBootstrapRaceError` as GitHub-layer evidence.
   - Writer converts that evidence to typed `bootstrap-publish` publication race.
   - Whole-operation replan is used; competitor bootstrap state is not silently adopted into a stale plan.

6. Encrypted speculative winner-KDF acceptance:
   - Runtime integration test covers loser speculative encrypted config with salt A, remote winner config/head with salt B, `bootstrap-config` retry, winner-key derivation, and successful encrypted remote read.

7. Actual runtime publication mutation race:
   - Added runtime coverage where `updateGitRef` actually loses a CAS race and the retry is driven by production reconciliation, not by injecting a typed race from an arbitrary ref read.

8. Observability/security:
   - Error sanitization now retains an allowlisted structured cause chain (`name`, `message`, `status`, `code`, `retryClass`, nested `cause`).
   - Sensitive key/header names such as token/passphrase/authorization/api-key are redacted case-insensitively.
   - Arbitrary Error fields are not serialized.
   - Cycle/depth guards are present.

### Child D — immutable Git read fallback

Child D contains latest Child C as merge ancestry and remains an ahead-only stack relative to Child C.

Implementation:
- Immutable 40-hex commit-SHA Contents 404 fallback is path-directed.
- One non-recursive tree read per exact path segment.
- Positive exact entry can be used even when root/intermediate tree is truncated.
- Negative absence requires `truncated === false` at the level proving absence.
- Duplicate/malformed/unsupported tree evidence fails closed.
- Regular/executable blob supported.
- Final tree/gitlink returns file absence.
- Managed symlink is explicitly unsupported.
- Exact path segments are not normalized/reinterpreted.
- Fallback handles both returned HTTP 404 and thrown errors carrying `status=404`.
- No retained tree cache; no unrelated subtree traversal.
- `GitHubTreeNode.type` widened to `"blob" | "tree" | "commit"` so public type matches gitlink responses.
- Additional D regression tests cover:
  - exact positive entry in a truncated intermediate tree;
  - thrown Contents 404 immutable fallback.

Stack integration:
- Merge base of Child D against Child C is Child C head `3c5008948f45d00fed72927183e1647c6572e7c3`.
- After carrying the acceptance-test corrections into D, compare was `ahead`, `behind=0`.
- Before adding this durable handoff document, D-vs-C diff contained only the seven D implementation/test files below. The current diff is those files **plus** root-level `HANDOFF-NEXT-SESSION.md`:
  - `docs/superpowers/plans/2026-09-06-immutable-git-read-fallback.md`
  - `src/lib/github-api.ts`
  - `src/lib/v4/immutable-git-read.ts`
  - `tests/v4/github-immutable-read-fallback-additional.test.ts`
  - `tests/v4/github-immutable-read-fallback-commit-failure.test.ts`
  - `tests/v4/github-immutable-read-fallback-malformed-evidence.test.ts`
  - `tests/v4/github-immutable-read-fallback.test.ts`
  - `HANDOFF-NEXT-SESSION.md`

## Important design decisions / invariants

- Publication-race retry is structured/evidence-based; do not reintroduce stale-message regex classification.
- Publication reconciliation remains fail-closed on bounded/incomplete ancestry.
- Copy reservation identity may survive an outer publication replan; staged bytes may not be treated as authoritative across a changed remote snapshot.
- Never delete a physical recovery stage at the moment runtime merely clears future stage references; let WAL recovery/discard own safe cleanup.
- Do not terminalize old recovery state before a successful local index save.
- Cancellation should win over transport/mutation errors when the operation signal is aborted.
- Bootstrap races should cause whole-operation replan rather than silent adoption into stale plan state.
- Recovery generation ordering is authoritative before payload-key resolution; never choose an older generation merely because it decrypts under the first key tried.
- Immutable Git fallback must never infer absence from a truncated/incomplete tree.
- Do not add a broad tree cache without profiling; current no-cache design intentionally favors correctness/resource boundedness.

## Verification status

**Do not claim the implementation is fully verified yet.**

### User acceptance run on 2026-09-25

The user ran the acceptance commands on Child D code head `263adbe2584816a9843f64d52fe8dc828595577f` with Node `v24.11.0` and pnpm `9.12.3`.

Observed results:
- production build: PASS;
- targeted recovery/publication/cancellation/bootstrap/encrypted-winner/mutation-race/logging/immutable-read tests: PASS except `runtime-publication-race-stage-lifetime`, which failed only because the test expected terminal `success` for a mocked `changedFiles: 0` result while runtime correctly reports `no-change`;
- fast suite: 411/419 passed, 8 failed;
- repeat runner reproduced the same 8 failures;
- recovery: 43/43 PASS;
- resource: 11/11 PASS;
- feasibility: 37/37 PASS;
- package validation: PASS;
- E2E bundle compilation with `--write-input-manifest` failed because local shell lacked CI producer fields such as `GITHUB_REPOSITORY_ID`; this was a command-mode error, not an E2E bundle compile failure.

Root-cause review of the 8 fast failures:
- two lifecycle assertions expected `success` even though the exercised retry completed with zero changed files; corrected to `no-change`;
- one folder-collision test overfit the exact error wording `V4 path collision`; corrected to assert the invariant `path collision`;
- five CAS-retry tests still simulated the retired regex-era behavior by throwing raw `Error("stale ref")` without changing the remote ref or providing structured evidence. The harness now advances the ref to a real competing commit with the same remote tree and throws a 422 CAS rejection, allowing production reconciliation to prove the publication race.

Corrections were committed to Child C as `2591ebff4dcd0b02acfcc70dbc7c1c3183e8d9ed` and merged into Child D as `196f0bd149cbb7db6b115d799490b33616f7b3d3`.

The user reran on Child D head `cf109389befe2a4d7fd9ca035aa2c97127eaaaeb`:
- folder-conflict-causality targeted suite: 6/6 PASS;
- runtime-publication-race-contract targeted suite: 4/4 PASS;
- runtime-publication-race-stage-lifetime targeted suite: 2/2 PASS;
- settings-secrets targeted suite: 33/35 PASS, leaving exactly two failures;
- full fast suite: 417/419 PASS;
- repeat runner reproduced the same two failures;
- local GitHub E2E compile-only without manifest generation: PASS, all three bundles compiled.

The final two failures were:
- `v4 incremental CAS retry publishes an applied conflict copy when retry chooses use-local`;
- `v4 incremental CAS retry keeps an out-of-scope copy local when policy and settings change`.

Root-cause review confirmed both remaining expectations were stale transaction semantics. A losing publication attempt writes `publish-intent` but does not apply recovery local mutations until candidate publication is proven. Therefore an uncommitted conflict copy from the losing attempt must not become user-visible merely because its reservation survives. If settings/policy change before the fresh retry and the retry chooses `use-local`, no conflict copy should be materialized. The tests now assert:
- no phantom local/remote/index conflict copy;
- canonical remote bytes are the local winner;
- retry progress is one canonical push and zero pulls.

Those final test-only corrections were committed to Child C as `3c5008948f45d00fed72927183e1647c6572e7c3` and merged into Child D as `4595ec537546bd9178cdb682d63b99abc49f0c2f`.

No production source changed in either acceptance-remediation round. The corrected tree still needs a final fast/repeat rerun before it can be called green.

At the time of this handoff:
- GitHub combined status checks for Child C and Child D were empty (`statuses: []`).
- The AI sandbox could not resolve `github.com` for a checkout.
- The sandbox did not have `pnpm` installed.
- Therefore the full repository verification suite has not been run by the AI on the final stacked tree.
- The user was asked to run the acceptance suite locally and return any failure output.

### Acceptance gate

From the repository root, checkout the latest `child-d-immutable-git-read-fallback` and run targeted red-team regressions first, then the full suite.

Use the current branch HEAD; do not use an old hard-coded hash from chat without checking `git rev-parse HEAD`.

Targeted regressions:

```powershell
node scripts/run-tests.mjs --tier=fast --filter=runtime-publication-race-stage-lifetime
node scripts/run-tests.mjs --tier=recovery --filter=v4-copy-publication-race-recovery
node scripts/run-tests.mjs --tier=recovery --filter=v4-bootstrap-recovery-key
node scripts/run-tests.mjs --tier=fast --filter=publication-ref-failure-semantics
node scripts/run-tests.mjs --tier=recovery --filter=v4-publish-reconciler-cancellation
node scripts/run-tests.mjs --tier=fast --filter=github-bootstrap-publication-race
node scripts/run-tests.mjs --tier=fast --filter=runtime-encrypted-speculative-winner
node scripts/run-tests.mjs --tier=fast --filter=runtime-publication-mutation-race
node scripts/run-tests.mjs --tier=fast --filter=debug-sanitization
node scripts/run-tests.mjs --tier=fast --filter=github-immutable-read-fallback
```

Then:

```powershell
pnpm build
pnpm test
pnpm test:repeat
pnpm test:recovery
pnpm test:resource
pnpm test:feasibility

Remove-Item -Recurse -Force .tmp/github-e2e-input -ErrorAction SilentlyContinue
node scripts/run-github-e2e.mjs --compile-only --out-dir=.tmp/github-e2e-input

pnpm validate:package
```

Do not run live GitHub E2E unless credentials/safety scope are explicitly intended. Compile-only is the default acceptance check.

## Known housekeeping

A temporary remote branch named `tmp-ignore` was accidentally created during connector inspection. It contains no unique work and should be deleted when convenient:

```powershell
git push origin --delete tmp-ignore
```

The connector available to the AI session did not expose a delete-ref action, so it could not be removed there.

## Next action for a resumed session

1. Read this file first.
2. Fetch PR #6 and PR #7 metadata and current heads from GitHub; do not trust old hashes blindly.
3. Confirm Child D is still ahead-only / behind=0 relative to Child C.
4. Current immediate next step: rerun only the final corrected surface on the latest Child D head:
   - `node scripts/run-tests.mjs --tier=fast --filter=settings-secrets`
   - `pnpm test`
   - `pnpm test:repeat`.
   The prior rerun already proved the other corrected targeted suites and local E2E compile-only path green.
5. For local E2E compile verification, use compile-only **without** `--write-input-manifest`; manifest creation is CI-producer validation and requires GitHub Actions environment fields.
6. If the user supplies new acceptance output:
   - on failure: use systematic debugging, fix the smallest demonstrated root cause, push to GitHub, update this file;
   - on success: record exact commands/results in this file, then proceed with integration decision only when the user requests it.
7. If any source/test/design/branch state changes, update this file before ending the session.

## Relevant design / plan docs

- `docs/superpowers/specs/2026-08-30-publication-race-and-conflict-recovery-design.md`
- `docs/superpowers/plans/2026-09-05-publication-race-and-conflict-recovery.md`
- `docs/superpowers/specs/2026-08-30-immutable-git-read-fallback-design.md`
- `docs/superpowers/plans/2026-09-06-immutable-git-read-fallback.md`

## Last updated

- 2026-09-25 (Asia/Bangkok)
- Reason: record the second acceptance run, reduce the fast failures from eight to two, document the final transaction-semantics root cause, and record the final test-only corrections.
