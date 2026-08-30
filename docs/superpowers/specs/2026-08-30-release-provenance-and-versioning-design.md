# Release Provenance and Versioning Design

## Status

Child design of `2026-08-30-release-e2e-runtime-hardening-followup-design.md`.

Repository baseline: `35e98cea924702293bde62d064a83d52eca6d898`.

This child owns release provenance, release workflow privilege boundaries, exact tested-byte promotion, stable-version history, and partial-publication safety. Live-E2E target safety is specified separately.

## Goal

Make stable publication promote the exact bytes that ordinary CI built and tested for the exact final master SHA, while keeping repository write authority out of all repository-code/dependency execution.

The release system must answer all of these questions with explicit evidence:

1. Which exact source commit produced these bytes?
2. Which CI workflow run and run attempt tested them?
3. Which live-E2E workflow run and run attempt qualified the same commit?
4. Have the bytes changed between CI artifact creation and public release assets?
5. Is the requested version canonical and strictly newer than declared/observed stable history?
6. Is `master` still the same exact commit at mutation/publication time?

## Non-goals

This child does not:

- rebuild source inside Stable Release,
- redesign the live-E2E target safety boundary,
- change V4 protocol versioning,
- add a third-party SemVer dependency,
- repair `scripts/zip-source.mjs`,
- make release/tag state transactionally atomic across GitHub resources,
- claim protection against an administrator who retains independent repository write authority.

---

# 1. Build Once, Promote Tested Bytes

## 1.1 CI is the release-artifact producer

Ordinary `ci.yml` on a `push` to `master` remains the deterministic build/test authority.

For an exact `GITHUB_SHA`, CI performs:

```text
checkout exact SHA
install frozen pnpm dependencies
build
fast tests
repeat tests
recovery tests
resource tests
feasibility tests
real-GitHub E2E compile gate
package validation
package stable-release ZIP
validate ZIP semantic contents
write release-input manifest
upload release-input artifact
```

The repository remains read-only during CI.

Stable Release **does not rebuild** these outputs. The public release promotes the same artifact bytes that passed ordinary CI.

## 1.2 Release-input artifact

CI uploads one blocking artifact whose name includes producer identity:

```text
release-input-${GITHUB_SHA}-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}
```

The artifact contains exactly:

```text
release-input.json
<plugin>-v<VERSION>.zip
main.js
manifest.json
styles.css
```

No additional files, executable helpers, environment files, symlinks, nested script directories, or hidden control files are part of the contract.

## 1.3 Release-input manifest

`release-input.json` records at least:

```json
{
  "schemaVersion": 1,
  "repositoryId": "...",
  "commitSha": "...",
  "workflowRunId": "...",
  "workflowRunAttempt": 1,
  "version": "...",
  "pluginId": "...",
  "assets": {
    "<plugin>-v<VERSION>.zip": { "size": 0, "sha256": "..." },
    "main.js": { "size": 0, "sha256": "..." },
    "manifest.json": { "size": 0, "sha256": "..." },
    "styles.css": { "size": 0, "sha256": "..." }
  }
}
```

Every value is data only. No manifest field can specify a command, arbitrary extraction path, shell fragment, executable, or upload destination.

## 1.4 ZIP semantic validation

CI verifies the release ZIP before upload, not merely that a file ending in `.zip` exists.

Required checks:

- valid ZIP container/signature,
- no absolute paths,
- no `..` traversal,
- no duplicate entry names,
- no symlink entries,
- exact expected directory/file set,
- no extra files,
- inner `main.js`, `manifest.json`, and `styles.css` bytes equal the corresponding standalone release assets,
- ZIP filename contains the exact canonical version.

The CI artifact records the resulting ZIP SHA-256 after these checks.

---

# 2. CI Qualification Identity

## 2.1 Exact run and attempt

A release-qualifying ordinary CI producer is identified by:

```text
workflow file = ci.yml
event = push
head_branch = master
head_sha = release GITHUB_SHA
status = completed
conclusion = success
job name/id verify = success
run_id = selected producer run
run_attempt = selected producer attempt
```

