# HANDOFF — NEXT SESSION

> Persistent handoff for the `obsidian-sync` project.
>
> **Mandatory workflow rule:** Every AI session that makes a material change to code, tests, design decisions, branch/PR state, verification status, or next steps MUST update this file before ending or handing work off. Treat this file as the first document to read when resuming work.

## Repository

- Repository: `crystalicez/obsidian-github-sync-multi-platform`
- Source of truth: GitHub
- Active final integration branch: `feature/local-release-qualification`
- Active PR: #4, base `master`
- PR #6 (`child-c-publication-race-conflict-recovery`) is merged to `master`.
- PR #7 (`child-d-immutable-git-read-fallback`) is merged to `master`.
- PR #4 mechanical restack merge commit: `4c74b8d05d03eae03dbc98fc684418bf7c98a5a3`.
- Current PR #4 branch is ahead-only / `behind=0` relative to `master` and Ready for Review.
- Do **not** assume the current branch HEAD equals a hash written here; this handoff file itself may advance the branch. Run `git rev-parse HEAD` after checkout.

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

Child D was landed to `master` via PR #7. The implementation state below remains historical/reference context.

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
3. PR #4: **FINAL ACCEPTANCE GREEN / READY TO MERGE**. Branch is merged with current `master`, `behind=0`, mergeable, and Ready for Review. Fresh local acceptance is complete on tested head `c6e38c5b5057adedb445a82fb5768435d22cdb73` using exact Node `v24.11.0` + pnpm `9.12.3`.

## PR #4 integration details

Current PR #4 integration decisions and hardening:
- Mechanical merge commit `4c74b8d05d03eae03dbc98fc684418bf7c98a5a3` restacked `feature/local-release-qualification` on master `25ea5f5116b98f2b2941da23b23cf022dbca5fcd`.
- The original master/PR #4 overlap was only `docs/github-e2e.md`, `docs/releasing.md`, and `scripts/run-github-e2e.mjs`; the integration retained master's compiler/input-manifest pipeline and added the local qualification flow around it.
- `GITHUB_E2E_EXPECTED_REPO_ID` is mandatory for local/manual destructive E2E.
- Target safety is bound to numeric identity: target ID must match the configured expected ID and must differ from both the stable canonical source repository ID (`1282135059`) and the current checkout source repository ID.
- Manual live E2E resolves the current checkout origin's numeric repository identity before target mutation; inability to prove source identity fails closed.
- Target preflight also rejects the actual target default branch and requires that default Git ref to be readable.
- Live-E2E/source credentials are separated: install/build/test/compile children get neither target E2E nor standard source/publication GitHub tokens; the live E2E child gets the dedicated E2E token with standard `GH_TOKEN`/`GITHUB_TOKEN`-family variables stripped.
- Local qualification cleanup is restricted to the `obsidian-sync-e2e/local-` namespace, re-proves target identity/default-ref capability before every delete attempt, and accepts success only when a fresh exact branch read is absent **after** the final target proof. A regression test covers stale absence followed by branch recreation.
- The shared live-E2E target-reset helper now applies the same principle to its early-absence path: an initial 404/recognized-missing response is re-proved against current target identity and re-read before reset success; if the branch reappears it is deleted and verified through the normal bounded path.
- `GITHUB_E2E_SOURCE_REPO_ID`, when supplied to the live harness, must be a positive numeric GitHub repository ID; malformed optional source identity fails closed.
- Qualification tag inspection now detects a pre-existing temp-ref collision and never unconditionally deletes a pre-existing local ref. Cleanup uses compare-and-delete against the SHA created by the invocation.
- Release staging rejects symlinked/non-directory `.tmp` / `.tmp/release` ancestors and symlinked staging targets.
- Release metadata, generated `main.js`, the canonical lockfile, and staged upload assets must be real non-empty regular files, not symlinks.
- Deterministic ZIP entry names reject absolute paths, backslashes, empty segments, `.`, and `..` traversal shapes.
- `.env.github-e2e.example` includes the mandatory numeric target repository ID.
- Local stable publication is documented as the supported authority path; GitHub Actions Stable Release remains intentionally interlocked by the current workflow. PR #4 does not bypass or remove that interlock.
- PR #4 is Ready for Review and remains the final integration target; the latest production-fix head before this handoff update is `572a69f40a84e125375cbd9f23de9b11649a1896`. Fresh exact-toolchain local execution evidence is still required before merge.

