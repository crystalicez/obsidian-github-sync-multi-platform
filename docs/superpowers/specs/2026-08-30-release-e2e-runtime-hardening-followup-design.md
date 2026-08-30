# Release, E2E Isolation, and Runtime Hardening Follow-up Design

## Status

Follow-up design for the repository state at baseline commit `35e98cea924702293bde62d064a83d52eca6d898`.

This document refines the already-implemented and already-documented hardening work in `docs/superpowers/specs/2026-08-24-release-and-e2e-hardening-design.md`. It does not rewrite that historical design. Requirements from the earlier design remain in force unless this document explicitly narrows, strengthens, or replaces them.

## Goal

Close the remaining correctness and release-safety gaps found after the August 24 hardening work without broadly rewriting the V4 sync core.

The follow-up has six outcomes:

1. Stable release publication is bound to the exact qualified commit through explicit tag creation and verification rather than relying on `gh release create --target` after a long pre-publication window.
2. Credentialed live GitHub E2E qualification proves it is operating on the intended disposable repository by immutable repository identity, and cleanup cannot silently succeed against an inaccessible or changed target.
3. Missing folder-conflict and recovery/CAS regressions are added before any additional causality changes are considered.
4. Recoverable publication races are represented by typed evidence-based errors rather than English message matching in production or live-E2E retry logic.
5. Immutable commit reads recover from transient Contents 404s without recursively materializing an entire repository tree or treating truncated evidence as absence.
6. Stable version parsing/comparison is canonical and identical across helper, validator, release workflow, and tests.

## Non-goals

This follow-up does not:

- change the user-visible Copy conflict contract,
- redesign file identity or encrypted storage layout,
- rewrite `V4SyncSession`, planner, or coordinator without a new failing deterministic regression,
- add a general-purpose Git tree cache,
- add a new SemVer runtime dependency,
- invent watcher-noise behavior without a reproducible production-relevant sequence,
- repair `scripts/zip-source.mjs` as part of this hardening scope,
- claim GitHub provides a server-side compare-and-swap primitive for branch refs,
- claim a workflow can prevent a repository administrator from deliberately mutating repository state while that administrator retains write authority.

The source ZIP helper remains a separate maintenance item because stable publication currently packages with the system `zip` command directly.

## Existing behavior that remains authoritative

The following current behavior is deliberately preserved unless a new regression proves it wrong:

- Copy policy is local-primary / remote-conflict-copy.
- Normal sync automatically replans bounded recoverable publication races.
- Force Push and Force Pull do not silently inherit Normal-sync retry semantics unless explicitly justified by their existing recovery contract.
- Case-insensitive/NFC namespace ambiguity fails closed rather than selecting a winning identity.
- Rescan may collapse redundant content-only modifications but must retain identity-breaking causal information.
- Conflict-copy identity and run state remain stable across a single logical runtime operation.
- Live GitHub E2E uses a unique disposable branch derived from the workflow run ID.
- Exact-SHA workflow/job metadata, not an uploaded audit artifact, is the authority for live qualification.

---

# 1. Stable Release Publication Safety

## 1.1 Problem

The current stable release workflow checks early that the requested numeric tag and release do not exist, then runs qualification checks, dependency installation, build, tests, package validation, and packaging. Publication finally calls:

```text
gh release create VERSION --target GITHUB_SHA ...
```

This leaves a time-of-check/time-of-use window. Another actor with repository write permission can create the same tag after the initial check. When a matching tag already exists, `--target` no longer gives the workflow the intended create-this-tag-at-this-SHA authority.

The release invariant must therefore be expressed through repository state that the workflow itself creates and verifies immediately before publication.

## 1.2 Publication state machine

The stable release workflow becomes an explicit state machine:

