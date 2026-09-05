# Live GitHub E2E Safety Design

## Status

Child design of `2026-08-30-release-e2e-runtime-hardening-followup-design.md` for baseline `35e98cea924702293bde62d064a83d52eca6d898`.

Revised after implementation-plan self-review on 2026-08-30. This child owns live-E2E executable provenance, target identity, credential isolation, reset/cleanup safety, and release-qualifying execution boundaries.

## Goal

Run real GitHub E2E tests against one pinned disposable repository while ensuring build/dependency processes never share a runner with the target credential, every target mutation proves pinned repository identity and a non-default disposable branch, cleanup fails closed on ambiguous identity/capability, and release qualification executes exact precompiled bundles produced by authoritative ordinary CI for the same source SHA.

## Non-goals

This child does not redefine V4 protocol `repoId`, migrate encrypted data after repository rename, guarantee cleanup after hard cancellation, own stable release publication, own publication-race retry semantics inside scenario code, or depend on undocumented cross-attempt artifact/job-output behavior.

---

# 1. CI Produces the Live-E2E Executable Artifact

Ordinary read-only `ci.yml` is the sole producer of executable bundles later used by live E2E.

After deterministic CI gates + compile gate succeed, CI creates:

```text
github-e2e-input-${GITHUB_SHA}-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}
```

with exactly:

```text
github-e2e-input.json
v4-real-github-e2e.test.mjs
v4-copy-contract-github-e2e.test.mjs
v4-encrypted-external-mutation.test.mjs
```

No source checkout, package-manager state, helper scripts, arbitrary executable, symlink, or extra file is part of this artifact.

`scripts/run-github-e2e.mjs` gains deterministic compile-only output to a caller-provided clean directory. Compile-only mode does not load `.env.github-e2e`, requires no target credential, performs no target API work, and emits exactly the three expected bundles.

Manifest data includes schema version, source repository ID/SHA, CI run ID, producer run attempt, exact Node version, bundle names, sizes, and SHA-256 values. It cannot define commands, arbitrary paths, test arguments, or environment names.

CI validates exact entries, regular-file shape, producer identity, and hashes before upload.

---

# 2. Authoritative CI Producer

For live run exact `GITHUB_SHA`, select the **newest matching** ordinary CI run satisfying:

```text
workflow = ci.yml
event = push
head_branch = master
head_sha = GITHUB_SHA
```

Newest matching run is authoritative even when queued/running/cancelled/failed; older success is not fallback authority.

The current run attempt must be completed successfully and its `verify` job must be completed/successful in that same attempt. The selected E2E artifact must bind to that exact run attempt.

If CI is rerun later for the same SHA, the previous E2E artifact and live qualification based on it become stale. Live E2E must run again against the new authoritative producer before release.

Completeness-sensitive run/job/artifact discovery is pagination-safe.

---

# 3. Artifact Boundary on a Fresh Runner

Live qualification uses a fresh GitHub-hosted runner and does not checkout repository code, install project dependencies, build, or compile.

Before executing bundles it derives authoritative CI identity, locates the exact artifact, requires unexpired state, verifies artifact repository/run/head metadata + server digest when exposed, rejects traversal/absolute/symlink/duplicate/unexpected archive entries, extracts into a fresh directory, parses the manifest strictly, verifies the exact bundle allowlist and each size/SHA-256, and establishes exact Node runtime from fixed exact-source metadata/workflow contract.

Only the three fixed verified bundle paths may execute.

The design does not claim the CI toolchain has no influence on bundle bytes. Those bytes are treated as exact reviewed/tested output of authoritative read-only CI, combined with fresh-runner isolation and target-only credential scope.

---

# 4. Pinned Target Identity and Environment

The `github-e2e` environment stores routing information, maintainer-pinned numeric target repository ID, and narrowly scoped target credential.

Before target work:

```text
resolved target.id == configured E2E_REPO_ID
resolved target.id != source GITHUB_REPOSITORY_ID
```

Owner/repository text is routing only. A changed route resolving to another accessible repository is rejected rather than becoming new authority.

Target credential mutable repository scope is limited to the dedicated disposable target. Broad credentials able to modify source repository or unrelated repositories are not release-qualifying configuration.

