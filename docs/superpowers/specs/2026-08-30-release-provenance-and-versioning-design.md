# Release Provenance and Versioning Design

## Status

Child design of `2026-08-30-release-e2e-runtime-hardening-followup-design.md`.

Repository baseline: `35e98cea924702293bde62d064a83d52eca6d898`.

This child owns release provenance, tested-byte promotion, release workflow privilege boundaries, stable-version history, and partial-publication safety. Live-E2E target safety is specified separately.

## Goal

Publish the exact bytes ordinary CI built and tested for the exact final master SHA, without running repository code or dependencies under repository write authority.

The release system must prove:

1. exact source commit,
2. exact CI run and run attempt that produced/tested the bytes,
3. exact live-E2E run and run attempt for the same commit,
4. byte integrity from CI artifact to public release assets,
5. canonical monotonic stable version history,
6. current-master eligibility at publication boundaries.

## Non-goals

This child does not rebuild source inside Stable Release, redesign live-E2E target safety, add a SemVer dependency, repair `scripts/zip-source.mjs`, make GitHub resources transactionally atomic, or claim protection against an administrator with independent write authority.

---

# 1. Build Once, Promote Tested Bytes

## 1.1 CI is the sole release-byte producer

For a `push` to `master`, ordinary `ci.yml` performs:

```text
checkout exact SHA
frozen pnpm install
build
fast + repeat + recovery + resource + feasibility tests
real-GitHub E2E compile gate
package validation
package release ZIP
validate ZIP semantic contents
write release-input manifest
upload release-input artifact
```

CI keeps repository permissions read-only.

Stable Release never reinstalls dependencies or rebuilds these outputs.

## 1.2 Release-input artifact identity

CI uploads one blocking artifact named:

```text
release-input-${GITHUB_SHA}-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}
```

Its exact logical entry set is:

```text
release-input.json
<plugin>-v<VERSION>.zip
main.js
manifest.json
styles.css
```

No scripts, env files, symlinks, hidden control files, or arbitrary extra entries are allowed.

## 1.3 Release-input manifest

`release-input.json` records only data, including:

```text
schemaVersion
repositoryId
commitSha
workflowRunId
workflowRunAttempt
version
pluginId
fixed asset names
asset byte sizes
asset SHA-256 values
```

No field may specify commands, executable paths, extraction destinations, or arbitrary upload targets.

## 1.4 ZIP semantic validation

Before artifact upload CI verifies:

- real valid ZIP container,
- no absolute/traversal paths,
- no duplicate entry names,
- no symlinks,
- exact expected ZIP directory/file set,
- no extras,
- inner `main.js`, `manifest.json`, and `styles.css` bytes exactly equal standalone assets,
- ZIP filename contains exact canonical version.

Only after these checks is the ZIP SHA-256 recorded.

---

# 2. Exact CI and Live Qualification Provenance

## 2.1 CI producer identity

A release-qualifying CI producer satisfies:

```text
workflow = ci.yml
event = push
head_branch = master
head_sha = GITHUB_SHA
status = completed
conclusion = success
verify job = success
run_id = selected run
run_attempt = selected attempt
```

PR/manual/stale/different-SHA evidence does not qualify.

## 2.2 Current-attempt policy

Qualification binds to both `run_id` and `run_attempt`.

At each release revalidation boundary the selected run must still have the same current attempt and that attempt must remain completed/successful. If a rerun starts, the previously selected attempt stops qualifying until a new current successful attempt and matching artifact are selected.

This is a conservative release policy, not a claim of atomicity with GitHub Actions controls. A rerun can theoretically begin after the final observation; tag SHA and artifact provenance remain the publication identity guarantees.

## 2.3 CI artifact selection

The selected artifact name must exactly match the selected producer SHA/run/attempt.

Artifact metadata must prove at least:

- not expired,
- source workflow run ID matches,
- source head SHA matches,
- source repository ID matches.

When GitHub exposes an artifact SHA-256 digest, the downloaded artifact archive must match it before archive processing.

## 2.4 Live-E2E identity

Stable Release independently selects a `github-e2e-live.yml` attempt satisfying:

```text
event = workflow_dispatch
head_branch = master
head_sha = GITHUB_SHA
status = completed
conclusion = success
qualify job = success
cleanup job = success
run_id = selected live run
run_attempt = selected live attempt
```

The same current-attempt policy applies. Live audit artifacts remain optional evidence, not release authority.

---

