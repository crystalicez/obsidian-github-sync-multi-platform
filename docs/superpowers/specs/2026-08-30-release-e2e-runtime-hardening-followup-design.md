# Release, E2E, Runtime, and Immutable-Read Hardening — Umbrella Design

## Status

Umbrella architecture approved on 2026-08-30 for repository baseline `35e98cea924702293bde62d064a83d52eca6d898`.

This document replaces the earlier monolithic follow-up draft as the architecture/decomposition authority. It refines, but does not rewrite, the historical hardening design in `docs/superpowers/specs/2026-08-24-release-and-e2e-hardening-design.md`.

The approved architecture is intentionally decomposed into four independently reviewable child designs. No production implementation starts from this umbrella document alone.

## Goal

Close the remaining release-safety, live-E2E isolation, publication-race/recovery, and immutable-read gaps without broad V4 rewrites or speculative optimization.

The design follows five principles:

1. **Promote tested bytes rather than rebuilding during release.**
2. **Keep destructive credentials out of build/tooling processes.**
3. **Classify races from observed Git state rather than error wording.**
4. **Add missing correctness evidence before touching V4 causality.**
5. **Fix known scaling hazards without speculative caches.**

## Decomposition

### Child A — Release Provenance and Versioning

`docs/superpowers/specs/2026-08-30-release-provenance-and-versioning-design.md`

Owns:

- build-once CI artifact production,
- exact workflow-run + run-attempt provenance,
- Stable Release read/write privilege separation,
- untrusted-artifact handling in the write-capable job,
- exact-SHA CI and live-E2E qualification,
- qualification revalidation before mutation/publication,
- explicit exact-SHA tag creation,
- draft release publication by release ID,
- release asset digest verification,
- partial-publication handling,
- canonical stable-version parsing/comparison/history,
- Immutable Releases guidance.

### Child B — Live GitHub E2E Safety

`docs/superpowers/specs/2026-08-30-live-github-e2e-safety-design.md`

Owns:

- step-scoped destructive credentials,
- precompile-without-secret execution,
- immutable numeric target-repository identity checks,
- canonical target name + actual default-branch checks,
- shared destructive-safety helpers across live E2E suites,
- cleanup identity binding,
- Git-ref capability probes before interpreting 404 as absence,
- safe manual cleanup/runbook behavior,
- release-qualifying credential-scope requirements.

### Child C — Publication Race and Conflict Recovery

`docs/superpowers/specs/2026-08-30-publication-race-and-conflict-recovery-design.md`

Owns:

- `V4PublicationRaceError`,
- publication reconciliation as the race-classification authority,
- concurrent empty-repository initialization races,
- preservation of current runtime and E2E retry semantics,
- terminal user-facing retry failure UX,
- multi-descendant folder rename/delete conflict regressions,
- exact folder-event exercise rather than file-event simulation,
- Copy + publication-race + recovery-store integration evidence,
- no broad causality changes unless a deterministic regression fails.

### Child D — Immutable Git Read Fallback

`docs/superpowers/specs/2026-08-30-immutable-git-read-fallback-design.md`

Owns:

- path-directed non-recursive immutable tree traversal,
- fail-closed truncated-tree semantics,
- safe handling of trees, gitlinks, symlinks, and unsupported modes,
- no unbounded tree cache,
- exact fallback regressions and scaling contract.

## Approved Dependency Order

Implementation planning and execution should proceed in this order:

```text
Live E2E Safety
        ↓
Release Provenance and Versioning
        ↓
Publication Race and Conflict Recovery
        ↓
Immutable Git Read Fallback
```

Rationale:

- Stable Release depends on trustworthy live-E2E qualification.
- Release hardening should be complete before declaring any subsequent implementation release-ready.
- Sync publication/recovery changes are logically independent of release infrastructure after qualification contracts are fixed.
- Immutable-read fallback is independent and can be implemented last without blocking the safety boundaries above.

The implementation order may be changed only if a child spec explicitly documents a new dependency discovered during planning.

## Cross-Cutting Invariants

The following remain authoritative across all child specs:

- `master` exact commit SHA, not a mutable branch label alone, is the release source identity.
- Numeric GitHub repository IDs are workflow/test safety identities only; they do not replace the existing V4 protocol `repoId` (`owner/repo#branch`).
- V4 `repoId` migration after repository rename/casing change is deferred because it affects encryption/key derivation and recovery namespaces.
- GitHub branch ref mutation is not treated as server-side compare-and-swap merely because local code accepts an expected SHA argument.
- Copy conflict semantics remain local-primary with the remote competitor preserved exactly once when a remote body exists.
- Ambiguous namespace or incomplete evidence fails closed.
- Recovery/stage lifecycle assertions remain in the recovery test tier.
- No Git-tree cache is added without profiling evidence and an explicit bounded resource design.
- No watcher-noise/out-of-order behavior is added without a reproducible production-relevant sequence.
- `scripts/zip-source.mjs` portability repair remains separate maintenance work; release ZIP correctness is verified independently.

## Release-Readiness Gate Across Children

A final release is eligible only after all implemented child plans have completed and the final `master` SHA has:

```text
ordinary CI push run: success
CI verify job: success
live GitHub E2E run: success
live qualify job: success
live cleanup job: success
Stable Release input version: canonical and current
master still equal to the qualified SHA at publication time
```

Any later master commit invalidates previous exact-SHA qualification.

## Deferred Work

Separate future designs remain for:

- V4 repository-rename/case-change protocol migration,
- physical Windows/Android qualification expansion,
- multi-gigabyte stress/benchmark qualification,
- bounded immutable-tree caching if profiling justifies it,
- watcher-noise hardening backed by production evidence,
- `scripts/zip-source.mjs` portability repair.

## Superpowers Workflow Gate

This umbrella architecture is approved. Each child design must still be:

1. written and committed,
2. self-reviewed for placeholders, contradictions, scope, and ambiguity,
3. reviewed/approved by the user,
4. converted to its own implementation plan using `writing-plans`,
5. implemented and verified independently.

No implementation plan should combine all four child designs into one monolithic execution document.
