# Publication Race and Conflict Recovery Design

## Status

Child design of `2026-08-30-release-e2e-runtime-hardening-followup-design.md` for baseline `35e98cea924702293bde62d064a83d52eca6d898`.

Revised after formal red-team review on 2026-08-30. This child owns evidence-based publication-race classification, bounded/indeterminate reconciliation, empty-repository/config-discovery races, retry UX, missing folder-causality evidence, and Copy-conflict recovery integration.

## Goal

Replace stale-ref message heuristics with structured Git-state evidence while preserving current user-visible retry behavior and proving folder/Copy recovery semantics before changing V4 causality.

## Non-goals

This child does not add server-side CAS GitHub does not provide, redesign the planner/coordinator wholesale, change local-primary Copy policy, change Force Push/Force Pull behavior beyond preserving current publication-race retry compatibility, add watcher-noise behavior without a deterministic production-relevant regression, or expand recovery assertions into the fast tier.

---

# 1. Existing Retry Compatibility

Production runtime currently has two distinct retry policies:

```text
publication/stale-head wording
-> retry regardless of operation
-> maximum three outer attempts

V4RecoveryReplanRequiredError
-> retry only for Normal
-> maximum three outer attempts
```

The typed migration preserves that behavior:

```text
V4PublicationRaceError
-> retry regardless of request.operation

V4RecoveryReplanRequiredError
-> retry only when request.operation == normal
```

The two live E2E wrappers currently retry stale-head wording only for Normal sync; they keep that harness policy after migrating to the typed predicate:

```text
tests/github-e2e/v4-real-github-e2e.test.ts
tests/github-e2e/v4-copy-contract-github-e2e.test.ts
```

Production and live harness therefore share race classification but intentionally not identical retry policy.

---

# 2. Structured Publication-Race Error

Introduce one shared error type/predicate, conceptually:

```ts
V4PublicationRaceError {
  code: "V4_PUBLICATION_RACE"
  phase: "bootstrap-config" | "bootstrap-publish" | "pre-publish" | "post-publish"
  expectedHeadSha: string | null
  observedHeadSha: string | null
  publicationOutcome: "published" | "not-published" | "unknown"
  cause?: unknown
}
```

Exact naming/file placement is a plan detail.

Retry decisions use this type/predicate only, never message regex.

Structured fields are for recovery/logging/diagnostics. The user-facing terminal message remains concise and does not expose raw SHA/CAS internals by default.

---

# 3. Reconciler Is the Post-Mutation Classification Authority

## 3.1 One state machine

`reconcileV4CandidatePublication()` remains the central authority for post-mutation evidence. Do not add a second independent stale-head classifier around ad-hoc ref reads.

The result model must distinguish:

```text
published
published-advanced
not-published
indeterminate
```

A separately named `diverged` state may remain only if it represents evidence stronger than the indeterminate cases below; it must not be returned merely because an evidence traversal stopped early.

## 3.2 Evidence mapping

After any ref mutation failure where reconciliation can be attempted:

```text
candidate is current head
-> treat mutation as successful
-> no outer retry

candidate/marker-equivalent is proven in current ancestry and branch advanced
-> V4PublicationRaceError
   publicationOutcome = published

expected head is still current
-> preserve original mutation failure
-> for outcome-unknown transport failures, retain the existing single evidence-based low-level retry policy

current head differs from expected and candidate publication cannot be proven
-> outer operation must replan
-> V4PublicationRaceError
   publicationOutcome = unknown

reconciliation cannot even establish trustworthy current-head state
-> do not invent race/success
-> preserve original mutation failure as primary failure
```

This handles both outcome-unknown and definitive API failures such as a competing ref update that returns a validation error.

## 3.3 Pre-publish mismatch

Immediately before candidate ref mutation:

```text
observed current head != expected candidate base
-> V4PublicationRaceError(
     phase = pre-publish,
     publicationOutcome = not-published,
     expected = candidate base,
     observed = current head
   )
-> no mutation attempt
```

## 3.4 Cause preservation

When race evidence is derived after an API/transport failure, preserve the original failure as diagnostic cause.

---

# 4. Bounded Traversal and Indeterminate Evidence

The current reconciler bounds ancestry traversal. A bound is necessary for resource control, but exhausting it is not proof that the candidate is unrelated.

Example:

