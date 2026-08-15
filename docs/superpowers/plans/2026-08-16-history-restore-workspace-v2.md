# Git History and File Restore Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the existing Sync Center into a lazy before/after Git history workspace and add safe local-first Restore for individual file versions without creating a direct History-to-Git mutation path.

**Architecture:** `V4HistoryService` gains immutable SHA caches, explicit before/after side APIs, safe external-commit capability metadata, and incremental file-version paging. Restore runs through `V4PluginRuntime`: revalidate the local target, stage/decode historical bytes using existing V4 storage/staging machinery, commit locally, then let the existing local-change queue decide whether/when remote sync happens. `V4SyncCenterView` remains the one history UI and reuses the read-only diff/preview primitives from the approved conflict plan.

**Tech Stack:** TypeScript 5.9, Obsidian native DOM/ItemView, existing GitHub client/V4 codec/staging/resource-controller APIs, Node `node:test`, no new runtime dependency.

## Global Constraints

- Prerequisite: execute `docs/superpowers/plans/2026-08-16-conflict-resolution-workspace-v2.md` first so `src/views/v4-diff-preview.ts`, active-conflict runtime state, and cancelled lifecycle exist.
- Keep `V4_HISTORY_PREVIEW_MAX_BYTES = 5 * 1024 * 1024`; this is a preview limit, not a Restore limit.
- Current-file logical history follows plugin journal `fileId`; external path history is not silently attached unless identity is proven.
- Deleted historical file Restore creates a new local logical identity in this iteration.
- Restore is disabled while any sync run is active, including conflict resolution.
- Restore is local-first; it never calls Git publication APIs and never forces sync when local-change auto-sync is disabled.
- External commits on encrypted V4 branches that bypass journals do not get logical plaintext diff/Restore.
- Merge commits compare first parent.
- Large/chunked historical materialization uses existing bounded staging/codec/resource controls; fail safely when a bounded path cannot be guaranteed.
- Do not add runtime dependencies or copy AGPL reference implementation.
- After each task: targeted tests → commit → `git push origin HEAD:agent/conflict-history-ui`.

## File Map

- Modify `src/lib/v4/history-service.ts`: explicit sides, caches, safe external detail, pagination, sink materialization.
- Create `src/lib/v4/history-restore.ts`: pure target/precondition/path/collision helpers.
- Modify `src/lib/v4/runtime.ts`: bounded history resources, target generation, local restore execution.
- Modify `src/views/sync-center.ts`: Repository history / Current file master-detail, paired diff, Restore UI.
- Modify `src/views/v4-diff-preview.ts`: generic two-way History renderer.
- Modify `src/styles.scss` and UI stubs/tests.

---

### Task 1: Immutable history caches and explicit before/after preview

**Files:**
- Modify: `src/lib/v4/history-service.ts`
- Modify: `tests/v4/history-service.test.ts`

**Interfaces:**
- Produces: `V4HistorySide`, `V4HistoryPairPreview`, `V4HistoryCommitDetail`, `previewChangePair()`, `clearCaches()`.

- [ ] **Step 1: Write failing pair/cache tests**

Add tests that build commit `c2` with first parent `c1`, a modify journal entry with both descriptors, and counters for `getGitCommit/getTreeAt/getBlob`. Assert `previewChangePair()` returns old/new text, two file selections from the same commit reuse commit/tree metadata, a pure rename with identical plaintext hash reports `contentUnchanged:true`, and a truncated tree throws before guessing blobs.

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

Expected: FAIL because only one `after ?? before` preview exists.

- [ ] **Step 3: Add explicit side/detail contracts**

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

Keep `getCommitChanges()` and `previewChange()` as compatibility wrappers during migration.

- [ ] **Step 4: Add bounded immutable SHA caches**

Add commit cache keyed by commit SHA and tree-map cache keyed by tree SHA. Each cache holds at most 32 entries with insertion-order eviction. Tree maps store blob path→`{sha,size}` only. `treeMapAtCommit()` rejects `tree.truncated`. `clearCaches()` empties both.

- [ ] **Step 5: Implement side-specific record lookup and preview**

