# Release and Real-GitHub E2E Hardening Design

## Goal

Raise release confidence without rewriting the V4 sync core. The work focuses on four boundaries around the existing sync engine:

1. make package/version metadata internally consistent,
2. tighten deterministic causality/conflict tests,
3. execute the existing real-GitHub multi-device E2E as an actual credentialed workflow,
4. make production release explicit and require qualification evidence for the exact commit being released.

The current V4 causality and identity logic remains unchanged unless a new deterministic regression test exposes a concrete defect.

## Current State

- `package.json`, `manifest.json`, and `versions.json` identify 1.0.8, while tracked `package-lock.json` still identifies 1.0.7.
- `package.json` declares pnpm as the package manager and CI/release install with pnpm.
- CI and release compile the destructive GitHub E2E harness with `GITHUB_E2E_COMPILE_ONLY=1`, but do not execute its GitHub REST scenarios.
- The real GitHub E2E already models independent logical devices A/B/C against one disposable real branch and includes deterministic branch-head interference.
- Normal runtime publication already replans branch-head/stale-ref races up to three attempts. This design does not replace that mechanism.

## Design Principles

- Correctness before optimization.
- Prefer deterministic tests over random concurrency or sleep-based timing.
- Keep destructive live tests isolated from ordinary PR CI and forks.
- Qualify the exact commit that will be released.
- Fail closed when qualification evidence is missing or stale.
- Do not pretend GitHub ref updates provide strict server-side compare-and-swap semantics; retain pre-read + non-force update + runtime replan.
- No 5 GiB or physical-device qualification in the quick live E2E.
- No new runtime dependency for the Obsidian plugin.

## 1. Package and Version Metadata

### Canonical package manager

The repository becomes pnpm-only for dependency locking.

- Remove tracked `package-lock.json`.
- Keep `pnpm-lock.yaml` as the only dependency lockfile.
- Add root ignore/protection for `package-lock.json` and `yarn.lock` so accidental alternate lockfiles do not enter normal commits.

### Package validation

Extend `scripts/validate-package.mjs` to validate release metadata, not just artifact presence:

- `package.json.version === manifest.json.version`.
- `versions.json` contains the current manifest version.
- `versions.json[currentVersion] === manifest.minAppVersion`.
- `pnpm-lock.yaml` exists and is tracked.
- `package-lock.json` and `yarn.lock` are not tracked.
- Existing secret-file and release-artifact checks remain intact.

The validator must be deterministic and require no network access.

### Version bump helper

Update `scripts/update-version.js` so a normal version bump updates all canonical version metadata in one operation:

- `package.json`,
- `manifest.json`,
- `versions.json` using the current `manifest.minAppVersion`.

The helper must reject malformed versions rather than silently producing inconsistent metadata.

## 2. Deterministic Correctness Hardening

Add tests around the existing V4 core before changing production semantics.

### Rename versus stale edit

Strengthen the current scenario so it asserts the complete result, not only byte survival:

- exact canonical renamed path,
- exactly one conflict copy when policy is `copy`,
- expected conflict-copy naming contract,
- canonical and conflict-copy bytes,
- distinct file identities where the contract requires a split,
- fresh Device C exact live-record path set,
- encrypted mode identity/remote-path invariants remain opaque and internally consistent.

### Delete versus stale edit

Add a deterministic two-device scenario:

1. A and B share a base file.
2. A deletes and publishes it.
3. stale B edits the old file and syncs.
4. A fresh C pulls.

Assertions must prove no silent data loss and no accidental identity reuse. The expected result must follow the current `copy` conflict policy and planner/session contract rather than inventing a new merge policy.

### Folder rename/delete versus stale descendant changes

Add deterministic scenarios for:

- folder rename on A versus stale descendant edit on B,
- folder delete on A versus stale descendant edit/recreate on B.

Assertions cover exact paths, byte lineages, duplicate count, and file identity continuity/discontinuity.

### Path boundary cases

Add deterministic coverage for:

- case-only path transitions such as `Foo.md` -> `foo.md`,
- Unicode NFC/NFD-equivalent names,
- collision handling on the logical-record layer.

The invariant is fail-safe behavior: the engine must never silently overwrite one logical file with another because of a case-insensitive or Unicode-normalization collision. Tests may assert rejection where the existing codebase intentionally rejects such states.

### Rescan causality matrix

Expand the coordinator/session matrix for combinations of:

- rescan + replace,
- rescan + rename/delete,
- rescan + folder rename/delete,
- ambiguous rename chains.

A rescan may discard redundant `modify` events, but must not discard identity-breaking causal information.

### Production-code rule

If all new tests pass against current production code, no V4 production file is changed.

If a new test exposes a real defect:

- keep the failing regression test,
- implement the smallest production fix,
- keep that fix as a separate commit within the hardening branch so the causality is auditable.

## 3. Credentialed Real GitHub E2E Workflow

Add `.github/workflows/github-e2e-live.yml` as the real network qualification workflow.

### Trigger

- `workflow_dispatch` is required.
- Optional scheduled execution may be added only if it does not make releases dependent on a nightly schedule.
- Ordinary PRs and forks must never receive the live-test secrets.

### Inputs and secrets

The workflow uses a GitHub Environment named `github-e2e` and reads:

- `GITHUB_E2E_OWNER`,
- `GITHUB_E2E_REPO`,
- `GITHUB_E2E_BRANCH`,
- `GITHUB_E2E_TOKEN`.

The configured repository/branch is disposable. The existing runner's protected/default-branch checks remain mandatory.

### Execution

The workflow:

