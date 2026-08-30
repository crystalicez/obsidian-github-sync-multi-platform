# Live GitHub E2E Safety Design

## Status

Child design of `2026-08-30-release-e2e-runtime-hardening-followup-design.md` for baseline `35e98cea924702293bde62d064a83d52eca6d898`.

Revised after formal red-team review on 2026-08-30. This child owns live-E2E executable provenance, target identity, credential isolation, reset/cleanup safety, and release-qualifying execution boundaries.

## Goal

Run real GitHub E2E tests against one pinned disposable repository while ensuring that build/dependency processes never share a runner with the target credential, every branch mutation proves the pinned target identity and disposable branch contract, and live qualification executes exact precompiled bundles produced by authoritative ordinary CI for the same source SHA.

## Non-goals

This child does not redefine V4 protocol `repoId`, migrate encrypted data after repository rename, guarantee cleanup after hard cancellation, own stable release publication, or own publication-race retry semantics inside scenario code.

---

# 1. CI Produces the Live-E2E Executable Artifact

Ordinary read-only `ci.yml` is the sole producer of executable bundles later used by live E2E.

After the deterministic CI gates and compile gate succeed, CI creates:

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

`scripts/run-github-e2e.mjs` gains a deterministic compile-only output contract, such as an explicit output directory. Compile-only mode requires no target credential, performs no target API work, and emits exactly the three expected bundles.

`github-e2e-input.json` records data only: schema version, source repository ID/SHA, CI run ID, producer `verify` job execution attempt, exact Node version, bundle names, sizes, and SHA-256 values. It cannot define commands, arbitrary paths, test arguments, or environment names.

CI validates exact entries, regular-file shape, producer identity, and bundle hashes before upload.

---

# 2. Authoritative CI Producer

For the live run's exact `GITHUB_SHA`, GitHub E2E Live selects the **newest** ordinary CI run matching:

```text
workflow = ci.yml
event = push
head_branch = master
head_sha = GITHUB_SHA
```

The newest matching run is authoritative even when queued, running, cancelled, or failed; an older success is never used as fallback.

Within that run, the latest execution of job `verify` across attempts must be completed successfully. The selected E2E artifact must bind to the execution attempt that produced it.

If CI is rerun later for the same SHA, the previous E2E artifact and any live qualification based on it become stale. Live E2E must run again against the newer authoritative producer before release.

Completeness-sensitive run/job/artifact discovery is pagination-safe.

---

# 3. Artifact Boundary on a Fresh Runner

The live qualification job uses a fresh GitHub-hosted runner and does not checkout the repository, install project dependencies, build, or compile.

Before executing bundles it:

1. derives the authoritative CI producer,
2. locates the exact artifact name,
3. requires the artifact to be unexpired,
4. verifies artifact repository/run/head metadata,
5. verifies the server artifact digest when exposed,
6. inspects archive structure before extraction,
7. rejects traversal, absolute paths, symlinks, duplicate names, unexpected directories, and extras,
8. extracts into a fresh empty directory,
9. parses the manifest strictly as data,
10. verifies producer identity and exact bundle allowlist,
11. recomputes every bundle size/SHA-256,
12. obtains the exact Node version from the exact source `.node-version` fixed path (or equivalent fixed trusted workflow contract) and requires compatibility with the manifest.

Only the three fixed verified bundle paths may then be executed.

The design does not claim the CI toolchain has no influence on bundle bytes. It treats those bytes as the exact reviewed/tested output of authoritative read-only CI and combines that provenance with runner isolation and a repository-scoped target credential.

---

# 4. Pinned Target Identity and Environment

The `github-e2e` environment stores routing information, a maintainer-pinned numeric target repository ID, and the narrowly scoped target credential.

Before target work:

```text
resolved target.id == configured pinned target repository ID
resolved target.id != source GITHUB_REPOSITORY_ID
```

Owner/repository text is routing only. A typo or changed route that resolves to another accessible repository is rejected rather than becoming new authority.

The target credential must be scoped so its mutable repository authority is limited to the dedicated disposable target. Broad credentials able to modify the source repository or unrelated repositories are not release-qualifying configuration.

The `github-e2e` environment uses **Selected branches and tags** with branch `master` allowed and no release tags. Do not use `Protected branches only` while this repository has no branch-protection rule.

The workflow still independently requires `GITHUB_REF == refs/heads/master` and current source `master == GITHUB_SHA`.

The target credential is never job-level environment state. It is exposed only to the fixed target guard/execution steps that require it, and separately to the cleanup job. The qualification job contains no repository checkout/install/build/compile step.

---

# 5. External Action Pinning

All external `uses:` references in repository workflows are pinned to verified full-length commit SHAs before repository-wide full-SHA action policy is enabled.

A feasibility/static test rejects mutable external action refs. This child may perform the mechanical cross-workflow pinning needed to establish the Actions trust boundary; later child changes preserve those pins.

Privileged live jobs minimize external actions and require no checkout action.

---

# 6. Target Repository and Branch Contract

Target metadata resolved with the target credential is:

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

Before target mutation require the pinned numeric ID, source-vs-target inequality, exact run-derived branch, and branch inequality with the actual target default branch. Canonical `full_name` returned by GitHub becomes the routing identity for the rest of the run.

---

