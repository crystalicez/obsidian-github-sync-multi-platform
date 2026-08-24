# Release, Conflict-Contract, and Real-GitHub E2E Hardening Design

## Goal

Raise release confidence and multi-device correctness evidence without rewriting the V4 sync core by default. The work hardens five boundaries around the existing engine:

1. make package/version metadata internally consistent and single-source,
2. make the current conflict semantics explicit and align docs/tests/UI with the implementation,
3. tighten deterministic causality, namespace, conflict, and runtime-retry tests,
4. execute the real-GitHub multi-device E2E as an isolated credentialed workflow,
5. remove release bypasses and make stable release an explicit exact-SHA qualified operation.

The current V4 causality/identity implementation remains unchanged unless a new deterministic regression test exposes a concrete defect. Any production change must be preceded by a failing regression and kept minimal.

## Audited Current State

- `package.json`, `manifest.json`, and `versions.json` identify 1.0.8, while tracked `package-lock.json` still identifies 1.0.7.
- `package.json` declares pnpm as the package manager, `pnpm-lock.yaml` exists, and CI/release install with pnpm.
- `scripts/update-version.js` currently derives bump targets independently from each versioned file, writes only `package.json` and `manifest.json`, and may fall back to `npm_package_version`. This can preserve or hide pre-existing metadata drift.
- CI and stable release compile the destructive GitHub E2E harness with `GITHUB_E2E_COMPILE_ONLY=1`; they do not execute the real REST scenarios.
- `.github/workflows/pre-release.yml` is a second release path: a non-master branch version bump can create an `-alpha` tag/release with weaker gates. This bypass must be removed as part of the same release-hardening change.
- The real GitHub E2E already models independent logical devices A/B/C against one real disposable branch and includes deterministic branch-head interference.
- Runtime publication already replans branch-head/stale-ref races up to three attempts. The live lower-level race test does not by itself prove that user-facing runtime retry path, so deterministic runtime coverage is required.
- Current executable conflict semantics are **local-primary / remote-conflict-copy**: the `copy` resolver returns `keep-local-copy-remote`, and current unit/live tests enforce that behavior. The FAQ currently says the opposite and is stale.
- Case-insensitive/NFC collision checks are currently performed on local and remote sets separately. Different file identities colliding only across the local/remote boundary can therefore reach planning/apply before failing; this should be tested and, if necessary, moved to an earlier fail-safe validation boundary.

## Design Principles

- Correctness before optimization.
- Preserve current executable behavior unless a regression proves it unsafe.
- Prefer deterministic tests over random concurrency and sleep-based correctness assertions.
- Preserve user data rather than silently choosing last-writer-wins.
- Fail early on ambiguous cross-platform namespaces.
- Keep destructive network qualification isolated from normal PR/fork CI.
- Successful exact-SHA workflow/job metadata is authoritative qualification evidence; uploaded artifacts are audit aids, not the source of truth.
- Qualify exactly the commit that will be released.
- Fail closed when qualification is absent, stale, skipped, or for a different SHA.
- Do not claim strict server-side compare-and-swap semantics that GitHub's ref update API does not provide; retain pre-read + non-force update + runtime replan.
- No 5 GiB physical qualification or pack-scale benchmark in the quick live E2E.
- No new runtime dependency for the Obsidian plugin.

---

## 1. Package and Version Metadata

### 1.1 Canonical package manager

The repository becomes explicitly pnpm-only for dependency locking.

- Remove tracked `package-lock.json`.
- Keep `pnpm-lock.yaml` as the only dependency lockfile.
- Ignore root `package-lock.json` and `yarn.lock`.
- Remove the duplicated GitHub-E2E ignore entries while editing `.gitignore`.

### 1.2 Package validation

Extend `scripts/validate-package.mjs` so release metadata drift fails before publication. It must validate, without network access:

