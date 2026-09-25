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
- Last implementation head before this handoff-document commit:
  - Child C: `30676ecdd830734424996101fcba8ee290f95c2f`
  - Child D: `263adbe2584816a9843f64d52fe8dc828595577f`
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
- Merge base of Child D against Child C was confirmed as Child C head `30676ecdd830734424996101fcba8ee290f95c2f`.
- Compare was `ahead`, `behind=0`.
- D-vs-C diff contained only D files:
  - `docs/superpowers/plans/2026-09-06-immutable-git-read-fallback.md`
  - `src/lib/github-api.ts`
  - `src/lib/v4/immutable-git-read.ts`
  - `tests/v4/github-immutable-read-fallback-additional.test.ts`
  - `tests/v4/github-immutable-read-fallback-commit-failure.test.ts`
  - `tests/v4/github-immutable-read-fallback-malformed-evidence.test.ts`
  - `tests/v4/github-immutable-read-fallback.test.ts`

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
node scripts/run-github-e2e.mjs --compile-only --out-dir=.tmp/github-e2e-input --write-input-manifest

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
4. If the user supplies acceptance-test output:
   - on failure: use systematic debugging, fix the smallest demonstrated root cause, push to GitHub, update this file;
   - on success: record exact commands/results in this file, then proceed with integration decision only when the user requests it.
5. If any source/test/design/branch state changes, update this file before ending the session.

## Relevant design / plan docs

- `docs/superpowers/specs/2026-08-30-publication-race-and-conflict-recovery-design.md`
- `docs/superpowers/plans/2026-09-05-publication-race-and-conflict-recovery.md`
- `docs/superpowers/specs/2026-08-30-immutable-git-read-fallback-design.md`
- `docs/superpowers/plans/2026-09-06-immutable-git-read-fallback.md`

## Last updated

- 2026-09-25 (Asia/Bangkok)
- Reason: establish durable cross-session handoff per user instruction.
