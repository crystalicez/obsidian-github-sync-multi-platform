# Git History and File Restore Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the existing Sync Center into a lazy before/after Git history workspace and add safe local-first Restore for individual file versions without creating a direct History-to-Git mutation path.

**Architecture:** `V4HistoryService` gains immutable SHA caches, explicit before/after side APIs, safe external-commit capability metadata, incremental file-version paging, and a sink materialization API separate from preview limits. Restore runs through `V4PluginRuntime`: resolve a safe current target, hash/revalidate it, stage historical content with the existing V4 codec/staging/resource system, commit locally, then rely on the normal local-change queue for later publication. `V4SyncCenterView` remains the single history UI and reuses the read-only diff primitives created by the conflict plan.

**Tech Stack:** TypeScript 5.9, Obsidian native DOM/ItemView, existing GitHub client/V4 codec/staging/resource-controller APIs, Node `node:test`, no new runtime dependency.

## Global Constraints

- Prerequisite: execute `docs/superpowers/plans/2026-08-16-conflict-resolution-workspace-v3.md` first.
- Keep `V4_HISTORY_PREVIEW_MAX_BYTES = 5 * 1024 * 1024`; preview limit is not a Restore limit.
- Plugin current-file history follows journal `fileId`; external path history is attached to a logical identity only when provable.
- Deleted plugin historical file Restore recreates a new local logical identity in this iteration.
- Plaintext external path Restore targets the exact safe path/current synced record at that path; it does not invent a plugin `fileId` from the external change's path surrogate.
- Restore is disabled while any sync run is active, including conflict resolution.
- Restore is local-first, never calls Git publication APIs directly, and never forces sync when local-change auto-sync is disabled.
- Encrypted external commits that bypass V4 journals do not get logical plaintext diff/Restore.
- Merge commits compare first parent.
- Large/chunked materialization uses existing bounded staging/codec/resource controls; fail safely when a bounded path cannot be guaranteed.
- Do not add runtime dependencies or copy AGPL reference implementation.
- After each task: targeted tests → commit → `git push origin HEAD:agent/conflict-history-ui`.

## File Map

- Modify `src/lib/v4/history-service.ts`: explicit sides, immutable caches, external safety, pagination, sink materialization.
- Create `src/lib/v4/history-restore.ts`: pure restore target/precondition/path/collision model.
- Modify `src/lib/v4/runtime.ts`: bounded History resources, service generation, local restore execution/cleanup.
- Modify `src/views/sync-center.ts`: Repository history / Current file master-detail, paired diff, Restore UI.
- Modify `src/views/v4-diff-preview.ts`: generic two-way history rendering.
- Modify `src/styles.scss` and UI stubs/tests.

---

### Task 1: Immutable history caches and explicit before/after preview

**Files:**
- Modify: `src/lib/v4/history-service.ts`
- Modify: `tests/v4/history-service.test.ts`

**Interfaces:**
- Produces: `V4HistorySide`, `V4HistoryPairPreview`, `V4HistoryCommitDetail`, `previewChangePair()`, `clearCaches()`.

- [ ] **Step 1: Write failing pair/cache/first-parent tests**

Build a plugin modify commit `c2` with first parent `c1`, both descriptors, and counters for commit/tree/blob reads. Assert pair returns old/new text, selecting multiple files in the same commit reuses immutable commit/tree metadata, pure rename with equal plaintext hash returns `contentUnchanged:true`, and truncated tree fails safe. Add a two-parent merge commit and assert before uses parent index 0.

```ts
const pair = await service.previewChangePair(commit, change);
assert.equal(pair.before?.kind, "text");
assert.equal(pair.after?.kind, "text");
assert.equal(pair.before?.kind === "text" && pair.before.text, "old");
assert.equal(pair.after?.kind === "text" && pair.after.text, "new");
assert.ok(treeReads <= 2);
```

- [ ] **Step 2: Verify red**

Run: `node scripts/run-tests.mjs --tier=fast --filter=history-service`

Expected: FAIL because current service exposes only one generic preview.

- [ ] **Step 3: Add explicit contracts**

```ts
export type V4HistorySide = "before" | "after";
export interface V4HistoryPairPreview {
  before?: V4VersionPreview;
  after?: V4VersionPreview;
  contentUnchanged: boolean;
}
export interface V4HistoryCommitDetail {
  changes: V4HistoryChange[];
  logicalContentAvailable: boolean;
  warning?: string;
}
```