Environment uses **Selected branches and tags**, allowing branch `master` and no release tags. Do not use `Protected branches only` while repository has no branch-protection rule.

Workflow independently requires `GITHUB_REF == refs/heads/master` and current source `master == GITHUB_SHA`.

Target credential is never job-level environment state. It is exposed only to fixed identity/test steps requiring it and separately to cleanup. Qualification contains no repository checkout/install/build/compile step.

Source workflow token remains read-only with only source/API/artifact read permissions.

---

# 5. External Action Pinning

All external `uses:` references in repository workflows are pinned to verified full-length commit SHAs before repository-wide full-SHA action policy is enabled.

A feasibility/static test rejects mutable external action refs. This child may perform mechanical cross-workflow pinning to establish the Actions trust boundary; later child changes preserve pins.

Privileged live jobs minimize external actions and require no checkout action.

---

# 6. Target Repository and Branch Contract

Target metadata:

```text
id
full_name
default_branch
```

Disposable target must already have an initialized readable default branch.

Release-qualifying branch is exactly:

```text
obsidian-sync-e2e/run-${GITHUB_RUN_ID}
```

Reruns of one workflow run intentionally reuse that branch; different run IDs remain isolated.

Before target mutation require pinned numeric ID equality, source-vs-target inequality, exact run-derived branch, and branch inequality with actual target default branch. Canonical `full_name` becomes the route identity for that attempt.

---

# 7. Shared Target-Safety Authority

All credentialed E2E suites use one support module, suggested:

```text
tests/github-e2e/support/target-safety.ts
```

It owns target resolution, expected-ID checks, disposable/default branch checks, Git-ref capability, exact disposable-ref reads, safe reset, and bounded absence verification. Scenario-specific sync behavior remains in scenario files.

Every target reset boundary re-resolves target and requires resolved ID equal mandatory expected numeric ID.

---

# 8. Ref Capability and Absence Evidence

Repository metadata visibility alone is not proof of Git-ref read capability.

After resolving target metadata, read actual default-branch Git ref and require successful ref with non-empty object SHA. Only then may recognized exact disposable-ref absence be treated as absence.

Reset/cleanup semantics:

```text
resolve + verify target identity
verify disposable branch contract
prove default-branch ref readability
read exact disposable ref
  recognized absent -> already clear
  present -> request exact disposable-ref removal
  other -> fail closed
if removal reports recognized concurrent already-absent -> continue
verify default-branch ref readability again
verify exact disposable ref absent with bounded retry if still present
```

Arbitrary `404`/`422` responses are not normalized blindly.

---

# 9. Qualification Receipt

After target identity/default-ref guard succeeds, but **before any scenario target mutation**, `qualify` writes and successfully persists:

```text
github-e2e-target-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}
```

containing strict non-secret data:

```text
schemaVersion
sourceRepositoryId
sourceCommitSha
workflowRunId
workflowRunAttempt
ciProducerRunId
ciProducerRunAttempt
ciE2EArtifactId/digest
targetRepositoryId
targetFullName
targetDefaultBranch
targetBranch
```

Receipt persistence is a blocking prerequisite for destructive scenario execution. Receipt data binds the successful qualification attempt to its exact CI input and observed target identity; it is **not** proof that E2E passed. Job success comes only from Actions job state.

The receipt is not used as a cross-attempt cleanup authority. This design deliberately avoids relying on old-attempt artifact visibility after reruns.

---

# 10. Cohesive Workflow-Attempt Qualification

A live workflow run is release-qualifying only when its **current/latest workflow attempt** is cohesive:

```text
current attempt exists
qualify executed in that attempt and succeeded
cleanup executed in that same attempt and succeeded
receipt for that same attempt exists and is valid
receipt binds to current authoritative CI producer/artifact
```

Older successful job executions are not mixed with newer attempts to synthesize qualification.

If `cleanup` fails, a maintainer may use **Re-run failed jobs** only as an operational cleanup retry; that partial attempt is not release-qualifying because `qualify` did not execute in the same attempt. To restore release qualification, use **Re-run all jobs** so a new cohesive attempt creates a new receipt, reruns the exact bundles, and cleans up successfully.

