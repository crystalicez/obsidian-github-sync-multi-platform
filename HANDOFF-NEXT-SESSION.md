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
  - Child C: `73a35a67aaff69f9765c3a2005d035a0e7e12d04`
  - Child D merge head: `af29c7c5339cfd552af577856c98cd2f0d446e00`
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
- Merge base of Child D against Child C is Child C head `73a35a67aaff69f9765c3a2005d035a0e7e12d04`.
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

**GREEN — acceptance completed on 2026-09-25.**

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

The user reran on Child D head `10a52a586d4add81c3d0562dc893b04b4d33a60b`:
- settings-secrets targeted suite remained 33/35 PASS;
- full fast suite remained 417/419 PASS;
- repeat runner reproduced the same two failures;
- the copy-count assertions were fixed, and the only remaining mismatch became canonical remote content: actual `remote change`, expected `local change`.

Root cause: the generic race harness created a synthetic **external** competing commit before invoking the settings-change callback. On the fresh plaintext retry, external reconciliation re-stamped remote metadata with `mtime = now()`; therefore policy `newer` correctly chose the remote content. The test name/intent said the retry should choose local, so the harness—not production—was modeling the wrong kind of competitor.

The harness now supports an async failure hook. For these two regressions, the remote runtime performs a real `forcePush()` during the local CAS attempt and the test asserts the competing V4 head actually advances. Only when a hook does not advance the ref does the generic harness fall back to a synthetic external competitor. This preserves the original intent: a plugin-valid competing publication advances the head without changing the logical `conflict.md` record, then the changed `newer` policy selects the local mtime-3 edit.

This third acceptance-remediation commit is test-only:
- Child C: `73a35a67aaff69f9765c3a2005d035a0e7e12d04`
- merged into Child D: `af29c7c5339cfd552af577856c98cd2f0d446e00`

No production source changed in the acceptance-remediation rounds.

### Final green acceptance

The user reran the final corrected Child D head `29406e9235c1484b919d835ecfb2ed00a6b92d9d` and reported:
- `settings-secrets` targeted fast suite: **35/35 PASS**;
- full fast suite: **419/419 PASS**;
- repeat runner: **10/10 complete repeats**, each **419/419 PASS**;
- zero failures, cancellations, skips, or todos in the final repeat summaries.

Earlier acceptance gates on the same production implementation had already passed:
- production build: PASS;
- recovery: 43/43 PASS;
- resource: 11/11 PASS;
- feasibility: 37/37 PASS;
- package validation: PASS;
- targeted publication/recovery/cancellation/bootstrap/encrypted-winner/mutation-race/logging/immutable-read regressions: PASS after expectation/harness corrections;
- local GitHub E2E compile-only without manifest generation: PASS for all three bundles.

Only test/harness and handoff-document commits changed after those earlier production gates; production source did not change. Therefore the final stacked implementation is accepted green.

The AI sandbox itself still cannot independently checkout/run the repository because direct GitHub DNS/pnpm availability is constrained, so the authoritative green evidence is the user's local acceptance run recorded above.

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

## Remaining repository work after green acceptance

Current GitHub backlog survey:
- PR #6 (`child-c-publication-race-conflict-recovery`) was merged to `master` on 2026-09-25 with merge commit `23c9c29dfbdd276733a082fdb8afb2feda86b2b3`.
- PR #7 (`child-d-immutable-git-read-fallback`) was retargeted to `master`, verified D-only, and merged on 2026-09-25 with merge commit `f3d07ebd98131e50328051c1415bbbb7cdee7cdb`.
- PR #4 (`feature/local-release-qualification`) is still open and draft but currently `mergeable=false`. Compared with current `master`, it is 40 commits ahead / 1 behind and needs a dedicated rebase/merge conflict review plus fresh verification before integration.
- There are currently no open GitHub issues.
- The repository still has multiple historical/agent/fix/design remote branches with no open PR. Treat branch cleanup as optional housekeeping only after checking whether each branch contains unique work.
- Current commit-status API results for PR #4/#6/#7 are empty, so do not assume GitHub-hosted CI evidence exists; rely on recorded local acceptance until new CI is configured/run.

Integration progress:
1. PR #6: **DONE**, merged to `master`.
2. PR #7: **DONE**, retargeted, D-only diff verified, merged to `master`.
3. PR #4: **NEXT**, resolve `feature/local-release-qualification` against the now-final master, re-run release/qualification verification, and merge if still valid.

## Known housekeeping

The previously noted temporary branch `tmp-ignore` is no longer present in the current remote branch listing, so no action is required for it.

## Next action for a resumed session

1. Read this file first.
2. Fetch PR #6 and PR #7 metadata and current heads from GitHub; do not trust old hashes blindly.
3. Confirm Child D is still ahead-only / behind=0 relative to Child C.
4. Acceptance is green. Do **not** make further correctness changes unless a new failure, review finding, or user request appears.
5. Preserve the stack: PR #7 remains on top of PR #6 until the user chooses the merge/integration sequence.
6. If local E2E compile verification is repeated outside CI, use compile-only **without** `--write-input-manifest`; manifest creation requires GitHub Actions producer environment fields.
7. Known housekeeping remains: delete remote branch `tmp-ignore` when convenient.
8. If any source/test/design/branch/verification state changes, update this file before ending the session.

## Relevant design / plan docs

- `docs/superpowers/specs/2026-08-30-publication-race-and-conflict-recovery-design.md`
- `docs/superpowers/plans/2026-09-05-publication-race-and-conflict-recovery.md`
- `docs/superpowers/specs/2026-08-30-immutable-git-read-fallback-design.md`
- `docs/superpowers/plans/2026-09-06-immutable-git-read-fallback.md`

## Last updated

- 2026-09-25 (Asia/Bangkok)
- Reason: record PR #6 and PR #7 fully landed; PR #4 is the remaining integration target.
