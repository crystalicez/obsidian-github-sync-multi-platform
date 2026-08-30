# Publication Race and Conflict Recovery Design

## Status

Child design of `2026-08-30-release-e2e-runtime-hardening-followup-design.md`.

Repository baseline: `35e98cea924702293bde62d064a83d52eca6d898`.

This child owns recoverable publication-race classification, retry semantics, empty-repository concurrent initialization, missing folder-causality evidence, and Copy-conflict recovery integration.

## Goal

Replace human-readable stale-ref heuristics with structured evidence-based publication-race handling while preserving existing user-visible retry behavior and proving folder/Copy recovery semantics before modifying V4 causality.

## Non-goals

This child does not redesign the V4 planner/coordinator/session wholesale, add server-side CAS semantics GitHub does not provide, change local-primary Copy policy, change Force operation UX beyond compatibility, move recovery assertions into fast tests, or add watcher-noise behavior without reproducible evidence.

---

# 1. Existing Behavioral Contract

## 1.1 Production runtime

Current runtime retries for:

1. branch-head/stale-ref message wording,
2. `V4RecoveryReplanRequiredError` during Normal sync.

The branch-race wording path is not restricted by operation. Compatibility is therefore:

```text
V4PublicationRaceError
→ retry regardless of request.operation
→ maximum three outer attempts

V4RecoveryReplanRequiredError
→ retry only for request.operation == normal
→ same bounded outer attempt loop
```

Narrowing Force Push/Force Pull retry later requires a separate UX design.

## 1.2 Live-E2E wrappers

Current wrappers in:

```text
tests/github-e2e/v4-real-github-e2e.test.ts
tests/github-e2e/v4-copy-contract-github-e2e.test.ts
```

retry branch-race wording only for Normal sync. They keep Normal-only wrapper retry after moving to typed classification.

Production and E2E share classification, not identical retry policy.

---

# 2. Structured Publication-Race Error

Introduce one shared type, for example:

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

Exact placement is a planning detail, but it must be importable by Git publication code, production runtime, and real-GitHub E2E bundles.

Retry decisions use type/predicate, never message regex.

The type carries structured expected/observed head evidence and original cause where available.

---

# 3. Publication Reconciler Is the Classification Authority

## 3.1 One state machine

The codebase already has candidate-publication reconciliation. Extend that authority rather than adding a second stale-head classifier around ad-hoc ref reads.

Semantically the reconciler distinguishes:

```text
candidate is current/published
candidate was published and branch later advanced
candidate was not published and expected head still holds
branch diverged away from candidate/expected base
```

Existing status names may remain implementation details; semantic mapping is authoritative.

## 3.2 Result mapping after mutation failure/uncertainty

```text
candidate published/current
→ success; no outer retry

candidate published then branch advanced
→ V4PublicationRaceError(expected, observed advanced head)

expected head still current; candidate not published
→ preserve original mutation failure classification
→ existing unknown-outcome policy may perform its one evidence-based mutation retry

branch diverged
→ V4PublicationRaceError(expected, observed diverged head)
```

This prevents a lost response after successful publication from becoming a false race/replay.

## 3.3 Pre-publish mismatch

Immediately before candidate ref mutation:

```text
observed current head != expected candidate base
→ V4PublicationRaceError(
     phase="pre-publish",
     expectedHeadSha=<base>,
     observedHeadSha=<current>
   )
→ no mutation attempted
```

## 3.4 Cause preservation

When a race is derived after a transport/API failure, preserve that original failure as `cause` for diagnostics.

User-facing terminal messaging does not expose raw SHA/CAS internals by default.

## 3.5 Reconciliation itself can fail

A follow-up reconciliation read can itself fail because of transport, rate limit, permission, or API errors.

If reconciliation cannot establish publication state:

- do not invent a publication race,
- do not claim candidate success,
- preserve/propagate the original mutation failure as the primary failure when one exists,
- retain reconciliation failure as diagnostic cause/context if the implementation can do so without obscuring the primary error.

