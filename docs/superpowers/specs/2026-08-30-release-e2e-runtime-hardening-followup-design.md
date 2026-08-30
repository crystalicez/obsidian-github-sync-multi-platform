# Release, E2E Isolation, and Runtime Hardening Follow-up Design

## Status

Follow-up design for repository baseline `35e98cea924702293bde62d064a83d52eca6d898`.

This document refines `docs/superpowers/specs/2026-08-24-release-and-e2e-hardening-design.md`. The earlier design remains historical context; this document is the authoritative follow-up for the remaining gaps described here.

## Goal

Close the remaining release-safety, live-E2E isolation, retry-classification, immutable-read, versioning, and missing-regression gaps without broadly rewriting the V4 sync core.

The design deliberately separates:

- **release authority** from build/test execution,
- **destructive E2E credentials** from ordinary build steps,
- **observed Git races** from human-readable error strings,
- **missing correctness evidence** from speculative core refactors,
- **known scaling hazards** from speculative caching.

## Non-goals

This follow-up does not:

- change the user-visible Copy conflict contract,
- redesign V4 file identity or encrypted storage layout,
- rewrite planner/coordinator/session causality without a new failing deterministic regression,
- add a Git-tree cache,
- add a SemVer dependency,
- repair `scripts/zip-source.mjs`,
- invent watcher-noise behavior without a reproducible production-relevant sequence,
- claim GitHub branch refs provide server-side compare-and-swap,
- claim workflow checks can make repository state immutable against an administrator who retains write authority,
- migrate the V4 protocol `repoId` from `owner/repo#branch` to GitHub's numeric repository ID.

Numeric GitHub repository IDs are used in this design for **workflow safety boundaries only**. The current V4 protocol scopes encryption/key derivation and remote identity using its existing string `repoId`; changing that is a separate protocol/migration problem.

---

# 1. Stable Release Architecture

## 1.1 Problems in the current workflow

The current Stable Release workflow combines all of these responsibilities in one write-capable job:

1. checkout,
2. metadata validation,
3. qualification lookup,
4. dependency installation,
5. build and tests,
6. packaging,
7. tag/release mutation.

It also checks tag absence early, performs lengthy work, and finally relies on `gh release create --target GITHUB_SHA` to create/bind the tag. That creates a time-of-check/time-of-use window.

A second issue is credential blast radius. The release job grants `contents: write` for its full lifetime, and checkout currently persists the job token. Build/install/test code should not need repository write authority.

A third issue is policy/enforcement drift: the runbook and acceptance criteria require ordinary exact-SHA CI to pass, but Stable Release currently enforces only exact-SHA live E2E plus its own deterministic rerun.

## 1.2 Two-job authority model

Stable Release becomes two jobs with explicit least-privilege boundaries.

### Job `verify`

Permissions:

```text
actions: read
contents: read
```

Responsibilities:

- checkout exact `github.sha` with `persist-credentials: false`,
- require workflow ref `master`,
- validate requested canonical version and package metadata,
- require current `master == github.sha`,
- require successful ordinary **CI push run** for this exact SHA,
- require successful **GitHub E2E Live** run for this exact SHA with successful `qualify` and `cleanup` jobs,
- install with frozen pnpm lockfile,
- build,
- run fast/repeat/recovery/resource/feasibility gates,
- compile the real-GitHub E2E harness,
- validate package,
- package the exact release ZIP,
- create a release-input integrity manifest,
- upload one blocking release-input artifact for this same workflow run.

The release-input manifest records at least:

```text
schemaVersion
workflowRunId
repositoryId
commitSha
version
asset file names
asset byte sizes
asset SHA-256 values
```

Expected final assets remain:

```text
<plugin>-v<VERSION>.zip
main.js
manifest.json
styles.css
```

The verify job never creates a tag or release.

### Job `publish`

Dependencies:

```text
needs: verify
```

Permissions:

```text
actions: read
contents: write
```

The publish job must be deliberately small:

- no source checkout,
- no dependency installation,
- no package scripts,
- no repository build/test code,
- no third-party action required for publication.