Keep `getCommitChanges()` and `previewChange()` as compatibility wrappers while UI migrates.

- [ ] **Step 4: Add bounded immutable SHA caches**

Cache commit metadata by commit SHA and blob-tree maps by tree SHA; 32 entries each with insertion-order eviction. Tree maps store path→`{sha,size}` only. `treeMapAtCommit()` rejects truncated tree. `clearCaches()` empties both; no plaintext body cache is persisted.

- [ ] **Step 5: Implement side-specific lookup/preview**

`before`: first parent commit + `previousPath ?? path`; `after`: selected commit + `path`. Descriptor size must be checked against 5 MiB before blob body fetch. Plugin records reconstruct/decrypt only through `V4StorageCodec`. Unchanged plugin pair compares `plaintextSha256`; external plaintext pair may compare Git blob SHA.

- [ ] **Step 6: Bound codec crypto/resident resources**

Extend service constructor input:

```ts
resources?: Pick<V4ResourceController, "withCrypto" | "reserveResidentBytes">;
```

Pass into `V4StorageCodec`; Task 5 runtime supplies a dedicated bounded controller.

- [ ] **Step 7: Verify green and commit**

Run: `node scripts/run-tests.mjs --tier=fast --filter=history-service`

Expected: PASS.

```bash
git add src/lib/v4/history-service.ts tests/v4/history-service.test.ts
git commit -m "feat: add paired V4 history previews"
git push origin HEAD:agent/conflict-history-ui
```

### Task 2: Incremental current-file paging and safe external commit semantics

**Files:**
- Modify: `src/lib/v4/history-service.ts`
- Modify: `tests/v4/history-service.test.ts`

**Interfaces:**
- Produces: `V4FileVersionPage`, `getFileVersionsPage()`, safe `getCommitDetail()`.

- [ ] **Step 1: Write failing >1000 commit and external tests**

Create 1,050 commits with target plugin journal entry beyond page 20 and prove iterative pages find it. Plaintext external: exactly one delete+create sharing unique blob SHA → rename; ambiguous repeated SHA → remain delete/create. Encrypted external:

```ts
const detail = await encryptedService.getCommitDetail(externalCommit);
assert.equal(detail.logicalContentAvailable, false);
assert.match(detail.warning ?? "", /encrypted.*journal/iu);
```

- [ ] **Step 2: Verify red**

Run: `node scripts/run-tests.mjs --tier=fast --filter=history-service`

Expected: FAIL because current `getFileVersions()` silently caps at 20 pages and external detail lacks capability metadata.

- [ ] **Step 3: Add page contract**

```ts
export interface V4FileVersionPage {
  items: Array<{ commit: V4HistoryCommit; change: V4HistoryChange }>;
  nextCommitPage?: number;
  hasMore: boolean;
}
```

`getFileVersionsPage(fileId,{startCommitPage=1,commitPages=5})` scans exactly that range or end, includes plugin journal entries matching `fileId`, returns newest→oldest, and returns next cursor. Keep old `getFileVersions(fileId,maxPages=20)` compatibility wrapper with current output ordering.

- [ ] **Step 4: Safe external plaintext rename inference**

After path/tree diff, pair delete/create only when one non-empty Git blob SHA maps to exactly one delete and one create. Never infer from size/text similarity. External `fileId` remains a path surrogate for display only and must not be treated as V4 logical identity by Restore.

- [ ] **Step 5: Encrypted external capability guard**

`getCommitDetail()` returns raw Git-path metadata plus `logicalContentAvailable:false`/warning for encrypted external commits. Pair preview/Restore callers must reject that capability.

- [ ] **Step 6: Verify green and commit**

Run: `node scripts/run-tests.mjs --tier=fast --filter=history-service`

Expected: PASS.

```bash
git add src/lib/v4/history-service.ts tests/v4/history-service.test.ts
git commit -m "feat: paginate safe V4 file history"
git push origin HEAD:agent/conflict-history-ui
```

### Task 3: Pure Restore target/path/precondition model

**Files:**
- Create: `src/lib/v4/history-restore.ts`
- Create: `tests/v4/history-restore.test.ts`

**Interfaces:**
- Produces: `V4RestoreTargetSnapshot`, `V4RestoreIntent`, `resolveV4RestoreTargetPath()`, `sameV4RestoreTarget()`, collision helper.