```text
validate metadata and requested version
        ↓
require exact-SHA live qualification
        ↓
install/build/all deterministic gates
        ↓
package release assets
        ↓
re-read current master; require master == GITHUB_SHA
        ↓
create refs/tags/VERSION -> GITHUB_SHA using create-only Git refs API
        ↓
read refs/tags/VERSION; require object SHA == GITHUB_SHA
        ↓
create a draft release for the existing verified tag
        ↓
upload/attach all final assets while release is draft
        ↓
re-read tag; require object SHA == GITHUB_SHA
        ↓
publish the draft release
        ↓
read published release and tag; verify final association and asset set
```

The mutation boundary moves as late as practical: all deterministic gates and asset construction occur before tag creation.

## 1.3 Tag creation semantics

The workflow must create `refs/tags/$VERSION` explicitly through GitHub's Git refs API with `GITHUB_SHA` as the target. The operation is create-only; if the ref already exists, publication fails closed.

After creation, the workflow must read the exact tag ref from GitHub and require both that it is the expected lightweight ref shape and that the observed object SHA equals `GITHUB_SHA`.

The workflow must not treat `gh release create --target "$GITHUB_SHA"` as the mechanism that binds publication to the qualified commit.

## 1.4 Draft release semantics

The release is created against the already-existing verified tag as a draft. Assets are attached while the release remains draft. Immediately before publication, the tag is read and verified again.

The final publish operation then makes the prepared draft public. The workflow must verify the resulting release state rather than assuming a successful command is sufficient. Final verification requires at least:

- release tag name is exactly `VERSION`,
- release is no longer a draft,
- exact tag ref still resolves to `GITHUB_SHA`,
- expected release assets are present: packaged plugin ZIP, `main.js`, `manifest.json`, and `styles.css`.

This ordering reduces the interval in which a partially prepared public release can exist and makes the final state observable rather than inferred from a CLI exit code.

## 1.5 Partial failure behavior

Tag creation, draft creation, asset upload, and release publication are not one cross-resource transaction.

The workflow must never automatically delete a tag or release solely because a later publication step failed. On a retry, any conflicting tag or release causes a fail-closed result until a maintainer inspects repository state.

The release runbook must document the expected partial states:

- tag exists, no release,
- tag exists, draft release exists,
- tag exists, published release exists but workflow verification failed,
- release asset upload failed before publication.

Recovery remains an explicit maintainer action after inspection.

## 1.6 Immutable Releases operational hardening

If GitHub Immutable Releases is available for the repository, repository configuration should enable it before stable publication is considered fully supply-chain hardened.

The workflow must not claim that its own pre-publication checks make the tag mathematically immutable. The workflow can prevent accidental concurrent tag creation through create-only ref semantics and can repeatedly verify the tag, but an administrator with sufficient repository authority remains outside the workflow's trust boundary until platform-level immutable-release protections take effect.

The runbook should distinguish:

- workflow-level exact-SHA binding before publication,
- platform-level post-publication immutability when the repository setting is enabled.

## 1.7 Workflow contract tests

Add a feasibility-tier workflow contract test that reads `.github/workflows/release.yml` as text and checks semantic ordering without depending on exact whitespace.

Required contract markers:

- final master recheck appears after all deterministic gates,
- explicit create-only tag creation appears after the final master recheck,
- exact tag-SHA verification appears after tag creation,
- release creation uses the already-existing tag rather than relying on `--target`,
- release is prepared as a draft before publication,
- tag verification occurs again before publish,
- public publish occurs only after asset preparation,
- final release/tag/asset verification occurs after publication.

The test is a regression guard, not a YAML interpreter.

---

# 2. Live GitHub E2E Repository Isolation and Cleanup

## 2.1 Problem

The current qualification job protects the source repository with a case-sensitive string comparison:

```text
E2E_OWNER/E2E_REPO != GITHUB_REPOSITORY
```

GitHub repository names are not an immutable security identity. Different capitalization resolves to the same repository, and names may change over time.

The cleanup job also treats a branch GET returning 404 as success without first proving that the E2E token can resolve the intended repository. A 404 alone is insufficient evidence that the branch is absent because inaccessible repository state can also surface as not found.