It locates the release-input artifact created by `verify` from the **same workflow run** through GitHub's Actions artifact API. Artifact metadata must prove at least:

```text
artifact is not expired
artifact workflow_run.id == GITHUB_RUN_ID
artifact workflow_run.head_sha == GITHUB_SHA
artifact workflow_run.repository_id == GITHUB_REPOSITORY_ID
artifact name is the exact expected release-input artifact name
```

When the API exposes an artifact SHA-256 digest, the downloaded artifact archive must match that digest before extraction.

After extraction, the publish job verifies the embedded release-input manifest and recomputes every listed asset's size and SHA-256. The manifest's `workflowRunId`, `repositoryId`, `commitSha`, and `version` must match the current workflow context/input.

Only then may the write-capable job mutate repository state.

This is the primary credential-compartmentalization boundary: repository write authority is not present during dependency installation or repository code execution.

## 1.3 Exact-SHA CI qualification

Stable Release must enforce ordinary CI rather than relying on the runbook alone.

The `verify` job requires a completed successful `ci.yml` workflow run satisfying all of:

```text
event == push
head_branch == master
head_sha == GITHUB_SHA
conclusion == success
job "verify" == success
```

A PR-only, manually-dispatched, stale, skipped, or different-SHA run does not qualify.

Stable Release still reruns deterministic gates. CI qualification and release-time verification are intentionally redundant: the former proves the normal master pipeline passed; the latter proves the release inputs were regenerated and tested in the release workflow itself.

## 1.4 Exact-SHA live qualification

The `verify` job requires a completed successful `github-e2e-live.yml` run satisfying:

```text
event == workflow_dispatch
head_branch == master
head_sha == GITHUB_SHA
conclusion == success
job "qualify" == success
job "cleanup" == success
```

The best-effort audit artifact remains optional evidence and is not release authority.

## 1.5 Publication-time remote-state revalidation

The publish job must not trust repository state captured during checkout or at the beginning of `verify`.

Immediately before tag creation it re-reads **remote GitHub state** and requires:

```text
current master == GITHUB_SHA
requested version is still canonical
no conflicting version tag exists
no release, including authenticated-visible draft release state, uses the requested tag
requested version is greater than every currently observed canonical stable tag
```

Remote tag and release enumeration must cover all pages needed to establish these facts; first-page-only checks are insufficient as a long-term contract.

Highest-version calculation must use remote tag state observed at publication time, not only local checkout tags captured earlier.

The workflow must not claim the monotonic check is globally atomic across different tag names. An external administrator can create another higher version between the maximum-tag read and this workflow's tag creation. The workflow's create-only ref operation gives strong atomicity only for the **requested tag name**. Platform repository rules/administrator policy remain outside this workflow boundary.

## 1.6 Canonical publication state machine

After all verification and artifact checks:

```text
re-read master and remote publication state
        ↓
create refs/tags/VERSION -> GITHUB_SHA through create-only Git refs API
        ↓
read exact tag ref; require lightweight ref object type=commit and SHA == GITHUB_SHA
        ↓
create draft release for the existing verified tag
        ↓
attach the exact integrity-verified release-input assets
        ↓
verify draft tag name + expected complete asset set
        ↓
re-read exact tag ref; require SHA == GITHUB_SHA
        ↓
publish the draft
        ↓
verify release is public, tag name exact, tag SHA exact, asset names/sizes/digests exact
```

`gh release create --target "$GITHUB_SHA"` is no longer the mechanism that establishes tag authority.

A draft is preferred because asset preparation completes before the release becomes public.

For every final release asset, if GitHub's release asset API exposes a `sha256:` digest, it must equal the SHA-256 recorded in the release-input manifest. This closes the byte-integrity chain from the read-only verify job through the published release asset.

## 1.7 Partial publication failure

Tag creation, draft creation, asset upload, and release publication are not one transaction.

Never automatically delete repository state merely because a later step failed.

The runbook must cover at least:

- tag exists, no release,
- tag exists, draft release exists,
- draft exists with incomplete assets,
- release is public but workflow final verification failed.

A subsequent Stable Release run fails closed on conflicting state until a maintainer inspects it.

## 1.8 Immutable Releases

If GitHub Immutable Releases is available for this repository, enable it as repository-level supply-chain hardening before calling stable publication fully immutable.

The workflow guarantees exact-SHA observation and create-only requested-tag binding as far as its own trust boundary allows. Platform immutable-release protection is what prevents post-publication tag/asset mutation after it takes effect.

---

# 2. Live GitHub E2E Isolation and Credential Scope

## 2.1 Problems in the current workflow

Current live qualification:

- compares `owner/repo` strings to reject the source repository,
- places the destructive E2E token in job-level environment variables,
- allows checkout/setup/install/build/upload steps to run in the same job environment where that secret is defined,
- validates repository identity only in the workflow guard, while the runner continues to address the repository by mutable owner/name strings,
- lets cleanup treat branch 404 as success without first proving the intended repository identity is reachable.

## 2.2 Secret compartmentalization

`E2E_TOKEN` / `GITHUB_E2E_TOKEN` must not be job-level environment state in the qualification job.

Non-secret values may remain job-level:

```text
GITHUB_E2E_OWNER
GITHUB_E2E_REPO
GITHUB_E2E_BRANCH
```

The secret token is supplied only to steps that need target-repository access:

1. target-repository identity guard,
2. real GitHub E2E execution.

Checkout/setup/install/build/audit-upload steps do not receive the E2E token.

Cleanup similarly passes `E2E_TOKEN` only to its cleanup/verification step.

The workflow-level `GITHUB_TOKEN` remains read-only in live E2E qualification.

## 2.3 Target repository identity guard

Before destructive E2E work, resolve target metadata using `E2E_TOKEN` and record:

```text
id
full_name
default_branch
```

Require:

```text
target repository resolves successfully
target repository ID != GITHUB_REPOSITORY_ID
derived branch == obsidian-sync-e2e/run-${GITHUB_RUN_ID}
derived branch != target default branch
current source master == GITHUB_SHA
source ref == refs/heads/master
```

The verified target repository ID is exposed as a `qualify` job output **before** destructive E2E work starts.

If that output was never produced, destructive work must not have started.

## 2.4 Revalidation inside the destructive runner

Workflow validation alone is not sufficient because the runner ultimately sends requests using `owner/repo` strings.

The live workflow passes:

```text
GITHUB_E2E_EXPECTED_REPO_ID=<verified numeric ID>
```

to the real E2E step.

Before spawning destructive tests, `scripts/run-github-e2e.mjs` resolves target metadata again using the target token and requires:

```text
resolved ID == GITHUB_E2E_EXPECTED_REPO_ID
branch != resolved default_branch
branch matches the disposable branch contract
```

The runner then uses the resolved canonical `full_name` for child-process owner/repo environment values so capitalization/rename aliases do not become its primary identity.

Inside the real E2E suite, each scenario reset/delete boundary re-resolves repository metadata and, when `GITHUB_E2E_EXPECTED_REPO_ID` is present, requires that the ID still matches before deleting/resetting the branch.

The design does not require an identity API call before every Git blob/tree request. Revalidation is required at destructive reset boundaries; fine-grained token scope plus branch isolation provide the remaining defense in depth.

## 2.5 Cleanup binding

`cleanup` uses `needs.qualify.outputs.target_repo_id` as the identity established before destructive qualification.

Before DELETE, cleanup independently resolves current configured target metadata with the cleanup token and requires:

```text
qualified target ID is non-empty
resolved target ID == qualified target ID
resolved target ID != GITHUB_REPOSITORY_ID
branch == obsidian-sync-e2e/run-${GITHUB_RUN_ID}
branch != resolved default_branch
```

If the qualified ID is absent or mismatched, cleanup deletes nothing and fails closed.

This prevents configuration changes between `qualify` and `cleanup` from redirecting cleanup into a different repository.

## 2.6 Cleanup 404 semantics