# 7. Shared Target-Safety Authority

All credentialed E2E suites use one support module, suggested:

```text
tests/github-e2e/support/target-safety.ts
```

It owns target resolution, expected-ID checks, disposable-branch checks, default-branch checks, Git-ref read capability, exact disposable-ref reads, safe branch reset, and bounded absence verification.

Scenario-specific sync behavior remains in scenario files.

Every reset boundary re-resolves the target and requires the resolved ID to equal the mandatory expected numeric ID.

---

# 8. Ref Capability and Absence Evidence

Repository metadata visibility alone is not proof of Git-ref read capability.

After resolving target metadata, read the actual default-branch Git ref and require a successful ref with non-empty object SHA. Only then may a recognized exact disposable-ref absence response be treated as absence.

Reset/cleanup semantics are:

```text
resolve + verify target identity
verify disposable branch contract
prove default-branch ref readability
read exact disposable ref
  absent with recognized semantics -> already clear
  present -> request exact disposable-ref removal
  other -> fail closed
verify default-branch ref readability again
verify exact disposable ref absent, with bounded retries if still present
```

If another actor removes the disposable ref between the read and removal request, a recognized already-absent result is accepted only after prior capability proof and is followed by the same final absence verification.

Arbitrary `404` or `422` responses are not normalized blindly.

---

# 9. Live Workflow Jobs

## `qualify`

Runs on a fresh GitHub-hosted runner and references `environment: github-e2e`.

```text
verify exact source master SHA                    [read-only source token]
select authoritative CI producer                 [read-only source token]
download and verify exact E2E artifact           [read-only source token]
set up exact Node runtime if required             [no target credential]
resolve target + pinned-ID/default-ref guard      [target credential]
execute exact three verified bundles serially    [target credential]
write/upload non-secret audit evidence            [no target credential]
```

There is no checkout, pnpm install, repository build, or compile.

Execution is fixed conceptually to `node --test --test-concurrency=1` plus the exact three verified bundle paths. The manifest cannot add tests or arguments.

Audit evidence records source SHA/run identity, CI producer run/job-execution identity and artifact ID/digest, target numeric ID/full name/branch, suite name, and timestamp.

## `cleanup`

Runs separately with `if: always()` and uses the canonical target full name/ID/branch established by `qualify`, not whichever mutable routing text happens to be configured later.

Before target mutation it requires the qualified identity outputs, equality with the pinned target ID, current resolution of the qualified canonical route to the same ID, source-vs-target inequality, exact run-derived branch, non-default branch, and default-ref readability.

Ambiguity performs no target mutation and fails. Hard cancellation can still prevent cleanup; unique per-run branches bound residue to the pinned disposable target.

---

# 10. Local and Manual Safety

Compile-only local mode remains offline and requires no target identity/credential.

Credentialed local execution requires an explicit expected numeric target repository ID in addition to owner/repo, branch, and credential. The expected ID is mandatory rather than advisory.

Local mode may use another explicit disposable branch but rejects the actual default branch and retains conservative protected-looking branch checks.

Manual residue cleanup follows the same identity/default-ref/absence evidence contract and uses a maintainer-known expected numeric target ID. The runbook does not offer a blind removal command that treats ambiguous API absence as success.

---

# 11. Tests

Required evidence includes:

- deterministic credential-free CI bundle output,
- exact three bundle artifact and accurate manifest hashes,
- newest exact-SHA CI run authority,
- newer failing/running CI blocks older success,
- latest `verify` execution authority across attempts,
- CI rerun invalidates previous live input,
- artifact digest/provenance/shape validation,
- no checkout/install/build/compile in live qualification,
- route resolving to wrong pinned repository ID rejected,
- source repository ID rejected,
- default branch and malformed run-derived branch rejected,
- default-ref capability failure fails closed,
- exact absence accepted only after capability proof,
- arbitrary validation responses rejected,
- concurrent already-absent race accepted only with final verification,
- cleanup uses qualified canonical target identity,
- local credentialed mode requires expected numeric ID,
- no job-level target credential,
- all external action refs are full-SHA pinned.

Publication-race wrapper retry policy is owned by Child C.

---

# 12. Maintainer Flow

One-time configuration:

1. maintain an initialized dedicated disposable repository,
2. record its numeric repository ID,
3. configure `github-e2e` environment with selected branch `master`,
4. configure routing values + pinned numeric target ID,
5. configure a target-repository-scoped credential.

Per qualification:

```text
merge master
-> ordinary CI succeeds and produces current E2E bundle artifact
-> dispatch GitHub E2E Live on exact current master
-> live job verifies and executes those CI bundles on the pinned target
-> cleanup succeeds
```

Normal Obsidian users see no behavior change.

---

# 13. Acceptance Criteria

Complete only when CI is the sole compiler of live-E2E bundles; live credentialed execution uses a fresh runner with no repository checkout/install/build/compile; newest authoritative exact-SHA CI evidence controls the input; target numeric ID is pinned configuration; target credential scope is target-only; `github-e2e` environment is selected-branch `master`; all external actions are full-SHA pinned; all credentialed suites share one target-safety authority; cleanup is bound to qualified canonical target identity and proves absence safely; local credentialed E2E requires expected target ID; and audit evidence records both CI producer and target identities.
