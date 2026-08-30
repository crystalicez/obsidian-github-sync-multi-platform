# Live GitHub E2E Safety Design

## Status

Child design of `2026-08-30-release-e2e-runtime-hardening-followup-design.md`.

Repository baseline: `35e98cea924702293bde62d064a83d52eca6d898`.

This child owns destructive live-E2E repository identity, credential scope, reset/cleanup safety, and release-qualifying live-test execution boundaries.

## Goal

Make every destructive live-E2E branch mutation prove that it is operating on the intended disposable repository and non-default disposable branch, while keeping the destructive credential out of checkout/install/build/compile processes.

## Non-goals

This child does not:

- redefine V4 protocol `repoId`,
- migrate encrypted data when a GitHub repository is renamed,
- make hard-cancel cleanup guaranteed,
- grant broader token scope for convenience,
- replace real GitHub qualification with mocks,
- add random concurrency when deterministic one-shot interference is sufficient.

---

# 1. Credential Model

## 1.1 Release-qualifying credential requirement

Release-qualifying GitHub E2E requires a credential whose mutable repository scope is restricted to the dedicated disposable target repository.

Acceptable examples include:

- a fine-grained personal access token scoped only to the target repository,
- a repository-scoped GitHub App installation token with only the permissions needed by the suite.

Required mutable permission is limited to repository Contents/Git data needed to create/update/delete the disposable test branch and objects.

A broad classic token that can mutate the plugin source repository or unrelated repositories is not a release-qualifying configuration.

The workflow cannot always infer every external credential policy attribute, so this restriction is both:

- a configuration prerequisite documented in the runbook,
- a defense complemented by numeric repository-ID checks at runtime.

## 1.2 Secret lifetime

`E2E_TOKEN` / `GITHUB_E2E_TOKEN` is never job-level environment state.

The qualification job has two stages:

```text
secret-free preparation
        ↓
secret-bearing destructive execution
```

Secret-free preparation includes:

- checkout,
- pnpm setup,
- Node setup,
- frozen dependency install,
- plugin build,
- compilation/bundling of the real-GitHub E2E test bundles.

The destructive token is introduced only to:

1. the target identity guard step,
2. the precompiled real-GitHub E2E execution step.

Audit artifact creation/upload does not receive the destructive token.

Cleanup receives the token only in its cleanup/verification step.

## 1.3 Precompiled test execution

The live workflow must not call a command that recompiles the E2E suite while the destructive token is present.

The runner is structured so the workflow can perform:

```text
pnpm test:github-e2e:compile      # no destructive token
node <precompiled serial test runner>   # destructive token present
```

Local/manual `pnpm test:github-e2e:quick` may remain a convenience command that performs prepare + execute in one invocation because local credential exposure is controlled by the maintainer running it. The release-qualifying Actions workflow uses the split boundary.

---

# 2. Target Repository Identity

## 2.1 Immutable authority

For workflow/test safety, the target repository is identified by GitHub's numeric repository ID.

Owner/name strings are discovery/routing interfaces only.

The workflow resolves configured `E2E_OWNER/E2E_REPO` with the target token and records:

```text
id
full_name
default_branch
```

Before destructive work it requires:

```text
target metadata request succeeds
target.id != GITHUB_REPOSITORY_ID
source ref == refs/heads/master
current source master == GITHUB_SHA
branch == obsidian-sync-e2e/run-${GITHUB_RUN_ID}
branch != target.default_branch
```

Repository-name case differences cannot bypass the numeric-ID comparison.

## 2.2 Qualification outputs

The guard step writes non-secret job outputs before destructive execution:

```text
target_repo_id
target_full_name
target_default_branch
target_branch
```

If these outputs are not produced successfully, the destructive test step must not run.

The target token itself is never a job output.

## 2.3 Canonical target name

After resolving metadata, child processes use `target.full_name` as the canonical owner/repo route rather than the original configured casing/alias.

This avoids relying on mutable capitalization while still binding safety to numeric repository ID.

---

# 3. Shared Destructive-Safety Library

The current live suites duplicate repository metadata, branch deletion, default-branch, and 404 handling. This child consolidates those safety primitives into one test-support module used by all credentialed E2E suites.

Suggested location:

```text
tests/github-e2e/support/target-safety.ts
```

The exact filename may change during planning, but there must be one shared authority for destructive safety semantics.

The helper owns:

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

It does not own scenario-specific sync behavior.

## 3.1 Expected repository ID