404 means "branch absent" only after repository metadata has already resolved successfully and identity checks passed.

Required sequence:

```text
resolve repository metadata
        ↓
verify repository ID/default branch/branch contract
        ↓
GET exact disposable branch
        ↓
404 => already absent, success
200 => DELETE
other => failure
        ↓
GET exact disposable branch again
        ↓
404 => deletion verified
```

Retries remain bounded to three attempts.

Hard workflow cancellation can still prevent cleanup from running; unique run-derived branches isolate that residue.

## 2.7 Local manual E2E

The local runner always resolves target metadata before destructive execution and rejects the target repository's actual default branch.

Name blacklists such as `main/master/production` may remain as defense in depth but are not the authority.

Numeric source-repository comparison is authoritative only when an expected/source repository ID is available, as in the live qualification workflow.

---

# 3. Missing Core Correctness Evidence

## 3.1 Production-code rule

For causality/conflict scenarios:

```text
write deterministic expected-behavior regression
        ↓
run against current production
        ↓
PASS => no production change
FAIL => preserve regression + implement smallest fix
```

No broad V4 core refactor is justified by theoretical complexity alone.

## 3.2 Folder conflict matrix must be genuinely folder-shaped

A folder test containing only one descendant can accidentally prove only ordinary file-conflict semantics.

Each primary folder rename/delete scenario therefore starts with at least two descendants:

```text
folder/edited.md
folder/untouched.md
```

The stale device changes only `edited.md`; `untouched.md` remains unchanged locally. This proves mixed per-descendant outcomes from one folder operation.

### Remote folder rename vs stale edited descendant

Remote device renames `folder -> moved`.

Expected final result:

- stale local edited lineage stays canonical at `folder/edited.md`, preserving original identity,
- remote competing renamed `moved/edited.md` is preserved exactly once as a conflict copy derived from the remote final path, with a distinct identity,
- unchanged `folder/untouched.md` follows the one-sided remote rename to `moved/untouched.md`, preserving identity,
- no intermediate/duplicate paths survive.

### Remote folder delete vs stale edited descendant

Remote device deletes `folder`.

Expected final result:

- stale locally edited `folder/edited.md` remains canonical with original identity,
- no meaningless conflict copy is created for its absent remote body,
- locally unchanged `folder/untouched.md` is deleted because remote deletion is one-sided for that lineage,
- exactly the edited canonical lineage survives from that folder.

### Remote folder delete vs stale delete/recreate descendant

Remote deletes `folder`. Stale local deletes and recreates `folder/edited.md` before sync.

Expected:

- recreated `folder/edited.md` survives as canonical,
- recreated file has a new identity,
- original edited-file identity remains deleted,
- unchanged sibling follows remote deletion,
- no remote-body conflict copy is invented.

### Nested folder rename chain

Remote publishes `folder -> middle -> final`; stale local edits only `folder/edited.md`.

Expected:

- edited stale lineage remains canonical at original path,
- remote edited-lineage final path is preserved once as conflict copy derived from `final/edited.md`,
- untouched sibling ends at `final/untouched.md`, preserving identity,
- no `middle/*` paths survive.

### Case-only folder rename

One-sided `Folder -> folder`, with multiple descendants and no competing normalized identity:

- descendant identities remain stable,
- exactly one normalized path per descendant remains,
- no conflict copy occurs solely because of casing.

### NFC-equivalent destination collision

If different identities would occupy the same `NFC + lowercase` namespace:

- fail before local/remote mutation,
- identify the namespace collision clearly,
- do not choose a winner or evade the invariant using conflict-copy creation.

All folder tests assert exact path set, bytes, identity continuity/discontinuity, conflict-copy count, absence of unrelated overwrite, and fresh-device convergence when the resulting state is valid.

## 3.3 Runtime and recovery integration

Keep a fast user-flow test proving one sync action automatically retries a recoverable publication race and exposes progress attempt 2.

Add a recovery-tier integration covering:

```text
shared base
→ local edit + remote edit under Copy
→ conflict copy staged
→ first candidate publication races
→ replan/recovery
→ exactly one conflict copy
→ final index/recovery state committed
```

Recovery assertions include:

- local canonical bytes preserved,
- remote competitor preserved exactly once,
- conflict-copy logical identity stable within the logical run,
- invalid stale stage references are not reused,
- no duplicate conflict-copy path,
- recovery state reaches committed/cleared boundary,
- final remote/index state agrees.

Recovery-store/stage-lifetime assertions stay in `tests/recovery/` rather than bloating the fast tier.

---

# 4. Typed, Evidence-Based Publication Races

## 4.1 Existing behavior to preserve

The current runtime has two retry reasons:

1. branch-head/stale-ref message matches,
2. `V4RecoveryReplanRequiredError` for Normal sync.

The first path is currently **not restricted by `request.operation`**. Therefore this refactor must not silently change operation semantics.

Compatibility contract:

```text
V4PublicationRaceError
→ bounded runtime retry regardless of request.operation, preserving the current branch-race retry path; only operations that actually reach a publication race will observe it

V4RecoveryReplanRequiredError
→ retry only for Normal sync, as today
```

A future decision to change force-operation behavior is a separate UX/behavior change.

The retry bound remains three attempts.

## 4.2 Structured error

Introduce a shared publication-boundary error, for example:

```ts
export class V4PublicationRaceError extends Error {
  readonly code = "V4_PUBLICATION_RACE"
  constructor(
    readonly phase: "bootstrap" | "pre-publish" | "post-mutation-failure" | "reconcile",
    readonly expectedHeadSha: string | null,
    readonly observedHeadSha: string | null,
    readonly cause?: unknown,
    message = "V4 publication race requires replanning.",
  ) { ... }
}
```

Retry decisions depend on the type, not message text.

## 4.3 Evidence rules

Type a publication race only when Git state establishes that the operation's assumed publication base is stale or reconciliation establishes divergence/advance.

Evidence includes:

- pre-publish observed head != expected head,
- ref mutation fails and an immediate re-read shows observed head != expected head,
- reconciliation returns `published-advanced`,
- reconciliation returns `diverged`,
- concurrent empty-repository bootstrap/init mutation fails, then re-observation proves another writer created repository/ref state that invalidates the session's empty-remote assumption.

A generic `Error("stale ref")` is not retryable by wording alone.

If a normal ref mutation fails and the branch still equals the expected head, preserve the original failure classification rather than inventing a race.

Unknown mutation outcomes continue through the existing mutation-outcome reconciler first. Do not replace evidence-based reconciliation with generic retry.

A typed race created after another mutation error preserves the original error as `cause` for diagnostics.

## 4.4 Empty-repository bootstrap race

Two devices can observe a truly empty repository concurrently. One can create bootstrap/default ref state while the other still believes the remote is empty.

The losing device must **not** simply adopt the newly observed base inside the already-planned session, because Normal sync planning was computed under the empty-remote assumption.

Required behavior:

```text
bootstrap/init mutation fails
        ↓
re-observe repository/configured ref state
        ↓
new writer-created state is now present
        ↓
throw V4PublicationRaceError(phase="bootstrap", expected=null, observed=<new head>)
        ↓
runtime re-runs the whole operation from a fresh remote plan
```

This preserves correctness for Normal sync and preserves explicit Force Push semantics through the same bounded outer retry.

A bootstrap failure with no evidence of newly created remote/ref state remains the original error.

## 4.5 Consumers

Both of these use the same shared type:

- `V4PluginRuntime`,
- the retry wrapper in `tests/github-e2e/v4-copy-contract-github-e2e.test.ts`.

The E2E harness may keep harness-specific conflict-copy stage clearing between attempts because it does not model the full production recovery-store lifecycle.

## 4.6 Required tests

Cover at least:

- pre-publish mismatch produces typed race with expected/observed SHAs,
- mutation failure + changed head produces typed race and preserves cause,
- mutation failure + unchanged head propagates original failure,
- `published-advanced` and `diverged` produce typed race,
- typed race retries regardless of human-readable message,
- generic message containing `stale ref` does not retry,
- retry bound remains three,
- Force Push publication-race retry behavior is preserved,
- `V4RecoveryReplanRequiredError` remains Normal-only,
- concurrent empty-repository bootstrap race replans rather than continuing an empty-remote plan or failing solely on a definitive bootstrap response,
- bootstrap failure without changed remote/ref evidence remains non-race,
- live E2E bundles compile with the shared type.

---

# 5. Immutable Commit Read Fallback

## 5.1 Problem

An immutable commit-SHA Contents 404 currently falls back to a recursive whole-repository tree lookup. This is safe only when the recursive response is complete and scales poorly for large repositories.

## 5.2 Path-directed non-recursive traversal

For `a/b/c.md`:

```text
commit -> root tree
GET root tree non-recursive; locate a
GET tree(a) non-recursive; locate b
GET tree(b) non-recursive; locate c.md
GET exact blob
```

No fallback request uses `recursive=1`.

## 5.3 Evidence semantics

At each tree level:

- requested segment present with required type => follow it,
- segment absent and `truncated == false` => immutable path confirmed absent,
- segment absent and `truncated == true` => throw; absence is unknown,
- intermediate entry that is not a tree => requested nested file is absent,
- final entry must be a blob; a tree/gitlink/other non-blob final entry means this requested file path is not a blob when the containing response is complete,
- unexpected Git tree/blob errors propagate.

Git tree typing must not assume every entry is only `blob | tree`; Gitlink/submodule-style `commit` entries are handled safely if encountered.

## 5.4 No cache

Do not add an unbounded tree cache in this follow-up.

The fallback is rare, while this project explicitly manages mobile/resource limits. If profiling later proves repeated path traversal is material, design a bounded resource-accounted cache separately.

## 5.5 Tests

Cover:

- root blob,
- deep nested blob,
- missing intermediate/final segment with complete evidence => null,
- missing segment with truncated tree => throw,
- intermediate non-tree => null,
- final tree/gitlink/non-blob => null,
- unexpected tree failure propagates,
- transient Contents 404 + exact tree path exists => returns exact blob,
- no recursive-tree request.

---

# 6. Canonical Stable Version Contract

## 6.1 Grammar

Stable versions are canonical only:

```text
^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$
```

Reject leading-zero components, prereleases, incomplete versions, and malformed input.

## 6.2 Exact comparison

Use dependency-free exact integer comparison such as `BigInt` for all three components.

Do not use JavaScript `Number` or `sort -V` as release-order authority.

The same rules apply to:

- `scripts/update-version.js`,
- `scripts/validate-package.mjs`,
- `.github/workflows/release.yml`,
- version/release workflow tests.

## 6.3 Highest stable tag

Both early validation and publication-time revalidation ignore non-canonical tags and compute the maximum canonical stable version using the same exact comparator.

The **publication-time remote** calculation is authoritative for the workflow's final monotonic check.

As stated above, monotonicity across different tag names cannot be made globally atomic against external administrators solely with this workflow. The workflow fails closed on what it observes and atomically refuses duplicate creation of the requested tag.

## 6.4 Helper UX

Documented supported inputs remain:

```text
pnpm ver -- patch
pnpm ver -- minor
pnpm ver -- major
pnpm ver -- x.y.z
NEW_VERSION=x.y.z pnpm ver
```

Single-letter aliases are optional cleanup, not a correctness requirement for this hardening.

## 6.5 Tests

Positive:

- patch,
- minor,
- major,
- explicit canonical target.

Negative:

- leading zeros,
- malformed target,
- equal/lower target,
- duplicate `versions.json` key,
- components larger than IEEE-754 exact integer range,
- inconsistent package/manifest metadata,
- non-canonical historical tags excluded from maximum calculation.

Preflight validation errors occur before metadata writes.

---

# 7. Workflow Contract Tests and Test Tiers

## 7.1 Feasibility workflow contracts

Add text-level semantic contract tests under `tests/feasibility/`.