## 2.2 Repository identity contract

Before destructive E2E work, a dedicated qualification guard step must resolve the target repository using `E2E_TOKEN` and record at least:

- immutable numeric repository ID,
- canonical full name,
- default branch.

The source repository identity is `github.repository_id` / `GITHUB_REPOSITORY_ID`.

Qualification fails before destructive work unless:

```text
target repository resolves successfully
AND target repository ID != source repository ID
AND generated E2E branch != target default branch
AND generated E2E branch matches the disposable branch contract
```

The canonical target repository ID becomes the authority; lowercased owner/name comparison is not a fallback.

The guard step must write the verified target repository ID to a named step output, and the `qualify` job must map that value to a job output before the real E2E command can run. This ordering is an invariant: if the job output is unavailable, destructive E2E work must not have started.

## 2.3 Disposable branch contract

The live workflow continues to derive the branch internally:

```text
obsidian-sync-e2e/run-${GITHUB_RUN_ID}
```

There is no workflow input that allows a caller to substitute an arbitrary branch.

The qualification job verifies the derived branch name before invoking the real GitHub E2E runner.

The branch must not equal the resolved target repository's default branch, even if that default branch uses a nonstandard name such as `trunk`.

## 2.4 Binding qualify and cleanup to the same repository

The qualification job exposes the verified target repository ID as a job output produced before destructive work.

The cleanup job must independently resolve `E2E_OWNER/E2E_REPO` using the cleanup token/environment before issuing any branch deletion. Cleanup then requires:

```text
qualify target repository ID is non-empty
AND resolved cleanup target ID == qualify target repository ID
AND resolved cleanup target ID != source repository ID
AND cleanup branch == obsidian-sync-e2e/run-${GITHUB_RUN_ID}
AND cleanup branch != current target default branch
```

If the qualify target ID is absent, cleanup must not delete anything and must fail closed. By construction, an absent ID means qualification was not permitted to begin destructive work.

If environment variables or repository names change between jobs, cleanup fails closed rather than deleting from a repository different from the one qualification used.

## 2.5 Cleanup 404 semantics

A branch 404 is accepted as "already absent" only after repository metadata has been resolved successfully and the repository identity checks above have passed.

The sequence is therefore:

```text
resolve repository metadata successfully
        ↓
verify repository identity/default-branch/branch-contract invariants
        ↓
GET exact disposable branch
        ↓
404 => success: expected repository is reachable and branch is absent
200 => attempt deletion
other/unresolved => failure, not absence
```

After DELETE, cleanup re-GETs the exact disposable branch. Success requires 404 against the already-verified repository identity.

Bounded cleanup retries remain three attempts.

## 2.6 Local manual E2E runner

The local manual runner may retain conservative name-based forbidden-branch checks as defense in depth, but it should also reject the resolved target repository's actual default branch when target metadata can be queried.

The live Actions workflow remains the authoritative release qualification boundary because it can compare the target repository ID against the known source repository ID.

## 2.7 Workflow contract tests

The feasibility workflow contract test must also cover `.github/workflows/github-e2e-live.yml`.

Required semantic markers:

- repository metadata resolution occurs before the real E2E command,
- numeric repository ID is compared with the source repository ID,
- target default branch is checked,
- disposable branch pattern is checked,
- verified target repository ID is exposed before destructive work,
- qualify exposes target repository identity to cleanup,
- cleanup rejects an absent qualify target ID,
- cleanup re-resolves repository metadata,
- cleanup verifies the resolved repository ID before DELETE,
- branch 404 is interpreted only after repository resolution/identity verification.

---

# 3. Missing Correctness Evidence Before More Core Changes

## 3.1 Production-code rule

The V4 core must not be changed merely because a scenario appears theoretically difficult.

For each new scenario:

```text
write deterministic regression with explicit expected user-visible behavior
        ↓
run it against current production code
        ↓
PASS => keep production code unchanged
FAIL => preserve failing regression, implement smallest fix, rerun affected + full gates
```

