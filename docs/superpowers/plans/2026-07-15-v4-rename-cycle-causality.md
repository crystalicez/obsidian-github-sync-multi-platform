# V4 Rename-Cycle Causality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make unknown-base file and folder rename cycles retain rename provenance through conflict handling while preserving terminal delete/replacement causality.

**Architecture:** Extend the existing ordered causal identity replay with a historical set of identities that pass through rename events. Return only the intersection of that set with terminal identities, leaving the existing planner-base hash gate and conflict engine unchanged.

**Tech Stack:** TypeScript, Node test runner, esbuild test bundling, in-memory V4 Git/vault integration fixtures.

## Global Constraints

- Use strict RED -> GREEN TDD.
- Cover plaintext and encrypted coordinator-coalesced file cycles plus a nested folder cycle ending at its original root.
- Preserve all 139 existing tests and Round 9 terminal delete/replacement behavior.
- Append Round 9 and Round 10 evidence to `.superpowers/sdd/final-review-fix-report.md`.

---

### Task 1: Reproduce Surviving Rename Cycles

**Files:**
- Modify: `tests/v4/sync-session.test.ts`
- Test: `tests/v4/sync-session.test.ts`

**Interfaces:**
- Consumes: `coalesceV4Changes(changes: V4QueuedChange[]): V4QueuedChange[]`, `V4SyncSession.sync()`.
- Produces: regressions proving configured conflict resolution, no publication/journal mutation, stable identity, unchanged-cycle no-op, and independent Force Pull persistence.

- [ ] **Step 1: Write failing divergent file-cycle tests**

Add a mode-parameterized test that coalesces `A.md -> B.md -> A.md`, asserts the resulting `oldPath === path` rename, runs unknown-base sync with `conflictPolicy: "ask"`, returns `{ action: "use-remote" }`, and verifies the callback, original commit/object/journal set, remote content, file identity, and independent Force Pull.

- [ ] **Step 2: Write unchanged and folder-cycle tests**

Add mode-parameterized unchanged-content file cycles expecting `noop`, and one nested folder `A -> B -> A` cycle with one divergent and one unchanged descendant expecting conflict-policy pull without publication.

- [ ] **Step 3: Verify RED**

Run:

```text
node ./node_modules/esbuild/bin/esbuild tests/v4/sync-session.test.ts --bundle --platform=node --format=esm --target=node22 --alias:obsidian=./tests/stubs/obsidian.ts --outfile=.tmp/sync-session-round10.mjs
node --test --test-name-pattern "rename cycle|folder cycle" .tmp/sync-session-round10.mjs
```

Expected: divergent cycle tests fail because the conflict callback is not invoked and local bytes are published directly. Unchanged tests may already pass and protect existing behavior.

### Task 2: Intersect Rename Provenance with Terminal Identities

**Files:**
- Modify: `src/lib/v4/sync-session.ts`
- Test: `tests/v4/sync-session.test.ts`

**Interfaces:**
- Consumes: the ordered `identities` map and queued `rename`/`folderRename` events inside `causalIdentityState()`.
- Produces: `survivingCausallyRenamedFileIds`, containing identities that both passed through a rename and remain in the terminal virtual state.

- [ ] **Step 1: Implement the minimal replay-time provenance set**

Create `passedThroughRenameFileIds`. Add a file identity on every successful file rename, including same-path renames, and every moved folder descendant. Build `survivingCausallyRenamedFileIds` from terminal identity values filtered by membership in that set.

- [ ] **Step 2: Verify focused GREEN**

Rebuild the focused test bundle and rerun the cycle pattern. Expected: every focused cycle test passes, including unchanged no-op behavior and prior terminal-chain tests.

- [ ] **Step 3: Append review reports**

Append exact Round 9 and Round 10 root causes, fixes, RED/GREEN evidence, persisted-state guarantees, full verification, and concerns to `.superpowers/sdd/final-review-fix-report.md`.

- [ ] **Step 4: Run final verification**

Run:

```text
npm test
npm run build
git diff --check
```

Expected: all tests pass, build exits zero, and no whitespace errors are reported.

- [ ] **Step 5: Commit**

Stage the production code, tests, and plan; the report remains ignored. Commit with:

```text
git commit -m "fix: preserve V4 rename-cycle causality"
```
