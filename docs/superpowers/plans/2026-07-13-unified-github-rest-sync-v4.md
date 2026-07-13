# Unified GitHub REST Sync V4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver one GitHub REST sync engine with plaintext/encrypted parity, atomic batching, scalable indexes and storage, safety controls, automation, status, and history preview.

**Architecture:** A trigger-aware coordinator serializes operations and delegates read-only comparison to a three-way planner. Storage codecs map logical files to plaintext blobs or authenticated encrypted objects, while sharded indexes and commit journals provide incremental sync and history without recursive scans.

**Tech Stack:** TypeScript 5.9, Obsidian API 1.12, Web Crypto, GitHub REST Git Database APIs, Node test runner, esbuild.

## Global Constraints

- Retire all V1–V3 runtime modules and tests after equivalent V4 behavior is covered.
- Use TDD for every production behavior: add a failing test, observe the expected failure, implement minimally, then run the focused and full relevant suites.
- No git binary is required at plugin runtime; desktop and mobile use GitHub REST.
- One published Git commit contains all remote changes for one sync operation.
- Encrypted remote data may reveal folder hierarchy, object sizes, commit timing, and plugin use, but not basenames, contents, plaintext hashes, or secrets.
- Do not silently read or migrate plaintext history into encrypted mode.

---

### Task 1: V4 protocol, crypto, scope, and local index

**Files:**
- Create: `src/lib/v4/protocol-types.ts`, `crypto.ts`, `paths.ts`, `scope.ts`, `local-index.ts`
- Test: `tests/v4/protocol-core.test.ts`, `scope.test.ts`, `local-index.test.ts`

**Interfaces:**
- Produces `V4RemoteConfig`, `V4RemoteHead`, `V4FileRecord`, `V4LocalIndex`, `deriveV4Keyring`, `encryptedRemotePath`, `isPathInSyncScope`, and sharded load/save helpers.

- [ ] Write tests for random-salt key derivation, domain separation, authenticated encryption, opaque basename mapping, folder preservation, scope truth tables, exclusions, and changed-shard persistence.
- [ ] Run focused tests and confirm they fail because V4 modules do not exist.
- [ ] Implement minimal protocol, crypto/path codecs, scope policy, and index persistence.
- [ ] Run focused tests and the encrypted coverage gate.

### Task 2: GitHub transport and atomic publishing

**Files:**
- Modify: `src/lib/github-api.ts`
- Create: `src/lib/v4/request-scheduler.ts`, `git-tree-writer.ts`
- Test: `tests/v4/github-transport.test.ts`, `git-tree-writer.test.ts`

**Interfaces:**
- Produces `listCommits`, `getCommit`, `getTreeAt`, `createGitRef`, rate-aware `request`, root commit creation, and hierarchical atomic tree writes.

- [ ] Test API version headers, pagination, ETag handling, retry headers, empty-repository root commit, ref CAS, and truncated-tree fallback.
- [ ] Confirm focused failures, implement the transport incrementally, then run existing GitHub primitive tests.

### Task 3: Storage codecs, parts, packs, and journals

**Files:**
- Create focused modules under `src/lib/v4/` for plaintext/encrypted codecs, large files, packs, remote indexes, and history journals.
- Test focused storage and history modules under `tests/v4/`.

**Interfaces:**
- Produces `StorageCodec`, `PreparedRemoteWrite`, `RemoteVersionDescriptor`, `HistoryJournalRoot`, `HistoryJournalPage`, and version readers.

- [ ] Test direct plaintext blobs, encrypted basename/content leakage, 50 MiB boundary prediction, 48 MiB parts, corrupt/missing parts, stale-part deletion, bounded directory packs, paged journals, and stable file IDs across rename.
- [ ] Observe focused failures, implement the minimum codec behavior, and re-run focused plus benchmark tests.

### Task 4: Three-way planner, conflicts, and modification guard

**Files:**
- Create focused planner, conflict, and guard modules under `src/lib/v4/`.
- Test: `tests/v4/planner.test.ts`, `conflicts.test.ts`, `change-guard.test.ts`.

**Interfaces:**
- Produces `SyncPlan`, `PlannedChange`, `ConflictDecision`, `ChangeGuardResult`, and pure `planSync`/`evaluateChangeGuard` functions.

- [ ] Test independent edits, same-path conflicts, deletes, renames, copy/newer/merge/ask decisions, exact and over-threshold cases, zero disablement, empty initialization, and rename counting.
- [ ] Confirm failures, implement pure planning first, then run all planner/conflict suites.

### Task 5: Coordinator and runtime integration

**Files:**
- Create: `src/lib/v4/sync-coordinator.ts`, `runtime.ts`, `change-batcher.ts`, `status.ts`
- Modify: `src/main.ts`
- Test: `tests/v4/sync-coordinator.test.ts`, `runtime.test.ts`, `status.test.ts`

**Interfaces:**
- Produces `SyncRequest`, `SyncResult`, `SyncStatus`, a single `SyncCoordinator`, and trigger entrypoints for normal/force/local operations.

- [ ] Test global five-second debounce, coalescing, queued changes during sync, duplicate manual/force rejection, scheduled skip, pull-before-push, no-change request counts, one commit per burst, CAS re-plan, force CAS abort, and watcher suppression.
- [ ] Confirm focused failures, implement coordinator/runtime, route V4 behind an explicit format gate, and run existing sync suites.

### Task 6: Settings, SecretStorage, controls, and scope UI

**Files:**
- Modify: `src/setting.tsx`, `src/main.ts`, `manifest.json`
- Test: extend settings tests and add secret migration tests.

**Interfaces:**
- Updates `PluginSettings` with scope and guard settings while moving token/passphrase values behind generated SecretStorage IDs.

- [ ] Test defaults, validation, independent scope toggles, secret migration success/failure, minimum app version, commands, force confirmations, and active-sync notices.
- [ ] Confirm failures, implement native Obsidian controls and migration, then run focused and full settings tests.

### Task 7: Sync Center and history preview

**Files:**
- Create: `src/views/sync-center.ts`
- Modify: `src/main.ts`, `src/styles.scss`
- Test: `tests/v4/history-service.test.ts`, `sync-center.test.ts`

**Interfaces:**
- Produces a history service and Obsidian ItemView with commit/file modes and lazy `VersionPreview` results.

- [ ] Test 50-item pagination, plugin/external commit classification, virtualized change pages, rename-aware file versions, encrypted journal failure, text/image/binary preview decisions, and lazy blob reads.
- [ ] Confirm failures, implement the history service before the native DOM view, then run UI-focused tests and build.

### Task 8: V4 cutover, legacy retirement, and release verification

**Files:**
- Modify routing and documentation; remove legacy runtime modules only after equivalent tests and dirty behavior are ported.

- [ ] Test non-V4 force-push-only behavior, plaintext-history refusal, empty target initialization, settings migration, and legacy route absence.
- [ ] Move reusable byte, vault, ignore, and scheduling helpers out of legacy namespaces; remove all V1–V3 source, tests, runners, and superseded design documents.
- [ ] Run `npm test`, `npm run build`, quick real-GitHub E2E when credentials are configured, and the 100k/5 GiB benchmark.
- [ ] Review the final diff against every requirement and document any environment-dependent E2E that could not run.
