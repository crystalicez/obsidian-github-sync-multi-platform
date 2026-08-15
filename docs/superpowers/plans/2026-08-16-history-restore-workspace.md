# Git History and File Restore Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the existing Sync Center into a lazy before/after Git history workspace and add safe local-first Restore for individual file versions without introducing a direct history-to-Git mutation path.

**Architecture:** Extend `V4HistoryService` to return explicit immutable before/after sides, bounded caches, safe external-commit metadata, and incremental file-version pagination. Put restore precondition/path/materialization logic behind `V4PluginRuntime`, writing only to the local vault and relying on the existing V4 change queue for later publication. Keep `V4SyncCenterView` as the single history UI and reuse the read-only diff/preview primitives introduced by the conflict-resolution plan.

**Tech Stack:** TypeScript 5.9, existing GitHub REST client/V4 storage codec/staging store, Obsidian native DOM ItemView, Node `node:test`, no new runtime dependency.

## Global Constraints

- Execute this plan after `docs/superpowers/plans/2026-08-16-conflict-resolution-workspace.md` has created `src/views/v4-diff-preview.ts` and the `cancelled`/active-conflict runtime state.
- Keep `V4_HISTORY_PREVIEW_MAX_BYTES = 5 * 1024 * 1024` as a visual preview ceiling; it is not a restore ceiling.
- Current-file history follows plugin journal `fileId` while that identity exists; deleted-file Restore creates a new local logical identity in this iteration.
- Restore is disabled while any sync run is active, including conflict resolution.
- Restore never creates/amends a Git commit directly and never forces sync when automatic local-change sync is disabled.
- Large/chunked Restore must use existing bounded staging/codec paths where safe; fail clearly rather than exceed memory/resource limits.
- Encrypted external commits that bypass V4 journals must not be presented as safely decoded logical plaintext history.
- Preserve first-parent comparison for merge commits.
- Preserve the repository's no-runtime-dependency posture and clean-room AGPL boundary.
- Every task ends with targeted tests, then a commit, then `git push origin HEAD:agent/conflict-history-ui`.

---

## File Structure

- Modify `src/lib/v4/history-service.ts` — immutable commit/tree cache, explicit before/after preview/materialization, safe external commit details, file-version pagination.
- Create `src/lib/v4/history-restore.ts` — restore target snapshot/precondition and path/identity decisions that are pure/testable.
- Modify `src/lib/v4/runtime.ts` — history service generation, bounded restore execution, active-sync gate, enqueue policy.
- Modify `src/views/sync-center.ts` — master/detail repository history, Current file timeline, diff preview, Restore UI.
- Modify `src/views/v4-diff-preview.ts` — add generic two-way diff rendering needed by History without coupling to conflict merge state.
- Modify `src/styles.scss` — responsive history layout and diff styles.
- Modify `tests/stubs/obsidian.ts` only for additional confirmation/input behavior not already added by the conflict plan.

## Task 1: Explicit before/after history previews and immutable commit/tree caches

**Files:**
- Modify: `src/lib/v4/history-service.ts`
- Modify: `tests/v4/history-service.test.ts`

**Interfaces:**
- Produces: `V4HistorySide`, `V4HistoryPairPreview`, `V4HistoryCommitDetail`, `previewChangePair()`, bounded internal commit/tree caches.
- Consumes: existing `V4StorageCodec`, journal descriptors, GitHub `getGitCommit/getTreeAt/getBlob`.

- [ ] **Step 1: Write failing tests for pair preview, first-parent delete/create, and cache reuse**

Add tests equivalent to:

```ts
let commitReads = 0;
let treeReads = 0;
let blobReads = 0;
const github = {
  async listCommits() { return []; },
  async getFileBytes() { return null; },
  async getGitCommit(sha: string) {
    commitReads++;
    return sha === "c2"
      ? { sha, treeSha: "tree-2", parentShas: ["c1"] }
      : { sha, treeSha: "tree-1", parentShas: [] };
  },
  async getTreeAt(treeSha: string) {
    treeReads++;
    const path = treeSha === "tree-1" ? "old.md" : "new.md";
    return { sha: treeSha, url: "", truncated: false, tree: [{ path, mode: "100644", type: "blob" as const, sha: treeSha === "tree-1" ? "b1" : "b2", size: 3, url: "" }] };
  },
  async getBlob(sha: string) { blobReads++; return new TextEncoder().encode(sha === "b1" ? "old" : "new"); },
};

const pair = await service.previewChangePair(commit, change);
assert.equal(pair.before?.kind, "text");
assert.equal(pair.after?.kind, "text");
assert.equal(pair.before.kind === "text" && pair.before.text, "old");
assert.equal(pair.after.kind === "text" && pair.after.text, "new");
await service.previewChangePair(commit, anotherChangeInSameCommit);
assert.ok(commitReads <= 2);
assert.ok(treeReads <= 2);
assert.equal(blobReads, 4);
```