`before` resolves descriptor/tree from first parent and classifies logical type using `previousPath ?? path`; `after` uses selected commit/path. Check the 5 MiB descriptor size before fetching body. Reconstruct/decrypt through `V4StorageCodec`. For unchanged plugin descriptors compare `plaintextSha256`; for external plaintext compare Git blob SHA.

- [ ] **Step 6: Bound History codec crypto resources**

Extend `V4HistoryService` constructor input with an optional resource controller subset accepted by `V4StorageCodec`:

```ts
resources?: Pick<V4ResourceController, "withCrypto" | "reserveResidentBytes">;
```

Pass it into `new V4StorageCodec(...)`. Runtime will provide a dedicated bounded history controller in Task 5.

- [ ] **Step 7: Verify green**

Run: `node scripts/run-tests.mjs --tier=fast --filter=history-service`

Expected: PASS.

- [ ] **Step 8: Commit and push**

```bash
git add src/lib/v4/history-service.ts tests/v4/history-service.test.ts
git commit -m "feat: add paired V4 history previews"
git push origin HEAD:agent/conflict-history-ui
```

### Task 2: Incremental file-version paging and safe external commit semantics

**Files:**
- Modify: `src/lib/v4/history-service.ts`
- Modify: `tests/v4/history-service.test.ts`

**Interfaces:**
- Produces: `V4FileVersionPage`, `getFileVersionsPage()`, safe `getCommitDetail()`.

- [ ] **Step 1: Write failing >1000-commit and external tests**

Create 1,050 commits with the target plugin journal version beyond page 20. Page through `getFileVersionsPage()` and assert the old version is discoverable. Add plaintext external tests: unique delete/create sharing one blob SHA becomes rename; ambiguous many-to-many same SHA remains delete/create. Add encrypted external assertion:

```ts
const detail = await encryptedService.getCommitDetail(externalCommit);
assert.equal(detail.logicalContentAvailable, false);
assert.match(detail.warning ?? "", /encrypted.*journal/iu);
```

- [ ] **Step 2: Verify red**

Run: `node scripts/run-tests.mjs --tier=fast --filter=history-service`

Expected: FAIL because `getFileVersions()` has a hidden 20-page cap and no capability metadata.

- [ ] **Step 3: Implement explicit file-version page contract**

```ts
export interface V4FileVersionPage {
  items: Array<{ commit: V4HistoryCommit; change: V4HistoryChange }>;
  nextCommitPage?: number;
  hasMore: boolean;
}
```

`getFileVersionsPage(fileId,{startCommitPage=1,commitPages=5})` scans exactly those commit pages or until end, includes only plugin journal entries matching `fileId`, and returns newest→oldest. Preserve old `getFileVersions(fileId,maxPages=20)` as a compatibility wrapper with its existing output ordering so old tests/callers do not change accidentally.

- [ ] **Step 4: Infer external plaintext rename only when exact**

After path diff, group create/delete entries by non-empty Git blob SHA. Convert only a one-delete/one-create group to one rename with `previousPath`. Never infer from size or content text. Sort final list deterministically.

- [ ] **Step 5: Disable logical interpretation for encrypted external commits**

`getCommitDetail()` returns raw Git-path change metadata with `logicalContentAvailable:false` and a warning for external commits when storage mode is encrypted. UI must not invoke logical pair preview or Restore in that state.

- [ ] **Step 6: Add first-parent regression and verify green**

Add a two-parent commit test; before side must use `parentShas[0]`. Run: `node scripts/run-tests.mjs --tier=fast --filter=history-service`

Expected: PASS.

- [ ] **Step 7: Commit and push**

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
- Produces: `V4RestoreTargetSnapshot`, `V4RestoreIntent`, `resolveV4RestoreTargetPath()`, `sameV4RestoreTarget()`, collision validation.

- [ ] **Step 1: Write failing semantics tests**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { resolveV4RestoreTargetPath, sameV4RestoreTarget } from "../../src/lib/v4/history-restore";

test("existing logical identity restores content to current path", () => {
  assert.equal(resolveV4RestoreTargetPath({ historicalPath: "Old/n.md", currentLogicalPath: "New/n.md" }), "New/n.md");
});