This rule applies especially to `causalIdentityState`, planner namespace logic, coordinator event coalescing, and conflict-copy staging.

## 3.2 Folder conflict matrix

Add deterministic folder scenarios required by the existing hardening design but not yet proven at the desired integration depth. The expected outcomes are explicit so the implementation must not invent a second folder-specific policy.

### 3.2.1 Remote folder rename versus stale local descendant edit

Starting from `folder/note.md`, device A renames `folder -> moved` and publishes. Stale device B edits `folder/note.md` and then performs Normal sync under Copy policy.

Expected result on B and a fresh converged device:

- B's edited lineage remains canonical at `folder/note.md`,
- canonical file keeps the original logical identity,
- A's remotely renamed version is preserved exactly once as a conflict copy derived from the remote final path `moved/note.md`,
- conflict copy receives a distinct logical identity,
- there is no extra live canonical `moved/note.md` in addition to that preserved copy,
- no unrelated path is overwritten.

This is the folder analogue of the existing remote-rename versus stale-local-edit contract.

### 3.2.2 Remote folder delete versus stale local descendant edit

Starting from `folder/note.md`, device A deletes the folder and publishes. Stale B edits the existing `folder/note.md` lineage and syncs.

Expected result:

- edited local file remains canonical at `folder/note.md`,
- original logical identity remains canonical,
- remote deletion is overridden by local-primary Copy semantics for that edited lineage,
- no meaningless conflict copy is created for the absent remote body,
- fresh-device convergence sees the canonical edited file and no duplicate.

### 3.2.3 Remote folder delete versus stale local descendant recreate

Starting from `folder/note.md`, device A deletes the folder and publishes. On stale B, the original descendant is deleted and a new file is recreated at the same logical path before sync.

Expected result:

- recreated local file remains canonical at `folder/note.md`,
- recreated file has a new logical identity rather than resurrecting the deleted original identity,
- original identity remains deleted,
- remote deletion has no body to preserve as a conflict copy,
- exactly one live canonical file exists at that path after convergence.

This scenario specifically guards identity discontinuity across delete/recreate.

### 3.2.4 Nested remote folder rename chain versus stale descendant edit

Starting from `folder/note.md`, device A publishes `folder -> middle -> final` while B remains stale and edits `folder/note.md`.

Expected result follows the same local-primary rename conflict rule:

- B's stale edited original lineage remains canonical at `folder/note.md` with its original identity,
- the remote lineage at its final path `final/note.md` is preserved exactly once as a conflict copy derived from that final remote path,
- the preserved copy has a distinct identity,
- no intermediate `middle/note.md` survives,
- no duplicate conflict copies are produced.

### 3.2.5 Case-only folder rename without a competing identity

For a one-sided folder rename such as `Folder -> folder` where no different identity occupies the normalized namespace:

- the rename remains a single logical lineage,
- descendant file identities are preserved,
- exactly one normalized logical path exists after convergence,
- no conflict copy is created solely because casing changed.

If a different identity already occupies the normalized destination namespace, the operation is governed by the existing collision rule and must fail before mutation rather than merging identities.

### 3.2.6 NFC-equivalent folder destination collision

When different logical identities would occupy folder/file paths that normalize to the same NFC + lowercase namespace key:

- Normal sync fails before local or remote mutation,
- the error clearly identifies a namespace collision,
- neither identity is silently selected as the winner,
- no conflict copy is used to evade the namespace invariant.

All folder assertions must cover exact live path set, bytes, canonical/conflict-copy role, conflict-copy count, identity continuity/discontinuity, no unrelated overwrite, and fresh-device convergence when the scenario yields a valid final state.

## 3.3 Fast runtime retry regression

Keep a fast deterministic runtime test proving:

- a Normal sync encounters a real simulated branch-head race,
- one user action automatically replans,
- progress exposes a retry attempt,
- final runtime lifecycle is success,
- no duplicate conflict copy appears for the simple retry case.