- [ ] **Step 1: Write failing semantics tests**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { resolveV4RestoreTargetPath, sameV4RestoreTarget } from "../../src/lib/v4/history-restore";

test("plugin identity restores to current logical path", () => {
  assert.equal(resolveV4RestoreTargetPath({ historicalPath: "Old/n.md", currentLogicalPath: "New/n.md" }), "New/n.md");
});

test("deleted plugin history uses safe historical path", () => {
  assert.equal(resolveV4RestoreTargetPath({ historicalPath: "Archive/n.md" }), "Archive/n.md");
});

test("hash mismatch invalidates equal stat", () => {
  assert.equal(sameV4RestoreTarget(
    { exists: true, path: "n.md", size: 1, mtime: 1, hash: "a".repeat(64) },
    { exists: true, path: "n.md", size: 1, mtime: 1, hash: "b".repeat(64) },
  ), false);
});
```

Add unsafe `..`, file/folder collision, case-insensitive occupied path, and external plaintext exact-path target cases.

- [ ] **Step 2: Verify red**

Run: `node scripts/run-tests.mjs --tier=fast --filter=history-restore`

Expected: FAIL because module missing.

- [ ] **Step 3: Implement contracts**

```ts
export type V4RestoreTargetSnapshot =
  | { exists: false; path: string }
  | { exists: true; path: string; size: number; mtime: number; hash?: string };

export interface V4RestoreIntent {
  commitSha: string;
  source: "plugin" | "external";
  historicalFileId?: string;
  historicalPath: string;
  targetPath: string;
  recreateAsNewIdentity: boolean;
}
```

Plugin change with current `fileId` record → current logical path, `recreateAsNewIdentity:false`. Deleted plugin identity absent from current index → latest safe historical path, `true`. External plaintext change → exact selected logical path; if current index has a synced record at that same path, preserve that existing identity (`false`), otherwise new (`true`). Never reuse external path surrogate as a V4 fileId seed.

`sameV4RestoreTarget()` compares presence/path, size/mtime, then hash when both present. Collision helper normalizes NFC/lowercase and performs no I/O.

- [ ] **Step 4: Verify green and commit**

Run: `node scripts/run-tests.mjs --tier=fast --filter=history-restore`

Expected: PASS.

```bash
git add src/lib/v4/history-restore.ts tests/v4/history-restore.test.ts
git commit -m "feat: define safe history restore targets"
git push origin HEAD:agent/conflict-history-ui
```

### Task 4: Historical sink materialization independent of preview limit

**Files:**
- Modify: `src/lib/v4/history-service.ts`
- Modify: `tests/v4/history-service.test.ts`
- Create: `tests/resource/history-restore-resource.test.ts`

**Interfaces:**
- Produces: `materializeChangeSideToSink(commit,change,side,sink)`.

- [ ] **Step 1: Write failing >5 MiB/chunked tests**

6 MiB descriptor: pair preview refuses before body fetch; sink materialization succeeds with correct hash/size. Chunked descriptor: each historical part appends to counting sink. Packed record over safe resource bound must fail clearly; no alternate unbounded path.

- [ ] **Step 2: Verify red**

```bash
node scripts/run-tests.mjs --tier=fast --filter=history-service
node scripts/run-tests.mjs --tier=resource --filter=history-restore-resource
```

Expected: FAIL because sink API absent.

- [ ] **Step 3: Factor side record lookup**

Private helper returns `{record,commitSha,logicalPath}` from before/after descriptor and first-parent/current tree. Preserve `single/chunked/pack`, part paths, pack ID, remote version.

- [ ] **Step 4: Implement sink API without 5 MiB preview gate**

```ts
async materializeChangeSideToSink(
  commit: V4HistoryCommit,
  change: V4HistoryChange,
  side: V4HistorySide,
  sink: V4StagedSink,
): Promise<{ plaintextSha256: string; size: number; mtime: number; logicalPath: string }>;
```

Call `codec.readToSink()` with reader resolving historical object paths via cached tree map and `getBlob`. Preview limit is not referenced.

- [ ] **Step 5: Verify green and commit**

Run Step 2 commands; expect PASS.

```bash
git add src/lib/v4/history-service.ts tests/v4/history-service.test.ts tests/resource/history-restore-resource.test.ts
git commit -m "feat: stream large history restores to staging"
git push origin HEAD:agent/conflict-history-ui
```

### Task 5: Runtime local-first Restore, generation/resource safety, and stage cleanup

**Files:**
- Modify: `src/lib/v4/runtime.ts`
- Create: `tests/v4/history-restore-runtime.test.ts`
- Create: `tests/recovery/history-restore-runtime.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4, existing staging/platform I/O/scope/coordinator.
- Produces: `historyGeneration`, `previewRestoreTarget()`, `restoreHistoryVersion()`.