test("deleted historical file uses historical path", () => {
  assert.equal(resolveV4RestoreTargetPath({ historicalPath: "Archive/n.md" }), "Archive/n.md");
});

test("hash mismatch invalidates an otherwise same stat", () => {
  assert.equal(sameV4RestoreTarget(
    { exists: true, path: "n.md", size: 1, mtime: 1, hash: "a".repeat(64) },
    { exists: true, path: "n.md", size: 1, mtime: 1, hash: "b".repeat(64) },
  ), false);
});
```

Also test unsafe `..`, file-vs-folder collision, and case-insensitive occupied target.

- [ ] **Step 2: Verify red**

Run: `node scripts/run-tests.mjs --tier=fast --filter=history-restore`

Expected: FAIL because the module is missing.

- [ ] **Step 3: Implement pure contracts**

```ts
export type V4RestoreTargetSnapshot =
  | { exists: false; path: string }
  | { exists: true; path: string; size: number; mtime: number; hash?: string };

export interface V4RestoreIntent {
  commitSha: string;
  fileId: string;
  historicalPath: string;
  targetPath: string;
  recreateAsNewIdentity: boolean;
}
```

Target path is `normalizeV4VaultPath(currentLogicalPath ?? historicalPath)`. `sameV4RestoreTarget()` compares presence/path, then size/mtime, then hash whenever both snapshots have hashes. Collision helper normalizes NFC/lowercase for case-insensitive comparison and rejects unrelated occupants; it performs no I/O.

- [ ] **Step 4: Verify green**

Run: `node scripts/run-tests.mjs --tier=fast --filter=history-restore`

Expected: PASS.

- [ ] **Step 5: Commit and push**

```bash
git add src/lib/v4/history-restore.ts tests/v4/history-restore.test.ts
git commit -m "feat: define safe history restore targets"
git push origin HEAD:agent/conflict-history-ui
```

### Task 4: Historical sink materialization independent of preview ceiling

**Files:**
- Modify: `src/lib/v4/history-service.ts`
- Modify: `tests/v4/history-service.test.ts`
- Create: `tests/resource/history-restore-resource.test.ts`

**Interfaces:**
- Produces: `materializeChangeSideToSink(commit,change,side,sink)`.
- Consumes: `V4StagedSink`, Task 1 side lookup, `V4StorageCodec.readToSink()`.

- [ ] **Step 1: Write failing >5 MiB/chunked tests**

Create a 6 MiB descriptor: visual pair preview must reject/refuse before loading body, while sink materialization succeeds and returns correct hash/size. Add chunked descriptor test asserting all parts append to a counting sink and no preview API is involved.

- [ ] **Step 2: Verify red**

Run:

```bash
node scripts/run-tests.mjs --tier=fast --filter=history-service
node scripts/run-tests.mjs --tier=resource --filter=history-restore-resource
```

Expected: FAIL because sink materialization API is absent.

- [ ] **Step 3: Factor historical side lookup**

Private helper returns `{record,commitSha,logicalPath}` for before/after, using first parent/current commit and cached tree metadata. It preserves storage fields (`single/chunked/pack`, part paths, pack ID, remote version) from descriptor.

- [ ] **Step 4: Implement sink API without the 5 MiB check**

```ts
async materializeChangeSideToSink(
  commit: V4HistoryCommit,
  change: V4HistoryChange,
  side: V4HistorySide,
  sink: V4StagedSink,
): Promise<{ plaintextSha256: string; size: number; mtime: number; logicalPath: string }>;
```

Call `codec.readToSink()`. Reader resolves historical object paths through cached tree map and `getBlob`. Propagate bounded resource/capability failures. Packed records retain current codec behavior; do not add an unbounded alternative if pack size exceeds safe resource limits.

- [ ] **Step 5: Verify green and commit**

Run both Step 2 commands; expect PASS.

```bash
git add src/lib/v4/history-service.ts tests/v4/history-service.test.ts tests/resource/history-restore-resource.test.ts
git commit -m "feat: stream large history restores to staging"
git push origin HEAD:agent/conflict-history-ui
```

### Task 5: Runtime local-first Restore and generation/resource safety

**Files:**
- Modify: `src/lib/v4/runtime.ts`
- Create: `tests/v4/history-restore-runtime.test.ts`
- Create: `tests/recovery/history-restore-runtime.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4 plus existing staging/platform I/O/scope/coordinator APIs.
- Produces: `historyGeneration`, `previewRestoreTarget()`, `restoreHistoryVersion()`.