The retry classifier requires positive state evidence, not merely failure of the evidence-gathering step.

---

# 4. Empty-Repository Concurrent Initialization

## 4.1 Failure mode

Two devices can observe a truly empty GitHub repository concurrently. One initializes repository/ref state while the other still plans under an empty-remote assumption.

The losing writer may receive a definitive mutation error even though the correct higher-level action is a full replan.

## 4.2 Required behavior

```text
session observed empty remote
        ↓
bootstrap/init mutation loses
        ↓
re-observe repository/configured ref state
        ↓
writer-created state now exists
        ↓
V4PublicationRaceError(
  phase="bootstrap",
  expectedHeadSha=null,
  observedHeadSha=<new head>,
  cause=<bootstrap failure>
)
        ↓
outer runtime retry reloads config/index/recovery/remote and replans whole operation
```

Do not silently adopt the new head inside the already-planned session.

## 4.3 Non-race bootstrap failures

If re-observation does not prove newly created remote/ref state, propagate the original bootstrap failure.

Unknown mutation outcomes continue through existing mutation-outcome reconciliation before higher-level classification.

If the bootstrap re-observation itself fails, absence of evidence is not race evidence; propagate the primary failure with diagnostics.

---

# 5. Runtime Retry and User Flow

## 5.1 Same user action, bounded attempts

A publication race is retried inside the same user-triggered sync action with the existing three-attempt bound.

On retry:

- phase becomes `retrying`,
- visible attempt advances,
- remote config/index/recovery are loaded fresh,
- planning recomputes,
- logical `runState` remains available where Copy/recovery requires stable conflict-copy reservation.

## 5.2 Terminal UX

Attempts before exhaustion stay transparent except for progress.

After the final typed race, present actionable wording such as:

```text
Remote branch changed repeatedly while syncing. Please try again.
```

Structured logs retain phase, expected/observed SHA, cause, attempt, and operation.

## 5.3 Message wording is not authority

```ts
new Error("stale ref")
```

is not retryable by wording alone.

A `V4PublicationRaceError` remains retryable even with unrelated human-readable text.

---

# 6. Live-E2E Retry Consumers

Both wrappers move from regex to shared typed detection:

```text
v4-real-github-e2e.test.ts
v4-copy-contract-github-e2e.test.ts
```

Policy remains:

```text
V4PublicationRaceError
AND operation == normal
AND attempt < 3
→ retry
```

Force operations do not gain harness-level retry.

Harness-specific conflict-copy stage clearing may remain because these wrappers do not model full production recovery storage.

The shared type must compile into precompiled live-E2E bundles.

---

# 7. Folder Conflict Evidence

## 7.1 Production-change rule

```text
write deterministic expected regression
run against current production
PASS → no V4 causality change
FAIL → keep regression + smallest production correction
```

No refactor is justified by theoretical complexity alone.

## 7.2 Exercise actual folder events

Tests must send production folder-event shapes rather than simulating folders with independent file events, e.g.:

```ts
{ type: "folderRename", oldPath: "folder", path: "moved" }
{ type: "folderDelete", path: "folder" }
```

A nested chain should be one logical batch when supported:

```text
folder -> middle
middle -> final
```

with final filesystem state at `final/*`.

## 7.3 Multi-descendant shape

Primary scenarios start with:

```text
folder/edited.md
folder/untouched.md
```

Only `edited.md` gets the stale competing edit; `untouched.md` proves one-sided sibling propagation under the same folder event.

## 7.4 Remote folder rename vs stale edited descendant

Remote renames `folder -> moved`.

Expected:

- stale edited lineage canonical at `folder/edited.md`, original identity,
- remote `moved/edited.md` competitor preserved exactly once as distinct conflict-copy identity,
- untouched sibling moves to `moved/untouched.md`, identity preserved,
- no intermediate/duplicate paths,
- fresh-device convergence.

## 7.5 Remote folder delete vs stale edited descendant

Expected:

- stale edited `folder/edited.md` survives canonical with original identity,
- no remote-body conflict copy invented for absent remote lineage,
- untouched sibling deleted,
- fresh-device convergence.

## 7.6 Remote folder delete vs stale delete/recreate

Expected:

- recreated `folder/edited.md` survives canonical,
- recreated file has new identity,
- old identity stays deleted,
- untouched sibling follows remote delete,
- no absent-body conflict copy.

## 7.7 Nested folder rename chain

Expected:

- stale edited lineage remains at original path,
- remote final edited lineage becomes one conflict copy derived from `final/edited.md`,
- untouched sibling ends at `final/untouched.md` with identity preserved,
- no `middle/*` paths.

## 7.8 Case-only folder rename

One-sided `Folder -> folder` with multiple descendants:

- identities stable,
- one normalized path per descendant,
- casing alone does not create conflict copy.

## 7.9 NFC/case namespace collision

Different identities colliding under `NFC + lowercase` must fail before mutation, report collision, and neither choose a winner nor evade the invariant through conflict-copy creation.

All folder regressions assert exact paths, bytes, identity continuity/discontinuity, copy count, unrelated-overwrite absence, and fresh-device convergence when valid.

---

# 8. Copy + Publication Race + Recovery Integration

## 8.1 Fast UX evidence

Keep/add a fast runtime test proving:

```text
one manual action
→ publication attempt races
→ automatic retry
→ progress attempt 2
→ success
```

It does not deeply inspect persisted recovery storage.

## 8.2 Recovery-tier integration

Add:

```text
shared base
→ local edit + remote edit
→ Copy conflict resolution
→ remote conflict-copy body staged
→ candidate publication races
→ reconciliation/replan/recovery
→ exactly one final conflict copy
→ index/recovery committed
```

Assert:

- local canonical bytes preserved,
- remote competitor exactly once,
- conflict-copy path and identity stable within logical run,
- invalid stale stage references not reused,
- no duplicate copy path/logical record,
- final remote/index agree,
- recovery reaches committed/cleared boundary,
- fresh device converges.

Recovery/stage assertions remain under `tests/recovery/`.

---

# 9. Required Tests

Publication classification tests cover:

- pre-publish mismatch → typed race,
- expected/observed structured evidence,
- mutation failure but candidate current → success,
- published-advanced → typed race,
- diverged → typed race,
- expected-head/not-published → original failure,
- reconciliation failure does not invent race/success,
- original cause preserved when race established,
- generic `stale ref` message no retry,
- typed race with unrelated message retries,
- production retry bound three,
- Force publication-race compatibility preserved,
- recovery-replan Normal-only,
- both live wrappers typed + Normal-only,
- concurrent empty-repo loser replans,
- bootstrap failure without new state remains original,
- E2E compile includes shared type.

---

# 10. Observability

Log only structured non-secret publication fields:

```text
operation
attempt
phase
expected head
observed head
reconciliation status
cause class/message
```

Do not log tokens, passphrases, plaintext encrypted payloads, or conflict body contents.

Count outer logical publication retries separately from transport retries.

---

# 11. Acceptance Criteria

Complete only when:

- production retry no longer depends on stale-ref wording,
- candidate reconciler is central post-mutation classification authority,
- reconciliation failure itself never becomes false race/success evidence,
- candidate-head idempotent success is preserved,
- advanced/diverged evidence produces typed race,
- empty-repository concurrent initialization replans the full operation,
- non-evidenced bootstrap failures remain original errors,
- runtime preserves operation-agnostic publication-race retry + Normal-only recovery replan,
- repeated-race terminal UX is actionable,
- both live wrappers use typed race while remaining Normal-only,
- folder tests exercise actual folder events with multiple descendants,
- folder rename/delete/recreate/case/NFC outcomes assert path/byte/identity semantics,
- Copy + publication-race recovery proves exactly-once stage/copy behavior,
- production V4 causality changes only for a demonstrated failing regression.