When `GITHUB_E2E_EXPECTED_REPO_ID` is present, every destructive reset boundary requires:

```text
resolved target.id == expected ID
```

A mismatch is a hard failure and performs no deletion/reset mutation.

## 3.2 Disposable branch contract

Release-qualifying Actions runs require the exact generated branch:

```text
obsidian-sync-e2e/run-${GITHUB_RUN_ID}
```

The helper rejects:

- empty branch,
- branch equal to actual target default branch,
- branch not matching the exact generated contract when the workflow run ID is available.

Local/manual E2E may use a different explicit disposable branch, but still rejects the actual default branch and retains conservative forbidden-name defense in depth.

---

# 4. Git-Ref Capability and 404 Semantics

Repository metadata visibility alone does not prove that the token can read Git refs. Therefore an exact branch 404 is not accepted as proof of absence until Git-ref read capability has been demonstrated.

## 4.1 Capability probe

Before destructive cleanup/reset interprets exact-ref absence, perform a non-destructive Git-ref read operation whose successful response proves ref-read capability for the target repository.

The implementation may use a stable Git refs endpoint/collection appropriate to the GitHub API, but the contract is:

```text
repository metadata = reachable and expected ID
Git-ref capability probe = success
```

Only then can exact-ref 404/recognized "reference does not exist" semantics be treated as absence.

## 4.2 Branch absence sequence

Required sequence:

```text
resolve target metadata
verify numeric ID
verify branch contract/default branch
verify Git-ref read capability
GET exact disposable branch
        ↓
recognized absent response => success, no DELETE
200 => DELETE exact disposable branch
other => failure
        ↓
verify Git-ref read capability still succeeds
GET exact disposable branch
        ↓
recognized absent response => deletion confirmed
200 => retry/fail boundedly
other => failure
```

The design does not blindly accept arbitrary `422` as absence. Only a documented/recognized reference-absent response may be normalized to absence.

Retries remain bounded.

---

# 5. Runner Revalidation

Workflow-level guards are insufficient because the precompiled suites still route requests by owner/repo strings.

The destructive test step passes:

```text
GITHUB_E2E_EXPECTED_REPO_ID
GITHUB_E2E_OWNER / REPO from canonical full_name
GITHUB_E2E_BRANCH
GITHUB_E2E_TOKEN
```

Before spawning test scenarios, the runner independently resolves metadata and requires:

```text
resolved ID == expected ID
resolved full_name is canonicalized into child env
branch != resolved default_branch
branch matches workflow disposable contract
Git-ref read capability succeeds
```

The runner then executes precompiled test files serially.

Each scenario-specific reset/delete uses the shared safety helper, which re-resolves identity at the destructive boundary.

The design does not require an identity API call before every blob/tree read. Identity is revalidated before destructive reset/delete boundaries; unique branch isolation and narrow credential scope provide the remaining defense in depth.

---

# 6. Live Workflow Structure

## 6.1 Qualification job

High-level order:

```text
checkout exact SHA                    [no E2E token]
setup/install/build                    [no E2E token]
compile E2E bundles                    [no E2E token]
resolve/guard target identity          [E2E token only here]
run precompiled serial E2E             [E2E token only here]
write audit manifest                   [no E2E token]
upload audit artifact                  [no E2E token]
```

The source workflow token remains read-only.

## 6.2 Audit manifest

The non-secret audit manifest includes at least:

```json
{
  "schemaVersion": 1,
  "commitSha": "...",
  "workflowRunId": "...",
  "workflowRunAttempt": 1,
  "targetRepositoryId": "...",
  "targetFullName": "...",
  "targetBranch": "...",
  "suite": "github-e2e-quick",
  "qualifiedAt": "..."
}
```

Artifact upload remains best-effort human evidence; release authority is workflow/job metadata, not artifact retention.

## 6.3 Cleanup job

`cleanup` runs with `if: always()` and `needs: qualify`.

It receives the target token only in the cleanup step and receives the non-secret qualified target identity through `needs.qualify.outputs`.

Before any DELETE it requires:

```text
qualified target repo ID non-empty
current configured target resolves
resolved target ID == qualified target ID
resolved target ID != source GITHUB_REPOSITORY_ID
branch == expected run-derived branch
branch != actual target default branch
Git-ref read capability succeeds
```

If identity cannot be established, cleanup deletes nothing and fails.

A hard workflow cancellation can still prevent cleanup from executing. Unique per-run branch naming bounds residue to the disposable target repository.

---

# 7. Manual/Local E2E Safety

