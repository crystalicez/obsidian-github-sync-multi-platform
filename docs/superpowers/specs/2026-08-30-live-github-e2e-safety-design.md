# Live GitHub E2E Safety Design

## Status

Child design of `2026-08-30-release-e2e-runtime-hardening-followup-design.md`.

Repository baseline: `35e98cea924702293bde62d064a83d52eca6d898`.

This child owns destructive live-E2E repository identity, credential scope, reset/cleanup safety, and release-qualifying live-test execution boundaries.

## Goal

Make every destructive live-E2E branch mutation prove that it targets the intended disposable repository and non-default disposable branch, while keeping the destructive credential out of checkout/install/build/compile processes.

## Non-goals

This child does not redefine V4 protocol `repoId`, migrate encrypted data after repository rename, guarantee cleanup after hard cancellation, grant broad tokens for convenience, or own publication-race retry semantics.

---

# 1. Credential Model

## 1.1 Release-qualifying credential scope

Release-qualifying GitHub E2E requires a credential whose mutable scope is restricted to the dedicated disposable target repository.

Acceptable examples:

- fine-grained PAT scoped only to that repository,
- repository-scoped GitHub App installation token with only required repository permissions.

Required mutable permission is limited to Contents/Git data needed by the isolated branch tests.

A classic/broad token able to mutate the source repository or unrelated repositories is not release-qualifying configuration.

This restriction is a documented environment prerequisite and is reinforced by numeric repository-ID checks at runtime.

## 1.2 Initialized disposable repository prerequisite

The target test repository must already have an initialized readable default branch.

The live suite mutates only its generated non-default branch. It never relies on creating or replacing the repository's default branch.

This makes the actual default-branch ref a concrete non-destructive capability probe for Git-ref read access.

## 1.3 Secret lifetime

`E2E_TOKEN` / `GITHUB_E2E_TOKEN` is never job-level environment state.

Secret-free preparation includes:

```text
checkout
pnpm/Node setup
frozen install
plugin build
E2E compilation/bundling
```

The destructive token appears only in:

1. target identity/capability guard,
2. execution of already-precompiled real-GitHub tests,
3. cleanup/verification step in cleanup job.

Audit generation/upload does not receive the destructive token.

## 1.4 Precompile before secret

The release-qualifying workflow must not call a command that can compile/bundle while the token is present.

Actions flow:

```text
pnpm test:github-e2e:compile      # no E2E token
node <precompiled serial runner>  # E2E token present
```

Local/manual convenience commands may still combine compile+run outside the release-qualifying Actions boundary.

---

# 2. Target Repository Identity

## 2.1 Numeric repository ID is safety authority

Workflow/test safety identifies the target by GitHub numeric repository ID. Owner/name strings are routing interfaces only.

The guard resolves configured target metadata with the target token:

```text
id
full_name
default_branch
```

Before destructive work require:

```text
target metadata request = success
target.id != GITHUB_REPOSITORY_ID
source ref == refs/heads/master
current source master == GITHUB_SHA
branch == obsidian-sync-e2e/run-${GITHUB_RUN_ID}
branch != target.default_branch
```

Case-only owner/repository changes cannot bypass numeric identity.

## 2.2 Guard outputs

Before destructive execution the guard exports non-secret job outputs:

```text
target_repo_id
target_full_name
target_default_branch
target_branch
```

If these outputs do not exist, destructive execution must not start.

The token is never an output.

## 2.3 Canonical routing name

After metadata resolution, child test processes receive owner/repo values derived from canonical `full_name`, while expected identity remains numeric ID.

---

# 3. One Shared Destructive-Safety Authority

Current credentialed E2E files duplicate repository/default-branch/delete/absence logic. Consolidate those semantics into one test-support module shared by every credentialed suite.

Suggested location:

```text
tests/github-e2e/support/target-safety.ts
```

The helper owns primitives equivalent to:

```text
resolveCanonicalTarget()
assertExpectedRepositoryId()
assertDisposableBranchContract()
assertNotDefaultBranch()
assertGitRefReadCapability()
readDisposableBranch()
deleteDisposableBranch()
waitForDisposableBranchAbsent()
```

Scenario-specific sync logic remains in scenario files.

When `GITHUB_E2E_EXPECTED_REPO_ID` exists, every destructive reset/delete boundary requires the current resolved repository ID to equal it.

---

# 4. Disposable Branch Contract

Release-qualifying Actions runs use exactly:

```text
obsidian-sync-e2e/run-${GITHUB_RUN_ID}
```

Reruns of the same workflow run intentionally reuse the same branch so they can reset residue from a previous attempt. Different run IDs remain isolated.

The helper rejects:

- empty branch,
- branch equal to actual default branch,
- branch not matching the exact run-derived contract in Actions mode.

Local/manual mode may use another explicit disposable branch but still rejects the actual default branch and may retain conservative forbidden-name checks as defense in depth.

---

# 5. Git-Ref Capability and Absence Semantics

## 5.1 Concrete capability probe

Repository metadata visibility alone is not enough to trust a branch 404.

After resolving target metadata, read the actual default-branch Git ref:

```text
GET /git/ref/heads/<encoded default_branch>
```

It must return a successful ref with a non-empty object SHA.

Failure to read the initialized default-branch ref means Git-ref capability is not established; cleanup/reset fails closed and performs no delete based on an absence interpretation.

## 5.2 Exact disposable-branch absence

Only after metadata identity + default-branch-ref capability succeed:

```text
GET exact disposable ref
```

can a recognized absent-ref response be interpreted as absence.

Required sequence:

```text
resolve metadata
verify numeric ID
verify generated branch + not default
GET actual default-branch ref = 200
GET exact disposable ref
        ↓
recognized absent => success/no DELETE
200 => DELETE exact disposable ref
other => failure
        ↓
GET actual default-branch ref = 200 again
GET exact disposable ref
        ↓
recognized absent => deletion confirmed
200 => bounded retry/failure
other => failure
```

Do not blindly accept all `422` responses. Only an explicitly recognized missing-reference response may be normalized to absence, and only after capability is proven.

---

# 6. Runner Revalidation

The token-bearing execution step passes:

```text
GITHUB_E2E_EXPECTED_REPO_ID
canonical GITHUB_E2E_OWNER
canonical GITHUB_E2E_REPO
GITHUB_E2E_BRANCH
GITHUB_E2E_TOKEN
```

Before spawning precompiled tests, the runner independently requires:

```text
resolved ID == expected ID
resolved canonical full_name matches child routing env
branch != actual default branch
branch matches workflow disposable contract
actual default-branch Git ref is readable
```

Precompiled test files execute serially.

Every destructive scenario reset uses the shared safety helper and re-resolves identity at that destructive boundary.

Identity checks are not required before every blob/tree read; narrow credential scope + isolated branch + destructive-boundary revalidation provide the intended defense in depth.

---

# 7. Live Workflow Structure

## 7.1 Qualification job order

```text
checkout exact source SHA             [no E2E token]
setup/install/build                   [no E2E token]
compile E2E bundles                   [no E2E token]
resolve target + ID/default-ref guard [E2E token only here]
run precompiled E2E serially          [E2E token only here]
write audit manifest                  [no E2E token]
upload audit artifact                 [no E2E token]
```

The source workflow token remains read-only.

## 7.2 Audit manifest

Best-effort audit data includes:

```text
schemaVersion
commitSha
workflowRunId
workflowRunAttempt
targetRepositoryId
targetFullName
targetBranch
suite
qualifiedAt
```

The artifact is human evidence, not release authority.

## 7.3 Cleanup job

`cleanup` uses `if: always()` and `needs: qualify`.

Before any DELETE it requires:

```text
qualified target repo ID exists
currently configured target resolves
current target ID == qualified target ID
current target ID != source repository ID
branch == expected run-derived branch
branch != actual default branch
actual default-branch ref readable
```

Identity/capability ambiguity deletes nothing and fails.

Hard cancellation can still prevent cleanup; unique run-derived branch bounds residue to the disposable target.

---

# 8. Local and Emergency Cleanup

## 8.1 Local runner

Local/manual execution always resolves target metadata and actual default branch before destructive work.

If an expected numeric target ID is supplied, it is enforced exactly.

Without a known source numeric ID, local mode cannot prove source-vs-target inequality automatically; documentation therefore requires an explicitly dedicated disposable target and recommends recording/supplying its numeric ID.

## 8.2 Manual residue cleanup

The documented emergency cleanup command follows the same invariant order:

```text
require maintainer-known expected target repository ID
resolve metadata
print canonical full_name + ID + default branch
require resolved ID == expected ID
require branch matches disposable residue contract
require branch != default branch
read actual default-branch ref successfully
read exact disposable ref
only if present: delete exact disposable ref
read default-branch ref again
verify disposable ref absent
```

The docs no longer offer a blind delete command that accepts permission-masked 404 as success.

If the audit artifact is missing after hard cancellation, the expected repository ID must come from maintainer-known target configuration/workflow evidence; it must not be inferred solely from whichever owner/repo strings happen to be configured at cleanup time.

---

# 9. Tests

## 9.1 Shared helper

Cover:

- case-different name resolving to source numeric ID rejected,
- expected target-ID mismatch before mutation,
- actual default branch rejected regardless of name,
- malformed run-derived branch rejected,
- metadata failure fails closed,
- default-branch ref unreadable fails closed,
- exact disposable 404 accepted only after capability success,
- arbitrary 422 rejected,
- recognized missing-reference response accepted only with capability,
- deletion followed by absence verification,
- post-delete loss of default-ref capability fails instead of masquerading as success.

## 9.2 Runner/workflow

Cover:

- token-bearing mode executes precompiled tests without compiling,
- expected repository ID revalidated,
- canonical full name propagated,
- tests serial,
- destructive reset uses shared helper,
- no job-level E2E token,
- compile precedes token-bearing execution,
- guard outputs ID before destructive step,
- cleanup consumes qualified target ID,
- audit includes target ID + run attempt,
- source workflow token remains read-only.

Publication-race retry classification inside E2E wrappers is owned and tested by the Publication Race and Conflict Recovery child design, not this child.

---

# 10. Maintainer Flow

1. maintain an initialized dedicated disposable repository,
2. configure a narrowly scoped credential that can mutate only that target,
3. configure `E2E_OWNER`, `E2E_REPO`, `E2E_TOKEN`,
4. dispatch GitHub E2E Live from exact current `master`,
5. require both `qualify` and `cleanup` success.

Normal Obsidian users see no behavior change.

If repository identity, default branch, or ref-read capability is ambiguous, the system fails without deleting anything.

---

# 11. Acceptance Criteria

Complete only when:

- release-qualifying credentials are documented as target-repository scoped,
- target repository is required to have a readable initialized default branch,
- destructive token is absent from checkout/install/build/compile/audit steps,
- live Actions execution uses precompiled E2E bundles under the token,
- numeric target ID is established before destructive work and cannot equal source ID,
- runner independently revalidates target ID/default branch/default-ref capability,
- all credentialed suites use one destructive-safety helper,
- absence semantics never rely on metadata visibility alone,
- arbitrary 404/422 is not blindly treated as absent branch,
- cleanup is bound to the exact qualified target ID and run-derived branch,
- hard-cancel residue remains isolated,
- manual cleanup uses the same ID/default-branch/ref-capability contract,
- audit evidence records target identity and workflow run attempt.
