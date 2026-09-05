# Release Provenance and Versioning Design

## Status

Child design of `2026-08-30-release-e2e-runtime-hardening-followup-design.md` for baseline `35e98cea924702293bde62d064a83d52eca6d898`.

Revised after implementation-plan self-review on 2026-08-30. This child owns stable release-byte provenance, privileged publication boundaries, qualification authority, canonical version history, and partial-publication safety.

## Goal

Publish the exact stable-release bytes produced and package-validated by authoritative ordinary CI for the exact final `master` SHA, while keeping repository write authority out of repository checkout/install/build/test execution.

The release system must prove exact source commit, authoritative current CI producer/current attempt, authoritative current live-E2E cohesive attempt for that same CI producer, byte integrity through public assets, source-manifest identity, monotonic stable version history, exact tag binding, and current qualification immediately before mutation/publication.

The design does not claim unit tests execute final bundled `main.js` byte-for-byte; it guarantees promoted bytes are exact outputs produced and package-validated in the same successful CI producer attempt after deterministic source/build/test gates, with no release-time rebuild.

## Non-goals

This child does not redesign live-E2E target safety, add a SemVer dependency, repair `scripts/zip-source.mjs`, make GitHub resources transactionally atomic, depend on old workflow-attempt artifacts being durable across reruns, or claim protection against a maintainer/admin who intentionally changes trusted `master` and release environment configuration.

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
validate ZIP semantics
write release-input manifest
upload release-input artifact
```

Stable Release never checks out repository code, installs dependencies, rebuilds, or reruns repository tests.

CI uploads:

```text
release-input-${GITHUB_SHA}-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}
```

with exactly:

```text
release-input.json
<repository-name>-v<VERSION>.zip
main.js
manifest.json
styles.css
```

Trusted `<repository-name>` authority is GitHub repository metadata/context, never artifact-supplied text.

The manifest records schema version, repository ID, commit SHA, CI run ID, producer run attempt, version, plugin ID, exact asset names, sizes, and SHA-256 values as data only.

---

# 2. Stable Package Compatibility Contract

Preserve current stable-release UX:

```text
release title/name = VERSION
generate release notes = true
prerelease = false
draft until verification completes
```

ZIP remains:

```text
<repository-name>-v<VERSION>.zip
```

with internal root:

```text
<repository-name>/
  main.js
  manifest.json
  styles.css