- [ ] **Step 1: Write failing runtime tests**

Cover active sync/conflict pending block; plugin current-path restore; external plaintext same-path restore preserving current record; stale target; explicit override with final race guard; auto-sync on → one effective queued modify; auto-sync off → local success/queued false; outside scope needs explicit allowance/never queues; deleted plugin file gets new identity on next scan; materialization/commit failure never reports success; stage removed after success/failure.

- [ ] **Step 2: Verify red**

Run: `node scripts/run-tests.mjs --tier=fast --filter=history-restore-runtime`

Expected: FAIL because runtime restore API absent.

- [ ] **Step 3: Add bounded History resource controller/service generation**

Runtime owns one `createV4ResourceController(resolveV4ResourceLimits(undefined))` for History. Pass it into services. Expose `historyGeneration = credentialGeneration`; saved settings already call `credentialsChanged()`, invalidating owner/repo/branch/mode/scope/credential changes.

- [ ] **Step 4: Implement hashed current target snapshot and target resolution**

Small target whole read+SHA256; large target bounded content-source hashing. For plugin source, lookup current index by historical `fileId`; if found use its path. If absent, use historical path/new identity. For external plaintext, lookup current index by exact path; if a record exists preserve it; otherwise new identity. Reject encrypted external logical restore before this step.

- [ ] **Step 5: Implement `previewRestoreTarget()`**

Choose restorable side: `after` when `change.after` exists, otherwise `before` for a delete version. Return generation, source, intent, target snapshot, scope flag, immutable commit/change/side. Validate normalize/path/file-folder/case collision.

- [ ] **Step 6: Implement stage-first restore with finally cleanup**

Fixed order:

1. reject when sync coordinator active or conflict pending;
2. reject stale History generation;
3. re-snapshot target; mismatch + no override → `{status:"stale"}`;
4. enforce outside-scope confirmation;
5. `beginStage()` with historical expected size/current target size;
6. call `materializeChangeSideToSink()` and finish stage;
7. verify hash/size;
8. immediately before local commit re-snapshot/precondition; override means accept the latest snapshot as the expected target, not disable race checking;
9. commit through existing platform/staging path while using ignored-file mechanism;
10. after successful commit explicitly enqueue modify only when auto-sync/watch/scope allow; duplicate vault events coalesce to one effective path change;
11. in `finally`, remove the stage if it still exists; cleanup failure is logged but cannot turn a successful local commit into a false failure;
12. return `{status:"restored",queued,targetPath}` only after local commit succeeds.

No Git publication method is called.

- [ ] **Step 7: Recovery/error tests**

Pre-commit failure leaves local unchanged; final target race blocks overwrite; successful local commit remains after later sync failure; cleanup executes after success/failure.

- [ ] **Step 8: Verify green and commit**

```bash
node scripts/run-tests.mjs --tier=fast --filter=history-restore-runtime
node scripts/run-tests.mjs --tier=recovery --filter=history-restore-runtime
```

Expected: PASS.

```bash
git add src/lib/v4/runtime.ts tests/v4/history-restore-runtime.test.ts tests/recovery/history-restore-runtime.test.ts
git commit -m "feat: restore V4 history versions locally"
git push origin HEAD:agent/conflict-history-ui
```

### Task 6: Diff-oriented Sync Center and Restore UX

**Files:**
- Modify: `src/views/sync-center.ts`
- Modify: `src/views/v4-diff-preview.ts`
- Modify: `src/styles.scss`
- Modify: `tests/stubs/obsidian.ts` only if confirmation controls need more behavior.
- Create: `tests/v4/sync-center-history.test.ts`

**Interfaces:**
- Consumes: Tasks 1–5 + conflict-plan read-only diff primitives.

- [ ] **Step 1: Write failing UI tests**

Assert visible Repository history/Current file; paired preview; create/delete absent side; unchanged rename label; Load older; encrypted external warning disables logical preview/Restore; plaintext external path restore label/target is correct; Restore disabled during sync; service generation invalidation; two image URLs revoked; stale render ignored; repeated click serialized.