### PR #4 verification constraint

The AI sandbox still cannot clone/download the repository from GitHub because direct GitHub DNS access fails (`Could not resolve host: github.com`), the public web download bridge does not expose this fork/branch, and the GitHub connector does not provide a workflow-dispatch action. The repository CI workflow supports `push` / `pull_request` / `workflow_dispatch`, but connector-created commits currently produce no Actions run for this branch. Therefore:
- static/code-path review and GitHub diff/ancestry checks can be done here;
- final build/test/package proof must come from a fresh user-local run on the **current PR #4 head**;
- do not merge PR #4 or claim it green until that evidence is reported.

### 2026-09-26 PR #4 acceptance follow-up

User acceptance on head `9f7efca7838cba3a901e4242f2250e90a8e6e028` exposed one focused/full feasibility failure:
- `credentialed runner requires expected target repository ID before execution`
- Windows/Node `v24.11.0` returned `3221226505` after the child printed the expected missing-ID preflight error plus a libuv `UV_HANDLE_CLOSING` assertion.

Root cause review found a real ordering defect rather than treating the crash as environment-only: `scripts/run-github-e2e.mjs` resolved the current source repository through network `fetch()` before validating that all required local E2E configuration was present. Missing `GITHUB_E2E_EXPECTED_REPO_ID` therefore still opened network handles before the process exited.

Fix:
- commit `572a69f40a84e125375cbd9f23de9b11649a1896`
- local origin route is still read first;
- env file/config is loaded and `requireGitHubE2EConfig()` runs **before** any source-repository network lookup;
- only a valid local config proceeds to source numeric-ID lookup and target remote preflight.

The same acceptance log showed:
- fast suite `419/419` PASS;
- repeat fast suite completed 10/10 with `419/419` each;
- recovery `43/43` PASS;
- resource `11/11` PASS;
- GitHub-E2E compile-only PASS;
- producer input-manifest generation PASS;
- package validation PASS.
However that run used Node `v24.11.0`, while the release contract requires exact Node `v22.11.0`; the interactive pasted PowerShell also continued after thrown gate failures. Therefore the run is useful debugging evidence but **not final release acceptance**. A fresh stop-on-first-failure run on exact Node `v22.11.0` is still required after `572a69f...`.

A subsequent stop-on-first-failure acceptance attempt on current head `68846941c8c00ce08382ee457c5c096527ad8fa0` verified:
- branch/head sync succeeded;
- working tree reached the expected PR #4 head;
- toolchain guard stopped immediately because actual Node was still `v24.11.0` while `.node-version` requires `v22.11.0`;
- no build/test gate ran after that mismatch, so this attempt adds no new code/test failure evidence.

Historical note: the acceptance attempts above happened while the committed release contract still required Node `v22.11.0`. The user chose to move the repository's official exact runtime forward instead of installing a second Node version locally.

### Node 24.11.0 exact-toolchain migration

Current release/toolchain authority is now **Node `v24.11.0`**:
- `.node-version` was changed from `v22.11.0` to `v24.11.0`;
- release qualification/release logic remains exact-version fail-closed and reads the committed `.node-version`; no production algorithm needed a Node-specific fork;
- feasibility/V4 release metadata tests that intentionally pin the exact runtime were updated to `v24.11.0`;
- release design/plan/runbook examples were updated to the new exact runtime;
- GitHub workflows already consume `.node-version` (or the exact CI-produced node-version value), so no workflow-specific hardcoded Node major change was required;
- `@types/node` was intentionally not upgraded as part of this runtime migration: it is a compile-time dependency and changing it would add unrelated lockfile/type-surface churn. Final build/tests on Node 24 are the evidence that the current type/runtime combination remains valid.

The user's current Windows installation already resolves `node.exe` from `C:\\Program Files\\nodejs\\node.exe` as `v24.11.0`, so no version-manager installation is required for the new contract.