- `package.json.version` and `manifest.json.version` are valid stable `x.y.z` versions.
- `package.json.version === manifest.json.version`.
- `manifest.minAppVersion` is a valid `x.y.z` version.
- `versions.json` contains the current manifest version.
- `versions.json[currentVersion] === manifest.minAppVersion`.
- `package.json.packageManager` identifies pnpm.
- `pnpm-lock.yaml` exists and is tracked.
- `package-lock.json` and `yarn.lock` are not tracked.
- Existing release-artifact and secret-file checks remain intact.

The validator does not require every historical release tag to exist; `versions.json` is compatibility metadata, while publication state belongs to Git tags/releases.

### 1.3 Version bump helper

Harden `scripts/update-version.js` around a preflight/compute/write flow:

1. require an explicit CLI version/bump argument or `NEW_VERSION`; do not silently fall back to `npm_package_version`,
2. read `package.json`, `manifest.json`, and `versions.json` before writing anything,
3. require current package/manifest versions to match,
4. derive the target version exactly once from the canonical current version,
5. require the target to be valid `x.y.z` and greater than the current version,
6. require the target key not to already exist in `versions.json`,
7. compute all updated JSON documents in memory,
8. write `package.json`, `manifest.json`, then append `versions.json[target] = manifest.minAppVersion`.

A failed preflight must leave all files untouched. The helper is not described as a filesystem transaction across power loss; the guarantee is that validation errors happen before writes.

### 1.4 Script regression tests

Add fast tests that spawn the version helper/validator against temporary fixture directories initialized as small Git repositories so tracked-file checks are real. Cover:

- patch/minor/major and explicit versions derive one target for all metadata,
- existing package/manifest drift is rejected before mutation,
- malformed/non-increasing/duplicate versions are rejected,
- missing/wrong `versions.json` mapping fails validation,
- alternate tracked lockfiles fail validation,
- valid pnpm metadata passes.

---

## 2. Conflict Semantics and User Contract

### 2.1 Canonical copy-policy contract

The current implementation is the contract for this hardening:

> **Copy policy keeps the local version at the canonical path and preserves the remote version as a conflict copy.**

This avoids a breaking semantic flip during release hardening because the resolver action name, unit tests, and current real-GitHub E2E already agree on local-primary behavior. It also keeps the file the user is actively editing at its familiar local path while preserving the competing remote lineage.

Update:

- English and Chinese FAQ copy-policy wording,
- the Settings option/description to an explicit user-facing phrase such as `Copy (keep local, copy remote)`,
- E2E/test names/messages where necessary.

No conflict-resolution policy is added.

### 2.2 Exact same-file conflict

Retain and strengthen the existing copy-conflict test:

- local bytes remain at the canonical path,
- exactly one remote conflict copy exists,
- the conflict copy has the expected deterministic suffix in fixed-time tests,
- canonical file identity remains the original identity,
- conflict-copy identity is distinct,
- a fresh device obtains the exact path set and byte mapping.

### 2.3 Rename versus stale local edit

For the existing sequence where A remotely renames `old -> new` and stale B edits `old`, the exact copy-policy outcome is:

- B's edited local lineage remains canonical at `old` with the original file identity,
- A's remote renamed version is preserved as exactly one conflict copy derived from the remote `new` path,
- the conflict copy has a new file identity,
- no extra old/new/conflict duplicates exist,
- a fresh Device C sees exactly those final live paths and bytes.

For encrypted mode:

- logical paths never leak into Git tree object paths,
- canonical and conflict-copy identities are distinct,
- their opaque storage bindings remain internally consistent,
- the canonical original file identity remains stable even though its content/version changed.

This intentionally documents current behavior instead of assuming the remote rename must win the canonical path.

### 2.4 Delete/edit asymmetry under local-primary copy policy

Test both directions explicitly because deletion has no bytes to materialize as a copy.

**Remote delete vs stale local edit**

- local edited file remains canonical at its path,
- original logical identity remains canonical,
- remote deletion is overridden by the local-primary policy,
- no meaningless conflict copy is created for an absent remote body.

**Local delete vs remote edit**

- canonical path remains deleted,
- remote edited bytes are preserved as exactly one conflict copy with a new identity,
- a fresh device sees the canonical deletion plus the remote conflict copy.

These tests define copy-policy behavior; they do not introduce tombstone UI or a new merge rule.

