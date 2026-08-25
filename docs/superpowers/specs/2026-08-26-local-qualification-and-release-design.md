# Official Local Qualification and Release Design

## Goal

Add a first-class maintainer workflow that can qualify and publish a stable release entirely from a trusted local machine without GitHub Actions, while preserving the existing exact-SHA release safety model.

The local path must not be a bypass. It must:

1. qualify the exact commit that will be released,
2. persist auditable qualification evidence on GitHub,
3. fail closed if `master`, metadata, qualification evidence, or publication state changes,
4. retain deterministic/package gates in addition to the real GitHub E2E,
5. avoid blind retries after ambiguous Git/GitHub mutations,
6. remain usable from PowerShell/Windows as well as macOS/Linux,
7. coexist with the current GitHub Actions qualification/release path rather than deleting it.

The current live GitHub E2E and V4 runtime behavior are unchanged by this work.

## Current State

- `pnpm test:github-e2e:quick` runs the credentialed real-GitHub suite locally and loads `.env.github-e2e` automatically when shell variables are absent.
- The deterministic release gates already exist as pnpm scripts: build, fast/repeat/recovery/resource/feasibility tests, E2E compile, and package validation.
- `.github/workflows/release.yml` currently requires a successful exact-SHA `github-e2e-live.yml` Actions run before creating a stable release.
- The current stable workflow rechecks that the target SHA is still current `master` immediately before publication and uses `gh release create --target <exact-sha>`.
- A local release flow does not yet have persistent qualification evidence. A local log file alone is not authoritative because it can be lost, edited, or detached from the released commit.

## Chosen Architecture

Use a namespaced annotated Git tag as the durable local-qualification attestation, then provide a separate local stable-release command that verifies that tag and publishes the exact qualified SHA.

New public maintainer commands:

```text
pnpm qualify:local
pnpm release:local -- <x.y.z>
```

The qualification command performs all required gates and creates/pushes a qualification tag only after success. The release command trusts that exact-SHA qualification receipt for the expensive qualification work, reruns inexpensive artifact-integrity gates, rechecks remote `master`, packages the plugin, and creates the GitHub Release.

GitHub Actions remains an optional independent release path. The local flow does not weaken or modify the existing Actions requirement inside `.github/workflows/release.yml`.

---

## 1. Trust Model

### 1.1 Authority

A local qualification tag is a **maintainer attestation**, not cryptographic proof that the tests physically ran. Anyone who can forge the qualification tag must already have repository tag-push permission; anyone who can publish the stable release must also have release/write permission. The security boundary is therefore the same trusted maintainer authority that already controls publication.

Version 1 of this design does not require GPG or SSH tag signing. Mandatory signing would add platform/account setup complexity without preventing a fully privileged maintainer from publishing anyway. Signing can be added later as defense-in-depth without changing the receipt schema.

### 1.2 Exact-SHA rule

Qualification is valid only for one exact 40-hex commit SHA. If `master` advances, the old receipt remains historical evidence but cannot qualify the new tip.

The source tree, lockfile, release scripts, and release metadata are all transitively bound by the commit SHA. No separate lockfile hash is authoritative.

### 1.3 No secret persistence

The qualification receipt must never include `GITHUB_E2E_TOKEN` or any credential value. It also does not need to expose the disposable test repository name. The tag stores only non-secret audit metadata.

---

## 2. Qualification Receipt

### 2.1 Tag namespace

For stable version `1.0.8` and commit SHA `<sha>`, the authoritative tag name is:

```text
qualification/local/v1/1.0.8/<sha>
```

The full SHA is included deliberately so the ref itself is self-describing and collision-resistant. Qualification tags are outside the stable `x.y.z` namespace, so existing stable-version ordering logic ignores them.

### 2.2 Annotated-tag message

The annotated tag message is JSON with this schema:

```json
{
  "schemaVersion": 1,
  "kind": "obsidian-sync-local-qualification",
  "repository": "crystalicez/obsidian-github-sync-multi-platform",
  "commitSha": "<40-hex-sha>",
  "version": "1.0.8",
  "result": "success",
  "qualifiedAt": "2026-08-26T00:00:00.000Z",
  "durationMs": 123456,
  "platform": "win32-x64",
  "nodeVersion": "v22.x.x",
  "pnpmVersion": "9.x.x",
  "e2eSuite": "github-e2e-quick",
  "gates": [
    "install-frozen",
    "package-validation",
    "build",
    "fast-tests",
    "repeat-tests",
    "recovery-tests",
    "resource-tests",
    "feasibility-tests",
    "github-e2e-compile",
    "github-e2e-live"
  ]
}
```

Required authority fields are `schemaVersion`, `kind`, `repository`, `commitSha`, `version`, `result`, `e2eSuite`, and the exact required gate set. Time/platform/tool versions are audit metadata and do not alter validity.

The receipt does not claim that GitHub independently verified the run; it records the maintainer's successful local qualification.

### 2.3 Idempotency

If the exact qualification tag already exists remotely and:

- it is an annotated tag,
- the remote tag object matches the local/verified tag object,
- the peeled commit is the expected exact SHA,
- the receipt validates against the current schema/version/repository/gate set,

then `qualify:local` may report the SHA as already qualified and succeed without replacing the tag.

Any mismatch fails closed. Qualification tags are never force-updated.

---

## 3. `pnpm qualify:local`

Implement `scripts/local-qualify.mjs` with shared validation/orchestration helpers in `scripts/local-release-lib.mjs`.

### 3.1 Preflight

Before expensive work:

1. require a clean Git working tree, including non-ignored untracked files,
2. require current branch `master`,
3. resolve `HEAD` and require a 40-hex commit SHA,
4. normalize `origin` and require it to identify the canonical repository,
5. query remote `refs/heads/master` directly and require it to equal `HEAD`,
6. require package/manifest/versions metadata to be internally valid,
7. require `.env.github-e2e` or shell environment to provide the existing E2E credentials at runner execution time,
8. reject protected-looking/destructive E2E branch misuse through the existing E2E runner checks.

Use the remote query rather than trusting a possibly stale local `origin/master` ref.

### 3.2 Gate order

Run gates sequentially and stop on first failure:

```text
corepack pnpm install --frozen-lockfile
corepack pnpm validate:package
corepack pnpm build
corepack pnpm test
corepack pnpm test:repeat
corepack pnpm test:recovery
corepack pnpm test:resource
corepack pnpm test:feasibility
corepack pnpm test:github-e2e:compile
corepack pnpm test:github-e2e:quick
```

Package validation is intentionally early so metadata drift is rejected before the expensive real-GitHub suite.

The live E2E remains last because it is the slowest and most destructive gate.

### 3.3 Post-gate revalidation

The qualification run may take many minutes. Immediately after all gates pass and before creating a receipt:

- require the working tree is still clean,
- require `HEAD` is unchanged,
- query remote `master` again and require it still equals the qualified SHA,
- re-read package/manifest version and require it still matches the receipt version.

If remote `master` advanced during qualification, do not create a qualification tag. The maintainer must update and rerun qualification for the new exact SHA.

### 3.4 Tag creation and push

Create the annotated tag locally only after all gates and post-gate validation pass. Push only that exact ref to `origin`, without force.

If `git push` returns an error or the connection outcome is ambiguous, do not blindly retry. Query the remote tag ref and peeled commit:

- if the remote tag object is exactly the local tag object and peels to the expected commit, treat publication of the qualification receipt as successful,
- otherwise fail and show inspection commands.

This mirrors the repository's existing unknown-outcome discipline for GitHub mutations.

---

## 4. `pnpm release:local -- <version>`

Implement `scripts/local-release.mjs`. This command publishes a stable GitHub Release without invoking GitHub Actions.

### 4.1 Release preflight

Require:

1. one explicit stable `x.y.z` argument,
2. clean Git working tree,
3. branch `master`,
4. canonical `origin`,
5. exact `HEAD == remote master`,
6. `package.json.version == manifest.json.version == requested version`,
7. `versions.json[version] == manifest.minAppVersion`,
8. requested version greater than the highest remote stable `x.y.z` tag,
9. no existing remote stable tag for the requested version,
10. no existing GitHub Release for the requested version,
11. GitHub CLI installed/authenticated for the canonical repository,
12. the exact qualification tag exists remotely for `(version, HEAD)`.

