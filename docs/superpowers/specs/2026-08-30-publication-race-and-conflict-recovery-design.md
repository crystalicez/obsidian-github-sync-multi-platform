# Publication Race and Conflict Recovery Design

## Status

Child design of `2026-08-30-release-e2e-runtime-hardening-followup-design.md`.

Repository baseline: `35e98cea924702293bde62d064a83d52eca6d898`.

This child owns recoverable publication-race classification, retry semantics, empty-repository concurrent initialization, missing folder-causality evidence, and Copy-conflict recovery integration.

## Goal

Replace human-readable stale-ref heuristics with structured evidence-based publication-race handling while preserving existing user-visible retry behavior and proving folder/Copy recovery semantics before modifying V4 causality.

## Non-goals

This child does not:

- redesign the V4 planner/coordinator/session wholesale,
- add server-side CAS semantics GitHub does not provide,
- change the local-primary Copy policy,
- change Force Push/Force Pull UX beyond preserving existing publication-race retry behavior,
- move recovery-store assertions into the fast tier,
- add watcher-noise behavior without a deterministic production-relevant regression.

---

# 1. Existing Behavioral Contract

## 1.1 Runtime retry reasons today

Production runtime currently retries a logical sync operation for two classes of events:

1. an error message matching branch-head/stale-ref wording,
2. `V4RecoveryReplanRequiredError` during Normal sync.

The branch-race message path is currently not restricted by operation. Therefore compatibility for this child is:

```text
V4PublicationRaceError
→ retry regardless of request.operation
→ maximum three outer attempts

V4RecoveryReplanRequiredError
→ retry only when request.operation == normal
→ maximum three outer attempts
```

A future UX change that narrows Force Push/Force Pull retry is a separate design.

## 1.2 Live-E2E wrapper behavior today

The two live E2E wrappers retry stale-ref wording only for Normal sync:

```text
tests/github-e2e/v4-real-github-e2e.test.ts
tests/github-e2e/v4-copy-contract-github-e2e.test.ts
```

Their compatibility contract remains:

```text
V4PublicationRaceError + operation == normal
→ bounded retry

force operations
→ no harness-level retry expansion
```

Production runtime and E2E harness intentionally share the error classification but not identical retry policy.

---

# 2. Structured Publication-Race Error

Introduce one shared publication-boundary error type, for example:

```ts
export class V4PublicationRaceError extends Error {
  readonly code = "V4_PUBLICATION_RACE"

  constructor(
    readonly phase: "bootstrap" | "pre-publish" | "reconcile",
    readonly expectedHeadSha: string | null,
    readonly observedHeadSha: string | null,
    readonly cause?: unknown,
    message = "Remote branch changed while publishing sync state.",
  ) { ... }
}
```

Exact file placement is decided during planning, but the type must be importable by:

- git publication code,
- production runtime,
- real-GitHub E2E bundles/tests.

Retry decisions use the type/predicate, never message regex.

The error preserves structured expected/observed head evidence and an original cause when one exists.

---

# 3. Publication Reconciler Is the Classification Authority

## 3.1 Do not create a parallel stale-head state machine

The codebase already has candidate-publication reconciliation. Extend that authority rather than building a second independent classifier around ad-hoc `getGitRefOrNull()` comparisons.

For a candidate commit, reconciliation distinguishes the meaningful states of publication:

```text
candidate is the current/published head
candidate was published and branch later advanced
candidate was not published and expected head still holds
branch diverged away from both candidate and expected base
```

The exact existing status names remain implementation details where appropriate, but callers must map the semantic states consistently.

## 3.2 Result mapping

After a ref mutation uncertainty/failure:

```text
candidate published/current
→ success; do not retry logical operation

candidate published then branch advanced
→ V4PublicationRaceError(expected, observed advanced head)

expected head still current and candidate not published
→ preserve the original mutation failure classification
→ existing unknown-outcome policy may perform its one evidence-based mutation retry

branch diverged
→ V4PublicationRaceError(expected, observed diverged head)
```

This closes the idempotent-success edge case where a mutation response failed after GitHub had already moved the ref to the candidate.

## 3.3 Pre-publish mismatch

Immediately before candidate ref mutation, if observed current head does not equal the candidate's expected head:

```text
throw V4PublicationRaceError(
  phase="pre-publish",
  expectedHeadSha=<candidate base>,
  observedHeadSha=<current head>
)
```

No mutation is attempted.

## 3.4 Error cause

When a publication race is derived after another transport/API failure, the typed race preserves that failure as `cause` for logs/diagnostics.

The user-facing terminal error does not expose raw SHAs or transport internals by default.

---

# 4. Empty-Repository Concurrent Initialization

## 4.1 Failure mode

Two devices can observe a truly empty GitHub repository at the same time.

