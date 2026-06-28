---
name: scrutinize
description: Runtime-aware code review and bug-hunt for code agents. Use on PRs, diffs, full files, feature changes, and suspected-but-not-yet-reproduced bugs when the expected output is actionable findings, hidden runtime risks, test gaps, and a verdict. Prefer this over a normal review when the user says the code passes review but fails in real use. If the user gives a concrete failing input, stack trace, production incident, or reproducible error, switch into Debug Mode inside this skill and prioritize reproduction before general review.
---

# Scrutinize

Review the code as an outsider, but assume real bugs hide in the gap between the diff, tests, mocks, environment, and production behavior. The diff is only the entry point; runtime paths are the scope.

## Operating stance

* **Skeptical of passing tests:** tests can prove only the exercised paths. Do not infer that untested runtime paths work.
* **Runtime-first:** prioritize behavior that can fail in real execution: state, I/O, async timing, config, environment, permissions, integration, and data shape.
* **Evidence-backed, but not evidence-blind:** findings need evidence. Risks without enough evidence must be reported separately as `Unverified risk`, with the exact missing evidence needed to confirm or dismiss it.
* **Path-oriented:** trace entry point → caller → branch → state/I/O → side effect → result → user-visible behavior.
* **Actionable:** every finding or risk must say what to change and how to verify.
* **No false certainty:** never say “no bugs found” unless the relevant runtime paths were traced and, when possible, executed.

## Mode selection

Start by selecting one mode:

1. **Review Mode:** use when given a diff, PR, design, or code change without a concrete failure.
2. **Bug-Hunt Mode:** use when the user says bugs still happen in real use but gives no exact reproduction.
3. **Debug Mode:** use when the user gives a concrete failure, stack trace, bad output, log, or reproducible input.

If in Debug Mode, stop broad review until the failure path is reproduced or the missing reproduction data is named.

## Required input inventory

List what you have and what is missing:

* changed files or full files
* related unchanged files
* entry points/routes/components/jobs/commands
* expected behavior
* observed behavior, if any
* test files and test command
* build/lint/typecheck command
* runtime environment, flags, config, dependency versions
* logs, stack traces, sample data, screenshots, network payloads

If key context is missing, continue with a best-effort static review, but mark the limit clearly in the verdict.

## Workflow

### 1. Intent and simpler alternative

State the goal in one sentence.

Before reviewing details, ask whether the change should exist at all. Look for:

* doing nothing because the problem is not load-bearing
* using existing code or platform behavior
* a smaller or lower-risk change
* a config/framework/build/runtime-layer solution instead of new code
* solving 90% of the goal with much less surface area

If a better alternative exists, lead with it.

### 2. Build a runtime map

Identify every real path touched by the change:

* external entry points: UI action, HTTP route, CLI command, cron/job, message consumer, webhook, migration, script
* internal callers and callback paths
* data sources and sinks: database, cache, file, network, queue, local storage, session, cookies
* state ownership and lifecycle
* auth/permission boundary
* error and retry boundary
* feature flags/config/env vars
* serialization/wire/persisted formats
* concurrency/ordering assumptions

For each path, record whether it was:

* **executed** with command/output
* **statically traced** with file:line evidence
* **assumed** because context is missing

### 3. Reproduce or simulate failure paths

When tools/repo are available, run the cheapest useful checks before finalizing:

* install/build/typecheck/lint only when safe and available
* focused tests for changed code
* targeted unit/integration tests around the traced path
* minimal script or REPL call for pure functions
* snapshot or DOM rendering only when UI behavior depends on rendering

Do not spend time on broad commands if a narrower command can verify the risk.

If commands cannot be run, say exactly which command should be run and what result would confirm the issue.

### 4. Verify claims against behavior

For each important claim, use this structure internally:

* **Claim:** what the PR/code/comment/test implies will happen.
* **Trace:** what path actually runs.
* **Runtime check:** command, test, manual scenario, or reason it could not be executed.
* **Result:** proven, refuted, or unverified.

Never accept mocks as proof of integration behavior unless the mock contract is verified against the real dependency.

### 5. Runtime bug checklist

Check only relevant items, but be explicit about high-risk misses:

* null/undefined/empty/malformed/huge/unicode input
* wrong data shape from API/database/cache
* stale cache, stale closure, stale props, stale memoized state
* async ordering, race condition, cancellation, double-submit, retry, idempotency
* partial failure between multiple writes or side effects
* auth, permissions, tenant/user scoping, privacy leaks
* timezone, date boundaries, locale, currency/number parsing
* environment differences: dev/prod, browser/server, mobile/desktop, OS, Node/runtime version
* feature flags, config defaults, missing env vars
* dependency version/API mismatch
* serialization/persisted format compatibility
* error semantics and fallback behavior
* performance under realistic data size
* observability: whether logs/metrics/errors expose the failure
* UI behavior: loading/empty/error states, accessibility-critical flows, hydration/client-server mismatch

### 6. Test gap audit

For each material risk, inspect tests and ask:

* Does a test exercise the real entry point, not only an implementation detail?
* Could mocks hide the bug?
* Does the test assert the user-visible or persisted result?
* Is there a negative case for malformed/empty/permission-denied/partial-failure state?
* Is there an integration or contract test where a unit test is insufficient?

### 7. Report

Report material findings first, ordered by severity:

1. blocker
2. major
3. minor
4. nit

Each finding must include:

* **Severity / category**
* **Finding:** one specific sentence
* **Why it matters:** concrete consequence
* **Evidence:** file:line, trace, command output, input, or test gap
* **Suggested change:** minimal actionable fix
* **Test:** test to add or update

Then report unverified but plausible runtime risks separately:

* **Unverified risk:** one sentence
* **Why it might happen:** concrete path or condition
* **Missing evidence:** exact file, log, command, data sample, or environment detail needed
* **How to verify:** smallest test/manual scenario/command

If no findings are proven, do not say only “LGTM.” State:

* paths traced
* checks executed
* risks checked
* important paths not covered
* why the review can or cannot support shipping

Always close with:

**Verdict:** ship / fix-then-ship / rework / reject — plus the single biggest reason.

## Rules

* No rubber-stamps.
* Cite or it did not happen.
* Distinguish proven findings from unverified risks.
* Do not convert missing evidence into confidence.
* Do not stop after the first finding unless blocked by missing access, underspecification, or a deliberately narrow request.
* Do not pad with style nits when runtime risk exists.
* Prefer one reproduced bug over ten speculative comments.
* If a concrete failure is provided, Debug Mode takes priority over general review.