- [ ] **Step 1: Write failing runtime tests**

Cover active sync/conflict pending rejection; unchanged target restore; stale target block; explicit override with final race guard; auto-sync enabled queues one effective modify after coalescing; auto-sync disabled restores locally with `queued:false`; outside-scope requires explicit allowance and never queues; deleted file recreates as new identity on next normal scan; materialization/commit failure never reports success.

- [ ] **Step 2: Verify red**

Run: `node scripts/run-tests.mjs --tier=fast --filter=history-restore-runtime`

Expected: FAIL because runtime restore APIs are absent.

- [ ] **Step 3: Add dedicated bounded History resource controller and target generation**

Create one runtime history resource controller using `createV4ResourceController(resolveV4ResourceLimits(undefined))`. Pass its crypto/resident methods to every `V4HistoryService`. Expose `historyGeneration` based on the runtime's settings/credential generation; because `saveSettings()` already calls `credentialsChanged()`, every saved repository/mode/scope/credential change invalidates long-open service instances.

- [ ] **Step 4: Implement hashed current-target snapshots**

Small files: read and SHA-256. Large files: existing content-source + `hashV4StableContentSource` with bounded chunks. Absence includes target path. Resolve current logical path from current index by `fileId`; if absent, historical path is used and intent marks `recreateAsNewIdentity:true`.

- [ ] **Step 5: Implement `previewRestoreTarget()`**

Validate normalized path, file/folder occupancy, and case-insensitive collision. Return immutable history generation, intent, current target snapshot, whether target is in current sync scope, and the selected commit/change side.

- [ ] **Step 6: Implement stage-first `restoreHistoryVersion()`**

Order is fixed:

1. reject if runtime sync coordinator is active or conflict batch pending;
2. reject stale history generation;
3. re-snapshot target; if mismatch and no override return `{status:"stale"}`;
4. enforce outside-scope confirmation flag;
5. create `V4StagingStore.beginStage()` using descriptor size/current target bytes;
6. call `materializeChangeSideToSink()` and finish stage;
7. validate returned hash/size;
8. immediately before commit re-snapshot/current-stat precondition; for override use the latest snapshot rather than disabling guards;
9. commit stage through existing platform/staging path while using the plugin's ignored-file mechanism;
10. after success, explicitly enqueue modify only when sync-on-local-change, watch, and scope allow it; duplicate vault events are harmless because existing `coalesceV4Changes()` yields one effective queued path change;
11. return `{status:"restored",queued,targetPath}`.

No direct Git client mutation is called.

- [ ] **Step 7: Add recovery/error tests**

Pre-commit failure leaves local bytes unchanged. Successful local commit followed by later sync failure leaves restored local content as a real local edit. Final target precondition change during staging prevents overwrite/success claim.

- [ ] **Step 8: Verify green**

Run:

```bash
node scripts/run-tests.mjs --tier=fast --filter=history-restore-runtime
node scripts/run-tests.mjs --tier=recovery --filter=history-restore-runtime
```

Expected: PASS.

- [ ] **Step 9: Commit and push**

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
- Modify: `tests/stubs/obsidian.ts` if confirmation controls need more behavior.
- Create: `tests/v4/sync-center-history.test.ts`

**Interfaces:**
- Consumes: Tasks 1–5 and shared diff primitives from conflict plan.

- [ ] **Step 1: Write failing UI tests**

Assert visible modes `Repository history` / `Current file`; commit→changed file→paired preview; create/delete absent side; unchanged rename label; Current file `Load older`; encrypted external warning disables logical preview/Restore; Restore disabled while runtime syncing; settings generation invalidates cached service; before/after image URLs all revoke; stale render generation ignored; repeated Restore click is disabled while first request is in flight.

- [ ] **Step 2: Verify red**

