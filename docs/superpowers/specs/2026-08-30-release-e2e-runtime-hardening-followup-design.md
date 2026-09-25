# Release, E2E, Runtime, and Immutable-Read Hardening — Umbrella Design

## Status

Umbrella architecture for repository baseline `35e98cea924702293bde62d064a83d52eca6d898`.

Revised after implementation-plan self-review on 2026-08-30. This document is the decomposition and cross-cutting authority; each child design remains independently reviewable and must be approved before implementation planning.

It refines, but does not rewrite, the historical hardening design in `docs/superpowers/specs/2026-08-24-release-and-e2e-hardening-design.md`.

## Goal

Close remaining release-safety, live-E2E isolation, publication-race/recovery, and immutable-read gaps without broad V4 rewrites or speculative optimization.

Principles:

1. **CI is sole producer of release bytes and live-E2E executable bundles.**
2. **Privileged workflows consume integrity-bound CI artifacts; they do not checkout/install/build repository code.**
3. **Privileged credentials are narrowly scoped, environment-gated, and never replaced by a write-capable default `GITHUB_TOKEN`.**
4. **Numeric GitHub repository IDs are safety identities; owner/repo names are routing only.**
5. **Qualification uses the newest exact-SHA matching workflow run and its current/latest workflow attempt as a cohesive authority.**
6. **A live qualification receipt binds that same successful attempt to its exact CI input/target identity; receipts never substitute for Actions job success or bridge old attempts.**
7. **Publication races are classified from observed Git state, never human-readable error wording.**
8. **Missing correctness evidence is added before changing V4 causality.**
9. **Known scaling hazards are fixed without speculative retained caches.**

---

# 1. Decomposition

## Child A — Release Provenance and Versioning

`docs/superpowers/specs/2026-08-30-release-provenance-and-versioning-design.md`

Owns CI stable-release artifact production; exact release-byte provenance; Stable Release privilege separation; `stable-release` environment/scoped publication credential; newest exact-SHA CI/live authority; cohesive current-attempt qualification; same-attempt live receipt-to-CI binding; artifact safety; canonical stable-version history; exact tag creation; draft/public release by numeric release ID; release title/notes/package compatibility; final asset digests; partial-publication handling; and Immutable Releases guidance.

## Child B — Live GitHub E2E Safety

`docs/superpowers/specs/2026-08-30-live-github-e2e-safety-design.md`

Owns CI precompiled E2E artifact production; fresh-runner/no-checkout credentialed execution; `github-e2e` environment restriction; mandatory pinned numeric target ID; target-only credential; same-attempt qualification receipt before target mutation; canonical target/default-branch/ref-capability checks; shared target-safety helper; fail-closed independent cleanup; and local/manual safety.

## Child C — Publication Race and Conflict Recovery

`docs/superpowers/specs/2026-08-30-publication-race-and-conflict-recovery-design.md`

Owns typed publication races; reconciliation as classification authority; explicit indeterminate evidence for traversal limits/read failures; concurrent empty initialization; remote-appears-after-speculative-config race; existing runtime/E2E retry compatibility; terminal retry UX; actual multi-descendant folder-event regressions; Copy + race + recovery-store evidence; and no broad causality changes without failing regression.

## Child D — Immutable Git Read Fallback

`docs/superpowers/specs/2026-08-30-immutable-git-read-fallback-design.md`

Owns path-directed non-recursive immutable traversal; explicit complete-evidence/truncation rules; malformed-tree evidence; managed-path symlink/gitlink policy; no retained tree cache; and fallback scaling regressions.

---

# 2. Dependency Order

```text
Live E2E Safety
        ↓
Release Provenance and Versioning
        ↓
Publication Race and Conflict Recovery
        ↓
Immutable Git Read Fallback
```

This is acyclic: Child B first adds the CI `github-e2e-input` producer/consumer contract; Child A later adds independent CI `release-input` production and Stable Release promotion.

Stable Release depends on trustworthy current live qualification. Sync/recovery becomes independent after qualification infrastructure is hardened. Immutable-read fallback remains independent and last.

---

# 3. CI Producer Boundary

Ordinary `ci.yml` on push to `master` is the only workflow that compiles/builds artifacts later consumed under privileged credentials.

CI remains repository read-only and may produce:

```text
github-e2e-input-<SHA>-<CI_RUN_ID>-<CI_ATTEMPT>
release-input-<SHA>-<CI_RUN_ID>-<CI_ATTEMPT>
```

Each binds repository ID, source SHA, producer run ID/current attempt, fixed entry allowlist, sizes, and SHA-256 values.

Artifacts are validated before upload and treated as untrusted data when consumed later. Privileged workflows never rebuild them.

---

# 4. GitHub Actions Trust Boundary

## External actions

Every external `uses:` reference in repository workflows is pinned to a verified full-length commit SHA. A feasibility/static contract rejects mutable external action refs. Repository-wide full-SHA policy may be enabled after every workflow satisfies the rule.

## Environments

`github-e2e` and `stable-release` use **Selected branches and tags**, allowing branch `master` and no tags. Do not use `Protected branches only` while this repository has no protected branch rule.

Workflow runtime checks still require `GITHUB_REF == refs/heads/master`; environment policy is independent defense.

## Credentials

Stable Release default `GITHUB_TOKEN` remains read-only. Tag/release state requiring publication authority is handled only in the no-code `publish` job with the environment-scoped source-repository publication credential.

Live E2E target credential exists only in `github-e2e` and its mutable scope is limited to the pinned disposable target repository.

These controls do not claim protection against an authorized maintainer/admin intentionally changing trusted `master` and environment configuration.

---

# 5. Qualification Authority and Reruns

For CI and live E2E, authority starts with the **newest matching exact-SHA run**, not the newest successful run and not any historical success.

If that newest matching run is queued, running, cancelled, or failed, qualification blocks rather than falling back.

The **current/latest workflow attempt** is the only attempt considered release-qualifying:

```text
CI current attempt:
  verify executed + completed/successful
  current CI artifacts bind to this attempt

Live current attempt:
  qualify executed + completed/successful
  same-attempt receipt present/valid
  cleanup executed + completed/successful
```

Success is never synthesized by mixing jobs/artifacts from older and newer attempts.

A cleanup-only partial rerun may be operationally useful, but it is not release-qualifying. To restore qualification after cleanup failure, rerun all jobs so one new attempt contains qualification, receipt, scenario execution, and cleanup together.

This rule intentionally avoids dependence on undocumented cross-attempt artifact/job-output behavior.

If current CI producer changes, old live qualification becomes stale and must be repeated.

---

# 6. Cross-Cutting Invariants

- Exact `master` commit SHA is release source identity.
- Numeric repository IDs are workflow/test safety identities only; they do not replace V4 `owner/repo#branch` protocol identity.
- V4 repository rename/case migration remains separate because it affects crypto/recovery namespaces.
- GitHub ref mutation is not server-side compare-and-swap merely because local code accepts expected SHA.
- Copy remains local-primary with remote competitor preserved exactly once when a remote body exists.
- Ambiguous namespace, incomplete ancestry evidence, malformed tree evidence, missing same-attempt provenance receipt, or uncertain privilege evidence fails closed.
- Recovery/stage lifecycle assertions remain recovery-tier tests.
- No Git-tree cache without profiling + bounded resource design.
- No watcher-noise behavior without production-relevant deterministic evidence.
- `scripts/zip-source.mjs` remains separate maintenance work; stable release packaging is independently validated.

---

# 7. Release-Readiness Gate

Final release eligibility requires final `master` SHA to have:

```text
newest exact-SHA ordinary CI push run: current attempt verify successful
current CI release artifact: valid/current-attempt
current CI E2E bundle artifact: valid/current-attempt
newest exact-SHA live run: current attempt qualify + cleanup successful
same current live attempt receipt: valid and bound to current CI E2E input
Stable Release input version: canonical/current
master still exact qualified SHA at mutation/publication boundaries
```

Any later `master` commit invalidates qualification. Any newer matching exact-SHA CI/live run or newer workflow attempt becomes new authority.

---

# 8. Deferred Work

Separate designs remain for V4 repository rename/case migration; physical Windows/Android qualification; multi-gigabyte stress qualification; bounded immutable-tree caching if profiling justifies it; watcher-noise hardening backed by evidence; `scripts/zip-source.mjs` portability repair; and stronger repository governance/branch protection if desired.

---

# 9. Superpowers Gate

Each child design must be written/committed, self-reviewed, user-approved, converted to its own `writing-plans` implementation plan, then implemented/tested/reviewed independently.

No implementation plan combines all children into one mega-plan.