Also add a pure rename with identical descriptor hash and assert `contentUnchanged === true` without requiring duplicate blob reads when the service can prove identical content identity.

- [ ] **Step 2: Run existing history tests and confirm new assertions fail**

Run: `node scripts/run-tests.mjs --tier=fast --filter=history-service`

Expected: FAIL because only `previewChange(after ?? before)` exists.

- [ ] **Step 3: Define explicit pair/detail types without breaking existing callers**

Add:

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

Keep `getCommitChanges()` and `previewChange()` as compatibility wrappers until Sync Center is migrated; they delegate to the new APIs.

- [ ] **Step 4: Add immutable commit/tree-map caches**

Inside `V4HistoryService`:

```ts
private readonly commitCache = new Map<string, Awaited<ReturnType<V4HistoryGithub["getGitCommit"]>>>();
private readonly treeCache = new Map<string, Map<string, { sha: string; size: number }>>();
```

Use helper methods `commitAt(sha)` and `treeMapAtCommit(sha)` that:

1. cache by immutable SHA;
2. throw if GitHub reports a truncated tree;
3. store only blob path→`{sha,size}` metadata, not all plaintext bytes;
4. cap each cache at 32 entries using insertion-order eviction.

Add `clearCaches()` for explicit lifecycle invalidation.

- [ ] **Step 5: Implement side-specific descriptor reading**

For `before`, use the first parent commit and `change.previousPath ?? change.path` for logical type classification. For `after`, use the selected commit and `change.path`.

Implement:

```ts
private async previewSide(
  commit: V4HistoryCommit,
  change: V4HistoryChange,
  side: V4HistorySide,
): Promise<V4VersionPreview | undefined>;
```

If the side descriptor is absent, return `undefined`. Check descriptor size against `V4_HISTORY_PREVIEW_MAX_BYTES` before fetching blob content. Reconstruct/decrypt through `V4StorageCodec`; never bypass it for plugin journal records.

- [ ] **Step 6: Implement `previewChangePair()` and compatibility wrapper**

```ts
async previewChangePair(commit: V4HistoryCommit, change: V4HistoryChange): Promise<V4HistoryPairPreview> {
  const beforeDescriptor = change.before;
  const afterDescriptor = change.after;
  const contentUnchanged = !!beforeDescriptor && !!afterDescriptor
    && !!beforeDescriptor.plaintextSha256
    && beforeDescriptor.plaintextSha256 === afterDescriptor.plaintextSha256;
  if (contentUnchanged) return { contentUnchanged, before: undefined, after: undefined };
  const [before, after] = await Promise.all([
    this.previewSide(commit, change, "before"),
    this.previewSide(commit, change, "after"),
  ]);
  return { before, after, contentUnchanged: false };
}
```

For external plaintext descriptors without `plaintextSha256`, treat identical Git blob SHA as unchanged.

Keep `previewChange()` returning `after ?? before` by selecting from the pair so legacy tests/callers remain valid during migration.

- [ ] **Step 7: Run targeted tests**

Run: `node scripts/run-tests.mjs --tier=fast --filter=history-service`

Expected: PASS.

- [ ] **Step 8: Commit and push**

```bash
git add src/lib/v4/history-service.ts tests/v4/history-service.test.ts
git commit -m "feat: add paired V4 history previews"
git push origin HEAD:agent/conflict-history-ui
```

## Task 2: Safe external commit semantics and incremental current-file pagination

**Files:**
- Modify: `src/lib/v4/history-service.ts`
- Modify: `tests/v4/history-service.test.ts`

**Interfaces:**
- Produces: `V4FileVersionPage`, `getFileVersionsPage()`, `getCommitDetail()` with logical-content capability.
- Consumes: Task 1 cache/pair APIs.

- [ ] **Step 1: Write failing tests for >1000-commit pagination and external rename safety**

