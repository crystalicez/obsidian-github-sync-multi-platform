# Encrypted Snapshot Object Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace threshold-driven encrypted sync with an adaptive encrypted snapshot object store that is safe for multi-device use and fast for real Obsidian watcher bursts.

**Architecture:** Build a v2 encrypted remote layout alongside the current encrypted sync engine, then migrate traffic phase-by-phase. The new layout uses append-only encrypted snapshots, a CAS-protected encrypted head pointer, content-addressed encrypted objects/packs, event batching, and delayed garbage collection.

**Tech Stack:** TypeScript, Obsidian plugin APIs, GitHub Contents/Git APIs through `src/lib/github-api.ts`, Web Crypto helpers already in `src/lib/encrypted/crypto.ts`, node:test regression suites.

---

## File Structure

- Create `src/lib/encrypted/snapshot-types.ts`: v2 remote layout types for head pointers, snapshots, file records, tombstones, generation IDs, and CAS errors.
- Create `src/lib/encrypted/snapshot-store.ts`: encrypted read/write helpers for `.obsidian-github-sync-v2/head.enc` and `snapshots/<id>.enc`, with CAS head updates.
- Create `src/lib/encrypted/change-queue.ts`: debounce/batch local watcher events into change sets.
- Create `src/lib/encrypted/sync-planner.ts`: cost model that chooses loose object, pack shard, chunked object, or compaction based on pending changes and current layout.
- Create `src/lib/encrypted/gc-policy.ts`: delayed object/pack deletion rules based on retention generation and age.
- Modify `src/lib/encrypted/sync-engine.ts`: route encrypted sync through v2 when initialized, keep v1 read/migration compatibility.
- Modify `src/lib/fs.ts`: queue encrypted watcher events instead of immediate per-file upload when v2 is active.
- Test in `tests/encrypted/snapshot-store.test.ts`, `tests/encrypted/change-queue.test.ts`, `tests/encrypted/sync-planner.test.ts`, and extend `tests/github-e2e/real-github-e2e.test.ts` with real 2,000-file watcher-burst benchmark.

## Task 1: Snapshot Types and CAS Head Store

**Files:**
- Create: `src/lib/encrypted/snapshot-types.ts`
- Create: `src/lib/encrypted/snapshot-store.ts`
- Test: `tests/encrypted/snapshot-store.test.ts`

- [ ] **Step 1: Write failing tests**

Create tests that assert:
- `writeSnapshot()` stores snapshots under opaque IDs.
- `loadHead()` returns `null` for a missing head.
- `updateHeadCas()` succeeds when the expected SHA matches.
- `updateHeadCas()` throws `SnapshotHeadCasError` when the expected SHA is stale.
- snapshot/head plaintext JSON is never written directly to remote.

- [ ] **Step 2: Run red test**

Run: `npm test -- tests/encrypted/snapshot-store.test.ts`
Expected: compile failure because snapshot store files do not exist yet.

- [ ] **Step 3: Implement minimal store**

Use existing `encryptJson`, `decryptJson`, `deriveEncryptionKey`, `toBase64Url`, and `randomBytes`. Store remote files under `.obsidian-github-sync-v2/head.enc` and `.obsidian-github-sync-v2/snapshots/<snapshotId>.enc`.

- [ ] **Step 4: Run green test**

Run: `npm test -- tests/encrypted/snapshot-store.test.ts`
Expected: PASS.

## Task 2: Snapshot Merge Semantics for Multi-Device Safety

**Files:**
- Modify: `src/lib/encrypted/snapshot-types.ts`
- Create: `src/lib/encrypted/snapshot-merge.ts`
- Test: `tests/encrypted/snapshot-merge.test.ts`

- [ ] **Step 1: Write failing tests**

Create tests for:
- stale device adds a different file and merges with newer remote head.
- stale device edits the same path and receives a conflict action instead of overwriting.
- delete tombstones are preserved across merge.
- rename is represented as tombstone old path plus create new path.

- [ ] **Step 2: Implement three-way merge**

Inputs: base snapshot, local snapshot, remote snapshot. Output: merged snapshot plus conflicts. Never discard a remote generation silently.

## Task 3: Adaptive Change Queue

**Files:**
- Create: `src/lib/encrypted/change-queue.ts`
- Modify: `src/lib/fs.ts`
- Test: `tests/encrypted/change-queue.test.ts`

- [ ] **Step 1: Write failing tests**

Assert that 2,000 create/modify events become one batched change set after debounce, repeated typing collapses to the latest path state, rename+modify coalesces to one final path, and delete removes pending modify.

- [ ] **Step 2: Implement queue**

Expose `enqueueEncryptedChange(plugin, change)` and `flushEncryptedChanges(plugin)`. Keep current status bar waiting/syncing UX.

## Task 4: Cost-Based Sync Planner

**Files:**
- Create: `src/lib/encrypted/sync-planner.ts`
- Test: `tests/encrypted/sync-planner.test.ts`

- [ ] **Step 1: Write failing tests**

Assert planner chooses:
- pack for initial snapshots with many small files regardless of exact threshold cliffs.
- loose delta for one edited file after a packed base.
- chunked object for GitHub-large files.
- compaction when loose deltas exceed request or size budgets.

- [ ] **Step 2: Implement planner**

Use explicit cost budgets: max request count, max loose delta count, max pack bytes, max pack file count, and current remote layout.

## Task 5: V2 Sync Engine Routing and V1 Migration

**Files:**
- Modify: `src/lib/encrypted/sync-engine.ts`
- Modify: `src/lib/encrypted/manifest-store.ts`
- Test: `tests/encrypted/e2e-sync.test.ts`

- [ ] **Step 1: Write failing tests**

Assert existing v1 encrypted repos can be read and migrated to v2 snapshot format without plaintext remote paths, wrong passphrase still fails specifically, and force pull from v2 reconstructs the vault.

- [ ] **Step 2: Implement routing**

Prefer v2 if `.obsidian-github-sync-v2/head.enc` exists. Otherwise read v1 and write first v2 snapshot after successful sync.

## Task 6: Delayed GC and Compaction

**Files:**
- Create: `src/lib/encrypted/gc-policy.ts`
- Modify: `src/lib/encrypted/sync-engine.ts`
- Test: `tests/encrypted/gc-policy.test.ts`

- [ ] **Step 1: Write failing tests**

Assert compacted old packs are retained inside grace period, deleted only after retention policy passes, and snapshots still referenced by stale devices keep objects alive.

- [ ] **Step 2: Implement delayed deletion**

Never delete objects/packs during the same transaction that makes them obsolete. Write GC metadata and perform cleanup only after safe retention.

## Task 7: Real GitHub E2E Stress Coverage

**Files:**
- Modify: `tests/github-e2e/real-github-e2e.test.ts`
- Modify: `scripts/run-github-e2e.mjs`

- [ ] **Step 1: Add destructive stress profile**

Add a real GitHub test that creates 2,000 files, emits watcher-like local changes, verifies pack/delta layout, records total requests and elapsed time, and compares against a max request budget.

- [ ] **Step 2: Run stress profile**

Run: `npm run test:github-e2e -- --profile=stress`
Expected: remote contains v2 encrypted snapshots/packs, no plaintext paths, no thousands of object uploads.

## Verification Gates

- [ ] `npm test`
- [ ] `npm run build`
- [ ] `git diff --check`
- [ ] `npm run test:github-e2e:quick`
- [ ] Stress profile before release: `npm run test:github-e2e -- --profile=stress`