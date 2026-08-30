# Release Provenance and Versioning Design

## Status

Child design of `2026-08-30-release-e2e-runtime-hardening-followup-design.md` for baseline `35e98cea924702293bde62d064a83d52eca6d898`.

Revised after formal red-team review on 2026-08-30. This child owns stable release-byte provenance, privileged publication boundaries, qualification authority, canonical version history, and partial-publication safety.

## Goal

Publish the exact stable-release bytes produced and package-validated by authoritative ordinary CI for the exact final `master` SHA, while keeping repository write authority out of repository checkout/install/build/test execution.

The release system must prove:

1. exact source commit,
2. authoritative current CI producer and producer job execution,
3. authoritative current live-E2E qualification for the same current CI producer,
4. byte integrity from CI artifact through public release assets,
5. source `manifest.json` identity for the public manifest,
6. canonical monotonic stable-version history,
7. exact tag binding to the source SHA,
8. current-master/qualification validity immediately before mutation and publication.

The design does not claim unit tests execute final bundled `main.js` byte-for-byte; it guarantees the promoted bytes are the exact outputs produced and package-validated in the same successful CI producer execution after deterministic source/build/test gates, with no release-time rebuild.

## Non-goals

This child does not redesign live-E2E target safety, add a SemVer dependency, repair `scripts/zip-source.mjs`, make GitHub resources transactionally atomic, or claim protection against a maintainer/admin who intentionally changes trusted `master` and release environment configuration.

---

# 1. CI Is the Sole Stable Release-Byte Producer

For a push to `master`, ordinary read-only `ci.yml` performs:

```text
checkout exact SHA
frozen dependency install
build
fast + repeat + recovery + resource + feasibility tests
real-GitHub E2E compile gate
package validation
construct stable release ZIP
validate ZIP semantic contents
write release-input manifest
upload release-input artifact
```

Stable Release never checks out the repository, installs dependencies, rebuilds, or reruns repository tests.

CI uploads:

```text
release-input-${GITHUB_SHA}-${GITHUB_RUN_ID}-${VERIFY_JOB_EXECUTION_ATTEMPT}
```

with exactly:

```text
release-input.json
<repository-name>-v<VERSION>.zip
main.js
manifest.json
styles.css
```

The trusted `<repository-name>` authority is GitHub repository metadata/context, not a value supplied by the artifact manifest.

`release-input.json` records data only: schema version, repository ID, commit SHA, CI run ID, producer `verify` job execution attempt, version, plugin ID, exact public asset names, sizes, and SHA-256 values. It cannot define commands, extraction destinations, upload destinations, or arbitrary filenames.

---

# 2. Stable Package Compatibility Contract

The hardening change preserves current stable-release UX:

```text
release title/name = VERSION
generate release notes = true
prerelease = false
draft until verification is complete
```

The convenience ZIP name remains:

```text
<repository-name>-v<VERSION>.zip
```

and its internal root directory remains:

```text
<repository-name>/
```

with exactly:

```text
main.js
manifest.json
styles.css
```

CI validates the ZIP as a real ZIP container and rejects absolute/traversal paths, duplicate names, symlinks, unexpected directories/files, or extras. The inner three files must be byte-identical to the standalone artifact files.

The ZIP SHA-256 is recorded only after semantic validation succeeds.

---

# 3. Exact Source Metadata Binding

The artifact `manifest.json` must be byte-identical to `manifest.json` stored at exact source `GITHUB_SHA`.

Stable Release reads fixed source paths directly through GitHub API at exact SHA:

```text
package.json
manifest.json
versions.json
.node-version when required by cross-workflow provenance checks
```

These are parsed strictly as data. No source checkout or source script execution is allowed.

The public `manifest.json` artifact is rejected if it differs from exact-SHA source bytes even when the artifact manifest is internally self-consistent.

---

# 4. Authoritative CI and Live Qualification

## 4.1 Newest exact-SHA run authority

For each workflow, select the **newest** run matching the exact required identity rather than any historical success.

CI identity:

```text
workflow = ci.yml
event = push
head_branch = master
head_sha = GITHUB_SHA
```

Live identity:

```text
workflow = github-e2e-live.yml
event = workflow_dispatch
head_branch = master
head_sha = GITHUB_SHA
```

If the newest matching run is queued/running/cancelled/failed, release blocks. It never falls back to an older successful run.

Run ordering uses explicit GitHub run metadata (newest creation/run ordering with deterministic ID tie-break where necessary), not first-page accident.

## 4.2 Latest execution of each required job

GitHub partial reruns may execute only failed or selected jobs. Therefore authority is not "all jobs must be in one attempt".

For a selected run, enumerate attempt-specific jobs and find the highest attempt in which each required job actually executed.

Require its latest execution to be:

```text
status = completed
conclusion = success
```

Required jobs:

```text
CI:       verify
Live E2E: qualify, cleanup
```