### 2.5 Folder rename/delete versus stale descendant changes

Add deterministic scenarios for:

- folder rename on A versus stale descendant edit on B,
- folder delete on A versus stale descendant edit on B,
- folder delete on A versus stale descendant recreate on B.

Assertions cover exact final path set, byte lineage, conflict-copy count, and identity continuity/discontinuity. Expected outcomes are derived from the same local-primary contract above, not invented separately for folders.

---

## 3. Cross-Platform Namespace and Causality Hardening

### 3.1 Combined local/remote namespace validation

Add regressions for two different file identities whose paths collide only after combining local and remote state:

- exact same logical path independently created on two devices,
- case-only collision such as `Foo.md` vs `foo.md`,
- Unicode NFC/NFD-equivalent names.

The required invariant is **fail early before local or remote mutation with a clear collision error** when different file identities occupy the same normalized namespace key (`NFC + lowercase`, matching the existing collision convention).

A same-file-identity case-only rename is not treated as two colliding files and remains allowed as a rename. This distinction prevents the safety check from breaking legitimate rename semantics.

If current code fails only late at a local precondition, keep the failing regression and implement the smallest production change that validates the combined namespace before applying pulls/pushes. Do not silently select either identity.

### 3.2 Existing conflict-copy-name collision

Add a regression where the deterministic conflict-copy candidate path is already occupied by an unrelated user file. The minimum required behavior is fail-safe: the existing user file must never be overwritten silently.

For this hardening, a clear refusal is accepted; automatically inventing numbered alternate conflict-copy names is out of scope.

### 3.3 Rescan causality matrix

Expand deterministic coordinator/session coverage for:

- rescan + replace,
- rescan + rename/delete,
- rescan + folder rename/delete,
- ambiguous rename chains,
- delete/recreate combined with rescan.

A rescan may discard redundant content-only `modify` events, but it must never discard identity-breaking causal information.

### 3.4 Runtime automatic replan user flow

Add a deterministic runtime-level test proving the user-facing `V4PluginRuntime` path automatically retries a branch-head/stale-ref publication race within its bounded retry loop. The test must assert:

- first attempt observes an injected branch-head race,
- retry/replan occurs without requiring a second manual user action,
- final result is success when the race is recoverable,
- progress exposes a retry attempt,
- no duplicate conflict copies or lost updates are produced.

The existing lower-level live race remains useful for real GitHub ref behavior; this deterministic test proves the UX layer that hides transient publication races from users.

### 3.5 Production-code rule

If all new deterministic tests pass against current production code, no V4 production file changes.

If a regression exposes a concrete defect:

- commit the failing regression first,
- implement the smallest production fix,
- keep the production fix separate and auditable,
- rerun the affected fast test plus the full deterministic gates.

---

## 4. Credentialed Real GitHub E2E Workflow

Add `.github/workflows/github-e2e-live.yml` as the real network qualification workflow.

### 4.1 Trust boundary and repository isolation

The live suite must use a **dedicated disposable E2E repository**, not the plugin source repository and not a real user vault.

Configure a GitHub Environment named `github-e2e` with configuration names that comply with GitHub's reserved-prefix rules:

- environment variable `E2E_OWNER`,
- environment variable `E2E_REPO`,
- environment secret `E2E_TOKEN`.

The workflow maps those values into the existing runner interface:

```text
GITHUB_E2E_OWNER=${E2E_OWNER}
GITHUB_E2E_REPO=${E2E_REPO}
GITHUB_E2E_TOKEN=${E2E_TOKEN}
GITHUB_E2E_BRANCH=obsidian-sync-e2e/run-${GITHUB_RUN_ID}
```

Do not configure `GITHUB_E2E_*` as GitHub configuration-variable or secret names because GitHub reserves the `GITHUB_` prefix. They exist only as process environment variables inside the job.

The workflow must fail before destructive work if `${E2E_OWNER}/${E2E_REPO}` equals the source repository `${github.repository}`.

A rerun of the same workflow run reuses/reset-cleans the same derived branch; different runs use different branches and cannot delete each other's test state.