### 4.2 Qualification verification

Fetch/inspect the exact qualification tag without force and validate:

- annotated tag object, not a lightweight tag,
- peeled commit exactly equals `HEAD`,
- receipt schema/kind/repository/version/SHA/result match expected values,
- `e2eSuite == github-e2e-quick`,
- gate set exactly contains all required v1 qualification gates.

A qualification for another version or another SHA is invalid even if the source contents appear similar.

### 4.3 Pre-publication rerun

The release command does **not** rerun the ~11-minute real-GitHub E2E or repeat loop because the exact-SHA receipt is the authority for those expensive gates.

It reruns the inexpensive artifact-integrity gates that matter for the machine doing publication:

```text
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm test
corepack pnpm test:github-e2e:compile
corepack pnpm validate:package
```

This verifies dependency restoration, TypeScript/build output, a fast regression pass, E2E bundle compilation, and release metadata immediately before packaging.

### 4.4 Final race check

Immediately before creating any stable publication state:

- require working tree still clean apart from ignored build outputs,
- require `HEAD` unchanged,
- query remote `master` again and require the same exact SHA,
- require the qualification tag still resolves to that SHA,
- recheck that stable tag/release does not already exist.

Any change aborts before publication.

---

## 5. Plugin Packaging

Preserve the existing release asset contract:

- `main.js`,
- `manifest.json`,
- `styles.css`,
- plugin ZIP containing those three files under a top-level directory named after the repository/plugin package as the current workflow does.

Add `scripts/package-plugin.mjs` so local publication does not depend on Bash `zip` availability. The packager uses Node built-ins only and writes a standard ZIP with deterministic entry names/order and normalized metadata. Compression level is not an authority boundary; correctness is the exact file contents and archive structure.

The packager overwrites only its known output path after validation and never archives arbitrary workspace files.

---

## 6. Stable Publication and Unknown Outcomes

The final mutation remains one explicit GitHub CLI operation equivalent to:

```text
gh release create <version> --target <exact-sha> ...assets...
```

Do not pre-create or force-update the stable tag separately.

If `gh release create` returns failure after mutation may have started, do not automatically retry or delete anything. Inspect actual GitHub state:

- stable tag target,
- release target/tag,
- draft/prerelease flags,
- expected asset names.

If an exact non-draft, non-prerelease release for the qualified SHA already exists with all expected assets, the command may report successful reconciliation.

If state is partial or mismatched, fail closed with inspection instructions. Never auto-delete a tag/release after an ambiguous publication result.

---

## 7. GitHub Actions Coexistence

Keep `.github/workflows/github-e2e-live.yml` and `.github/workflows/release.yml` intact as an optional independent qualification/publication mechanism.

The Actions stable-release workflow continues to require Actions-native exact-SHA qualification. It does not automatically trust local qualification tags in this version.

The official supported release documentation presents two independent paths:

- **Local maintainer path:** `qualify:local` -> qualification tag -> `release:local`.
- **GitHub Actions path:** GitHub E2E Live -> Stable Release workflow.

Both retain exact-SHA semantics. Neither path can qualify a different commit merely because the version number matches.

---

## 8. Test Strategy

Use TDD for release machinery. Tests must not mutate the real repository or create real releases.

### 8.1 Pure/shared validation tests

Test `local-release-lib.mjs` with injected command/GitHub runners for:

- stable-version parsing and monotonic comparison,
- canonical repository normalization for HTTPS/SSH origin forms,
- qualification tag naming,
- receipt generation/parsing/validation,
- wrong schema/kind/repository/SHA/version/result/gate set rejection,
- lightweight tag rejection,
- remote peeled-SHA mismatch rejection,
- remote-master mismatch rejection,
- dirty-tree and non-master rejection,
- existing stable tag/release rejection.

