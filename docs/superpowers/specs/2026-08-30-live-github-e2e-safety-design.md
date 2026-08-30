# Live GitHub E2E Safety Design

## Status

Child design of `2026-08-30-release-e2e-runtime-hardening-followup-design.md` for baseline `35e98cea924702293bde62d064a83d52eca6d898`.

Revised after formal red-team review on 2026-08-30. This child owns live-E2E executable provenance, target identity, credential isolation, reset/cleanup safety, and release-qualifying execution boundaries.

## Goal

Run real GitHub E2E tests against one pinned disposable repository while ensuring that build/dependency processes never share a runner with the target credential, every target branch mutation proves the pinned repository identity and disposable branch contract, cleanup remains safe across partial reruns, and live qualification executes exact precompiled bundles produced by authoritative ordinary CI for the same source SHA.

## Non-goals

This child does not redefine V4 protocol `repoId`, migrate encrypted data after repository rename, guarantee cleanup after hard cancellation, own stable release publication, or own publication-race retry semantics inside scenario code.

---

# 1. CI Produces the Live-E2E Executable Artifact

Ordinary read-only `ci.yml` is the sole producer of executable bundles later used by live E2E.

After deterministic CI gates and the compile gate succeed, CI creates:

```text
github-e2e-input-${GITHUB_SHA}-${GITHUB_RUN_ID}-${VERIFY_JOB_ATTEMPT}
```

with exactly:

```text
github-e2e-input.json
v4-real-github-e2e.test.mjs
v4-copy-contract-github-e2e.test.mjs
v4-encrypted-external-mutation.test.mjs
```

No source checkout, package-manager state, helper scripts, arbitrary executable, symlink, or extra file is part of this artifact.

`scripts/run-github-e2e.mjs` gains a deterministic compile-only output contract. Compile-only mode requires no target credential, performs no target API work, and emits exactly the three expected bundles to a caller-provided clean directory.

The manifest records data only: schema version, source repository ID/SHA, CI run ID, producer `verify` job execution attempt, exact Node version, bundle names, sizes, and SHA-256 values. It cannot define commands, arbitrary paths, test arguments, or environment names.

CI validates exact entries, regular-file shape, producer identity, and hashes before upload.

---

# 2. Authoritative CI Producer

For the live run's exact `GITHUB_SHA`, select the **newest** ordinary CI run matching:

```text
workflow = ci.yml
event = push
head_branch = master
head_sha = GITHUB_SHA
```

The newest matching run is authoritative even when queued, running, cancelled, or failed. Older successful runs are not fallback authority.

Within that run, the latest execution of job `verify` across attempts must be completed successfully. The selected E2E artifact must bind to the attempt in which that latest successful `verify` execution actually produced it.

If CI is rerun later for the same SHA, the previous E2E artifact and every live qualification based on it become stale. Live E2E must run again against the newer authoritative producer before release.

Completeness-sensitive run/job/artifact discovery is pagination-safe.

---

# 3. Artifact Boundary on a Fresh Runner

The live qualification job uses a fresh GitHub-hosted runner and does not checkout repository code, install project dependencies, build, or compile.

Before executing bundles it:

1. derives authoritative CI producer identity,
2. locates exact artifact name,
3. requires artifact unexpired,
4. verifies artifact repository/run/head metadata,
5. verifies server artifact digest when exposed,
6. inspects archive structure before extraction,
7. rejects traversal, absolute paths, symlinks, duplicate names, unexpected directories, and extras,
8. extracts into a fresh empty directory,
9. parses manifest strictly as data,
10. verifies producer identity and exact bundle allowlist,
11. recomputes every bundle size/SHA-256,
12. obtains exact Node version from the exact source `.node-version` fixed path (or equivalent fixed trusted workflow contract) and requires compatibility.

Only the three fixed verified bundle paths may be executed.

The design does not claim the CI toolchain has no influence on bundle bytes. It treats those bytes as exact reviewed/tested output of authoritative read-only CI and combines that provenance with fresh-runner isolation and target-only credential scope.

---

# 4. Pinned Target Identity and Environment

The `github-e2e` environment stores routing information, a maintainer-pinned numeric target repository ID, and the narrowly scoped target credential.

Before target work:

```text
resolved target.id == configured pinned target repository ID
resolved target.id != source GITHUB_REPOSITORY_ID
```