This test is about user flow, not recovery-store internals.

## 3.4 Recovery-tier Copy + CAS + stage integration

Add a recovery-tier integration test for the harder boundary:

```text
shared base
→ local edit + remote edit under Copy policy
→ remote conflict copy is staged
→ publication race invalidates first candidate
→ runtime/session recovery replans
→ exactly one logical conflict copy survives
→ final index/recovery state commits cleanly
```

The test must assert:

- local canonical bytes remain canonical under the current Copy policy,
- remote competing bytes are preserved exactly once,
- conflict-copy logical identity is stable across attempts within one logical run,
- stale stage references are not reused after they are invalid,
- no duplicate conflict-copy filename is materialized,
- recovery state reaches the expected committed/cleared boundary,
- final remote/index state agrees.

Recovery-store and stage-lifetime assertions belong in `tests/recovery/`, not the ordinary fast tier.

---

# 4. Typed, Evidence-based Publication Races

## 4.1 Problem

Production runtime and the current real-GitHub copy-contract E2E wrapper classify recoverable publication races by matching English error messages such as `branch head changed` or `stale ref`.

This makes retry behavior depend on wording instead of the state transition that actually makes a retry safe.

## 4.2 Error type

Introduce a V4-specific error representing an observed recoverable publication race. The type should carry structured evidence useful for diagnostics, for example:

```ts
export class V4PublicationRaceError extends Error {
  readonly code = "V4_PUBLICATION_RACE"
  constructor(
    readonly phase: "pre-publish" | "post-mutation-failure" | "reconcile",
    readonly expectedHeadSha: string | null,
    readonly observedHeadSha: string | null,
    message = "V4 publication race requires replanning.",
  ) {
    super(message)
    this.name = "V4PublicationRaceError"
  }
}
```

The exact file location should follow the existing Git publication boundary so `git-tree-writer`, runtime, recovery tests, and live E2E can depend on one stable type without introducing a circular dependency.

The structured fields are diagnostic evidence; retry decisions depend on the type, not the message text.

## 4.3 Evidence rules

A publication race is typed only when the system has state evidence.

Examples that qualify:

- expected branch head differs from the branch head observed immediately before candidate publication,
- ref publication fails and an immediate re-read proves current head no longer equals the candidate's expected head,
- publish reconciliation reports `published-advanced`,
- publish reconciliation reports `diverged` from the expected publication lineage.

An arbitrary transport/API error whose message contains `stale ref` is not sufficient.

If a mutation fails and the branch head still equals the expected head, preserve the original error/recovery classification rather than inventing a publication race.

Unknown mutation outcomes continue to follow the existing evidence-based mutation/reconciliation policy before they are converted into a replan decision.

## 4.4 Runtime consumer

Normal runtime retry becomes type-driven:

```text
V4PublicationRaceError
OR Normal-operation V4RecoveryReplanRequiredError
→ bounded replan/retry
```

The three-attempt bound remains unchanged unless a test demonstrates that the existing bound itself is insufficient.

Force Push/Force Pull retry behavior remains governed by their existing explicit logic; this refactor must not broaden it accidentally.

## 4.5 Live E2E consumer

The retry wrapper in `tests/github-e2e/v4-copy-contract-github-e2e.test.ts` must use the same `V4PublicationRaceError` classification rather than keeping an independent regex contract.

The wrapper may continue to clear conflict-copy stage references between attempts because the harness does not have production recovery-store lifecycle wiring. That harness-specific cleanup is separate from publication-race classification.

## 4.6 Tests

Required deterministic tests:

- typed race retries,
- typed race remains retryable if its human-readable message changes,
- generic `new Error("stale ref")` does not retry by itself,
- observed expected-vs-current ref mismatch yields `V4PublicationRaceError` with expected/observed SHA evidence,
- non-race API failure with unchanged head propagates,
- retry bound remains three attempts,
- force-operation behavior is unchanged,
- live-E2E compile tests remain valid after importing the shared type.