### 8.2 Qualification orchestration tests

With a fake command runner, prove:

- gate commands run in the required order,
- first failing gate stops the run,
- no tag is created before all gates pass,
- remote `master` is rechecked after the long test run,
- changed remote `master` prevents qualification,
- successful run creates exactly one annotated qualification tag,
- push error + verified exact remote tag reconciles as success,
- push error + absent/mismatched remote tag fails without blind retry.

### 8.3 Release orchestration tests

Prove:

- unqualified SHA cannot release,
- receipt for a different version/SHA cannot release,
- expensive live E2E/repeat gates are not rerun by `release:local`,
- inexpensive publication gates run before packaging,
- remote `master` is rechecked immediately before publication,
- `gh release create` receives exact SHA and expected assets,
- ambiguous publish outcome is inspected rather than blindly retried,
- partial publication is reported and never auto-deleted.

### 8.4 Package regression

Add a deterministic test that inspects the generated ZIP and proves it contains exactly the three expected plugin files under the expected top-level directory with byte-identical contents.

All new tests belong in the existing feasibility/release-test tier where practical so the ordinary fast V4 runtime suite is not slowed by process-heavy Git fixture tests.

---

## 9. Documentation and UX

Update `docs/releasing.md` with copy-paste PowerShell and POSIX examples for both local commands, including prerequisites:

- Git,
- Node/corepack/pnpm,
- GitHub CLI authentication for publication,
- `.env.github-e2e` for local live qualification,
- dedicated disposable E2E repository.

Update `docs/github-e2e.md` to distinguish routine compile/smoke checks from official local release qualification.

Command output should always print:

- source SHA,
- version,
- qualification tag name,
- current phase/gate,
- final qualified/released SHA,
- inspection commands on ambiguous mutation failure.

Never print tokens or `.env.github-e2e` contents.

---

## 10. Rollout Sequence

The current real-GitHub fix SHA `35e98cea924702293bde62d064a83d52eca6d898` remains preserved on `fix/live-github-immutable-read-fallback` as the already-qualified runtime/E2E evidence.

This design/implementation lives on a separate branch based on that SHA so the qualified fix branch does not move.

Before using the new release flow:

1. merge the already-qualified runtime/E2E fix to `master`,
2. merge the local-qualification implementation to `master`,
3. run `pnpm qualify:local` on the new final `master` SHA,
4. verify the qualification tag exists remotely and resolves to that exact SHA,
5. run `pnpm release:local -- <version>`.

Because the release tooling changes the commit SHA, the earlier live-E2E result for `35e98cea...` cannot qualify the final release SHA. The new `qualify:local` command must run once on final `master`; that run itself includes the full real-GitHub E2E.

---

## Non-goals

- No removal of GitHub Actions workflows.
- No automatic release on push/version bump.
- No lightweight qualification tags.
- No force-updating qualification or stable tags.
- No requirement for GPG/SSH tag signing in v1.
- No storage of E2E secrets in tags, files, artifacts, or logs.
- No relaxation of the exact-SHA rule.
- No automatic cleanup of partial stable publication state.
- No V4 sync/runtime behavior changes.
- No dependency on a local JSON receipt as release authority.

## Acceptance Criteria

The work is complete when:

1. `pnpm qualify:local` can run from PowerShell and POSIX shells without shell-specific environment syntax,
2. qualification cannot create a receipt unless every required gate succeeds and remote `master` still equals the tested SHA,
3. the pushed annotated qualification tag is verifiably bound to the exact version/SHA and required gate schema,
4. `pnpm release:local -- <version>` refuses dirty, non-master, stale-master, unqualified, mismatched-version, duplicate, or non-monotonic publication attempts,
5. local release does not require any GitHub Actions run,
6. local release publishes only the exact qualified SHA and expected four assets,
7. ambiguous tag/release mutations are reconciled by inspecting remote state rather than blind retry,
8. deterministic tests cover failure-before-mutation and exact-SHA enforcement,
9. existing Actions release path remains functional and unchanged in authority,
10. maintainer documentation clearly identifies the local path as an official supported release flow.
