# Release, E2E, Runtime, and Immutable-Read Hardening — Umbrella Design

## Status

Umbrella architecture for repository baseline `35e98cea924702293bde62d064a83d52eca6d898`.

Revised after formal red-team review on 2026-08-30. This document is the decomposition and cross-cutting authority; each child design remains independently reviewable and must be approved before implementation planning.

It refines, but does not rewrite, the historical hardening design in `docs/superpowers/specs/2026-08-24-release-and-e2e-hardening-design.md`.

## Goal

Close the remaining release-safety, live-E2E isolation, publication-race/recovery, and immutable-read gaps without broad V4 rewrites or speculative optimization.

The design follows these principles:

1. **CI is the sole producer of release bytes and live-E2E executable bundles.**
2. **Privileged workflows consume integrity-bound CI artifacts; they do not checkout/install/build repository code.**
3. **Destructive credentials are narrowly scoped, environment-gated, and never replaced by a write-capable default `GITHUB_TOKEN`.**
4. **Numeric GitHub repository IDs are safety identities; owner/repo names are routing only.**
5. **Qualification uses newest exact-SHA evidence and the latest execution of each required job.**
6. **Publication races are classified from observed Git state, never human-readable error wording.**
7. **Missing correctness evidence is added before changing V4 causality.**
8. **Known scaling hazards are fixed without speculative retained caches.**

---

# 1. Decomposition

## Child A — Release Provenance and Versioning

`docs/superpowers/specs/2026-08-30-release-provenance-and-versioning-design.md`

Owns:

- CI-produced stable release artifact,
- exact release-byte provenance,
- Stable Release read/write privilege separation,
- `stable-release` environment and scoped `RELEASE_TOKEN`,
- newest exact-SHA CI/live qualification,
- latest-job-execution rerun semantics,
- untrusted-artifact handling,
- canonical stable-version parsing/comparison/history,
- exact create-only tag,
- draft release by numeric release ID,
- release notes/title/package-layout compatibility,
- final asset digest verification,
- partial-publication handling,
- Immutable Releases guidance.

## Child B — Live GitHub E2E Safety

`docs/superpowers/specs/2026-08-30-live-github-e2e-safety-design.md`

Owns:

- CI-produced precompiled E2E artifact,
- no checkout/install/build/compile in credentialed live-E2E execution,
- `github-e2e` environment selected-branch restriction,
- mandatory pinned numeric target repository ID,
- narrowly scoped target credential,
- canonical target routing + actual default-branch checks,
- shared destructive-safety helper across all live suites,
- cleanup bound to the qualified target identity,
- Git-ref capability probes before interpreting absence,
- safe local/manual cleanup behavior.

## Child C — Publication Race and Conflict Recovery

`docs/superpowers/specs/2026-08-30-publication-race-and-conflict-recovery-design.md`

Owns:

- `V4PublicationRaceError`,
- publication reconciliation as race-classification authority,
- explicit indeterminate reconciliation evidence,
- concurrent empty-repository initialization,
- remote-appears-between-config-discovery-and-session race,
- preservation of existing runtime/E2E retry semantics,
- terminal retry UX,
- multi-descendant folder regressions using actual folder events,
- Copy + publication-race + recovery-store integration,
- no broad causality changes without a deterministic failing regression.

## Child D — Immutable Git Read Fallback

`docs/superpowers/specs/2026-08-30-immutable-git-read-fallback-design.md`

Owns:

- path-directed non-recursive immutable tree traversal,
- strict complete-evidence/truncation semantics,
- malformed-tree evidence handling,
- explicit managed-path symlink/gitlink policy,
- no unbounded tree cache,
- exact fallback regressions and scaling contract.

---

# 2. Dependency Order

Implementation planning/execution proceeds:

```text
Live E2E Safety
        ↓
Release Provenance and Versioning
        ↓
Publication Race and Conflict Recovery
        ↓
Immutable Git Read Fallback
```

This remains acyclic because Child B owns production of the CI `github-e2e-input` artifact, while Child A independently adds the CI `release-input` artifact later.

Stable Release depends on trustworthy live-E2E qualification. Sync/recovery changes are independent once qualification infrastructure is hardened. Immutable-read fallback remains independent and last.

---

# 3. CI as the Trusted Producer Boundary

Ordinary `ci.yml` on a push to `master` is the only workflow allowed to compile/build artifacts later consumed under privileged credentials.

CI remains repository read-only and may produce two independent artifacts:

```text
release-input-<SHA>-<CI_RUN_ID>-<VERIFY_ATTEMPT>
github-e2e-input-<SHA>-<CI_RUN_ID>-<VERIFY_ATTEMPT>
```

Both artifacts:

- bind repository ID, source SHA, producer run ID, and producer job execution attempt,
- contain strict manifests with fixed file allowlists + byte sizes + SHA-256 values,
- are validated before upload,
- are treated as untrusted data when downloaded later,
- are never trusted solely because their artifact names match.

No privileged workflow rebuilds either artifact.

---

# 4. GitHub Actions Trust Boundary

## 4.1 External actions are immutable inputs

Every external `uses:` reference in repository workflows is pinned to a verified full-length commit SHA. Human-readable version comments may be retained beside the SHA.

A feasibility/static contract rejects mutable external action refs such as `@v4`, `@v6`, or branch names.

After all workflows satisfy the contract, repository policy may require full-length action SHA pinning as defense in depth.

Local actions/reusable code under the repository are governed by the exact source SHA and ordinary CI review, not by external-action pinning.

## 4.2 Environment branch policy

`github-e2e` and `stable-release` environments use **Selected branches and tags**, explicitly allowing branch `master` and no release tags.

Do not use **Protected branches only** as the policy while this repository has no protected branch rule; that setting would not provide the intended restriction.

Workflow runtime checks still require `GITHUB_REF == refs/heads/master`; environment policy is an independent defense.

## 4.3 No write-capable default workflow token in release

Stable Release's default `GITHUB_TOKEN` remains read-only. Repository mutation uses a separate environment secret `RELEASE_TOKEN` whose mutable scope is restricted to this source repository and only the repository permissions required for tag/release publication.

If a workflow variant removes the `stable-release` environment, it loses `RELEASE_TOKEN`; it does not fall back to a write-capable `GITHUB_TOKEN`.

The same principle applies to live E2E: the destructive target token exists only as an environment secret on `github-e2e`.

These controls do not claim protection against an authorized maintainer/admin who intentionally changes trusted `master` and environment configuration.

---

# 5. Qualification Authority

For CI and live E2E, Stable Release uses the **newest qualifying exact-SHA workflow run**, not any historical successful run.

For each required job within that run, authority is the **latest execution of that job across workflow attempts**:

```text
latest execution exists
status == completed
conclusion == success
```

This preserves normal GitHub rerun behavior:

- rerunning only failed `cleanup` may reuse an earlier successful `qualify`,
- rerunning `qualify` creates newer authority for `qualify`,
- a newer failing/in-progress execution blocks release,
- a newer exact-SHA live workflow run blocks fallback to an older successful run.

Artifact identity is bound to the execution attempt of the producer job that actually created it.

If current CI producer evidence changes, any live-E2E qualification that consumed the previous CI E2E artifact becomes stale and must be rerun.

---

# 6. Cross-Cutting Invariants

- Exact `master` commit SHA is the release source identity.
- Numeric repository IDs are workflow/test safety identities only; they do not replace V4 `owner/repo#branch` protocol identity.
- V4 repository rename/case migration remains separate because it affects crypto/recovery namespaces.
- GitHub ref mutation is not server-side compare-and-swap merely because local code accepts an expected SHA argument.
- Copy conflict semantics remain local-primary with a remote competitor preserved exactly once when a remote body exists.
- Ambiguous namespace, incomplete ancestry evidence, malformed tree evidence, or uncertain privilege provenance fails closed.
- Recovery/stage lifecycle assertions remain in recovery tests.
- No Git-tree cache is added without profiling and a bounded resource design.
- No watcher-noise/out-of-order behavior is added without production-relevant evidence.
- `scripts/zip-source.mjs` remains separate maintenance work; stable release packaging is independently validated.

---

# 7. Release-Readiness Gate

A final release is eligible only after all implemented child plans are complete and final `master` SHA has:

```text
newest exact-SHA ordinary CI push run: authoritative required jobs successful
current CI release artifact: valid
current CI E2E bundle artifact: valid
newest exact-SHA live E2E run: authoritative qualify + cleanup successful
live qualification consumed current CI E2E artifact
Stable Release input version: canonical/current
master still equals exact qualified SHA at mutation/publication boundaries
```

Any later `master` commit invalidates qualification. Any newer exact-SHA CI/live run or newer execution of a required job becomes the new authority.

---

# 8. Deferred Work

Separate future designs remain for:

- V4 repository rename/case migration,
- physical Windows/Android qualification expansion,
- multi-gigabyte stress qualification,
- bounded immutable-tree caching if profiling justifies it,
- watcher-noise hardening backed by production evidence,
- `scripts/zip-source.mjs` portability repair,
- stronger repository governance/branch-protection policy if desired.

---

# 9. Superpowers Workflow Gate

Each child design must be:

1. written and committed,
2. self-reviewed for placeholders, contradictions, scope, and ambiguity,
3. reviewed/approved by the user,
4. converted to its own implementation plan with `writing-plans`,
5. implemented/tested/reviewed independently.

No implementation plan combines all children into one mega-plan.