```text
candidate published
-> branch advances more than traversal bound
-> later recovery cannot reach candidate within bound
```

Returning a definitive unrelated/diverged result in that case would overstate evidence.

Required semantics:

- if queue/traversal completes and all required reads succeeded, use the strongest proven result,
- if traversal bound is exhausted while unexplored ancestry remains, return `indeterminate`,
- if an ancestry commit needed for classification cannot be read, return `indeterminate` rather than silently skipping it into a definitive negative conclusion,
- cancellation still propagates as cancellation,
- `indeterminate` records known current head plus reason such as `traversal-limit` or `ancestry-read-failure`.

For runtime publication handling, `indeterminate` plus a current head different from expected is enough to require an outer replan, but it is **not** evidence that the candidate was or was not previously published.

For recovery, indeterminate publication history must never populate `verifiedRemoteHead` as though candidate publication were proven. Recovery moves to conservative replan-required state while retaining stable conflict-copy identity/stages only under their existing safe lifetime rules.

---

# 5. Empty-Repository Races

## 5.1 Publish-time concurrent initialization

Two devices may observe an empty repository/branch and race to initialize it.

When one create-ref/bootstrap writer loses and re-observation shows another writer's head now exists:

```text
V4PublicationRaceError(
  phase = bootstrap-publish,
  expectedHeadSha = null,
  observedHeadSha = new head,
  publicationOutcome = unknown,
  cause = original mutation failure
)
```

The outer runtime retries and replans from fresh remote/config/index state. The losing session never silently adopts the new head inside a plan derived from empty-remote assumptions.

If bootstrap fails and no new remote state can be proven, preserve the original failure.

## 5.2 Remote appears after speculative config discovery

There is an earlier race before publication:

```text
runtime observes no V4 remote
-> runtime creates speculative new config (encrypted mode may create new random KDF salt)
-> another device initializes V4
-> session starts and sees winner's remote config
```

The session must not proceed to decode/decrypt remote state with the speculative loser's config/keyring.

Required design:

- runtime/session carry whether the selected config came from observed remote state or was speculative for an empty remote,
- when a speculative-empty config reaches session startup, remote config existence is checked before using the speculative codec/keyring for remote state,
- if another valid V4 remote now exists, throw `V4PublicationRaceError` with phase `bootstrap-config` and replan the whole outer operation,
- next attempt loads the winner's actual config/KDF and derives the correct keyring fresh,
- malformed/non-V4 remote state still follows existing explicit migration/Force Push errors rather than being mislabeled automatically as a race.

This test is required for plaintext and especially encrypted mode so a recoverable concurrent initialization cannot surface as a misleading authentication/decryption failure.

---

# 6. Runtime Retry and User Flow

One user-triggered sync action owns one logical `runState` and up to three outer attempts.

On publication race:

- progress becomes `retrying`,
- attempt number advances,
- remote config/index/recovery state are loaded fresh,
- planning is recomputed,
- stable logical Copy reservations in the same `runState` remain available where current recovery contract requires them.

Attempts 1->2->3 are transparent except progress.

If the final attempt still ends in publication race, user-facing error is actionable, for example:

```text
Remote branch changed repeatedly while syncing. Please try again.
```

Structured logs retain operation, attempt, phase, expected/observed head, publication outcome/evidence, and cause without secrets/plaintext payloads.

A generic `new Error("stale ref")` is not retryable unless publication code converted it from actual Git-state evidence. A typed race remains retryable even when its human message contains no stale/race wording.

---

# 7. Live-E2E Retry Consumers

Both precompiled live bundles migrate from regex classification to the shared race predicate:

```text
v4-real-github-e2e.test.ts
v4-copy-contract-github-e2e.test.ts
```

Their harness behavior remains:

```text
V4PublicationRaceError
AND operation == normal
AND attempt < 3
-> retry
```

Force operations do not gain harness-level retry behavior.

Harness-specific conflict-stage clearing may remain because these wrappers do not model the complete production recovery-store lifecycle.

The CI E2E compile artifact from Child B must bundle the shared error predicate successfully.

---

# 8. Folder Conflict Evidence Before Core Changes

For every folder regression:

```text
write deterministic regression
run against current production
PASS -> do not change V4 causality
FAIL -> keep failing regression and make smallest correction
```

Tests exercise actual queued folder events, not synthetic independent file renames:

```text
{ type: "folderRename", oldPath: "folder", path: "moved" }
{ type: "folderDelete", path: "folder" }
```

Each primary scenario starts with at least:

```text
folder/edited.md
folder/untouched.md
```

Only `edited.md` receives stale competing modification. `untouched.md` proves one-sided folder propagation for a sibling under the same event.

Required scenarios/expected contract:

### Remote folder rename vs stale edited descendant

- stale edited lineage remains canonical at original path/identity,
- remote competitor from renamed path is preserved exactly once as conflict copy,
- untouched sibling follows remote rename and keeps identity,
- no duplicate/intermediate paths,
- fresh-device convergence.

### Remote folder delete vs stale edited descendant

- stale locally edited file remains canonical/original identity,
- no absent-body conflict copy,
- untouched sibling follows remote deletion,
- fresh-device convergence.

### Remote folder delete vs stale delete/recreate descendant

- recreated canonical path survives with new identity,
- old identity remains deleted,
- untouched sibling follows remote deletion,
- no absent-body conflict copy.

### Nested folder rename chain

Exercise one logical batch where possible:

```text
folder -> middle
middle -> final
```

Final filesystem state is `final/*`; stale edited lineage/conflict semantics remain correct; untouched sibling reaches `final/untouched.md`; no `middle/*` survives.

### Case-only rename

Multiple descendants preserve identities and do not create conflict copies when no normalized-namespace collision exists.

### NFC/case namespace collision

Different identities that would occupy one `NFC + lowercase` namespace fail before mutation; no winner/conflict-copy workaround bypasses the namespace invariant.

Assertions cover exact paths, bytes, identities, conflict-copy count, no unrelated overwrite, and fresh-device convergence where valid.

---

# 9. Copy + Publication Race + Recovery Integration

Keep/add a fast runtime user-flow regression:

```text
one manual sync
-> first publication attempt races
-> automatic retry
-> visible attempt reaches 2
-> final success
```

Add a recovery-tier integration:

```text
shared base
-> local edit + remote competitor
-> Copy conflict reserves/stages remote copy
-> candidate publication races
-> reconcile/replan/recovery
-> exactly one final conflict copy
-> index/recovery reaches committed terminal boundary
```

Required assertions:

- local canonical bytes preserved,
- remote competitor preserved exactly once,
- logical conflict-copy path/file identity stable within run,
- invalid stale stages not reused,
- no duplicate conflict path/record,
- final remote/index agreement,
- recovery terminal boundary correct,
- fresh device converges.

Deep stage/recovery lifetime assertions remain under `tests/recovery/`.

---

# 10. Focused Publication Tests

Required regressions include:

- pre-publish mismatch -> typed race/no mutation,
- candidate current after failed response -> success/no outer retry,
- candidate ancestor/marker equivalent -> published-advanced typed race,
- expected head current -> original failure preserved,
- current head advanced but publication history unknown -> typed race with `publicationOutcome=unknown`,
- traversal bound exhausted -> indeterminate, never false definitive divergence,
- ancestry read failure -> indeterminate,
- current-head/ref read failure -> original mutation failure, not invented race,
- original failure retained as cause when race is derived,
- generic stale-ref wording does not retry,
- typed race with unrelated wording retries,
- runtime bound remains three,
- runtime Force Push/Force Pull publication-race retry compatibility preserved,
- recovery-replan remains Normal-only,
- both live wrappers typed + Normal-only,
- empty-ref competing initializer replans,
- remote V4 appearing after speculative config discovery replans before decrypt,
- encrypted version of that race derives winner keyring on retry,
- non-race bootstrap failure remains original failure,
- CI precompiled E2E bundle includes shared race type.

---

# 11. Acceptance Criteria

Complete only when message regex no longer controls production/live publication retry; reconciliation is the central post-mutation authority; bounded/incomplete ancestry evidence is explicitly indeterminate; candidate-head idempotent success is preserved; advanced head with uncertain publication outcome replans conservatively; reconciliation failure does not invent success/race without head evidence; both publish-time and pre-session empty-repository races replan the whole operation; encrypted speculative config cannot cause misleading decrypt failure after a concurrent initializer wins; runtime and E2E retry compatibility are preserved; actual multi-descendant folder events have deterministic evidence; Copy + publication-race recovery proves exactly-once conflict preservation; and production causality changes only for demonstrated failing regressions.