Both may enter the bootstrap/initialization path under an empty-remote assumption. One writer wins and creates repository/ref state; the other writer can receive a definitive mutation failure even though the correct response is to replan against the newly created remote state.

## 4.2 Required behavior

The losing initializer does not silently adopt the newly observed head inside the already-planned session.

Required sequence:

```text
session observed empty remote
        ↓
bootstrap/init mutation loses
        ↓
re-observe repository/configured ref state
        ↓
writer-created state now exists
        ↓
throw V4PublicationRaceError(
  phase="bootstrap",
  expectedHeadSha=null,
  observedHeadSha=<new head>,
  cause=<original bootstrap failure>
)
        ↓
outer runtime retry reloads config/index/remote and replans the whole operation
```

Continuing the old session is forbidden because the planning assumptions changed.

## 4.3 Non-race bootstrap failures

If bootstrap/init fails and re-observation does not prove newly created remote/ref state, propagate the original failure rather than inventing a publication race.

Unknown mutation outcomes retain the existing mutation-outcome reconciliation policy before being promoted to a higher-level race.

---

# 5. Runtime Retry and User Flow

## 5.1 Outer attempt lifecycle

A publication race is retried within the same user-triggered logical sync action.

The runtime retains the existing three-attempt bound.

On retry:

- progress phase becomes `retrying`,
- visible attempt advances,
- remote config/index/recovery state is loaded fresh,
- planning is recomputed,
- the same logical `runState` remains available where the current Copy/recovery contract requires stable conflict-copy reservation.

## 5.2 Terminal UX

Attempts 1→2→3 are transparent except for progress state.

If the third attempt still ends in `V4PublicationRaceError`, the user-facing message is concise and actionable, for example:

```text
Remote branch changed repeatedly while syncing. Please try again.
```

Structured diagnostics retain:

```text
phase
expectedHeadSha
observedHeadSha
cause
attempt
operation
```

Do not present internal CAS/ref terminology as the primary user message.

## 5.3 Negative wording contract

A generic error such as:

```ts
new Error("stale ref")
```

is not retryable unless it has been converted to the typed race from actual publication evidence.

A `V4PublicationRaceError` remains retryable even if its human-readable message contains no stale/race wording.

---

# 6. Live-E2E Retry Consumers

Both credentialed wrappers migrate from regex classification to the shared publication-race type/predicate:

```text
v4-real-github-e2e.test.ts
v4-copy-contract-github-e2e.test.ts
```

Their wrapper policy remains:

```text
if error is V4PublicationRaceError
AND operation == normal
AND attempt < 3
→ retry
```

Harness-specific conflict-copy stage clearing between attempts may remain because these wrappers do not model the full production recovery-store lifecycle.

The shared type must compile into the precompiled E2E bundles used by the live workflow.

---

# 7. Folder Conflict Evidence

## 7.1 Production-change rule

For folder causality/conflict scenarios:

```text
write deterministic regression
run against current production
PASS → do not change V4 production causality
FAIL → commit regression, then implement the smallest correction
```

The purpose is evidence, not refactoring for aesthetic reasons.

## 7.2 Exercise actual folder events

Folder tests must exercise queued folder events understood by the coordinator/session rather than simulating a folder operation with independent file events.

Use actual change inputs such as:

```ts
{ type: "folderRename", oldPath: "folder", path: "moved" }
{ type: "folderDelete", path: "folder" }
```

where the test harness exposes those production event shapes.

A nested rename chain must be tested as one logical batch when possible:

```text
folder -> middle
middle -> final
```

with final local filesystem state at `final/*`.

## 7.3 Multi-descendant shape

Each primary folder scenario starts with at least:

```text
folder/edited.md
folder/untouched.md
```

Only `edited.md` receives a stale competing edit. `untouched.md` proves one-sided folder propagation for a sibling under the same folder event.

## 7.4 Remote folder rename vs stale edited descendant

Remote device renames `folder -> moved`.

Expected:

- stale edited lineage remains canonical at `folder/edited.md`, preserving original file identity,
- remote competitor derived from `moved/edited.md` is preserved exactly once as conflict copy with distinct identity,
- unchanged sibling follows remote rename to `moved/untouched.md`, preserving identity,
- no duplicate/intermediate paths survive,
- fresh-device convergence matches the final remote/index state.

## 7.5 Remote folder delete vs stale edited descendant

Remote deletes `folder`.

Expected:

- stale locally edited `folder/edited.md` remains canonical with original identity,
- no remote-body conflict copy is invented because the remote lineage is absent,
- unchanged sibling is deleted as one-sided remote deletion,
- fresh-device convergence matches the resulting remote/index state.

## 7.6 Remote folder delete vs stale delete/recreate descendant