Add a synthetic history with 1,050 commits where the target `fileId` appears beyond commit page 20. Assert:

```ts
const first = await service.getFileVersionsPage("file-1", { startCommitPage: 1, commitPages: 5 });
assert.equal(first.hasMore, true);
const next = await service.getFileVersionsPage("file-1", { startCommitPage: first.nextCommitPage!, commitPages: 20 });
assert.ok(next.items.some(item => item.commit.sha === "old-target"));
```

External plaintext rename tests:

- one deleted path and one created path with the same unique blob SHA → one `rename` with `previousPath`;
- two deleted and two created paths sharing the same blob SHA → leave delete/create entries; do not guess.

Encrypted external test:

```ts
const detail = await encryptedService.getCommitDetail(externalCommit);
assert.equal(detail.logicalContentAvailable, false);
assert.match(detail.warning ?? "", /encrypted.*journal/iu);
```

- [ ] **Step 2: Run and verify failures**

Run: `node scripts/run-tests.mjs --tier=fast --filter=history-service`

Expected: FAIL because current file history silently stops after 20 pages and external commits lack capability metadata/rename inference.

- [ ] **Step 3: Add incremental page contract**

```ts
export interface V4FileVersionPage {
  items: Array<{ commit: V4HistoryCommit; change: V4HistoryChange }>;
  nextCommitPage?: number;
  hasMore: boolean;
}

async getFileVersionsPage(
  fileId: string,
  options: { startCommitPage?: number; commitPages?: number } = {},
): Promise<V4FileVersionPage>;
```

Default `startCommitPage = 1`, `commitPages = 5`. Scan exactly that many GitHub commit pages or stop at end. Include only plugin journal commits for logical `fileId` tracking. Return items newest→oldest in encounter order. `nextCommitPage` is the first unscanned page when `hasMore` is true.

Keep `getFileVersions(fileId, maxPages=20)` as a compatibility wrapper implemented via `getFileVersionsPage()` so old tests/API do not break immediately.

- [ ] **Step 4: Implement safe external plaintext rename inference**

After path-based parent/current diff, collect creates and deletes by Git blob SHA. Convert to rename only when exactly one delete and exactly one create share a non-empty SHA. Preserve modify entries as-is. Sort final output by `path`.

Do not use file size alone for rename inference.

- [ ] **Step 5: Implement encrypted external capability warning**

`getCommitDetail(commit)` behavior:

```ts
if (commit.source === "external" && this.input.config.mode === "encrypted") {
  return {
    changes: await this.diffExternalCommit(commit),
    logicalContentAvailable: false,
    warning: "External commit bypassed V4 journals on an encrypted branch; logical plaintext diff and Restore are disabled.",
  };
}
return { changes: await this.getCommitChangesInternal(commit), logicalContentAvailable: true };
```

The raw change list may show Git object paths/metadata for diagnostics, but UI must not call plaintext pair preview or Restore when `logicalContentAvailable === false`.

- [ ] **Step 6: Add first-parent merge-commit regression**

Create a commit with two parents and assert the before side uses `parentShas[0]`, matching current semantics.

- [ ] **Step 7: Run targeted tests**

Run: `node scripts/run-tests.mjs --tier=fast --filter=history-service`

Expected: PASS.

- [ ] **Step 8: Commit and push**

```bash
git add src/lib/v4/history-service.ts tests/v4/history-service.test.ts
git commit -m "feat: paginate safe V4 file history"
git push origin HEAD:agent/conflict-history-ui
```

## Task 3: Pure restore target/precondition model

**Files:**
- Create: `src/lib/v4/history-restore.ts`
- Create: `tests/v4/history-restore.test.ts`

**Interfaces:**
- Produces: `V4RestoreTargetSnapshot`, `V4RestoreIntent`, `resolveV4RestoreTargetPath()`, `sameV4RestoreTarget()`.
- Consumes: `normalizeV4VaultPath`, V4 logical file/index metadata.

- [ ] **Step 1: Write failing path/identity/precondition tests**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { resolveV4RestoreTargetPath, sameV4RestoreTarget } from "../../src/lib/v4/history-restore";

test("existing logical file restores to current path, not historical path", () => {
  assert.equal(resolveV4RestoreTargetPath({ historicalPath: "Old/n.md", currentLogicalPath: "New/n.md" }), "New/n.md");
});