Owner/repository text is routing only. A changed route that resolves to another accessible repository is rejected rather than becoming new authority.

The target credential must have mutable repository scope limited to the dedicated disposable target. Broad credentials able to modify the source repository or unrelated repositories are not release-qualifying configuration.

The environment uses **Selected branches and tags**, allowing branch `master` and no release tags. Do not use `Protected branches only` while the repository has no branch-protection rule.

The workflow independently requires `GITHUB_REF == refs/heads/master` and current source `master == GITHUB_SHA`.

The target credential is never job-level environment state. It is exposed only to fixed identity/test steps that require it and separately to cleanup. The qualification job contains no repository checkout/install/build/compile step.

The source workflow token remains read-only with only the read permissions needed for source/API/artifact operations.

---

# 5. External Action Pinning

All external `uses:` references in repository workflows are pinned to verified full-length commit SHAs before repository-wide full-SHA action policy is enabled.

A feasibility/static test rejects mutable external action refs. This child may perform the mechanical cross-workflow pinning needed to establish the Actions trust boundary; later child changes preserve those pins.

Privileged live jobs minimize external actions and require no checkout action.

---

# 6. Target Repository and Branch Contract

Target metadata is:

```text
id
full_name
default_branch
```

The disposable target must already have an initialized readable default branch.

Release-qualifying branch is exactly:

```text
obsidian-sync-e2e/run-${GITHUB_RUN_ID}
```

Reruns of one workflow run intentionally reuse that branch; different run IDs remain isolated.

Before target mutation require pinned numeric ID equality, source-vs-target inequality, exact run-derived branch, and branch inequality with actual target default branch. Canonical `full_name` returned by GitHub becomes the routing identity for the run.

---

# 7. Shared Target-Safety Authority

All credentialed E2E suites use one support module, suggested:

```text
tests/github-e2e/support/target-safety.ts
```

It owns target resolution, expected-ID checks, disposable-branch checks, default-branch checks, Git-ref read capability, exact disposable-ref reads, safe reset, and bounded absence verification.

Scenario-specific sync behavior remains in scenario files.

Every target reset boundary re-resolves the target and requires the resolved ID to equal the mandatory expected numeric ID.

---

# 8. Ref Capability and Absence Evidence

Repository metadata visibility alone is not proof of Git-ref read capability.

After resolving target metadata, read the actual default-branch Git ref and require a successful ref with non-empty object SHA. Only then may a recognized exact disposable-ref absence response be treated as absence.

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

Arbitrary `404` or `422` responses are not normalized blindly.

---

# 9. Durable Target Identity Receipt for Cleanup

Do not make cleanup safety depend on undocumented cross-attempt preservation of `needs.<job>.outputs`.

After target identity/default-ref guard succeeds, but **before any scenario target mutation**, `qualify` writes and successfully persists a non-secret receipt artifact:

```text
github-e2e-target-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}
```

containing strict data such as:

```text
schemaVersion
sourceRepositoryId
sourceCommitSha
workflowRunId
qualifyExecutionAttempt
ciProducerRunId
ciVerifyExecutionAttempt
ciE2EArtifactId/digest
targetRepositoryId
targetFullName
targetDefaultBranch
targetBranch
```

Receipt upload is a blocking prerequisite for destructive scenario execution. Therefore if a later `qualify` attempt fails before producing its receipt, that attempt has not yet run target mutation.

The receipt is machine authority for cleanup routing only; Stable Release still judges qualification from workflow/job/API execution state and current CI producer binding.

On cleanup (including `Re-run failed jobs`), select the highest-attempt valid receipt available for the same workflow run. Verify its artifact/source/run metadata and require its target ID to equal the pinned configured target ID before using its canonical route/branch.

This permits cleanup reruns without relying on prior job outputs while ensuring a newer attempt cannot mutate the target before its own cleanup identity has been durably recorded.

---

# 10. Live Workflow Jobs

## `qualify`

Runs on a fresh GitHub-hosted runner and references `environment: github-e2e`.

```text
verify exact source master SHA                    [read-only source token]
select authoritative CI producer                 [read-only source token]
download/verify exact E2E artifact               [read-only source token]
set up exact Node runtime if required             [no target credential]
resolve pinned target + default-ref guard         [target credential]
write + persist target identity receipt           [no target credential]
execute exact three verified bundles serially    [target credential]
write/upload optional richer audit evidence       [no target credential]
```