Stale local deletes then recreates `folder/edited.md` before sync while remote deletes the folder.

Expected:

- recreated path survives as canonical,
- recreated file has a new identity,
- old identity remains deleted,
- untouched sibling follows remote deletion,
- no absent-body conflict copy is invented.

## 7.7 Nested folder rename chain

Remote publishes a logical chain ending at `final` while stale local edits only the original edited descendant.

Expected:

- edited stale lineage remains canonical at original path,
- remote final edited lineage becomes exactly one conflict copy derived from `final/edited.md`,
- untouched sibling ends at `final/untouched.md`, preserving identity,
- no `middle/*` paths survive.

## 7.8 Case-only folder rename

One-sided `Folder -> folder` with multiple descendants and no competing normalized identity:

- descendant identities remain stable,
- one normalized path per descendant remains,
- casing change alone does not create conflict copies.

## 7.9 NFC/case namespace collision

If different identities would occupy the same `NFC + lowercase` namespace:

- fail before local/remote mutation,
- report the collision clearly,
- do not select a winner,
- do not bypass the invariant by creating a conflict copy into the colliding namespace.

All folder regressions assert exact paths, bytes, identities, conflict-copy count, absence of unrelated overwrite, and fresh-device convergence where the resulting state is valid.

---

# 8. Copy + Publication Race + Recovery Integration

## 8.1 Fast user-flow evidence

Keep/add a fast runtime test proving:

```text
one manual sync action
→ first publication attempt races
→ runtime automatically retries
→ visible attempt reaches 2
→ final lifecycle success
```

This test focuses on UX/retry behavior and does not deeply assert persisted recovery storage.

## 8.2 Recovery-tier integration

Add a recovery-tier scenario:

```text
shared base
→ local edit
→ concurrent remote edit
→ Copy conflict chosen/resolved
→ remote conflict-copy body staged
→ candidate publication races
→ reconciliation/replan/recovery
→ exactly one final conflict copy
→ index/recovery reaches committed boundary
```

Required assertions:

- local canonical bytes preserved,
- remote competitor bytes preserved exactly once,
- conflict-copy path reservation remains stable within the logical run,
- conflict-copy file identity remains stable within the logical run,
- stale/invalid stage references are not reused after recovery says they are invalid,
- no duplicate conflict-copy path,
- no duplicate remote logical record for the same reserved copy,
- final remote/index state agrees,
- recovery state reaches the expected committed/cleared terminal boundary,
- a fresh device converges to the same logical result.

Recovery/stage lifetime assertions remain under `tests/recovery/`.

---

# 9. Tests for Publication Classification

Required focused tests include:

- pre-publish expected/observed mismatch → typed race,
- typed race exposes structured expected/observed values,
- mutation response failure but candidate is current head → success/no outer retry,
- mutation failure + published-advanced reconciliation → typed race,
- mutation failure + diverged reconciliation → typed race,
- mutation failure + expected head still current → original failure preserved,
- original failure preserved as `cause` when race is derived,
- generic `Error("stale ref")` does not retry,
- typed race with unrelated message does retry,
- production retry bound remains three,
- Force Push/Force Pull publication-race retry compatibility preserved in runtime,
- recovery-replan remains Normal-only,
- both live E2E wrappers use typed detection and remain Normal-only,
- concurrent empty-repository loser replans,
- bootstrap failure without new remote state remains original failure,
- E2E compile gate bundles the shared error type successfully.

---

# 10. Observability

Publication-race logs should record structured non-secret fields:

```text
operation
attempt
phase
expected head
observed head
reconciliation status where available
cause class/message
```

Do not log token values, passphrases, plaintext encrypted payloads, or conflict body contents.

Retry metrics should count outer logical retries separately from low-level transport retries so repeated remote contention is distinguishable from HTTP/network retry behavior.

---

# 11. Acceptance Criteria

This child is complete when:

- production retry decisions no longer depend on `branch head changed|stale ref` wording,
- candidate publication reconciliation is the central post-mutation classification authority,
- idempotent candidate-head success is not misclassified as a race,
- published-advanced/diverged evidence produces `V4PublicationRaceError`,
- concurrent empty-repository initialization replans the full operation when another writer wins,
- bootstrap failures without new remote state remain non-race,
- runtime preserves operation-agnostic publication-race retry and Normal-only recovery-replan behavior,
- terminal repeated-race failure has user-facing actionable wording,
- both live E2E wrappers use the typed race while preserving Normal-only harness retry,
- folder conflict tests exercise actual folder events with multiple descendants,
- folder rename/delete/recreate/case/NFC scenarios assert path, byte, and identity semantics,
- Copy + publication-race recovery proves exactly-once conflict-copy/stage behavior,
- V4 production causality is changed only for a demonstrated failing deterministic regression.