test("deleted file uses latest safe historical path as a new local file", () => {
  assert.equal(resolveV4RestoreTargetPath({ historicalPath: "Archive/n.md" }), "Archive/n.md");
});

test("restore target comparison includes content hash when available", () => {
  assert.equal(sameV4RestoreTarget(
    { exists: true, path: "n.md", size: 1, mtime: 1, hash: "a".repeat(64) },
    { exists: true, path: "n.md", size: 1, mtime: 1, hash: "b".repeat(64) },
  ), false);
});
```

Add unsafe `../`, file-vs-folder, and case-insensitive occupied-path validation input cases.

- [ ] **Step 2: Run and verify failure**

Run: `node scripts/run-tests.mjs --tier=fast --filter=history-restore`

Expected: FAIL because restore model does not exist.

- [ ] **Step 3: Implement restore contracts**

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

export function resolveV4RestoreTargetPath(input: { historicalPath: string; currentLogicalPath?: string }): string {
  return normalizeV4VaultPath(input.currentLogicalPath ?? input.historicalPath);
}

export function sameV4RestoreTarget(a: V4RestoreTargetSnapshot, b: V4RestoreTargetSnapshot): boolean {
  if (a.exists !== b.exists || a.path !== b.path) return false;
  if (!a.exists || !b.exists) return true;
  if (a.size !== b.size || a.mtime !== b.mtime) return false;
  return !a.hash || !b.hash || a.hash === b.hash;
}
```

Keep collision enumeration as a pure helper taking current vault/logical paths, normalized to NFC/lowercase for case-insensitive comparison. Do not perform I/O in this file.

- [ ] **Step 4: Run targeted tests**

Run: `node scripts/run-tests.mjs --tier=fast --filter=history-restore`

Expected: PASS.

- [ ] **Step 5: Commit and push**

```bash
git add src/lib/v4/history-restore.ts tests/v4/history-restore.test.ts
git commit -m "feat: define safe history restore targets"
git push origin HEAD:agent/conflict-history-ui
```

## Task 4: Bounded historical materialization independent of preview limit

**Files:**
- Modify: `src/lib/v4/history-service.ts`
- Modify: `tests/v4/history-service.test.ts`
- Create: `tests/resource/history-restore-resource.test.ts`

**Interfaces:**
- Produces: `materializeChangeSideToSink(commit, change, side, sink)`.
- Consumes: `V4StagedSink`, Task 1 side lookup/cache logic, `V4StorageCodec.readToSink()`.

- [ ] **Step 1: Write a failing >5 MiB restore-materialization test**

Create a historical descriptor of `6 * 1024 * 1024` bytes. Assert `previewChangePair()` rejects/refuses preview before blob body allocation, while `materializeChangeSideToSink()` succeeds through a chunk-counting sink without building one 6 MiB preview buffer.

For a chunked descriptor, assert each remote object is read and appended in bounded chunks and the final hash/size match.

- [ ] **Step 2: Run preview/resource tests and verify materialization API is missing**

Run:

```bash
node scripts/run-tests.mjs --tier=fast --filter=history-service
node scripts/run-tests.mjs --tier=resource --filter=history-restore-resource
```

Expected: FAIL on missing materialization method.

- [ ] **Step 3: Factor side lookup into a reusable historical record reader**

Create a private helper that resolves:

```ts
{ record: V4IndexFileRecord; commitSha: string; logicalPath: string }
```

for `before` or `after`. `before` uses first parent; `after` uses current commit. The helper must use cached tree metadata and descriptor storage fields exactly as preview does.

- [ ] **Step 4: Implement sink materialization without `V4_HISTORY_PREVIEW_MAX_BYTES`**

```ts
async materializeChangeSideToSink(
  commit: V4HistoryCommit,
  change: V4HistoryChange,
  side: V4HistorySide,
  sink: V4StagedSink,
): Promise<{ plaintextSha256: string; size: number; mtime: number; logicalPath: string }>;
```

Call `this.codec.readToSink({ record, reader, sink })`. The reader resolves object paths from the historical tree map and fetches Git blobs. Return the codec hash/size plus descriptor mtime/logical path. Do not apply the 5 MiB preview limit here.

For packed records, `readToSink()` currently delegates to `read()` and may allocate the decrypted pack. Keep existing pack/resource behavior; if the pack cannot be bounded within current resource limits, propagate a clear failure rather than adding a hidden unbounded path.