This intentionally trades a little rerun convenience for documented, auditable provenance and removes dependence on cross-attempt artifact/job-output behavior.

---

# 11. Live Workflow Jobs

## `qualify`

Runs on fresh GitHub-hosted runner and references `environment: github-e2e`.

```text
verify exact source master SHA                    [read-only source token]
select authoritative CI producer                 [read-only source token]
download/verify exact E2E artifact               [read-only source token]
set up exact Node runtime if required             [no target credential]
resolve pinned target + default-ref guard         [target credential]
write + persist same-attempt qualification receipt [no target credential]
execute exact three verified bundles serially    [target credential]
```

There is no checkout, pnpm install, repository build, or compile.

Execution is fixed conceptually to `node --test --test-concurrency=1` plus exact three verified bundle paths. Manifest cannot add tests or arguments.

## `cleanup`

Runs separately with `if: always()` and references the same protected environment.

Cleanup independently uses the currently configured route plus pinned `E2E_REPO_ID`; it does not trust old-attempt artifacts or need prior job outputs as repository identity authority.

Before any target mutation it requires:

```text
configured route resolves now
resolved target ID == pinned E2E_REPO_ID
resolved target ID != source repository ID
branch == obsidian-sync-e2e/run-${GITHUB_RUN_ID}
branch != current target default branch
current default-branch ref readable
```

Only then may it inspect/remove the exact disposable ref and verify absence.

If route/ID/capability is ambiguous, cleanup mutates nothing and fails closed. Hard cancellation can still prevent cleanup; unique per-run branches bound residue to the pinned disposable target.

---

# 12. Local and Manual Safety

Compile-only local mode remains offline and requires no target identity/credential.

Credentialed local execution requires explicit expected numeric target repository ID in addition to owner/repo, branch, and credential. Expected ID is mandatory.

Local mode may use another explicit disposable branch but rejects actual default branch and conservative protected-looking names.

Manual residue cleanup follows the same pinned-ID/default-ref/absence evidence contract. Runbook does not offer blind removal that treats ambiguous API absence as success.

---

# 13. Tests

Required evidence includes deterministic credential-free CI bundle output; exact bundle artifact/hash manifest; newest exact-SHA CI authority; newer failed/running CI blocks older success; current CI attempt/verify success; CI rerun invalidates prior live input; artifact digest/provenance/shape validation; no checkout/install/build/compile in live qualification; wrong pinned/source/default target rejection; default-ref capability failure; exact absence only after capability proof; arbitrary validation response rejection; concurrent already-absent handling with final verification; receipt persisted before scenario mutation; same-attempt receipt/job qualification; partial cleanup-only rerun is not release-qualifying; local expected numeric ID mandatory; no job-level target credential; and all external action refs full-SHA pinned.

Publication-race wrapper policy is owned by Child C.

---

# 14. Maintainer Flow

One-time:

1. maintain initialized dedicated disposable repository,
2. record numeric repository ID,
3. configure `github-e2e` environment selected branch `master`,
4. configure routing + pinned numeric target ID,
5. configure target-repository-scoped credential.

Per qualification:

```text
merge master
-> ordinary CI succeeds and produces current E2E bundle artifact
-> dispatch GitHub E2E Live on exact current master
-> live verifies CI artifact
-> same-attempt qualification receipt persists
-> exact bundles execute on pinned target
-> cleanup succeeds in same workflow attempt
```

If cleanup alone fails and is retried separately, treat that as cleanup-only evidence; rerun all jobs before release qualification.

Normal Obsidian users see no behavior change.

---

# 15. Acceptance Criteria

Complete only when CI is sole compiler of live-E2E bundles; credentialed live execution uses fresh runner with no repository checkout/install/build/compile; newest authoritative exact-SHA CI controls input; target numeric ID is pinned; target credential scope is target-only; `github-e2e` environment is selected-branch `master`; external actions are full-SHA pinned; same-attempt receipt persists before scenario mutation and binds successful `qualify` to exact CI input; release qualification requires `qualify` + `cleanup` success in the same current workflow attempt; partial cleanup-only rerun never synthesizes release qualification; all suites share one target-safety authority; cleanup independently proves current pinned target identity/capability; local credentialed E2E requires expected target ID; and current CI producer/target identities remain auditable.