Run: `node scripts/run-tests.mjs --tier=fast --filter=sync-center-history`

Expected: FAIL against current generic preview/fixed file-version loading.

- [ ] **Step 3: Make cached History service generation-aware**

Track `serviceGeneration`. Before each async mode/detail render, if runtime generation differs, call old service `clearCaches()`, create a new service, update generation, and retain existing `openGeneration/renderGeneration` checks after every await.

- [ ] **Step 4: Upgrade Repository history**

Keep same ItemView/command identity. Commit detail calls `getCommitDetail()`. Safe logical changes call `previewChangePair()`. Encrypted external unsafe detail renders warning/raw paths only. Create/delete display an explicit absent side. Pure rename unchanged content displays `Content unchanged` without body fetch.

- [ ] **Step 5: Extend shared two-way renderer**

`renderV4HistoryPair(container,pair,urls)` uses Task 2 conflict-plan text tokenizer/diff for read-only before/after rows. If diff work budget fails, fall back to side-by-side/stacked raw text within the existing preview byte ceiling. Images create two managed object URLs; binaries show side-specific metadata. Never communicate add/remove only by color.

- [ ] **Step 6: Upgrade Current file pagination**

Resolve active file `fileId`, reset list/cursor, call `getFileVersionsPage()`, append newest→oldest items, and show `Load older` only when `hasMore`. Deduplicate by commit SHA + file ID + path + kind. Re-entering Current file after active-file change resets state.

- [ ] **Step 7: Implement Restore confirmation/result flow**

Selecting a version calls `previewRestoreTarget()`. Button label is `Restore this version` for an existing logical file and `Restore file as new local file` when identity is absent. Disable while sync active or restore promise in flight. Handle runtime results: `restored` → success Notice; `queued:false` additionally says sync manually when ready; `stale` → Refresh comparison / Restore anyway; `outside-scope` → explicit warning confirmation then retry with allowance; errors → inline error + Notice, never success.

- [ ] **Step 8: Add responsive/theme CSS and verify**

Desktop master/detail, narrow/mobile stacked layout, Obsidian variables only. Run:

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
- Modify: History/Restore tests from prior tasks only for concrete regression coverage.
- Modify implementation only when a failing gate identifies a defect.

**Interfaces:**
- No planned new public API.

- [ ] **Step 1: Add cache/pagination stress**

Select 20 files in one commit and assert tree/commit metadata requests stay bounded by cache, not 40 independent tree loads. Page past 1,000 commits and assert no silent truncation.

- [ ] **Step 2: Add collision/concurrency/encryption stress**

Change target occupancy/case collision after preview before restore and assert no overwrite. Trigger two UI Restore clicks and assert one local commit. Run paired preview/restore in plaintext and encrypted plugin histories. Assert encrypted external commits never enable logical diff/Restore; external plaintext inferred rename never enters plugin `fileId` timeline.

- [ ] **Step 3: Run full project gates**

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

- [ ] **Step 4: Verify no direct Git mutation/dependency regression**

```bash
git grep -n "createGitCommit\|updateGitRef\|createGitRef" -- src/views/sync-center.ts src/lib/v4/history-service.ts src/lib/v4/history-restore.ts || true
node -e "const p=require('./package.json'); if (Object.keys(p.dependencies||{}).length) process.exit(1)"
```

Expected: no direct History/Restore Git publication call and empty runtime dependencies.

- [ ] **Step 5: Commit and push**

```bash
git add src tests
git commit -m "test: harden history restore edge cases"
git push origin HEAD:agent/conflict-history-ui
```

## Self-Review Coverage

- Explicit before/after, first-parent, tree truncation/cache: Task 1.
- >1000 commits and safe external plaintext/encrypted semantics: Task 2.
- Current-path/deleted-new-identity target semantics: Task 3.
- Preview ceiling separated from bounded Restore: Task 4.
- Active-sync gate, hashed precondition, local-first staging, sync-policy respect: Task 5.
- Repository/current-file UI, paired diff, Restore UX, async generations: Task 6.
- Cache/resource/concurrency/collision/encryption/full CI: Task 7.

History/Restore must never bypass the normal V4 sync path to publish remote Git state.