Use a fine-grained token scoped only to the disposable E2E repository with the minimum repository Contents permission required for Git data/ref writes. Environment deployment-branch protection permits only `master`; no required-reviewer gate is needed for the cleanup job.

### 4.2 Trigger and qualified SHA

- `workflow_dispatch` only.
- The workflow must be dispatched on ref `master`; a normal failing guard step verifies `github.ref == refs/heads/master` so the qualification job cannot become silently skipped.
- The qualified SHA is exactly `github.sha`.
- Before destructive work, verify that `github.sha` still equals the source repository's current `refs/heads/master`; a queued stale dispatch fails and must be rerun.
- Ordinary PR/fork workflows never receive the live-test environment or token.

### 4.3 Qualification job

Use a required job with stable job id/name `qualify`. It:

1. checks out `github.sha`,
2. installs pnpm dependencies with `--frozen-lockfile`,
3. builds the plugin,
4. runs `pnpm test:github-e2e:quick` without `GITHUB_E2E_COMPILE_ONLY`,
5. therefore executes the existing plaintext/encrypted A/B/C scenarios and controlled real ref race,
6. adds an encrypted external-mutation safety scenario: an out-of-band commit on an encrypted V4 branch must be rejected safely, remain reachable, and never be silently overwritten,
7. after E2E success, writes a non-secret audit manifest and uploads it.

The current Node suite timeout is 15 minutes. Set `timeout-minutes: 25` on `qualify` to leave bounded workflow overhead without creating an unbounded run.

### 4.4 Qualification authority

The authoritative qualification record is the exact-SHA workflow run **plus its required job results**. Stable release selects a `github-e2e-live.yml` run only if:

- `event == workflow_dispatch`,
- `head_branch == master`,
- `head_sha == release target SHA`,
- `status == completed`,
- `conclusion == success`,
- job `qualify` has `conclusion == success`,
- job `cleanup` has `conclusion == success`.

Requiring named successful jobs protects against an accidentally skipped qualification job producing a misleading workflow-level success.

The workflow additionally uploads an audit artifact named:

```text
github-e2e-qualification-${GITHUB_SHA}-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}
```

containing:

```json
{
  "schemaVersion": 1,
  "commitSha": "...",
  "workflowRunId": "...",
  "runAttempt": 1,
  "qualifiedAt": "...",
  "suite": "github-e2e-quick"
}
```

The artifact is informative; release authority does not depend on artifact retention/expiry.

### 4.5 Cleanup resilience

Use a required job with stable job id/name `cleanup`, `needs: qualify`, and `if: always()`. It receives the same isolated environment and deletes only its derived `obsidian-sync-e2e/run-${GITHUB_RUN_ID}` branch.

Cleanup:

- treats an already-absent branch as success,
- retries transient GitHub API cleanup failure a bounded maximum of three attempts,
- fails if the branch still exists after those attempts.

A workflow is release-qualifying only when both `qualify` and `cleanup` succeed.

Hard cancellation can still prevent any cleanup job from running; the unique per-run branch makes such residue isolated and harmless. A rerun resets the same branch, and maintainer docs include a copy-paste cleanup command.

Use workflow concurrency group `github-e2e-live` with `cancel-in-progress: false` as an API-rate throttle. Correctness does not depend on this lock because branches are unique.

---

## 5. Branch Candidate / Pre-release Workflow

The existing `.github/workflows/pre-release.yml` must no longer create public tags/releases from arbitrary non-master branch version bumps.

Convert it to **Branch Candidate Build** with exactly these triggers:

- `push` to non-master branches when `manifest.json` changes, preserving the current version-candidate behavior,
- `workflow_dispatch` for explicit candidate builds.

The workflow uses `contents: read` only and runs:

- frozen pnpm install,
- build,
- fast tests,
- repeat tests,
- recovery tests,
- resource tests,
- feasibility tests,
- compile-only GitHub E2E harness,
- package validation,
- upload plugin artifact named with branch and SHA.

It never creates a Git tag or GitHub Release.