A PR run, workflow-dispatch CI run, stale SHA, skipped job, or different attempt does not qualify.

## 2.2 Latest-attempt authority

Workflow reruns can change the current attempt for a run ID. Qualification therefore binds to both `run_id` and `run_attempt`.

At every release gate, the selected CI run must still report:

```text
current run_attempt == selected run_attempt
status == completed
conclusion == success
```

If the run is rerun after selection, the old attempt immediately stops qualifying until the new current attempt completes successfully and its own exact artifact is selected.

## 2.3 Artifact selection

The selected artifact name must equal the producer identity exactly:

```text
release-input-${HEAD_SHA}-${RUN_ID}-${RUN_ATTEMPT}
```

Artifact metadata must additionally show:

- not expired,
- producer workflow run ID matches,
- head SHA matches,
- repository ID matches the source repository.

If GitHub exposes an artifact SHA-256 digest, Stable Release verifies the downloaded archive against that digest before extraction.

---

# 3. Live-E2E Qualification Provenance

Stable Release selects a completed successful `github-e2e-live.yml` run for the same source SHA.

Required identity:

```text
event = workflow_dispatch
head_branch = master
head_sha = release GITHUB_SHA
status = completed
conclusion = success
qualify job = success
cleanup job = success
run_id = selected live run
run_attempt = selected live attempt
```

The selected live run/attempt is revalidated with the same latest-attempt rule as CI.

The live audit artifact remains optional human evidence and is not release authority.

Target-repository identity/credential rules are owned by the Live GitHub E2E Safety child design.

---

# 4. Stable Release Privilege Architecture

Stable Release contains two small jobs and executes no repository package scripts.

## 4.1 Job `verify`

Permissions:

```text
actions: read
contents: read
```

Properties:

- no source checkout,
- no pnpm install,
- no build,
- no tests,
- no execution of code obtained from the release artifact,
- no repository mutation.

Responsibilities:

1. require workflow dispatch from `master`,
2. require current `master == GITHUB_SHA`,
3. validate canonical requested version syntax,
4. select exact successful CI run + current attempt,
5. select exact successful live-E2E run + current attempt,
6. locate the exact CI release-input artifact,
7. validate artifact provenance,
8. safely inspect artifact archive structure,
9. parse strict manifest data,
10. require manifest repository/run/attempt/SHA/version identity to match,
11. recompute exact asset sizes and SHA-256 values,
12. validate package/manifest/version-history data using only fixed data parsing,
13. expose selected CI/live run IDs + attempts and artifact identity to `publish` as job outputs.

The `verify` job may use GitHub CLI/API and fixed shell/Node snippets defined in the workflow itself. It does not execute files contained in the downloaded artifact.

## 4.2 Job `publish`

Dependencies:

```text
needs: verify
```

Permissions:

```text
actions: read
contents: write
```

Properties:

- no checkout,
- no dependency installation,
- no repository build/test code,
- no execution of artifact content,
- no third-party publication action,
- only fixed workflow-defined GitHub API/CLI and archive/hash utilities.

The publish job independently downloads and verifies the exact selected artifact rather than trusting files passed through an unverified workspace.

---

# 5. Untrusted Artifact Boundary

The release-input artifact originates from a read-only job, but it is still treated as untrusted data when entering a write-capable job.

Before extraction or use, `publish` requires:

- exact artifact name,
- same source repository ID,
- same source SHA,
- same producer run ID,
- same producer run attempt,
- not expired,
- artifact digest match when exposed.

Archive inspection then rejects:

- absolute paths,
- `../` traversal,
- path normalization escapes,
- symlinks,
- duplicate entries,
- unexpected entries,
- unexpected directories,
- filenames outside the fixed allowlist.

Extraction occurs only into a new empty temporary directory.

After extraction, `publish` parses `release-input.json` as data and verifies:

- schema version is exactly supported,
- no required field is missing,
- run/repository/SHA/version identities match the workflow-selected values,
- asset key set equals the fixed expected allowlist,
- each file is a regular file,
- each size matches,
- each SHA-256 matches.