# 3. Stable Release Privilege Architecture

Stable Release has two jobs and runs no repository package scripts.

## 3.1 `verify` job

Permissions:

```text
actions: read
contents: read
```

Properties:

- no checkout,
- no pnpm install,
- no build/tests,
- no artifact code execution,
- no repository mutation.

Responsibilities:

1. require dispatch from `master`,
2. require current `master == GITHUB_SHA`,
3. validate canonical requested version syntax,
4. select exact successful current CI attempt,
5. select exact successful current live-E2E attempt,
6. locate exact CI release-input artifact,
7. validate artifact provenance,
8. safely inspect/extract allowlisted artifact data,
9. verify manifest identity and asset hashes,
10. read fixed source metadata files `package.json`, `manifest.json`, and `versions.json` directly from GitHub at **exact `GITHUB_SHA`** using `contents:read`,
11. parse those fixed files strictly as data and verify release metadata/version history,
12. expose selected CI/live run IDs + attempts + artifact identity to `publish`.

Reading fixed source metadata through the GitHub API is allowed; checking out or executing source is not.

## 3.2 `publish` job

Permissions:

```text
actions: read
contents: write
```

Properties:

- no checkout,
- no dependencies,
- no repository build/test code,
- no artifact code execution,
- no third-party publication action,
- only fixed workflow-defined API/CLI/archive/hash operations.

`publish` independently downloads and verifies the selected artifact rather than trusting a mutable workspace handoff from `verify`.

When it needs `package.json`, `manifest.json`, or `versions.json`, it re-reads those exact fixed paths from the exact release SHA through GitHub API and treats them as data only.

---

# 4. Untrusted Artifact Boundary

The CI artifact crosses into a write-capable job and is therefore untrusted input even though CI itself was read-only.

Before extraction, `publish` validates artifact name, producer repository/SHA/run/attempt, expiry, and server digest when exposed.

Archive processing rejects:

- absolute paths,
- `..` traversal or normalization escape,
- symlinks,
- duplicate entries,
- unexpected directories/files,
- anything outside the fixed five-entry allowlist.

Extraction occurs only into a new empty temporary directory.

After extraction:

- `release-input.json` schema is strict,
- identity fields must equal workflow-selected values,
- asset key set must equal fixed expected public assets,
- each asset must be a regular file,
- size/SHA-256 must match.

Artifact files are never `source`d, imported, required, executed, or used to generate arbitrary shell commands.

---

# 5. Canonical Stable-Version Contract

## 5.1 Grammar and comparison

Canonical stable versions match:

```text
^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$
```

Comparison uses exact integer components (`BigInt` or equivalent), never JavaScript `Number` or `sort -V` as authority.

## 5.2 Shared repository-side helper

Repository tooling uses one dependency-free version helper providing parser/validator/comparator/max functions. `scripts/update-version.js`, `scripts/validate-package.mjs`, and their tests use this shared implementation.

The write-capable release job does not checkout/execute that helper. It uses a tiny fixed workflow-owned comparator validated against the same test vectors.

## 5.3 `versions.json` invariant

Validation requires:

- every key canonical,
- compatibility values valid under the project's stable compatibility syntax,
- package and manifest versions identical,
- current version present in `versions.json`,
- current version is maximum canonical declared key,
- current mapping equals `manifest.minAppVersion`.

The version bump helper rejects an existing target and non-increasing target before any metadata write.

## 5.4 Publication history

At publication time calculate observed stable history from:

```text
canonical keys in exact-SHA versions.json
UNION canonical remote tag names
UNION canonical authenticated-visible release tag_name values
```

Requested version must equal the maximum declared `versions.json` key and be greater than every other canonical historical version observed.

This protects against rollback when a higher historical tag is deleted but release or declared history remains.

Deleted history absent from all three sources cannot be reconstructed by workflow logic; Immutable Releases/repository policy are the long-term defense.

---

# 6. Publication-Time Revalidation

## 6.1 Before tag creation

Immediately before tag mutation require:

```text
current master == GITHUB_SHA
selected CI run/attempt still current + completed + successful
selected CI verify job for that attempt successful
selected live run/attempt still current + completed + successful
selected live qualify + cleanup jobs for that attempt successful
release-input artifact still matches selected producer identity
exact-SHA package/manifest/versions metadata still matches requested version
complete paginated tag/release history still permits version
requested tag absent
no authenticated-visible release/draft uses requested tag
```