```

CI rejects invalid ZIP container, absolute/traversal paths, duplicate names, symlinks, unexpected entries, or extras. Inner files must be byte-identical to standalone assets. ZIP SHA-256 is recorded only after semantic validation.

---

# 3. Exact Source Metadata Binding

Artifact `manifest.json` must be byte-identical to exact source `manifest.json` at `GITHUB_SHA`.

Stable Release reads only fixed source paths through GitHub API at exact SHA:

```text
package.json
manifest.json
versions.json
.node-version when needed by provenance checks
```

These are parsed strictly as data; no source checkout/script execution is allowed.

---

# 4. Authoritative CI and Live Qualification

## 4.1 Newest exact-SHA run authority

For each workflow, select the **newest matching** run; do not choose any historical success.

CI:

```text
workflow = ci.yml
event = push
head_branch = master
head_sha = GITHUB_SHA
```

Live:

```text
workflow = github-e2e-live.yml
event = workflow_dispatch
head_branch = master
head_sha = GITHUB_SHA
```

If the newest matching run is queued/running/cancelled/failed, release blocks. Ordering uses explicit run metadata with deterministic tie-breaking, not first-page accident.

## 4.2 Current workflow attempt is cohesive authority

Qualification deliberately does not synthesize success across different workflow attempts.

For authoritative CI, the current/latest run attempt must contain a completed/successful `verify` job and the selected release/E2E artifacts for that same attempt.

For authoritative live E2E, the current/latest run attempt must contain:

```text
qualify = completed/success
cleanup = completed/success
same-attempt qualification receipt = present/valid
```

If a maintainer reruns failed `cleanup` only, that cleanup may be operationally useful but the partial attempt is **not release-qualifying** because `qualify` did not execute in the same attempt. A release-qualifying rerun uses **Re-run all jobs** so `qualify`, receipt, scenario execution, and cleanup are cohesive again.

This avoids dependence on undocumented cross-attempt artifact/job-output retention.

## 4.3 Current CI producer binds live qualification

Child B persists a strict non-secret receipt **before live scenario mutation** for each `qualify` attempt:

```text
github-e2e-target-${LIVE_RUN_ID}-${LIVE_RUN_ATTEMPT}
```

For the current successful live attempt, Stable Release requires the same-attempt receipt and verifies its repository/SHA/run/attempt metadata/content.

The receipt supplies the exact CI input identity consumed by that attempt:

```text
ciProducerRunId
ciProducerRunAttempt
ciE2EArtifactId
ciE2EArtifactDigest when exposed
```

Receipt existence/content is not proof E2E passed; successful `qualify`/`cleanup` authority comes only from Actions job state in the same attempt.

Those CI values must equal current authoritative CI producer/E2E artifact. Any later CI rerun invalidates old live qualification until live E2E is rerun.

---

# 5. Release Artifact Selection and Untrusted Boundary

Selected `release-input` artifact binds to current authoritative CI attempt.

Require exact artifact name, unexpired state, matching workflow run/repository/head metadata, server artifact digest when exposed, and embedded producer identity.

`verify` and `publish` independently download/validate the same selected artifact; mutable workspace handoff is not trusted.

Before extraction reject absolute/traversal paths, symlinks, duplicate names, unexpected directories, and anything outside the fixed five-entry allowlist derived from trusted repository name + requested canonical version.

Extraction is into a fresh empty directory. Every asset must be a regular file with exact expected size/SHA-256. Artifact files are never sourced/imported/required/executed.

---

# 6. Stable Release Privilege Architecture

## 6.1 Default workflow token is always read-only

Stable Release never grants repository write permission to default `GITHUB_TOKEN`.

It has only read authority required for Actions/source/artifact inspection, such as:

```text
actions: read
contents: read
```

Repository mutation never uses this token.

## 6.2 `stable-release` environment + scoped publication credential

Create `stable-release` environment with **Selected branches and tags** allowing branch `master` and no tags. Do not use `Protected branches only` while repository has no protected branch rule.

The environment provides `RELEASE_TOKEN`, scoped so mutable repository authority is restricted to this source repository and only permissions required for tag/release publication. A fine-grained repository-scoped credential or repository-scoped GitHub App credential is acceptable; broad classic credentials are not release-qualifying configuration.

`publish` references `environment: stable-release`; removing the environment loses `RELEASE_TOKEN` and leaves only read-only default token.

The release credential is exposed only to fixed workflow-owned publication-state inspection/mutation/upload/publication steps that execute no repository code. Most read-only qualification uses default token.

Draft-release enumeration is performed with publication credential because draft visibility requires push authority.

## 6.3 `verify`

No release credential; no repository mutation. It requires exact master, selects authoritative current CI/live attempts, requires current live receipt to bind current CI input, verifies exact release artifact, reads fixed exact-SHA source metadata, validates package/version/history, and exposes only non-secret identities.

## 6.4 `publish`

Depends on `verify`, references protected release environment, contains no checkout/install/build/test, independently re-downloads/revalidates artifact/source metadata, and performs final publication-state inspection before mutation.

---

# 7. External Action Pinning

All external `uses:` references remain pinned to verified full-length commit SHAs under the cross-cutting Actions policy established by Child B. Static feasibility tests prevent regression to mutable action tags/branches.

Privileged release jobs minimize external actions and execute no repository code.

---

# 8. Canonical Stable-Version Contract

Canonical stable versions match:

```text
^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$
```

Comparison uses exact integer components (`BigInt` or equivalent), never JavaScript `Number` or `sort -V` authority.

Repository tooling shares one dependency-free helper for parse/validate/compare/max. `scripts/update-version.js`, `scripts/validate-package.mjs`, and tests use it.

Privileged release jobs do not checkout/execute that helper; small fixed workflow-owned comparison logic is tested against the same vectors.

`versions.json` requires every key canonical, compatibility values valid under current project syntax, package/manifest versions identical, current version present and maximum, and current mapping equal `manifest.minAppVersion`.

Bump helper rejects existing/non-increasing target before write.

---

# 9. Publication History

Immediately before tag creation calculate stable history union:

```text
canonical exact-SHA versions.json keys
canonical remote tag names
canonical authenticated-visible release tag_name values (including drafts)
```

Requested version must equal maximum declared exact-SHA `versions.json` key and be strictly greater than every other canonical observed stable version.

Tag/release enumeration is pagination-safe. Release enumeration requiring draft visibility uses scoped publication credential in no-code `publish` job.

Deleted history absent from all three sources cannot be reconstructed; Immutable Releases/repository governance are long-term defenses.

---

# 10. Publication-Time Revalidation

Immediately before tag mutation require:

```text
current master == GITHUB_SHA
newest authoritative CI run unchanged
current CI attempt verify still successful
newest authoritative live run unchanged
current live attempt qualify + cleanup still successful
same-attempt live receipt valid and bound to current CI E2E producer
release-input artifact still matches current CI producer
artifact/source manifest binding valid
exact-SHA package/manifest/versions match requested version
complete tag + draft/published release history permits version
requested tag absent
no authenticated-visible release/draft uses requested tag
```

Immediately before draft -> public transition re-require at least:

```text
current master == GITHUB_SHA
authoritative CI/live current attempts unchanged/successful
same-attempt live receipt still binds current CI producer
exact tag == GITHUB_SHA
same expected draft release ID/assets
```

No claim of atomicity against external administrator modifying controls after final observation.

---

# 11. Publication State Machine

```text
revalidate ordinary authority with read-only token
inspect complete release state (including drafts) with RELEASE_TOKEN
        ↓
