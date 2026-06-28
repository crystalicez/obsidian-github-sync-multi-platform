# Scalable Encrypted Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a scalable encrypted sync foundation that can plan and process vaults with 100,000 files and about 5GB of data without reading all data into memory or creating one remote GitHub object per file.

**Architecture:** Add a pack planner that groups many plaintext files into bounded encrypted pack shards, plus pack metadata types that can be stored in manifests. The first implementation adds deterministic planning, simulation tests for 100k files/5GB, and a sync decision gate so large vaults use pack mode in follow-up wiring rather than object-per-file sync.

**Tech Stack:** TypeScript, Node test runner, existing encrypted sync modules, existing esbuild test bundler.

---

### Task 1: Pack Planner Foundation

**Files:**
- Create: `src/lib/encrypted/pack-planner.ts`
- Modify: `src/lib/encrypted/constants.ts`
- Modify: `src/lib/encrypted/types.ts`
- Test: `tests/encrypted/pack-planner.test.ts`
- Modify: `scripts/run-tests.mjs`
- Modify: `scripts/check-test-coverage.mjs`

- [ ] Add a failing test that generates 100,000 virtual file records totaling 5GiB and asserts all files are assigned to bounded pack shards.
- [ ] Add pack constants for max pack plaintext bytes and max files per pack.
- [ ] Implement deterministic `planEncryptedPacks()` with no file content reads.
- [ ] Verify `npm test` passes.

### Task 2: Pack Format Metadata

**Files:**
- Create: `src/lib/encrypted/pack-format.ts`
- Modify: `src/lib/encrypted/types.ts`
- Test: `tests/encrypted/pack-planner.test.ts`

- [ ] Add failing tests for stable pack object paths and pack manifest records.
- [ ] Implement pack path helpers and metadata structures.
- [ ] Verify `npm test` passes.

### Task 3: Scalable Mode Decision Gate

**Files:**
- Create: `src/lib/encrypted/scale-policy.ts`
- Test: `tests/encrypted/pack-planner.test.ts`
- Modify: `scripts/check-test-coverage.mjs`

- [ ] Add failing tests proving vaults over file-count or total-size thresholds choose pack mode.
- [ ] Implement `chooseEncryptedStorageMode()` returning `object` or `pack`.
- [ ] Verify `npm test` and `npm run build` pass.

### Task 4: Commit and Push

**Files:** all above.

- [ ] Run `git diff --check`.
- [ ] Run `npm test` and confirm all tests pass.
- [ ] Run `npm run build` and confirm build passes.
- [ ] Commit with `feat: add scalable encrypted pack planning`.
- [ ] Push `origin encrypted-sync`.