1. checks out the requested commit SHA,
2. installs pnpm dependencies with `--frozen-lockfile`,
3. builds the plugin,
4. runs `pnpm test:github-e2e:quick` without `GITHUB_E2E_COMPILE_ONLY`,
5. records the exact tested commit SHA,
6. uploads a small qualification artifact/manifest containing only non-secret evidence,
7. always attempts branch cleanup through the test harness/final cleanup path.

### Concurrency and timeout

Use one concurrency group for the shared disposable E2E target so two runs cannot delete/reset the same branch concurrently. Do not cancel an already-running destructive test merely because a new dispatch starts.

Set a finite workflow/job timeout. Test correctness must not depend on arbitrary sleeps; existing bounded polling remains acceptable.

### Evidence artifact

On success, generate a machine-readable file such as `github-e2e-qualification.json` containing at minimum:

```json
{
  "schemaVersion": 1,
  "commitSha": "...",
  "workflowRunId": "...",
  "qualifiedAt": "...",
  "suite": "github-e2e-quick"
}
```

No tokens, passphrases, file contents, or encrypted object bytes are stored in this artifact.

## 4. Qualified Explicit Release Workflow

Replace automatic "manifest version changed on master => publish release" behavior with an explicit dispatch flow.

### Trigger and input

`release.yml` becomes `workflow_dispatch`-driven and accepts a release version input. Tag pushes must not create a second release path that bypasses qualification.

### Release preconditions

Before building/releasing, the workflow verifies:

1. checkout is the current intended `master` commit or an explicitly supplied master SHA,
2. requested version equals `manifest.json.version`,
3. `package.json`, `manifest.json`, and `versions.json` are consistent,
4. the target version tag does not already exist,
5. all deterministic local gates pass,
6. successful live-GitHub-E2E evidence exists for the exact target SHA.

### Qualification lookup

The release workflow retrieves the successful live E2E workflow run/artifact for the target SHA and validates `commitSha` inside the artifact. Evidence for a different SHA, even a parent or child commit, is rejected.

If GitHub Actions cannot reliably query a prior artifact by SHA using the chosen action/API permissions, the implementation must use an explicit `workflow_run`/artifact linkage or another fail-closed mechanism. It must never degrade to "latest successful live E2E" without SHA equality.

### Deterministic release gates

The release workflow reruns the non-network gates:

- install with pnpm frozen lockfile,
- build,
- fast tests,
- repeat tests,
- recovery tests,
- resource tests,
- feasibility tests,
- compile-only GitHub E2E harness,
- package validation.

The live GitHub E2E is not rerun inside the release job; it is prequalification evidence for the exact SHA. This keeps release retry behavior deterministic if GitHub's external API is temporarily unavailable.

### Release creation

Only after all preconditions pass:

- create the version tag pointing to the qualified SHA,
- create the GitHub Release,
- upload `main.js`, `manifest.json`, `styles.css`, and the packaged plugin ZIP.

No release/tag is created on failed validation.

## 5. CI Responsibilities

Normal `.github/workflows/ci.yml` remains secret-free and runs on PR/push/manual dispatch:

- frozen pnpm install,
- build,
- deterministic test tiers,
- compile-only real GitHub E2E harness,
- package validation,
- artifact upload.

It does not execute destructive GitHub REST tests.

This separation means a GitHub network outage cannot make every source-code PR fail, while a production release still cannot proceed without explicit live qualification.

## 6. Maintainer User Flow

The intended release flow is:

1. merge normal code to `master`,
2. ensure deterministic CI is green,
3. dispatch `GitHub E2E Live` for the exact master SHA,
4. wait for a successful qualification artifact,
5. dispatch `Release` with that version/SHA,
6. release workflow revalidates deterministic gates and exact-SHA qualification,
7. tag/release is created only after all gates pass.

If the live E2E fails, maintainers fix/retry it without creating a release. If the release build fails, maintainers rerun the release after fixing the source; a source change necessarily changes the SHA and therefore requires a fresh live qualification.

## 7. Verification Strategy

### Local/container attempt

Before delivery, attempt to run all commands available in the execution environment:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm test
corepack pnpm test:repeat
corepack pnpm test:recovery
corepack pnpm test:resource
corepack pnpm test:feasibility
GITHUB_E2E_COMPILE_ONLY=1 corepack pnpm test:github-e2e:quick
corepack pnpm validate:package
```

If the environment cannot fetch/install dependencies, record the limitation and rely on GitHub Actions for deterministic checks.

### Live test handoff

The only expected maintainer-run step is credentialed live qualification if this environment cannot access the required secrets. The repository must provide a copy-pasteable command and the GitHub workflow UI path.

The work is not described as fully qualified until a real live E2E run succeeds for the target SHA.

## 8. Scope Boundaries

This hardening does not include:

- 5 GiB qualification,
- physical Windows/Android qualification,
- pack-scale benchmarking,
- random chaos testing,
- strict server-side CAS that GitHub's ref API does not provide,
- new conflict-resolution policies,
- unrelated V4 refactors.

## 9. Definition of Done

- pnpm is the single canonical dependency-lock source.
- version drift across package/manifest/versions metadata fails validation.
- version bump helper updates all canonical metadata.
- strengthened deterministic conflict/causality/path tests pass.
- no production V4 change exists without a failing regression that requires it.
- ordinary CI stays secret-free and compiles the live harness.
- credentialed workflow executes the real GitHub E2E against a disposable branch.
- successful live E2E produces exact-SHA qualification evidence.
- release is explicit rather than triggered solely by a manifest bump.
- release fails closed without qualification for the exact target SHA.
- release artifacts are created only after deterministic gates pass.