with RELEASE_TOKEN: create refs/tags/VERSION -> GITHUB_SHA via create-only Git refs API
        ↓
read exact tag; require commit object at GITHUB_SHA
        ↓
with RELEASE_TOKEN: create draft release for existing tag
  title/name = VERSION
  generate_release_notes = true
  prerelease = false
        ↓
capture numeric release ID + upload URL
        ↓
with RELEASE_TOKEN: upload exact allowlisted assets
        ↓
GET same release ID; require draft/tag/exact asset set
        ↓
boundedly wait for release asset digest readiness if needed
require each `sha256:` digest + size equals release-input manifest
        ↓
revalidate master + CI/live/current-CI binding + exact tag
        ↓
with RELEASE_TOKEN: publish same numeric release ID
        ↓
GET same release ID
require public non-prerelease state, exact tag/title, exact assets/sizes/digests
```

`gh release create --target` is not tag authority. Numeric release ID returned by draft creation is release identity for subsequent mutation; do not rediscover by tag/name.

---

# 12. Partial Publication and Immutability

Tag creation, draft creation, upload, and public publication are not one transaction.

Never automatically remove publication state because a later step fails. Conflicting partial state remains inspectable and blocks another stable run until maintainer resolution.

Runbook covers tag-only state, incomplete draft, complete stale-qualified draft, public release with failed final verification, and digest mismatch.

Enable GitHub Immutable Releases before calling published releases immutable. Workflow provenance protects publication correctness; platform immutability protects associated tag/assets after publication when enabled.

---

# 13. Tests

Required evidence includes canonical version positives/negatives + huge integers; noncanonical/current-not-maximum history; exact ZIP name/root/content semantics; ZIP traversal/symlink/duplicate/extra rejection; artifact/source manifest mismatch rejection; newest exact-SHA CI/live authority; cohesive current-attempt job qualification; cleanup-only partial rerun rejected for release qualification; newer CI producer invalidating older live qualification; exact same-attempt receipt binding; missing/mismatched receipt rejection; malicious release artifact rejection; no release checkout/install/build/test; no write-capable default `GITHUB_TOKEN`; protected release environment boundary; draft-visible conflict enumeration with publication credential; complete pagination-safe history; create-only exact tag; captured release ID; preserved title/generated-notes/non-prerelease/ZIP UX; revalidation before tag/publication; exact final asset digests; and no automatic destructive rollback.

---

# 14. Maintainer Flow

One-time:

1. configure `stable-release` environment,
2. restrict it to selected branch `master`,
3. configure repository-scoped publication credential,
4. enable Immutable Releases when appropriate,
5. keep external actions full-SHA pinned.

Per release:

```text
bump version
-> merge master
-> ordinary CI succeeds and produces current release + E2E artifacts
-> GitHub E2E Live succeeds for exact SHA/current CI E2E artifact in one cohesive attempt
-> Stable Release promotes current CI release artifact
```

If authoritative CI changes, live qualification must be repeated. If master changes, prior exact-SHA qualification is irrelevant to new tip.

---

# 15. Acceptance Criteria

Complete only when CI is sole stable release-byte producer; Stable Release executes no repository code/dependencies; default workflow token remains read-only; publication authority exists only through protected environment-scoped repository-limited credential; draft conflict inspection is complete; newest exact-SHA CI/live runs and their current cohesive attempts are authoritative; current live receipt binds that same attempt to current CI producer; cleanup-only partial rerun cannot synthesize qualification; source/public manifest + artifact digests are verified; version history is canonical/exact; exact tag is create-only; release lifecycle uses returned numeric release ID; current release title/notes/ZIP UX is preserved; final public asset digests match; and partial failures never trigger automatic destructive rollback.