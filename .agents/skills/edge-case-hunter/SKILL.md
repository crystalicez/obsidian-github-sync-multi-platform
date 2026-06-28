---

name: edge-case-hunter
description: Adversarial edge-case discovery for code agents. Use when asked to find weird edge cases, break a feature, stress behavior, harden tests, or uncover hidden failure modes. Map the real feature surface, build a compact interaction case tree, trace high-risk leaves through actual code paths, rank by impact, and propose minimal tests or fixes.
---

# Edge Case Hunter

Find realistic ways behavior can break before users, production data, time, concurrency, or external systems break it.

## Workflow

### 1. Pin expected behavior

State the intended behavior, invariants, and success criteria.

Identify the relevant surface:

* entry points and user flows
* inputs and outputs
* auth/permission boundaries
* persisted state and cache
* external systems
* feature flags/config
* existing tests and contracts

If behavior is unclear, state assumptions and proceed unless blocked.

### 2. Map the real path

Trace the actual behavior path, not just changed lines:

entry point → validation → business logic → state/cache/I/O → side effects → response/UI

Include related callers, downstream consumers, jobs, retries, migrations, old data, flagged/disabled states, and rollback paths when relevant.

### 3. Build a compact case tree

Create a selective tree of cases that can materially change the outcome.

Branch only on applicable dimensions:

* input shape
* auth/permission state
* persisted/cache state
* config or feature flag
* time/date boundary
* concurrency/retry/order
* external dependency result
* UI/client state
* version or contract compatibility

Combine branches only where interaction risk is real. Avoid full Cartesian explosion.

Prioritize interaction leaves such as:

* stale data + retry
* wrong role + cached response
* timezone boundary + scheduled job
* partial failure + idempotency
* old data + new validation
* feature flag off + downstream caller

Mark important leaves as:

* normal
* boundary
* suspicious
* high-risk
* already covered
* not applicable

### 4. Trace and test high-risk leaves

For each serious leaf:

* trace the actual code path it would take
* identify where it could violate an invariant
* classify impact and likelihood
* check whether existing tests cover the real path
* name the smallest test, repro, or experiment that would confirm it

Use these risk dimensions when relevant:

* data loss, corruption, crash, security/privacy, cross-user impact
* core-flow breakage or contract regression
* partial failure, retry, race, idempotency, ordering
* null, empty, malformed, duplicate, huge, unicode, boundary input
* old/migrated/deleted/stale/conflicting state
* timezone, DST, leap day, expiry, clock skew
* API/storage/wire-format compatibility
* loading, empty, error, disabled, rapid UI interaction
* N+1, pagination, memory growth, slow dependency
* missing logs, silent failure, misleading metrics

Realistic beats exhaustive.

### 5. Report material gaps

Report only edge cases worth acting on, ordered by risk.

Each finding includes:

* **Risk:** severity and category
* **Scenario:** concrete edge case
* **Trace:** path, file:line, state, or contract involved
* **Impact:** user/system consequence
* **Coverage:** covered / missing / unclear
* **Suggested test:** minimal failing test or repro
* **Suggested fix:** minimal fix if obvious

Close with:

**Highest-risk gap:** the one case most worth testing or fixing first.

## Rules

* Trace before claiming an edge case is real.
* Distinguish confirmed gaps from plausible risks.
* Do not report vague “could fail” claims without a concrete path or scenario.
* Do not duplicate existing coverage unless the test is weak or misses the real path.
* Do not propose broad rewrites when a targeted guard, test, validation, retry, or contract check is enough.
* If code, tests, or runtime evidence is missing, say what could not be verified.
* Prefer one high-value failing test over a long speculative list.