Workflow/job reads must be attempt-aware. Completeness-sensitive tag/release/run/job enumeration must be pagination-safe.

## 6.2 Before public publish

After draft assets are complete but before the release becomes public, re-require:

```text
current master == GITHUB_SHA
selected CI run/attempt still current successful
selected live run/attempt still current successful
exact tag still == GITHUB_SHA
```

A mutable external control can still change after the final observation; the workflow does not overstate cross-service atomicity.

---

# 7. Publication State Machine

```text
revalidate all authority
        ↓
create refs/tags/VERSION -> GITHUB_SHA via create-only Git refs API
        ↓
read exact tag; require object.type=commit and SHA=GITHUB_SHA
        ↓
create draft release for existing verified tag
        ↓
capture numeric release ID + upload URL from creation response
        ↓
use bounded readiness polling only if API visibility requires it
        ↓
upload exact fixed allowlisted assets using captured release identity
        ↓
GET same release ID; verify draft/tag/exact asset set
        ↓
verify asset names/sizes/digests against manifest where digest is exposed
        ↓
re-read tag + revalidate CI/live/current master
        ↓
PATCH same release ID from draft to public
        ↓
GET same release ID
        ↓
verify public state, exact tag, exact asset names/sizes/digests
```

`gh release create --target` is not tag authority.

Following the returned release ID avoids repeated rediscovery by tag and reduces eventual-consistency ambiguity.

---

# 8. Partial Publication and Immutability

Tag creation, draft creation, uploads, and public publication are not transactional.

Never auto-delete repository state because a later step fails. Conflicting partial state remains visible for maintainer inspection and blocks another stable run.

Runbook covers:

- tag only,
- tag + empty/incomplete draft,
- complete draft whose qualification became invalid,
- public release with failed final verification,
- digest mismatch.

Enable GitHub Immutable Releases when available before calling published releases immutable. Workflow checks provide exact provenance/binding; platform immutable-release protection provides post-publication mutation resistance once effective.

---

# 9. Tests

## 9.1 Version tests

Cover patch/minor/major/explicit canonical targets, huge integer components, leading zeros, malformed/equal/lower targets, duplicate target, noncanonical history keys, current version not maximum declared key, and package/manifest/history inconsistency.

## 9.2 Packaging tests

Cover exact artifact entry set, valid ZIP, traversal/absolute/symlink/duplicate rejection, exact ZIP inner-vs-standalone byte equality, and SHA-256/size manifest accuracy.

## 9.3 Release workflow contract/model tests

Cover:

- no Stable Release checkout/install/build/test,
- read-only verify vs isolated write publish,
- exact run ID + run attempt binding,
- rerun invalidation under current-attempt policy,
- exact artifact producer identity,
- exact-SHA metadata fetched as fixed data paths rather than checkout,
- malicious archive rejection,
- pagination-safe history/qualification lookup,
- history rollback rejected when higher version survives only in release history or `versions.json`,
- revalidation before tag and before public publish,
- create-only exact tag,
- draft release ID capture,
- final asset digest verification,
- no `gh release create --target` authority.

---

# 10. Maintainer Flow

```text
bump version
merge to master
ordinary CI builds/tests/packages exact release-input artifact
run GitHub E2E Live for same exact SHA
run Stable Release with already-declared version
```

Stable Release is faster and narrower than today because it only verifies/promotes tested CI bytes.

If CI artifact expired, rerun CI for the same current master SHA and use the new successful current attempt/artifact. If master changes, prior qualification cannot release the new tip.

---

# 11. Acceptance Criteria

Complete only when:

- CI produces release-ready bytes after all deterministic gates,
- Stable Release never rebuilds release bytes,
- Stable Release executes no repository code/dependencies,
- source metadata is read only from fixed paths at exact `GITHUB_SHA`,
- CI/live evidence binds exact SHA + run ID + current run attempt,
- artifact provenance/digest/structure are verified across the write boundary,
- ZIP internals equal standalone tested assets,
- stable version parsing/comparison is canonical/exact,
- repository-side version tooling shares one implementation,
- current version is maximum declared `versions.json` key,
- monotonic history considers declared versions + tags + releases,
- requested tag is create-only at exact SHA and reverified,
- draft/public release is tracked by returned release ID,
- qualification/master/tag are revalidated before public publish,
- final release asset names/sizes/digests match expected values,
- partial failures never trigger automatic destructive rollback,
- runbook accurately documents rerun invalidation, partial states, and Immutable Releases.