---

# 5. Immutable Commit Read Fallback Without Recursive Whole-tree Fetches

## 5.1 Problem

For an immutable 40-hex commit SHA, a Contents API 404 is currently verified by loading the commit's full recursive Git tree and looking for the path.

That is correctness-safe when the recursive tree is complete, but it scales poorly and GitHub may truncate large recursive-tree responses. A transient Contents 404 for a real file can therefore become a safe-but-unnecessary sync failure on a sufficiently large repository.

## 5.2 Path-directed traversal

Replace the recursive fallback with non-recursive traversal of the requested path.

For path `a/b/c.md`:

```text
get immutable commit -> root tree SHA
GET root tree non-recursive
find entry "a" and require tree
GET tree(a) non-recursive
find entry "b" and require tree
GET tree(b) non-recursive
find entry "c.md" and require blob
GET blob
```

The helper returns the exact blob bytes and SHA when found.

## 5.3 Fail-closed truncation rule

At every non-recursive tree level:

- if the requested segment is present, follow it,
- if the requested segment is absent and `truncated == false`, the immutable path is confirmed absent and the helper may return `null`,
- if the requested segment is absent and `truncated == true`, the helper must throw because absence has not been proven.

A tree where the final path segment resolves to a tree rather than a blob confirms that the requested file path is not a blob and returns `null` only when the containing tree response itself is complete.

Unexpected Git tree/blob errors propagate; they are not converted to file absence.

## 5.4 No speculative tree cache

Do not add an unbounded `Map<string, GitHubTree>` or similar cache in this follow-up.

The repository already has explicit resource controllers and bounded byte caches for mobile/resource discipline. Immutable Contents-404 verification is a fallback path, so memory should remain bounded until profiling shows repeated path traversal is a real bottleneck.

If future profiling justifies caching, it requires a separate bounded-cache design with explicit resource accounting.

## 5.5 Tests

Extend immutable-read fallback tests with:

- root-level blob,
- nested path traversal,
- missing intermediate directory with complete tree => null,
- missing final blob with complete tree => null,
- absent segment in truncated tree => throw,
- final segment is a tree => null when evidence is complete,
- unexpected tree request failure => propagate,
- transient Contents 404 + exact tree path exists => recover bytes,
- no fallback request uses `recursive=1`.

---

# 6. Canonical Stable Version Contract

## 6.1 Shared stable-version grammar

All release tooling accepts canonical stable `x.y.z` only:

```text
^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$
```

Examples rejected:

```text
01.2.3
1.02.3
1.2.03
1.2
1.2.3-beta
```

This follow-up does not add prerelease SemVer support.

## 6.2 Comparison and highest published version

Numeric version components are compared without JavaScript `Number` precision loss. Use `BigInt` or an equivalent dependency-free exact integer comparison.

The same canonical grammar/comparison semantics must apply to:

- `scripts/update-version.js`,
- `scripts/validate-package.mjs`,
- `.github/workflows/release.yml`,
- release metadata regression tests,
- release workflow contract tests where appropriate.

The release workflow must not keep a permissive regex or `Number` comparison after the scripts are hardened.

The workflow must also avoid making `sort -V` the authority for selecting the highest published stable tag. It should enumerate candidate tags, discard non-canonical stable versions, and compute the maximum with the same exact component comparator used for monotonic validation. This prevents the workflow from having a second subtly different version-ordering implementation.

## 6.3 Version helper user flow

The supported documented interface remains:

```text
pnpm ver -- patch
pnpm ver -- minor
pnpm ver -- major
pnpm ver -- x.y.z
NEW_VERSION=x.y.z pnpm ver
```

Single-letter aliases are not a correctness blocker. Their removal is optional cleanup and should not be coupled to the release-safety patch unless explicitly chosen during implementation review.

## 6.4 Tests

Add positive tests for:

- patch,
- minor,
- major,
- explicit canonical target.

Add negative tests for:

- leading-zero components,
- malformed target,
- equal/lower target,
- duplicate `versions.json` key,
- large components beyond IEEE-754 exact integer range,
- inconsistent package/manifest metadata,
- non-canonical historical tags being ignored by the stable-tag maximum calculation.

A validation failure must occur before metadata writes.

---

# 7. Test Tiers and Verification Gates

## 7.1 Test placement

Use the repository's existing tier semantics:

- workflow/tooling contract tests: `tests/feasibility/`,
- ordinary deterministic sync/user-flow tests: fast tier under `tests/v4/`,
- crash/recovery/stage-lifetime tests: `tests/recovery/`,
- real credentialed GitHub tests: `tests/github-e2e/` and the live workflow.

Do not move recovery-store behavior into fast tests merely to make the implementation plan look smaller.

## 7.2 Per-batch TDD

Every production change follows:

```text
write failing regression
run focused test and confirm expected failure
implement smallest change
run focused test and confirm pass
run affected tier
commit
```

A refactor whose intended regression already passes must not be justified as a correctness fix unless the refactor removes a separately demonstrated maintenance hazard such as message-based retry classification.

## 7.3 Final deterministic gate

Before final merge/release qualification:

```text
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm test
corepack pnpm test:repeat
corepack pnpm test:recovery
corepack pnpm test:resource
corepack pnpm test:feasibility
corepack pnpm test:github-e2e:compile
corepack pnpm validate:package
```

The exact command spelling may use existing package scripts, but the set of gates remains equivalent.

## 7.4 Exact-SHA external evidence

After the final implementation is merged to `master`:

1. ordinary CI must succeed for the exact final master SHA,
2. GitHub E2E Live must be dispatched from `master` for that exact SHA,
3. job `qualify` must succeed,
4. job `cleanup` must succeed,
5. `master` must still point to the same SHA before Stable Release is dispatched.

A previously qualified SHA does not qualify a newer master tip.

---

# 8. Implementation Batches and Ordering

The implementation plan should use six reviewable batches. Each batch must leave the repository in an internally valid state and should be independently revertible where practical.

## Batch A — Publication safety

- add release workflow feasibility contracts,
- replace `--target` binding with explicit create-only tag ref,
- verify tag SHA,
- prepare release as draft with final assets,
- re-verify tag before publish,
- publish and verify final release/tag/asset state,
- update release runbook,
- document Immutable Releases as repository-level hardening rather than pretending workflow checks provide platform immutability.

## Batch B — Live-E2E isolation

- resolve target repository metadata with `E2E_TOKEN`,
- compare immutable target/source repository IDs,
- expose verified target ID before destructive work,
- enforce target default-branch exclusion and disposable branch pattern,
- pass qualified target repository ID to cleanup,
- cleanup rejects absent/mismatched target identity and re-resolves identity before DELETE,
- tighten 404 semantics,
- update E2E docs and workflow contracts.

## Batch C — Missing correctness evidence

- add explicit folder conflict matrix,
- retain/strengthen fast runtime retry user-flow coverage,
- add recovery-tier Copy + CAS + stage lifecycle integration,
- change production causality only if a new regression fails.

## Batch D — Typed publication races

- define shared publication-race error with structured expected/observed-head evidence at Git publication boundary,
- classify from observed Git state/reconciliation outcomes,
- remove message regex from production runtime,
- remove message regex from real-GitHub copy-contract retry wrapper,
- add positive and negative retry regressions.

## Batch E — Immutable-read scalability and canonical SemVer

- replace recursive immutable-tree fallback with path-directed non-recursive traversal,
- fail closed on truncated evidence at every level,
- add no cache,
- make stable-version grammar and exact comparison consistent across helper, validator, workflow, and tests,
- compute highest canonical stable tag with the same exact comparator rather than `sort -V` authority.

These two changes share no runtime behavior but are both bounded infrastructure hardening; the implementation plan may split them into separate commits/tasks inside Batch E for review clarity.

## Batch F — Final verification and qualification