- [ ] **Step 2: Verify red**

Run: `node scripts/run-tests.mjs --tier=fast --filter=sync-center-history`

Expected: FAIL against current generic preview/fixed version loading.

- [ ] **Step 3: Generation-aware service cache**

Track `serviceGeneration`; on mismatch call `clearCaches()`, create new service, update generation. Keep existing open/render generation checks after every await.

- [ ] **Step 4: Repository history master/detail**

Commit detail uses `getCommitDetail()`. Safe logical changes use pair preview. Encrypted external shows warning/raw paths only. Create/delete explicitly show absent side. Pure unchanged rename shows metadata without body fetch.

- [ ] **Step 5: Shared two-way renderer**

`renderV4HistoryPair(container,pair,urls)` uses conflict text tokenizer/diff. If work budget exceeded, display bounded raw side previews instead of computing diff. Images manage before/after object URLs; binary shows side metadata. Labels/icons supplement color.

- [ ] **Step 6: Current file incremental pagination**

Reset by active `fileId`, call `getFileVersionsPage()`, append newest→oldest, `Load older` while `hasMore`, dedupe by commit SHA+file ID+path+kind.

- [ ] **Step 7: Restore UX/result handling**

On selected version obtain `previewRestoreTarget()`. Plugin existing identity label `Restore this version`; deleted/new external absent identity label `Restore file as new local file`; external plaintext current exact-path record uses ordinary restore label. Disable during sync/in-flight. Handle `restored`, `stale` (Refresh / Restore anyway), `outside-scope` (explicit warning then allowance), errors. `queued:false` success text says sync manually when ready.

- [ ] **Step 8: Responsive CSS + verify**

Desktop master/detail, mobile stacked, theme variables only.

```bash
node scripts/run-tests.mjs --tier=fast --filter=sync-center-history
pnpm build
```

Expected: PASS.

- [ ] **Step 9: Commit and push**

```bash
git add src/views/sync-center.ts src/views/v4-diff-preview.ts src/styles.scss tests/stubs/obsidian.ts tests/v4/sync-center-history.test.ts
git commit -m "feat: upgrade Sync Center history workspace"
git push origin HEAD:agent/conflict-history-ui
```

### Task 7: History/Restore stress and full gates

**Files:**
- Modify prior History/Restore tests only for concrete regression coverage.
- Modify implementation only for observed failures.

**Interfaces:** No planned new public API.

- [ ] **Step 1: Cache/pagination stress**

Select 20 files in one commit and assert commit/tree metadata requests remain bounded by cache. Page past 1,000 commits with no silent truncation.

- [ ] **Step 2: Collision/concurrency/storage-mode stress**

Change target occupancy/case collision after preview before restore; no overwrite. Two Restore clicks → one local commit. Paired preview/restore in plaintext/encrypted plugin history. Encrypted external never enables logical diff/Restore. Plaintext external inferred rename stays path history and does not enter plugin fileId timeline.

- [ ] **Step 3: Full gates**

```bash
pnpm build
pnpm test:fast
pnpm test:repeat
pnpm test:recovery
pnpm test:resource
pnpm test:feasibility
pnpm validate:package
```

Expected: all exit 0.

- [ ] **Step 4: Direct-Git/dependency scan**

```bash
git grep -n "createGitCommit\|updateGitRef\|createGitRef" -- src/views/sync-center.ts src/lib/v4/history-service.ts src/lib/v4/history-restore.ts || true
node -e "const p=require('./package.json'); if (Object.keys(p.dependencies||{}).length) process.exit(1)"
```

Expected: no direct History/Restore publication call and empty runtime dependencies.

- [ ] **Step 5: Commit and push**

```bash
git add src tests
git commit -m "test: harden history restore edge cases"
git push origin HEAD:agent/conflict-history-ui
```

## Self-Review Coverage

- Explicit before/after, first-parent, tree truncation/cache/resource bounds: Task 1.
- >1000 commits + safe external semantics: Task 2.
- Plugin/external/deleted target identity rules: Task 3.
- Preview limit separated from sink Restore: Task 4.
- Active-sync gate, hashed preconditions, stage cleanup, sync settings: Task 5.
- Repository/current-file UI, paired diff, Restore labels/results, async generations: Task 6.
- Cache/resource/concurrency/collision/encryption/full CI: Task 7.

History/Restore must never bypass the normal V4 sync path to publish remote Git state.