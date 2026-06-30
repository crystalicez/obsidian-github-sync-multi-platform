# GitHub Native Sync V3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the sync hot path with a GitHub Git-API native v3 architecture that uses branch head, tree, commit, and ref CAS for maximum speed and correctness without invoking git.

**Architecture:** Add Git database primitives first, then build a v3 atomic commit writer used by encrypted and plaintext sync. Encrypted mode moves from pack rewrite to base-pack plus loose-delta DAG and compaction; plaintext mode uses Git tree/head cache to avoid full remote scans when the branch has not changed.

**Tech Stack:** TypeScript, Obsidian requestUrl, GitHub REST Git APIs, Web Crypto, node:test, existing real GitHub e2e harness.

---

## File Structure

- Modify `src/lib/github-api.ts`: add Git ref, commit, tree, blob, and atomic ref update methods.
- Create `src/lib/github-git-types.ts`: shared Git API response/input types.
- Create `src/lib/v3/git-atomic-writer.ts`: batches blob/tree/commit/ref writes into one atomic branch update.
- Create `src/lib/v3/remote-cache.ts`: branch-head and tree-cache helpers for plaintext and encrypted fast paths.
- Create `src/lib/encrypted/v3-types.ts`: encrypted DAG object, snapshot, delta, compaction, and head records.
- Create `src/lib/encrypted/v3-planner.ts`: chooses loose delta, base pack, chunked object, and compaction.
- Modify `src/lib/encrypted/sync-engine.ts`: route encrypted normal sync to v3 after initialization.
- Modify `src/lib/fs.ts`: route plaintext normal sync through v3 tree-cache when available.
- Extend `tests/encrypted/error-handling.test.ts`: Git API HTTP handling.
- Add `tests/v3/git-atomic-writer.test.ts`, `tests/v3/remote-cache.test.ts`, `tests/encrypted/v3-planner.test.ts`.
- Extend `tests/github-e2e/real-github-e2e.test.ts`: v3 request counts, stale-ref retry, random/stress verification.

## Task 1: GitHub Git API Primitives

**Files:**
- Modify: `src/lib/github-api.ts`
- Create: `src/lib/github-git-types.ts`
- Test: `tests/encrypted/error-handling.test.ts`

- [ ] Write failing tests for `getGitRef`, `createGitBlob`, `createGitTree`, `createGitCommit`, and `updateGitRef`.
- [ ] Run `npm test -- tests/encrypted/error-handling.test.ts` and verify compile/runtime failure from missing methods.
- [ ] Implement methods with explicit HTTP status errors and no caching on reads.
- [ ] Run `npm test -- tests/encrypted/error-handling.test.ts` and verify pass.

## Task 2: Atomic Commit Writer

**Files:**
- Create: `src/lib/v3/git-atomic-writer.ts`
- Test: `tests/v3/git-atomic-writer.test.ts`

- [ ] Write failing tests showing multiple path changes become one commit and stale ref throws a typed conflict.
- [ ] Implement tree overlay creation, commit creation, and CAS ref update.
- [ ] Run `npm test -- tests/v3/git-atomic-writer.test.ts` and verify pass.

## Task 3: Remote Head Cache

**Files:**
- Create: `src/lib/v3/remote-cache.ts`
- Test: `tests/v3/remote-cache.test.ts`

- [ ] Write failing tests that unchanged branch head skips recursive tree load and changed head refreshes cache.
- [ ] Implement branch-head comparison and safe invalidation.
- [ ] Run targeted tests.

## Task 4: Encrypted V3 DAG Planner

**Files:**
- Create: `src/lib/encrypted/v3-types.ts`
- Create: `src/lib/encrypted/v3-planner.ts`
- Test: `tests/encrypted/v3-planner.test.ts`

- [ ] Write failing tests for small delta, initial base pack, large chunked object, and compaction threshold.
- [ ] Implement planner using request and byte budgets.
- [ ] Run targeted tests.

## Task 5: Encrypted V3 Sync Routing

**Files:**
- Modify: `src/lib/encrypted/sync-engine.ts`
- Test: `tests/encrypted/e2e-sync.test.ts`

- [ ] Write failing tests that one-file edit in packed vault uploads a loose delta, not a rewritten pack.
- [ ] Implement v3 normal sync path behind v3 initialization.
- [ ] Preserve force operations and wrong-passphrase UX.
- [ ] Run encrypted e2e tests.

## Task 6: Plaintext V3 Tree Fast Path

**Files:**
- Modify: `src/lib/fs.ts`
- Test: `tests/encrypted/e2e-sync.test.ts`

- [ ] Write failing tests that unchanged branch head skips `getTree` and changed head downloads only needed paths.
- [ ] Implement tree cache routing and conflict checks.
- [ ] Run plaintext behavior tests.

## Task 7: Real GitHub Verification

**Files:**
- Modify: `tests/github-e2e/real-github-e2e.test.ts`
- Modify: `scripts/run-github-e2e.mjs`

- [ ] Add request counters to real GitHub client wrapper.
- [ ] Add v3 stale-ref race test.
- [ ] Add v3 random/stress assertions for request budget and byte-for-byte final verify.
- [ ] Run `npm run test:github-e2e:full` and `npm run test:github-e2e:random`.

## Verification Gates

- [ ] `npm test`
- [ ] `npm run build`
- [ ] `git diff --check`
- [ ] `npm run test:github-e2e:full`
- [ ] `npm run test:github-e2e:random`