They are regression guards, not YAML interpreters, and avoid whitespace-sensitive assertions.

Stable Release contract verifies ordering/markers for:

- explicit `verify` and `publish` jobs,
- read-only permissions in `verify`,
- write permission isolated to `publish`,
- checkout uses `persist-credentials: false`,
- publish performs no checkout/install/build/test package scripts,
- exact-SHA CI qualification,
- exact-SHA live-E2E qualification,
- release-input artifact + integrity manifest,
- artifact metadata is bound to same run/repository/SHA,
- final remote master/version/tag/release revalidation before mutation,
- remote tag/release checks are pagination-safe,
- create-only tag creation,
- exact tag verification,
- draft before public publication,
- final release/tag/asset digest verification where GitHub exposes digests.

Live-E2E contract verifies:

- E2E token is not job-level environment state,
- target metadata resolves before destructive work,
- numeric repository ID differs from source repository ID,
- target default branch and disposable branch contract are checked,
- verified target ID is exposed before destructive work,
- runner receives expected target repository ID,
- cleanup requires/re-resolves the same ID before DELETE,
- branch 404 is accepted only after repository identity has resolved.

## 7.2 Test placement

- workflow/tooling: `tests/feasibility/`,
- deterministic sync/user flow: `tests/v4/`,
- crash/recovery/stage lifecycle: `tests/recovery/`,
- credentialed real GitHub behavior: `tests/github-e2e/` + live workflow.

## 7.3 TDD rule

For production changes:

```text
write focused failing regression
confirm expected failure
implement smallest change
confirm focused pass
run affected tier
commit
```

Core causality changes are made only when a new correctness regression fails.

---

# 8. Implementation Batches

## Batch A — Stable release authority and credential compartmentalization

- add workflow-contract regression,
- split Stable Release into read-only `verify` and minimal write-only `publish`,
- enforce exact-SHA CI and live-E2E evidence,
- create and integrity-check release-input artifact,
- bind artifact metadata/digest to current run/repo/SHA,
- re-read paginated remote master/tags/releases immediately before publication,
- create requested tag explicitly at `GITHUB_SHA`,
- draft/upload/reverify/publish/final-verify release including asset digests where exposed,
- update runbook and immutable-release guidance.

## Batch B — Live-E2E identity and secret scope

- remove job-level E2E secret exposure,
- resolve numeric target identity before destructive work,
- pass expected ID into runner,
- canonicalize target full name in runner,
- revalidate identity/default branch at destructive reset boundaries,
- bind cleanup to exact qualified target ID,
- tighten 404 semantics,
- update E2E docs/contracts.

## Batch C — Missing folder/recovery evidence

- add multi-descendant folder conflict matrix,
- retain fast one-action retry UX evidence,
- add recovery-tier Copy + CAS + stage integration,
- modify core only for demonstrated failing regressions.

## Batch D — Typed publication races

- add structured shared race type,
- classify normal publication and bootstrap races from Git/reconciliation evidence,
- preserve existing operation retry semantics,
- remove message regex from runtime and real-E2E wrapper,
- add positive/negative/force/bootstrap tests.

## Batch E — Immutable read fallback

- path-directed non-recursive Git tree traversal,
- truncated-evidence fail-closed behavior,
- safe non-blob/gitlink handling,
- no cache.

## Batch F — Canonical SemVer

- canonical grammar + BigInt helper/validator/workflow logic,
- exact maximum canonical stable tag calculation,
- publication-time remote monotonic recheck,
- positive/negative regression matrix.

## Batch G — Final verification and qualification

- full deterministic gates,
- review final diff against this design,
- merge,
- exact-final-SHA ordinary CI success,
- exact-final-SHA live E2E `qualify` + `cleanup` success,
- Stable Release only while `master` still equals that SHA.

---

# 9. Final Verification Gate

Before merge/release qualification:

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

After merge, exact-final-SHA evidence is required from ordinary CI and live GitHub E2E. A previously qualified SHA does not qualify a newer master tip.

---