Public alpha/beta publication is intentionally removed from this hardening. A future prerelease channel must be separately explicit and qualified.

---

## 6. Qualified Explicit Stable Release

Replace automatic `manifest.json`-push/tag-trigger publication with a `workflow_dispatch`-only stable release flow.

### 6.1 Trigger, target, and permissions

- one required `version` input in stable `x.y.z` form,
- dispatch on ref `master` only,
- target SHA is exactly `github.sha`,
- a normal failing guard verifies target SHA is the current `refs/heads/master`,
- `permissions: actions: read, contents: write`, with no broader repository permissions,
- release concurrency group `stable-release` with `cancel-in-progress: false` so release dispatches cannot race tag creation.

### 6.2 Release preconditions

Before any tag/release mutation, the workflow must establish all of the following; checks that require built artifacts run after the build step but still before publication:

1. requested version is valid stable `x.y.z`,
2. requested version equals `manifest.json.version` and `package.json.version`,
3. `versions.json[version] === manifest.minAppVersion`,
4. full package validation passes after build artifacts exist,
5. requested version is greater than the highest existing stable `x.y.z` tag (historical prerelease suffixes are ignored),
6. target stable version tag/release does not already exist,
7. a completed successful `github-e2e-live.yml` workflow-dispatch run exists for exact `head_sha == github.sha`, with successful `qualify` and `cleanup` jobs,
8. deterministic release gates pass.

No "latest successful E2E" fallback is permitted. Parent/child SHA qualification is not accepted.

### 6.3 Qualification lookup

Use the repository's GitHub Actions API via `gh api` and `GITHUB_TOKEN` to query the specific `github-e2e-live.yml` workflow filtered by exact `head_sha`, `event=workflow_dispatch`, and successful/completed state. For candidate runs, query run jobs and require the stable job ids/names `qualify` and `cleanup` to have successful conclusions.

If no candidate satisfies every exact-SHA workflow/job condition, release fails closed.

The lookup depends on Actions run/job metadata, not downloadable artifact retention.

### 6.4 Deterministic release gates

Run before publication:

- `pnpm install --frozen-lockfile`,
- `pnpm build`,
- fast tests,
- repeat tests,
- recovery tests,
- resource tests,
- feasibility tests,
- compile-only real GitHub E2E harness,
- package validation.

The live network suite is not rerun inside stable release because exact-SHA qualification already exists. This keeps stable-release retries deterministic with respect to the disposable E2E repository.

### 6.5 Remove release-time translation network dependency

Do not `pip install deep-translator` or call Google Translate as part of the release path. Stable release notes use GitHub-generated release notes only. Translation remains outside the correctness-critical release workflow.

### 6.6 Final stale-master guard

Immediately before publication, re-check that target SHA is still current `master`. If master advanced, fail before creating a tag/release and require a new live qualification for the new tip.

This is a policy guard, not a claim of atomic compare-and-swap with future master pushes; exact target SHA remains the release-content identity.

### 6.7 Release creation and partial-failure rule

After every gate passes, package the plugin ZIP and use authenticated GitHub CLI/API on the hosted runner rather than a third-party release action to create the stable tag/release at exactly the qualified target SHA, generate release notes, and upload:

- `main.js`,
- `manifest.json`,
- `styles.css`,
- packaged plugin ZIP.

No release mutation occurs before all qualification/deterministic gates pass.

GitHub tag/release/asset APIs are not a single cross-resource transaction. If the publication command itself fails after mutation begins, the workflow must report a publication failure and must not pretend rollback succeeded. Maintainer docs include an inspection/cleanup command for a partial draft/tag before retry; a rerun remains fail-closed while a conflicting tag/release exists.

---

## 7. Normal CI Responsibilities

`.github/workflows/ci.yml` remains secret-free and runs on PR/push/manual dispatch:

- frozen pnpm install,
- build,
- deterministic test tiers,
- compile-only real GitHub E2E harness,
- package validation,
- artifact upload.

It never executes destructive GitHub REST tests. A GitHub API outage in the disposable E2E repository must not make ordinary source PR CI fail.

---

## 8. Documentation and Maintainer/User Flow