- run all deterministic gates,
- push branch/PR,
- verify final diff against this spec,
- merge only after deterministic evidence is clean,
- require exact-final-SHA CI and live GitHub E2E evidence before release.

---

# 9. Long-term Design Rationale

## 9.1 Prefer identities over names

Repository IDs and exact commit SHAs are authorities. Owner/repository strings, branch labels, error messages, and human-readable release names are interfaces, not security/correctness identities.

## 9.2 Prefer evidence over inference

Retry only when Git state proves a race. Treat a truncated tree as unknown, not absent. Treat cleanup 404 as absence only after the repository itself is proven reachable and identical to the qualified target.

## 9.3 Prefer fail-closed boundaries over clever recovery

Release publication, E2E cleanup, namespace conflicts, and immutable reads must stop when evidence is ambiguous. Recovery can be retried explicitly after state is re-observed.

## 9.4 Keep the sync core stable

The current causality and conflict logic has already accumulated deterministic coverage. Additional theoretical complexity is not sufficient reason to rewrite it. New production logic must correspond to a demonstrated failing behavior or a clearly isolated maintenance hazard.

## 9.5 Optimize only measured hot paths

Path-directed immutable tree traversal removes a known whole-repository scaling hazard without introducing retained memory. A cache is deferred until measurement demonstrates repeated traversal cost matters in real workloads.

## 9.6 Keep maintenance scope reviewable

The source ZIP helper and speculative watcher-noise hardening are intentionally outside this plan. They should not increase the blast radius of release/runtime correctness work.

---

# 10. Acceptance Criteria

This follow-up is complete only when all of the following are true:

- Stable release no longer relies on `gh release create --target` to create/bind a missing tag after lengthy gates.
- Stable release explicitly creates the version tag at `GITHUB_SHA`, verifies it, prepares assets before public publication, verifies again before publish, and verifies final release/tag/asset state afterward.
- The release runbook accurately describes partial states and repository-level immutable-release hardening without overstating workflow atomicity.
- Live qualification rejects the source repository by numeric repository ID, not repository-name string comparison.
- Live qualification resolves and exposes the verified target repository ID before any destructive E2E work.
- Live qualification rejects the target repository's actual default branch and enforces the generated disposable branch contract.
- Cleanup is bound to the same target repository ID used by qualification and verifies that identity before any deletion.
- Cleanup refuses deletion when the qualified target repository ID is absent or mismatched.
- Cleanup does not treat an unauthenticated/unresolved repository 404 as evidence that a branch is absent.
- Folder conflict regressions cover the required stale descendant cases with the exact outcomes in this spec and either pass unchanged production code or precede the smallest demonstrated fix.
- Runtime and recovery tests prove one-action retry and exactly-once conflict-copy/recovery semantics at their correct test tiers.
- Retry classification no longer depends on `branch head changed|stale ref` message regex in either production runtime or the real-GitHub copy-contract harness.
- Generic errors containing the words `stale ref` do not become retryable without state evidence.
- Publication-race errors carry structured expected/observed ref evidence for diagnostics.
- Immutable Contents-404 verification does not request a recursive whole-repository tree and never converts truncated evidence to absence.
- No unbounded Git tree cache is introduced.
- Stable version grammar/comparison is canonical and consistent across scripts and release workflow, including values beyond JavaScript Number's exact integer range.
- Highest stable-tag selection uses the same canonical exact comparator and does not delegate version authority to `sort -V`.
- Full deterministic gates pass on the final implementation.
- Exact final master SHA has successful ordinary CI plus successful live `qualify` and `cleanup` jobs before Stable Release is considered eligible.

## Explicit deferred work

The following remain separate after this design:

- `scripts/zip-source.mjs` portability/format repair,
- speculative watcher-noise/out-of-order event handling without a reproducible regression,
- physical Windows/Android qualification,
- multi-gigabyte qualification/benchmarking,
- optional bounded Git tree caching if future profiling justifies it.