Artifact files are never `source`d, imported, required, executed, or used to construct arbitrary shell commands.

---

# 6. Canonical Stable-Version Contract

## 6.1 Grammar

Stable versions are canonical only:

```text
^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$
```

Leading-zero components, prereleases, build metadata, partial versions, and malformed strings are rejected.

## 6.2 Exact comparison

Version components are parsed as exact non-negative integers using `BigInt` or equivalent exact comparison.

Do not use JavaScript `Number` or `sort -V` as release-order authority.

## 6.3 Shared source tooling

Repository-side tooling uses one dependency-free helper module for:

```text
isCanonicalStableVersion
parseStableVersion
compareStableVersions
maxStableVersion
```

`scripts/update-version.js`, `scripts/validate-package.mjs`, and source-side tests use that helper rather than duplicating parser/comparator behavior.

The write-capable `publish` job does **not** checkout or execute that helper. It implements the small fixed comparator in workflow-owned code and is tested against the same version-contract vectors.

## 6.4 Declared version-history invariant

`versions.json` is long-lived declared stable history.

Validation requires:

- every key is canonical stable version syntax,
- every value is valid canonical Obsidian compatibility version syntax under the project's current compatibility contract,
- current `manifest.json`/`package.json` version exists exactly once as a key,
- current version is the maximum canonical key in `versions.json`,
- mapping for current version equals `manifest.minAppVersion`.

The version helper refuses a target already present in `versions.json` and refuses a target not greater than the current version.

## 6.5 Publication-history invariant

Immediately before tag mutation, Stable Release obtains complete paginated remote state and computes canonical stable history from:

```text
canonical keys in versions.json
UNION canonical remote tag names
UNION canonical authenticated-visible release tag_name values
```

The requested version must equal the maximum canonical `versions.json` key and must be strictly greater than every *other* canonical historical version observed from those sources.

This prevents accidental rollback when a historical tag was deleted but its release or declared version history remains.

Deleted history that is absent from all three sources cannot be reconstructed by the workflow; Immutable Releases and repository policy are the long-term protection against such historical erasure.

---

# 7. Publication-Time Revalidation

## 7.1 Before tag mutation

Immediately before creating the requested tag, `publish` revalidates all mutable authority:

```text
current master == GITHUB_SHA
selected CI run_id + run_attempt still current/successful
selected CI verify job still successful
selected live run_id + run_attempt still current/successful
selected live qualify job still successful
selected live cleanup job still successful
release-input artifact still resolves to selected producer identity
requested version still canonical
remote tag/release enumeration still satisfies version history
no requested tag exists
no authenticated-visible release/draft uses requested tag
```

A qualification rerun that has started or changed attempt invalidates the old evidence.

## 7.2 Pagination

Remote tag, release, workflow-run, and workflow-job discovery must not rely on first-page-only results when completeness affects authority.

Use explicit pagination until completion or a GitHub CLI mode whose documented behavior traverses all pages.

---

# 8. Canonical Publication State Machine

After revalidation:

```text
create refs/tags/VERSION -> GITHUB_SHA via create-only Git refs API
        ↓
read exact tag; require object.type=commit and object.sha=GITHUB_SHA
        ↓
create draft release for existing verified tag
        ↓
capture release ID and upload URL from creation response
        ↓
wait/retry only as needed for bounded API readiness using the release ID
        ↓
upload exact fixed allowlisted assets by captured release identity
        ↓
GET draft by release ID; verify draft=true, tag exact, asset set exact
        ↓
verify asset names/sizes/digests against manifest where GitHub exposes digests
        ↓
re-read exact tag == GITHUB_SHA
        ↓
revalidate selected CI/live run attempts and current master again
        ↓
PATCH the same release ID from draft to public
        ↓
GET same release ID; require public/non-draft state
        ↓
verify exact tag and final fixed asset names/sizes/digests
```

`gh release create --target` is not tag authority.

The workflow follows the release object by returned numeric release ID after draft creation rather than repeatedly rediscovering it by mutable/tag lookup.

---

# 9. Partial Publication Failure

Tag creation, draft creation, asset upload, and public publication are not one transaction.