- [ ] **Step 5: Run targeted tests**

Run:

```bash
node scripts/run-tests.mjs --tier=fast --filter=history-service
node scripts/run-tests.mjs --tier=resource --filter=history-restore-resource
```

Expected: PASS.

- [ ] **Step 6: Commit and push**

```bash
git add src/lib/v4/history-service.ts tests/v4/history-service.test.ts tests/resource/history-restore-resource.test.ts
git commit -m "feat: stream large history restores to staging"
git push origin HEAD:agent/conflict-history-ui
```

## Task 5: Runtime local-first Restore with active-sync gate and exact effective enqueue

**Files:**
- Modify: `src/lib/v4/runtime.ts`
- Modify: `src/main.ts` only if a small public runtime hook is needed by UI.
- Create: `tests/v4/history-restore-runtime.test.ts`
- Create: `tests/recovery/history-restore-runtime.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4, runtime staging/platform I/O, local index, scope predicate, coordinator enqueue.
- Produces: `previewRestoreTarget()`, `restoreHistoryVersion()` runtime APIs.

- [ ] **Step 1: Write failing runtime tests**

Cover:

- active sync/conflict pending → Restore rejects before local mutation;
- unchanged target → restore writes historical bytes;
- changed target → default restore returns a stale-precondition result and does not write;
- `overrideLocal: true` re-snapshots current stat and still guards the final commit race;
- sync-on-local-change enabled + watch enabled → one effective queued modify after coalescing;
- auto-sync disabled → local restore succeeds with `queued: false`;
- outside current sync scope → local restore succeeds only after caller confirmation flag and `queued: false`;
- deleted historical file creates at safe path and receives normal new identity on the next scan, not an injected old `fileId`.

- [ ] **Step 2: Run and verify failures**

Run: `node scripts/run-tests.mjs --tier=fast --filter=history-restore-runtime`

Expected: FAIL because runtime has no restore API.

- [ ] **Step 3: Add history target generation and stale-service invalidation**

Expose:

```ts
get historyGeneration(): number { return this.credentialGeneration; }
```

Incrementing credential generation already occurs on saved settings. `createHistoryService()` remains generation-bound by construction; Sync Center will discard its cached service when this number changes.

- [ ] **Step 4: Implement current target snapshot hashing**

Add a private runtime helper that uses `sessionVault()`/platform content-source paths:

- absent target → `{exists:false,path}`;
- small target → read bytes and SHA-256;
- large target → `createV4ContentSource` + `hashV4StableContentSource` bounded hashing.

Return `V4RestoreTargetSnapshot` with size/mtime/hash. Do not use mtime alone.

- [ ] **Step 5: Implement `previewRestoreTarget()`**

Given immutable `commit/change/side`, resolve current logical path from current index by `fileId` when present. Otherwise use the historical path and set `recreateAsNewIdentity: true`. Validate normalized path and case-insensitive/file-folder collisions before returning an intent plus current target snapshot.

- [ ] **Step 6: Implement `restoreHistoryVersion()` with stage-first commit**

Method input includes `{ intent, expectedTarget, overrideLocal, allowOutsideScope }`.

Execution order:

1. reject if `this.coordinator.isSyncing` or `this.conflictCoordinator.snapshot.pending`;
2. validate history generation/context is unchanged;
3. re-snapshot target; if it differs and `overrideLocal === false`, return `{status:"stale"}` without mutation;
4. if outside scope and `allowOutsideScope === false`, return `{status:"outside-scope"}`;
5. create staging sink with `expectedSize` from descriptor, `existingTargetBytes` from current target, `atomicReplace:false`;
6. call `historyService.materializeChangeSideToSink()`;
7. finish stage and verify returned hash/size;
8. build `V4LocalTargetPrecondition` from the latest target stat and commit stage through `platformIo.commitStage`/existing staging path;
9. suppress plugin self-events with the same ignored-file mechanism used by session writes;
10. after successful local commit, explicitly call `enqueueModify(targetPath, Date.now())` only when sync-on-local-change/watch/scope policy allows;
11. return `{status:"restored", queued:boolean, targetPath}`.

If final precondition changes between snapshot and stage commit, propagate stale/error and do not report success.

- [ ] **Step 7: Add recovery/error tests**

In recovery-tier tests simulate stage materialization failure, stage commit failure, and successful local commit followed by later sync failure. Assert pre-commit failures leave local bytes unchanged; after a successful local restore the edit remains even if later sync fails.

- [ ] **Step 8: Run targeted tests**

Run:

```bash
node scripts/run-tests.mjs --tier=fast --filter=history-restore-runtime
node scripts/run-tests.mjs --tier=recovery --filter=history-restore-runtime
```

Expected: PASS.

- [ ] **Step 9: Commit and push**

```bash
git add src/lib/v4/runtime.ts src/main.ts tests/v4/history-restore-runtime.test.ts tests/recovery/history-restore-runtime.test.ts
git commit -m "feat: restore V4 history versions locally"
git push origin HEAD:agent/conflict-history-ui
```

## Task 6: Upgrade Sync Center to diff-oriented repository/current-file history

**Files:**
- Modify: `src/views/sync-center.ts`
- Modify: `src/views/v4-diff-preview.ts`
- Modify: `src/styles.scss`
- Modify: `tests/stubs/obsidian.ts` if confirmation controls need support.
- Create: `tests/v4/sync-center-history.test.ts`

**Interfaces:**
- Consumes: paired previews, commit details, file-version pages, runtime restore APIs, shared diff renderer.
- Produces no new sync semantics; UI only.

- [ ] **Step 1: Write failing Sync Center UI tests**

Cover:

- header labels `Repository history` and `Current file`;
- repository commit selection shows changed-file list then before/after detail;
- create/delete renders an absent side rather than fake empty bytes;
- pure rename unchanged content shows `Content unchanged`;
- Current file loads initial version page and `Load older` continues from `nextCommitPage`;
- encrypted external commit warning disables logical preview/Restore;
- Restore button disabled while runtime is syncing;
- stale service generation is discarded after settings generation changes;
- object URLs for before/after images are both revoked on rerender/close;
- stale async render generation cannot replace a newer selection.

- [ ] **Step 2: Run and verify current Sync Center fails the new UI expectations**

Run: `node scripts/run-tests.mjs --tier=fast --filter=sync-center-history`

Expected: FAIL because current view uses a single generic preview and fixed `getFileVersions()` loading.

- [ ] **Step 3: Make service caching generation-aware**

Replace the single `service?` field with:

```ts
private service?: V4HistoryService;
private serviceGeneration = -1;