# 10. Long-Term Rationale and Explicit Deferred Work

## 10.1 Prefer immutable identity where the layer supports it

For workflow security boundaries, numeric GitHub repository ID and exact commit SHA are authorities; owner/name strings and branch labels are interfaces.

This principle does **not** retroactively change the V4 protocol's existing `repoId` contract.

## 10.2 Prefer evidence over wording

- retry from observed Git state, not English messages,
- replan after concurrent empty-repository initialization rather than continuing an already-invalid plan,
- treat truncated tree responses as unknown, not absent,
- treat cleanup 404 as absence only after repository identity is proven,
- publish only the exact artifact whose bytes were verified in the read-only job,
- verify server-reported release-asset SHA-256 digests against the release-input manifest when available.

## 10.3 Minimize credential blast radius

Repository code and dependencies execute without repository write authority. Destructive E2E credentials exist only in the steps that need them.

## 10.4 Optimize measured hot paths only

Path-directed traversal removes a known whole-tree scaling hazard without retained memory. Caching remains deferred until profiling justifies it.

## 10.5 Deferred work

Separate follow-ups remain for:

- V4 `repoId` migration/user flow when a GitHub repository is renamed or only capitalization changes; this needs protocol/encryption compatibility design because `repoId` scopes derived keys/AAD,
- `scripts/zip-source.mjs` portability/actual-ZIP repair,
- speculative watcher-noise/out-of-order event handling without reproducible production evidence,
- optional bounded Git tree cache if profiling later proves useful,
- physical Windows/Android qualification,
- multi-gigabyte qualification/benchmarking.

---

# 11. Acceptance Criteria

This follow-up is complete only when all of the following are true:

- Stable Release separates read-only verification from write-capable publication.
- Repository code/dependencies never execute in the write-capable publish job.
- Stable Release enforces exact-SHA ordinary CI and exact-SHA live E2E qualification.
- The exact published assets are produced/tested in `verify`, integrity-manifested, and reverified in `publish`.
- Publish verifies the release-input artifact belongs to the same workflow run/repository/SHA and verifies its digest when the API exposes one.
- Publication re-reads complete paginated remote `master`, tag, and conflicting release state immediately before mutation.
- Stable Release no longer relies on `gh release create --target` to create/bind a missing tag after lengthy gates.
- Requested tag creation is create-only at `GITHUB_SHA` and is verified before and after draft preparation.
- Public release publication occurs only after complete draft asset preparation.
- Final release/tag/asset state is explicitly verified, including SHA-256 asset digests where GitHub exposes them.
- Runbook documents partial states and does not overstate atomicity or administrator resistance.
- Live E2E secret is step-scoped rather than job-scoped.
- Live qualification rejects the source repository by numeric repository ID.
- The verified target repo ID is established before destructive work and passed into the runner.
- The runner revalidates that repository ID and actual default branch before destructive execution/reset boundaries.
- Cleanup is bound to the same qualified repository ID and never treats unresolved-repository 404 as branch absence.
- Folder conflict regressions use multiple descendants and prove both conflicted and unaffected child behavior.
- Recovery integration proves exactly-once conflict-copy/stage behavior through a publication race.
- Publication-race retry no longer depends on `branch head changed|stale ref` regex in production or live E2E.
- Typed publication-race refactor preserves the current operation-agnostic branch-race retry path and keeps recovery-replan retry Normal-only.
- Concurrent empty-repository initialization is re-observed and replanned instead of continuing an empty-remote plan or failing solely because another writer won bootstrap.
- Immutable Contents-404 fallback performs no recursive whole-tree request, fails closed on truncated evidence, and handles non-blob tree entries safely.
- No unbounded Git tree cache is added.
- Stable version grammar/comparison is canonical and exact across helper, validator, workflow, and tests.
- Highest canonical stable version is re-read from remote state at publication time rather than trusted from stale checkout state.
- Full deterministic gates pass on final implementation.
- Exact final master SHA has successful ordinary CI plus successful live `qualify` and `cleanup` before Stable Release is eligible.