### 8.1 Maintainer release flow

1. merge code/version metadata to `master`,
2. ensure deterministic CI is green,
3. dispatch **GitHub E2E Live** on ref `master`,
4. require successful `qualify` + `cleanup` for that exact master SHA,
5. dispatch **Stable Release** on ref `master` with the version input,
6. stable release revalidates metadata, monotonic version, deterministic gates, and exact-SHA workflow/job evidence,
7. tag/release is created only after every gate passes.

If master changes between live qualification and stable release, stable release fails closed and the new tip must be qualified. This deliberately trades a small amount of maintainer ceremony for unambiguous release evidence.

### 8.2 Documentation changes

Update:

- `docs/github-e2e.md`: dedicated disposable repo, Environment names `E2E_OWNER`/`E2E_REPO`/`E2E_TOKEN`, runtime env mapping, dynamic branch behavior, manual workflow use, local command, residue cleanup command, qualification boundary,
- add/refresh a release-maintainer document describing candidate build, live qualification, stable release, and partial-publication cleanup,
- `docs/FAQ.md` English/Chinese copy-policy semantics,
- Settings copy-policy description so local-primary behavior is visible before users select it,
- README qualification section to distinguish deterministic CI, live real-GitHub qualification, and physical large-file evidence.

---

## 9. Verification Strategy

### 9.1 Local/container deterministic attempt

Before delivery, attempt every available deterministic command:

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

Also run targeted new fast tests separately while developing so each regression has red/green evidence.

If the environment cannot fetch dependencies, record that limitation and use GitHub deterministic CI once available.

### 9.2 Maintainer-run live step

When live credentials are unavailable to the implementation environment, the maintainer-run steps are:

1. create/configure dedicated disposable E2E repository,
2. configure GitHub Environment `github-e2e` with variables `E2E_OWNER`, `E2E_REPO` and secret `E2E_TOKEN`,
3. dispatch **GitHub E2E Live** on `master`,
4. after it succeeds, dispatch **Stable Release** if publication is desired.

The implementation handoff includes copy-paste local E2E commands and exact GitHub UI/configuration steps. The code is not described as live-qualified until the real workflow succeeds for the target SHA.

---

## 10. Scope Boundaries

This hardening does not include:

- 5 GiB physical qualification,
- physical Windows/Android qualification,
- pack-scale benchmarking,
- random chaos testing,
- strict server-side CAS that GitHub's ref API does not provide,
- new conflict-resolution policies,
- public alpha/beta release automation,
- unrelated V4 refactors.

---

## 11. Definition of Done

- pnpm is the single canonical dependency-lock source.
- version drift across package/manifest/versions metadata fails validation.
- version bump helper preflights consistency, derives one target, and updates all canonical metadata.
- FAQ, Settings, resolver tests, and live E2E agree that Copy policy is local-primary / remote-conflict-copy.
- exact rename/delete/folder conflict outcomes are covered deterministically.
- cross-side exact/case/NFC namespace collisions fail early without mutation when different identities collide.
- same-identity legitimate renames remain supported.
- conflict-copy candidate collisions never overwrite user files silently.
- rescan causality matrix preserves identity-breaking information.
- runtime automatic branch-race retry has deterministic user-flow coverage.
- no V4 production change exists without a failing regression that requires it.
- ordinary CI stays secret-free and compiles the live harness.
- GitHub Environment names comply with reserved-prefix rules; process env still matches the existing runner.
- live E2E uses a dedicated disposable repository and unique per-run branch.
- encrypted external mutation refusal is covered live.
- successful exact-SHA workflow + `qualify`/`cleanup` job metadata is authoritative qualification evidence.
- cleanup is isolated into a bounded-retry separate job and leftover branches are uniquely scoped.
- branch candidate workflow cannot create tags/releases.
- stable release is explicit, monotonic, exact-SHA qualified, and serialized.
- stable release contains no translation service dependency.
- no stable-release mutation begins before all deterministic and exact-SHA qualification gates pass.
- partial GitHub publication failure is surfaced honestly and has documented recovery rather than assumed rollback.