private async ensureService(): Promise<V4HistoryService> {
  const generation = this.plugin.v4Runtime.historyGeneration;
  if (!this.service || this.serviceGeneration !== generation) {
    this.service?.clearCaches();
    this.service = await this.plugin.v4Runtime.createHistoryService();
    this.serviceGeneration = generation;
  }
  return this.service;
}
```

Keep existing open/render generation guards around every awaited call.

- [ ] **Step 4: Upgrade Repository history master/detail flow**

Rename visible `Commits` mode to `Repository history` without changing view type/command IDs. Commit detail calls `getCommitDetail()`. For safe logical history, changed-file selection calls `previewChangePair()` and passes the pair to `v4-diff-preview.ts`. For unsafe encrypted external history, render warning + raw changed paths and do not attach preview/restore handlers.

- [ ] **Step 5: Add two-way read-only text diff renderer**

In `v4-diff-preview.ts`, add a pure display model using `decodeV4TextDocument()` and `diffV4TextLines()` from the conflict plan. Render before/after line rows with context and added/removed classes. If diff budget is exceeded, fall back to two scrollable raw text previews within the 5 MiB preview limit; History viewing must not freeze.

Export:

```ts
export function renderV4HistoryPair(
  container: HTMLElement,
  pair: V4HistoryPairPreview,
  urls: V4PreviewObjectUrlBag,
): void;
```

Image pair creates two managed object URLs; binary pair shows side-specific size metadata.

- [ ] **Step 6: Upgrade Current file timeline to incremental pagination**

Store `fileVersionItems`, `nextCommitPage`, and `hasMore`. Initial render calls `getFileVersionsPage(fileId)`. `Load older` appends de-duplicated `{commit.sha,fileId,path,kind}` entries and advances cursor. Do not reverse the list; show newest first.

When active file changes and user re-enters Current file mode, resolve a fresh `fileId` and reset pagination.

- [ ] **Step 7: Add Restore confirmation flow**

Selecting a historical version calls `runtime.previewRestoreTarget()` and shows:

- selected commit/time/historical path;
- current target path;
- `Restore this version` or `Restore file as new local file`;
- disabled state while sync active.

On click show confirmation. First call `restoreHistoryVersion(... overrideLocal:false ...)`. Handle results:

- `restored` → Notice `Restored locally` plus `; sync manually when ready` when `queued:false`;
- `stale` → render `Refresh comparison` and `Restore anyway`; the latter calls again with `overrideLocal:true` using a newly captured target intent;
- `outside-scope` → require an explicit second confirmation then call with `allowOutsideScope:true`;
- error → inline error + Notice, no success claim.

Disable the action while the promise is in flight to serialize repeated clicks.

- [ ] **Step 8: Add responsive history CSS**

Keep `.github-sync-center` root. Desktop master/detail remains side-by-side; narrow/mobile widths stack master above detail. Use existing theme variables. Diff rows use textual `Before/After`, `Added/Removed` labels/classes so color is not the only signal.

- [ ] **Step 9: Run targeted UI tests and build**

Run:

```bash
node scripts/run-tests.mjs --tier=fast --filter=sync-center-history
pnpm build
```

Expected: PASS.

- [ ] **Step 10: Commit and push**

```bash
git add src/views/sync-center.ts src/views/v4-diff-preview.ts src/styles.scss tests/stubs/obsidian.ts tests/v4/sync-center-history.test.ts
git commit -m "feat: upgrade Sync Center history workspace"
git push origin HEAD:agent/conflict-history-ui
```

## Task 7: Full history/restore resource and regression gates

**Files:**
- Modify: `tests/resource/history-restore-resource.test.ts`
- Modify: `tests/v4/history-service.test.ts`
- Modify: `tests/v4/history-restore-runtime.test.ts`
- Modify: `tests/v4/sync-center-history.test.ts`
- Modify implementation only for concrete failures.

**Interfaces:**
- Verifies all prior History/Restore behavior.

- [ ] **Step 1: Add cache and pagination stress assertions**

Select at least 20 changed files from the same commit and assert commit/tree metadata request counts remain bounded by cache entries rather than 20×2 tree loads. Load more than 1,000 commits through multiple `getFileVersionsPage()` calls and assert no silent truncation.

- [ ] **Step 2: Add restore concurrency and collision stress**

Start two Restore calls for the same view action and assert UI/runtime serializes them so only one local commit occurs. Change target path occupancy/case collision after preview but before restore and assert final validation prevents overwrite.

- [ ] **Step 3: Add encrypted/plaintext history regression**

Run paired preview and restore tests in both storage modes for plugin commits. Confirm encrypted external commits never enable logical diff/Restore. Confirm plaintext external unambiguous rename inference does not affect plugin `fileId` history.

- [ ] **Step 4: Run all project verification gates**

Run exactly:

```bash
pnpm build
pnpm test:fast
pnpm test:repeat
pnpm test:recovery
pnpm test:resource
pnpm test:feasibility
pnpm validate:package
```

Expected: every command exits 0.

- [ ] **Step 5: Verify no direct Git mutation path was added to History/Restore**

Run:

```bash
git grep -n "createGitCommit\|updateGitRef\|createGitRef" -- src/views/sync-center.ts src/lib/v4/history-service.ts src/lib/v4/history-restore.ts || true
node -e "const p=require('./package.json'); if (Object.keys(p.dependencies||{}).length) process.exit(1)"
```

Expected: History/Restore files contain no direct Git publication call and runtime dependencies are empty.

- [ ] **Step 6: Commit final history hardening and push**

```bash
git add src tests
git commit -m "test: harden history restore edge cases"
git push origin HEAD:agent/conflict-history-ui
```

---

## Self-Review Checklist

- explicit before/after and first-parent behavior → Task 1;
- immutable tree cache and safe truncated-tree failure → Task 1;
- >1000 commits/load older + external plaintext/encrypted semantics → Task 2;
- current-path vs deleted/new-identity Restore target semantics → Task 3;
- >5 MiB/chunked restore independent from preview → Task 4;
- active-sync gate, hash precondition, local-first write, auto-sync policy → Task 5;
- repository/current-file diff UI and Restore UX → Task 6;
- cache/resource/concurrency/encryption/full CI → Task 7.

The History plan must not introduce a path that writes remote Git state directly. All publication after Restore remains normal V4 sync.