This permits a successful `qualify` from attempt 1 plus a successful rerun of failed `cleanup` in attempt 2, while a newer failed/running execution of `qualify` supersedes its earlier success.

## 4.3 Current CI producer binds live qualification

The newest authoritative live run must record the exact CI producer identity it consumed:

```text
ciProducerRunId
ciVerifyExecutionAttempt
ciE2EArtifactId
ciE2EArtifactDigest when exposed
```

Stable Release requires those values to equal the current authoritative CI producer/E2E artifact.

Therefore any later CI rerun/new producer for the same SHA invalidates old live qualification until live E2E is rerun against the new current CI artifact.

---

# 5. Release Artifact Selection and Untrusted Boundary

The selected `release-input` artifact must bind to the latest authoritative CI `verify` execution that produced it.

Before use require:

- exact artifact name,
- artifact not expired,
- artifact workflow run ID/repository ID/head SHA match authoritative CI,
- server artifact SHA-256 digest matches when exposed,
- embedded manifest run/repository/SHA/job-attempt identity matches.

The `verify` and `publish` jobs each independently download and validate the exact selected artifact. No mutable workspace handoff is trusted across jobs.

Before extraction reject absolute/traversal paths, symlinks, duplicate names, unexpected directories, and anything outside the fixed five-entry allowlist derived from trusted repository name + requested canonical version.

Extraction occurs only into a fresh empty directory. Every extracted asset must be a regular file with exact expected size/SHA-256. Artifact files are never sourced, imported, required, or executed.

---

# 6. Stable Release Privilege Architecture

## 6.1 Default workflow token remains read-only

Stable Release never grants repository write permission to its default `GITHUB_TOKEN`.

Workflow/job permission contract is limited to read authority required for qualification/source/artifact inspection, such as:

```text
actions: read
contents: read
```

Repository mutation does not use this token.

## 6.2 `stable-release` environment and scoped publication credential

Create a `stable-release` environment with **Selected branches and tags** allowing branch `master` and no tags.

Do not use `Protected branches only` while the repository has no protected branch rule.

The environment provides a release publication credential represented as `RELEASE_TOKEN`. Its mutable repository scope is restricted to this source repository and only the repository permissions required for tag/release publication.

Acceptable implementations include a fine-grained repository-scoped credential or repository-scoped GitHub App installation credential. Broad classic credentials are not release-qualifying configuration.

The `publish` job references `environment: stable-release`; if a workflow variant removes that environment, it loses `RELEASE_TOKEN` and still has only the read-only default workflow token.

The release credential is exposed only to fixed mutation/upload/publication steps. Read-only revalidation uses the default read token.

## 6.3 `verify` job

`verify` has no release publication credential and performs no repository mutation.

It:

1. requires dispatch from `master`,
2. requires current `master == GITHUB_SHA`,
3. selects authoritative CI and live runs/jobs,
4. requires live consumed current CI E2E input,
5. downloads/verifies the exact release-input artifact,
6. reads fixed exact-SHA source metadata,
7. validates version/history/source-manifest/package invariants,
8. exposes only non-secret selected identities to `publish`.

## 6.4 `publish` job

`publish` depends on `verify`, runs with `environment: stable-release`, and has no checkout/install/build/test step.

It independently re-downloads/revalidates the exact artifact and exact source metadata before any mutation.

---

# 7. External Action Pinning

All external `uses:` references remain pinned to verified full-length commit SHAs under the cross-cutting Actions policy established by Child B.

A static feasibility test prevents regression to mutable action tags/branches.

Privileged release jobs minimize external actions and execute no repository code.

---

# 8. Canonical Stable-Version Contract

Canonical stable versions match:

```text
^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$
```

Comparison uses exact integer components (`BigInt` or equivalent), never JavaScript `Number` or `sort -V` as authority.

Repository-side tooling shares one dependency-free version helper for parse/validate/compare/max behavior. `scripts/update-version.js`, `scripts/validate-package.mjs`, and source-side tests use it.

Privileged release jobs do not checkout/execute that helper; they use small fixed workflow-owned logic tested against the same canonical vectors.

`versions.json` validation requires every key canonical, compatibility values valid under current project syntax, package/manifest versions identical, current version present and maximum, and current mapping equal `manifest.minAppVersion`.

The bump helper rejects an existing/non-increasing target before write.

---

# 9. Publication History

Immediately before tag creation, calculate stable history from the union of:

```text
canonical exact-SHA versions.json keys
canonical remote tag names
canonical authenticated-visible release tag_name values
```

The requested version must equal the maximum declared exact-SHA `versions.json` key and be strictly greater than every other canonical observed stable version.

Enumeration is pagination-safe.

Deleted history absent from all three sources cannot be reconstructed by workflow logic; Immutable Releases/repository governance are the long-term defense against historical erasure.

---

# 10. Publication-Time Revalidation