Never automatically delete a tag, draft, public release, or asset merely because a later step fails.

Fail closed on any partial state until a maintainer inspects it.

Runbook cases include:

- tag exists, no release,
- tag exists, draft exists with no assets,
- draft exists with incomplete/wrong assets,
- draft complete but qualification became invalid before publish,
- public release exists but final verification failed,
- public release asset digest does not match expected manifest.

Repair/removal is an explicit maintainer decision.

---

# 10. Immutable Releases

If GitHub Immutable Releases is available for the repository, enable it before describing stable publication as immutable.

Workflow-level guarantees are:

- exact tested-byte provenance,
- exact-SHA requested-tag creation,
- explicit before/after verification,
- fail-closed partial-state handling.

Platform immutable-release protection supplies post-publication tag/asset immutability once effective.

---

# 11. Tests

## 11.1 Version helper tests

Positive:

- patch/minor/major bumps,
- explicit canonical target,
- very large integer components.

Negative:

- leading zeros,
- malformed input,
- equal/lower target,
- duplicate target key,
- non-canonical `versions.json` key,
- current version not maximum declared key,
- inconsistent manifest/package/current mapping.

## 11.2 CI packaging tests

Verify:

- release-input manifest schema,
- expected five artifact entries exactly,
- valid ZIP,
- no traversal/symlink/duplicate entries,
- ZIP inner asset bytes equal standalone asset bytes,
- all expected SHA-256/size values match.

## 11.3 Stable Release feasibility contracts

Text-level semantic contracts verify:

- Stable Release does not checkout/install/build/test,
- read-only `verify` and isolated write `publish`,
- exact CI and live run **attempt** binding,
- producer artifact name includes run attempt,
- untrusted archive validation/allowlist markers,
- complete pagination markers,
- revalidation before tag and before public publish,
- create-only tag,
- exact tag verification,
- draft release ID capture,
- final asset digest verification,
- no `gh release create --target` authority.

## 11.4 Negative workflow-model tests

Model/fixture tests cover:

- CI rerun invalidates previously selected attempt,
- live-E2E rerun invalidates previously selected attempt,
- wrong producer run/attempt artifact rejected,
- expired artifact rejected,
- malicious archive path rejected,
- symlink/extra artifact entry rejected,
- artifact hash mismatch rejected,
- release-history rollback rejected when higher version survives only in release history,
- release-history rollback rejected when higher version survives only in `versions.json`,
- conflicting draft release blocks publication.

---

# 12. User/Maintainer Flow

Normal release flow remains simple:

```text
bump version
merge to master
ordinary CI succeeds and produces release-input artifact
run GitHub E2E Live for exact SHA
run Stable Release with the already-declared version
```

Stable Release is faster than the current design because it verifies/promotes CI output instead of reinstalling/rebuilding.

If `master`, CI attempt, or live-E2E attempt changes, the release fails with a specific qualification message rather than publishing stale evidence.

Partial publication failures direct the maintainer to inspect exact tag/release ID/state rather than automatically deleting evidence.

---

# 13. Acceptance Criteria

This child is complete when:

- ordinary CI produces the exact release-input artifact after all deterministic gates,
- Stable Release never rebuilds release bytes,
- Stable Release runs no repository code or dependency installation,
- CI/live qualification binds to exact run ID + current run attempt + exact SHA,
- qualification is revalidated before tag mutation and before public publish,
- producer artifact is treated as untrusted data across the write boundary,
- artifact and ZIP structures are allowlisted and traversal/symlink safe,
- standalone assets and ZIP inner assets are byte-identical,
- requested version is canonical and exact-integer compared,
- repository-side version tools share one parser/comparator implementation,
- current version is maximum declared `versions.json` key,
- publication monotonicity considers declared versions + remote tags + release tag names,
- requested tag is created explicitly and create-only at `GITHUB_SHA`,
- draft/public release is tracked by returned release ID,
- final release assets match expected names/sizes/digests,
- partial publication never triggers automatic destructive rollback,
- runbook documents qualification invalidation, partial states, and Immutable Releases accurately.
