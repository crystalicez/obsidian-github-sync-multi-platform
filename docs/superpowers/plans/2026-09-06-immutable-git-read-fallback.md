# Immutable Git Read Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace immutable commit-SHA Contents-404 recursive-tree recovery with exact path-directed non-recursive Git traversal that is resource-bounded and fail-closed on incomplete or malformed evidence.

**Architecture:** Keep the public `GitHubClient.getFileBytes()` API unchanged. Add private validation/traversal helpers inside `src/lib/github-api.ts`; the resolver reads the commit root tree, walks one exact path segment per non-recursive tree request, and fetches only the final supported blob. `null` is emitted only from complete evidence; malformed/truncated/unsupported evidence throws. No retained tree cache is introduced.

**Tech Stack:** TypeScript, Obsidian `requestUrl`, Node test runner, existing GitHubClient transport scheduler/resource controller.

**Spec:** `docs/superpowers/specs/2026-08-30-immutable-git-read-fallback-design.md`

## Global Constraints

- Fallback activation remains restricted to 40-hex immutable commit identifiers.
- No immutable-404 fallback request may contain `recursive=1`.
- Exact path semantics only: no case folding, Unicode normalization, dot-segment collapsing, or alternate-path reinterpretation.
- Absence requires `truncated === false` at the tree level that proves absence.
- Positive exact-entry evidence may be used even when that tree reports `truncated=true`.
- Duplicate exact names and malformed required node fields throw.
- Final supported regular blobs are only `(type=blob, mode=100644|100755)`.
- Final tree/gitlink means requested regular file is absent; symlink and unsupported mode/type combinations throw.
- Ordinary successful Contents behavior and mutable-ref 404 behavior remain unchanged.
- No retained Git-tree cache.

---

### Task 1: Request-Level Evidence Contract

**Files:**
- Modify: `tests/v4/github-immutable-read-fallback.test.ts`

**Interfaces:**
- Consumes: `GitHubClient.getFileBytes(path, ref)` and `setRequestUrlHandler`.
- Produces: request-level regression coverage for exact traversal, complete absence, malformed/incomplete evidence, object policy, and resource shape.

- [ ] **Step 1: Replace recursive fallback expectations with non-recursive path traversal expectations.**

Use 40-hex commit/tree/blob object IDs in fixtures and assert deep paths request only the root tree and the exact descendant trees.

- [ ] **Step 2: Add success cases.**

Cover root blob, deep blob, spaces/punctuation/Unicode, executable `100755`, and positive exact entry in a `truncated=true` tree.

- [ ] **Step 3: Add confirmed-absence cases.**

Cover missing final/intermediate segment in `truncated:false`, intermediate non-tree, final tree, and final gitlink.

- [ ] **Step 4: Add fail-closed cases.**

Cover missing segment with truncated/missing/null/non-boolean completeness, duplicate exact entries, malformed path/type/mode/SHA fields, symlink `120000`, unsupported mode/type pairs, invalid commit root tree SHA, tree failure, and blob failure.

- [ ] **Step 5: Add compatibility/resource assertions.**

Assert mutable-ref 404 remains `null`, successful Contents remains direct, no URL contains `recursive=1`, and unrelated subtrees are never requested.

- [ ] **Step 6: Commit tests before implementation.**

Commit message: `test: specify immutable git path fallback contract`.

### Task 2: Path-Directed Immutable Resolver

**Files:**
- Modify: `src/lib/github-api.ts`
- Test: `tests/v4/github-immutable-read-fallback.test.ts`

**Interfaces:**
- Consumes: existing `getGitCommit`, `getTreeAt(treeSha, false)`, and `getBlob`.
- Produces: private immutable path traversal used only after Contents 404 for a 40-hex commit ref.

- [ ] **Step 1: Add exact path validation.**

Reject empty path/segments and `.`/`..` segments without normalizing the caller's path.

- [ ] **Step 2: Validate commit root tree SHA.**

Require a 40-hex SHA from the immutable commit response before traversal.

- [ ] **Step 3: Fetch one non-recursive tree per path level.**

For each segment, require a tree array and validate every candidate entry needed for exact-name authority (`path`, `type`, `mode`, `sha`). Detect duplicate exact names before choosing one.

- [ ] **Step 4: Apply completeness rules.**

If exact segment exists, positive evidence wins even when `truncated=true`. If absent, return `null` only for `truncated === false`; otherwise throw incomplete-evidence error.

- [ ] **Step 5: Apply intermediate object policy.**

Descend only through valid tree entries. A valid non-tree exact intermediate entry proves the requested deeper regular file absent. Unsupported/malformed mode/type data throws rather than silently descending or selecting.

- [ ] **Step 6: Apply final object policy.**

Fetch modes `100644` and `100755`; return `null` for final tree/gitlink; throw explicit symlink managed-path error for `120000`; throw for unsupported/mismatched combinations.

- [ ] **Step 7: Preserve all unexpected failures.**

Do not catch commit/tree/blob/transport failures into `null`.

- [ ] **Step 8: Commit implementation.**

Commit message: `feat: traverse immutable git paths without recursive trees`.

### Task 3: Compatibility and Resource Review

**Files:**
- Review: `src/lib/github-api.ts`
- Review: `tests/v4/github-immutable-read-fallback.test.ts`

**Interfaces:**
- Consumes: Task 1 and Task 2.
- Produces: reviewed Child D branch suitable for final combined verification after the remaining implementation sequence.

- [ ] **Step 1: Confirm fallback boundary.**

Verify only immutable 40-hex Contents-404 enters the Git traversal; mutable branch 404 and successful Contents paths remain unchanged.

- [ ] **Step 2: Confirm request/resource shape.**

Verify no fallback call passes `recursive=true`, deep success is `1 commit + depth tree + 1 blob`, and no cache/Map was added.

- [ ] **Step 3: Review malformed evidence semantics.**

Ensure `null` is reachable only from explicit complete absence or valid tree/gitlink/non-tree structural absence; incomplete evidence and malformed nodes throw.

- [ ] **Step 4: Perform available isolated verification.**

Attempt TypeScript/runtime verification in the current environment where practical; defer the repository-wide `pnpm` suite to the final user-run verification as instructed.

- [ ] **Step 5: Open/update stacked draft PR.**

Base Child D on `child-c-publication-race-conflict-recovery` until Child C is merged, document dependency and deferred final test execution.