Fresh acceptance must now run on exact Node `v24.11.0` and pnpm `9.12.3` against the current PR #4 head. The earlier Node-24/libuv failure is **not** accepted as proof: it occurred before the preflight-ordering fix `572a69f40a84e125375cbd9f23de9b11649a1896`; the focused `github-e2e-compile-cli` regression must pass on the migrated toolchain before merge.

### 2026-09-26 Node 24 acceptance progress

The user ran a fresh non-destructive acceptance subset on exact code/test head `1d924d68d0e1ba8efc28ee54189e7e4fe8f66bd7` with:
- Node `v24.11.0`;
- pnpm `9.12.3`.

Observed GREEN evidence:
- focused `github-e2e-compile-cli`: 4/4 PASS, including the regression `credentialed runner requires expected target repository ID before execution`;
- focused `release-metadata`: 9/9 PASS;
- focused `local-qualify`: 9/9 PASS;
- focused `local-release`: 37/37 PASS;
- production build: PASS;
- full feasibility suite: 138/138 PASS, 0 fail/cancel/skip/todo.

This directly verifies the preflight-ordering fix on Node 24 and validates the Node-24 exact-toolchain migration across the release/E2E feasibility surface.

Final acceptance is now GREEN.

Fresh user-local evidence on exact branch head `c6e38c5b5057adedb445a82fb5768435d22cdb73` with Node `v24.11.0` and pnpm `9.12.3`:
- full fast suite: 419/419 PASS;
- repeat fast suite: 10/10 complete, each run 419/419 PASS;
- recovery suite: 43/43 PASS;
- resource suite: 11/11 PASS;
- release metadata validation: PASS;
- GitHub-E2E compile-only: PASS for all 3 bundles;
- CI producer input-manifest path: PASS;
- package validation: PASS;
- final clean-tree/head integrity check: PASS;
- terminal acceptance banner reached without an intervening gate failure.

Combined with the prior Node-24 acceptance subset:
- focused `github-e2e-compile-cli`: 4/4 PASS;
- focused `release-metadata`: 9/9 PASS;
- focused `local-qualify`: 9/9 PASS;
- focused `local-release`: 37/37 PASS;
- production build: PASS;
- full feasibility suite: 138/138 PASS.

Therefore PR #4 has complete non-destructive release-grade acceptance evidence for the integrated Node-24 toolchain. Do not rerun solely because this handoff markdown commit advances the branch head; this update is documentation-only and records the tested SHA above.

## Known housekeeping

The previously noted temporary branch `tmp-ignore` is no longer present in the current remote branch listing, so no action is required for it.

## Next action for a resumed session

1. Read this file first and fetch PR #4 metadata/current head from GitHub.
2. Confirm `feature/local-release-qualification` is still `behind=0` and mergeable against `master`.
3. Do not make new correctness changes unless final static audit or execution output exposes a concrete failure.
4. Run/obtain the final PR #4 acceptance gate on the current head using exact Node `v24.11.0` + pnpm `9.12.3`: focused local-release/E2E feasibility tests, build, full fast/repeat/recovery/resource/feasibility suites, GitHub-E2E compile + producer-manifest path, and package validation.
5. If any gate fails, debug the specific failure before merging.
6. If all final gates are freshly green, update this handoff with exact observed counts/head SHA, merge PR #4 to `master`, verify the merged result, then audit historical remote branches for unique work before deleting only branches proven obsolete.
7. Do not run destructive live GitHub E2E or `release:local` merely as an acceptance test.
8. Any material code/test/design/branch/verification change must update this file before handoff.

## Relevant design / plan docs

- `docs/superpowers/specs/2026-08-30-publication-race-and-conflict-recovery-design.md`
- `docs/superpowers/plans/2026-09-05-publication-race-and-conflict-recovery.md`
- `docs/superpowers/specs/2026-08-30-immutable-git-read-fallback-design.md`
- `docs/superpowers/plans/2026-09-06-immutable-git-read-fallback.md`

## Last updated

- 2026-09-26 (Asia/Bangkok)
- Reason: record the Node v24.11.0 exact-toolchain migration and the remaining fresh execution gate before PR #4 merge.