There is no checkout, pnpm install, repository build, or compile.

Execution is fixed conceptually to `node --test --test-concurrency=1` plus the exact three verified bundle paths. The manifest cannot add tests or arguments.

Optional richer audit evidence may record test completion/timestamps, but release authority remains workflow/job state plus current CI producer identity.

## `cleanup`

Runs separately with `if: always()` and references the same protected environment.

Cleanup does not require `needs.qualify.outputs` as identity authority. It derives the highest valid persisted target receipt for the workflow run, then requires:

```text
receipt source repository/SHA/run identity matches
receipt target ID == pinned target ID
receipt branch == expected run-derived branch
receipt canonical route resolves now to same target ID
resolved ID != source repository ID
branch != current target default branch
current default-branch ref readable
```

Only then may cleanup act on the exact disposable ref and verify absence.

If no valid receipt exists, cleanup may perform no target mutation and fails closed. Because destructive execution is gated on receipt persistence, absence of any receipt means the design provides no evidence that this workflow attempt was allowed to start destructive scenarios.

Hard cancellation can still prevent cleanup after a valid receipt/destructive action; unique per-run branches bound residue to the pinned disposable target.

---

# 11. Local and Manual Safety

Compile-only local mode remains offline and requires no target identity/credential.

Credentialed local execution requires an explicit expected numeric target repository ID in addition to owner/repo, branch, and credential. The expected ID is mandatory.

Local mode may use another explicit disposable branch but rejects actual default branch and conservative protected-looking names.

Manual residue cleanup follows the same pinned-ID/default-ref/absence evidence contract and uses a maintainer-known target ID. The runbook does not offer blind removal that treats ambiguous API absence as success.

---

# 12. Tests

Required evidence includes:

- deterministic credential-free CI bundle output,
- exact three bundle artifact and accurate manifest hashes,
- newest exact-SHA CI run authority,
- newer failing/running CI blocks older success,
- latest `verify` execution authority across attempts,
- CI rerun invalidates previous live input,
- artifact digest/provenance/shape validation,
- no checkout/install/build/compile in live qualification,
- route resolving to wrong pinned target ID rejected,
- source repository ID rejected,
- default branch and malformed run-derived branch rejected,
- default-ref capability failure fails closed,
- exact absence accepted only after capability proof,
- arbitrary validation responses rejected,
- concurrent already-absent race accepted only with final verification,
- target receipt must persist before scenario mutation,
- cleanup can use attempt-1 receipt when only failed cleanup is rerun in attempt 2,
- newer valid receipt supersedes older receipt,
- invalid/mismatched receipt never authorizes cleanup,
- no receipt means no cleanup mutation,
- local credentialed mode requires expected numeric ID,
- no job-level target credential,
- all external action refs are full-SHA pinned.

Publication-race wrapper retry policy is owned by Child C.

---

# 13. Maintainer Flow

One-time configuration:

1. maintain initialized dedicated disposable repository,
2. record its numeric repository ID,
3. configure `github-e2e` environment with selected branch `master`,
4. configure routing values + pinned numeric target ID,
5. configure a target-repository-scoped credential.

Per qualification:

```text
merge master
-> ordinary CI succeeds and produces current E2E bundle artifact
-> dispatch GitHub E2E Live on exact current master
-> live job verifies CI artifact
-> target identity receipt persists
-> exact bundles execute on pinned target
-> cleanup succeeds
```

Normal Obsidian users see no behavior change.

---

# 14. Acceptance Criteria

Complete only when CI is sole compiler of live-E2E bundles; credentialed live execution uses a fresh runner with no repository checkout/install/build/compile; newest authoritative exact-SHA CI evidence controls input; target numeric ID is pinned configuration; target credential scope is target-only; `github-e2e` environment is selected-branch `master`; all external actions are full-SHA pinned; target identity receipt is durably persisted before scenario mutation; cleanup works safely across partial reruns without depending on cross-attempt job outputs; all credentialed suites share one target-safety authority; cleanup proves absence against the pinned target; local credentialed E2E requires expected target ID; and current CI producer/target identities remain auditable.