## 7.1 Local runner

Local/manual execution always resolves target metadata before destructive test execution and rejects the actual default branch.

If the user supplies an expected numeric repository ID, the runner enforces it exactly.

When no source repository ID is available locally, the runner cannot prove source-vs-target inequality by numeric identity. The documentation therefore requires the configured repository to be a dedicated disposable test repository and recommends supplying an expected target ID for stronger local assurance.

## 7.2 Emergency cleanup command

The documented manual cleanup procedure must use the same safety order as automated cleanup:

```text
resolve repository metadata
print canonical full_name + numeric ID + default branch
require maintainer-provided/recorded expected target ID
require branch matches disposable residue contract
require branch != default branch
prove Git-ref read capability
read exact branch
only then delete if present
verify absence
```

The runbook no longer provides a blind `DELETE` command that treats unauthenticated/permission-masked 404 as success.

The qualification audit manifest supplies the expected target repository ID/full name/branch needed for residue inspection when available.

---

# 8. Real-E2E Retry Consumers

The two live suites that currently wrap `V4SyncSession` retry publication races are:

```text
tests/github-e2e/v4-real-github-e2e.test.ts
tests/github-e2e/v4-copy-contract-github-e2e.test.ts
```

Both must move from message regex matching to the shared typed publication-race predicate specified by the Publication Race and Conflict Recovery child design.

Harness retry policy remains **Normal-only**, preserving current E2E behavior:

```text
V4PublicationRaceError + operation=normal => retry, bounded to 3
otherwise => propagate
```

This differs intentionally from production runtime's current operation-agnostic branch-race retry policy.

Harness-specific conflict-copy stage clearing between attempts may remain until the E2E harness models the full production recovery store.

---

# 9. Tests

## 9.1 Shared safety helper tests

Cover:

- case-different owner/repo resolving to source numeric ID is rejected,
- expected target ID mismatch rejects before mutation,
- actual default branch rejected regardless of its name,
- malformed workflow branch rejected,
- metadata 404/403 fails closed,
- Git-ref capability failure fails closed,
- exact branch 404 accepted only after capability success,
- arbitrary 422 not accepted as absence,
- recognized missing-reference response accepted after capability success,
- delete followed by successful absence verification,
- post-delete ref-capability loss fails rather than being mistaken for absence.

## 9.2 Runner tests

Cover:

- precompiled execution path does not invoke compile when token-bearing mode is selected,
- expected repository ID passed/revalidated,
- canonical full name propagated to child test env,
- test files execute serially,
- destructive reset calls shared helper.

## 9.3 Workflow feasibility contracts

Verify semantic markers/order for:

- no job-level E2E token,
- compile occurs before token-bearing execution,
- target guard outputs numeric ID before destructive step,
- source/target numeric inequality,
- cleanup consumes qualified target ID,
- cleanup capability probe precedes absent-branch interpretation,
- audit manifest contains target repository ID/run attempt,
- workflow token is read-only.

---

# 10. User/Maintainer Flow

Release-qualifying setup is explicit:

1. create/select a dedicated disposable repository,
2. configure a narrowly scoped mutable credential for only that repository,
3. configure environment `E2E_OWNER`, `E2E_REPO`, `E2E_TOKEN`,
4. dispatch GitHub E2E Live from `master`,
5. inspect `qualify` and `cleanup` results.

Normal users of the Obsidian plugin see no behavior change from this child design.

Maintainers gain safer failure behavior: if identity or ref-read capability becomes ambiguous, the workflow fails without deleting anything.

---

# 11. Acceptance Criteria

This child is complete when:

- release-qualifying credential scope is documented as restricted to the disposable repository,
- destructive token is absent from checkout/install/build/compile/audit steps,
- live workflow compiles E2E before introducing the destructive token,
- numeric target repository ID is established before destructive work,
- source repository numeric ID cannot equal target numeric ID,
- runner independently revalidates expected target ID/default branch/ref capability,
- all credentialed suites share one destructive-safety helper,
- no suite blindly accepts arbitrary 404/422 as branch absence,
- cleanup proves Git-ref read capability before interpreting branch absence,
- cleanup is bound to the exact qualified target ID,
- hard cancellation residue remains isolated by run-derived branch,
- manual cleanup follows the same identity/default-branch/capability invariants,
- audit evidence records target ID/full name/branch/run attempt,
- both regex-based live-E2E retry wrappers migrate to typed publication-race detection while preserving Normal-only harness retry behavior.