Immediately before tag mutation, require:

```text
current master == GITHUB_SHA
newest authoritative CI run unchanged
latest CI verify execution still successful
newest authoritative live run unchanged
latest live qualify + cleanup executions still successful
live run still references current CI E2E producer
release-input artifact still matches current CI producer
artifact/source manifest binding still valid
exact-SHA package/manifest/versions still match requested version
complete tag/release history still permits version
requested tag absent
no authenticated-visible release/draft uses requested tag
```

Immediately before draft -> public transition, re-require at least:

```text
current master == GITHUB_SHA
authoritative CI/live evidence unchanged and successful
live still references current CI producer
exact tag == GITHUB_SHA
same expected draft release ID/assets
```

The workflow does not claim atomicity against an external administrator modifying controls after final observation.

---

# 11. Publication State Machine

```text
revalidate all authority using read-only token
        ↓
with RELEASE_TOKEN: create refs/tags/VERSION -> GITHUB_SHA via create-only Git refs API
        ↓
read exact tag; require commit object at GITHUB_SHA
        ↓
with RELEASE_TOKEN: create draft release for existing tag
  name/title = VERSION
  generate_release_notes = true
  prerelease = false
        ↓
capture numeric release ID + upload URL from creation response
        ↓
with RELEASE_TOKEN: upload exact fixed allowlisted assets
        ↓
GET same release ID; require draft/tag/exact asset set
        ↓
boundedly wait for each release asset digest if necessary
require `sha256:` digest + size equal release-input manifest
        ↓
revalidate master + authoritative CI/live + current-CI binding + exact tag
        ↓
with RELEASE_TOKEN: publish the same numeric release ID
        ↓
GET same release ID
require public non-prerelease release, exact tag/title, exact assets, exact sizes/digests
```

`gh release create --target` is not tag authority. Returned numeric release ID is release authority after draft creation; do not rediscover the draft by mutable tag/name for subsequent mutation.

---

# 12. Partial Publication and Immutability

Tag creation, draft creation, asset upload, and public publication are not one transaction.

Never automatically remove repository publication state because a later step fails. Conflicting partial state remains inspectable and blocks another stable run until a maintainer resolves it.

Runbook covers tag-only state, incomplete draft, complete draft whose qualification became stale, public release with failed final verification, and digest mismatch.

Enable GitHub Immutable Releases before calling published releases immutable. Workflow provenance/binding protects publication correctness; platform immutability protects the associated tag/assets after publication when enabled.

---

# 13. Tests

Required tests include:

- canonical patch/minor/major/explicit versions,
- huge integer version components,
- leading-zero/malformed/equal/lower/duplicate versions,
- noncanonical history/current-not-maximum metadata,
- exact ZIP root/name/content semantics,
- traversal/symlink/duplicate/extra ZIP rejection,
- ZIP inner files equal standalone assets,
- artifact manifest/source manifest mismatch rejection,
- newest exact-SHA CI/live run authority,
- newer failed/running run blocks older success,
- latest required-job execution across attempts,
- partial cleanup rerun remains usable,
- newer CI producer invalidates older live qualification,
- malicious artifact shape rejected,
- no release checkout/install/build/test,
- no write-capable default `GITHUB_TOKEN`,
- `stable-release` environment/published credential boundary present,
- complete pagination-safe publication history,
- create-only exact tag before draft,
- release ID captured and reused,
- title/generated-notes/non-prerelease/ZIP-layout compatibility,
- revalidation before tag and before public publication,
- final asset `sha256:` digests/sizes match,
- no automatic destructive rollback.

---

# 14. Maintainer Flow

One-time setup:

1. configure `stable-release` environment,
2. restrict it to selected branch `master`,
3. configure repository-scoped release publication credential,
4. enable Immutable Releases when available/desirable,
5. keep external actions full-SHA pinned.

Per release:

```text
bump version
merge to master
ordinary CI succeeds and produces current release + E2E artifacts
run GitHub E2E Live for exact current SHA/current CI E2E artifact
run Stable Release with already-declared version
```

Stable Release only verifies and promotes CI output, so it is faster and narrower than the current rebuild workflow.

If authoritative CI changes, live qualification must be repeated. If `master` changes, all previous exact-SHA qualification is irrelevant to the new tip.

---

# 15. Acceptance Criteria

Complete only when CI is the sole stable release-byte producer; Stable Release executes no repository code/dependencies; default workflow token remains read-only; publication authority exists only through the `stable-release` environment-scoped repository-limited credential; newest exact-SHA CI/live runs and latest executions of required jobs are authoritative; live qualification is bound to the current CI producer; source/public manifest and artifact digests are verified; version history is canonical/exact; tag creation is create-only at exact SHA; release draft/public lifecycle uses returned numeric release ID; existing release title/notes/ZIP UX is preserved; final public asset digests match; and partial failures never trigger automatic destructive rollback.
