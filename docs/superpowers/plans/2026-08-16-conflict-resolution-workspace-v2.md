# Conflict Resolution Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace per-file conflict modals with one generation-aware, resource-bounded conflict workspace that resolves structural and text conflicts safely before the existing V4 publication/recovery pipeline proceeds.

**Architecture:** `V4SyncSession` remains the owner of planning, Git/CAS, staging, recovery, and final safety checks. A runtime-scoped `V4ConflictResolutionCoordinator` provides one awaitable batch boundary and retains in-memory UI state across pane close/reopen and CAS replans. Pure TypeScript modules handle structural fingerprints, bounded exact-EOL diff, and editable three-way merge; the ItemView only renders/edits coordinator state.

**Tech Stack:** TypeScript 5.9, Obsidian native DOM/ItemView, existing V4 codec/staging/resource-controller APIs, Node `node:test`, no new runtime dependency.

## Global Constraints

- Keep `V4_MAX_MERGE_BYTES = 2 * 1024 * 1024`.
- Diff bounds: 40,000 logical line tokens per side, 250,000 DP cells per fallback segment, 2,000,000 DP cells total per two-way diff.
- `copy` and `newer` preserve current automatic semantics; `ask` opens the workspace for every planner conflict; `merge` auto-merges only fully safe cases and asks for unresolved structural/content conflicts.
- Force Push and Force Pull never open the conflict workspace.
- Desktop `auto` → Split; mobile `auto` → Unified.
- Draft BASE/LOCAL/REMOTE/merged state is memory-only before confirmation; confirmed merged bytes may use existing V4 staging/recovery.
- Do not add runtime dependencies.
- Do not copy AGPL reference source/CSS/components.
- After each task: targeted tests → commit → `git push origin HEAD:agent/conflict-history-ui`.

## File Map

- Create `src/lib/v4/conflict-types.ts`: side snapshots, fingerprints, batch/materializer/resolution contracts.
- Create `src/lib/v4/text-diff.ts`: fatal UTF-8 decoding, exact EOL/BOM tokenization, bounded deterministic diff.
- Create `src/lib/v4/conflict-merge-model.ts`: three-way hunks, merged text, hunk actions, manual-edit mapping.
- Create `src/lib/v4/conflict-coordinator.ts`: pending batch state, generation reuse, subscriptions, cancellation.
- Create `src/views/v4-diff-preview.ts`: shared read-only diff/image/binary DOM primitives.
- Create `src/views/conflict-resolution.ts`: Conflict Resolution ItemView.
- Modify `src/lib/v4/conflicts.ts`, `sync-session.ts`, `runtime.ts`, `progress.ts`, `status.ts`, `setting.tsx`, `main.ts`, `styles.scss`, and `tests/stubs/obsidian.ts` only at their existing boundaries.

---

### Task 1: Structural side snapshots and path-aware fingerprints

**Files:**
- Create: `src/lib/v4/conflict-types.ts`
- Create: `tests/v4/conflict-fingerprint.test.ts`

**Interfaces:**
- Produces: `V4ConflictSideSnapshot`, `V4ConflictFileSummary`, `V4ConflictMaterializedFile`, `V4ConflictFileResolution`, `V4ConflictBatchRequest`, `V4ConflictBatchResolution`, `fingerprintV4ConflictFile()`.
- Consumes: `normalizeV4VaultPath`, `sha256Hex`, `utf8ToBytes`.

- [ ] **Step 1: Write the failing fingerprint tests**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { fingerprintV4ConflictFile } from "../../src/lib/v4/conflict-types";

const present = (path: string, hash = "a".repeat(64)) => ({ exists: true as const, path, hash, size: 10, mtime: 1 });
const absent = { exists: false as const };

test("rename changes fingerprint even when bytes are identical", async () => {
  const a = await fingerprintV4ConflictFile({ fileId: "f", base: present("a.md"), local: present("a.md"), remote: present("r.md") });
  const b = await fingerprintV4ConflictFile({ fileId: "f", base: present("a.md"), local: present("l.md"), remote: present("r.md") });
  assert.notEqual(a, b);
});

test("absence is not empty content", async () => {
  const a = await fingerprintV4ConflictFile({ fileId: "f", base: present("a.md"), local: absent, remote: present("a.md") });
  const b = await fingerprintV4ConflictFile({ fileId: "f", base: present("a.md"), local: present("a.md", "e".repeat(64)), remote: present("a.md") });
  assert.notEqual(a, b);
});
```

- [ ] **Step 2: Verify red**

Run: `node scripts/run-tests.mjs --tier=fast --filter=conflict-fingerprint`

Expected: FAIL because `conflict-types.ts` does not exist.

- [ ] **Step 3: Implement canonical structural contracts**

```ts
import { sha256Hex, utf8ToBytes } from "../bytes";
import { normalizeV4VaultPath } from "./paths";

export type V4ConflictSideSnapshot =
  | { exists: false }
  | { exists: true; path: string; hash: string; size: number; mtime: number };

function canonical(side: V4ConflictSideSnapshot): object {
  return side.exists
    ? { exists: true, path: normalizeV4VaultPath(side.path).normalize("NFC"), hash: side.hash }
    : { exists: false };
}

export async function fingerprintV4ConflictFile(input: {
  fileId: string;
  base: V4ConflictSideSnapshot;
  local: V4ConflictSideSnapshot;
  remote: V4ConflictSideSnapshot;
}): Promise<string> {
  return sha256Hex(utf8ToBytes(JSON.stringify({
    fileId: input.fileId,
    base: canonical(input.base),
    local: canonical(input.local),
    remote: canonical(input.remote),
  })));
}

export interface V4ConflictFileSummary {
  fileId: string;
  displayPath: string;
  fingerprint: string;
  base: V4ConflictSideSnapshot;
  local: V4ConflictSideSnapshot;
  remote: V4ConflictSideSnapshot;
  textEligible: boolean;
  requiresReview: boolean;
}

export interface V4ConflictMaterializedFile {
  generation: number;
  summary: V4ConflictFileSummary;
  baseBytes?: Uint8Array;
  localBytes?: Uint8Array;
  remoteBytes?: Uint8Array;
}

export type V4ConflictFileResolution =
  | { fileId: string; fingerprint: string; kind: "use-local" }
  | { fileId: string; fingerprint: string; kind: "use-remote" }
  | { fileId: string; fingerprint: string; kind: "keep-both" }
  | { fileId: string; fingerprint: string; kind: "merged"; path: string; bytes: Uint8Array };

export interface V4ConflictBatchRequest {
  runId: string;
  generation: number;
  contextKey: string;
  expectedRemoteHead: string | null;
  files: readonly V4ConflictFileSummary[];
  materialize(fileId: string, generation: number): Promise<V4ConflictMaterializedFile>;
}

export interface V4ConflictBatchResolution {
  runId: string;
  generation: number;
  files: readonly V4ConflictFileResolution[];
}
```

- [ ] **Step 4: Verify green**

Run: `node scripts/run-tests.mjs --tier=fast --filter=conflict-fingerprint`

Expected: PASS.

- [ ] **Step 5: Commit and push**

```bash
git add src/lib/v4/conflict-types.ts tests/v4/conflict-fingerprint.test.ts
git commit -m "feat: define structural conflict fingerprints"
git push origin HEAD:agent/conflict-history-ui
```

### Task 2: Exact-EOL bounded text diff

**Files:**
- Create: `src/lib/v4/text-diff.ts`
- Create: `tests/v4/conflict-text-diff.test.ts`
- Modify: `src/lib/v4/conflicts.ts`

**Interfaces:**
- Produces: `V4TextDocument`, `V4LineToken`, `V4LineChange`, `V4DiffBudgetExceededError`, `decodeV4TextDocument()`, `diffV4TextLines()`.

- [ ] **Step 1: Write failing decoder/budget tests**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { decodeV4TextDocument, diffV4TextLines, V4DiffBudgetExceededError } from "../../src/lib/v4/text-diff";

const enc = (s: string) => new TextEncoder().encode(s);

test("preserves BOM mixed EOL and no-final-newline", () => {
  const doc = decodeV4TextDocument(enc("\uFEFFa\r\nb\nc\rd"));
  assert.equal(doc.bom, "\uFEFF");
  assert.deepEqual(doc.lines.map(x => [x.text, x.eol]), [["a","\r\n"],["b","\n"],["c","\r"],["d",""]]);
});

test("rejects NUL pseudo text", () => {
  assert.throws(() => decodeV4TextDocument(new Uint8Array([0x61, 0, 0x62])), /binary-looking/u);
});

test("fails closed when work budget is exceeded", () => {
  const base = { bom: "" as const, lines: Array.from({ length: 2000 }, () => ({ text: "x", eol: "\n" as const })) };
  const next = { bom: "" as const, lines: Array.from({ length: 2000 }, (_, i) => ({ text: i === 1000 ? "y" : "x", eol: "\n" as const })) };
  assert.throws(() => diffV4TextLines(base, next, { maxSegmentCells: 1000, maxTotalCells: 1000 }), V4DiffBudgetExceededError);
});
```

- [ ] **Step 2: Verify red**

Run: `node scripts/run-tests.mjs --tier=fast --filter=conflict-text-diff`

Expected: FAIL because `text-diff.ts` is missing.

- [ ] **Step 3: Implement exact tokenization and limits**

```ts
export const V4_MAX_DIFF_LINES = 40_000;
export const V4_MAX_DIFF_SEGMENT_CELLS = 250_000;
export const V4_MAX_DIFF_TOTAL_CELLS = 2_000_000;
export type V4Eol = "\n" | "\r\n" | "\r" | "";
export interface V4LineToken { text: string; eol: V4Eol; }
export interface V4TextDocument { bom: "" | "\uFEFF"; lines: V4LineToken[]; }
export interface V4LineChange { baseStart: number; baseEnd: number; replacement: V4LineToken[]; }
export class V4DiffBudgetExceededError extends Error {
  constructor(message = "V4 text diff work budget exceeded.") { super(message); this.name = "V4DiffBudgetExceededError"; }
}
```

`decodeV4TextDocument()` must check the 2 MiB ceiling before fatal UTF-8 decode, separate one BOM, reject NUL/control-heavy content (>2% non-tab C0 controls), scan EOLs once, and represent empty file as zero tokens.

- [ ] **Step 4: Implement patience anchors plus bounded DP gaps**

`diffV4TextLines(base, variant, limits)` must trim exact common prefix/suffix, find line tokens unique on both sides, use LIS over variant positions for monotonic anchors, and solve only anchor gaps with LCS DP. Before each gap allocate only if `(baseGap + 1) * (variantGap + 1) <= maxSegmentCells` and cumulative cells remain `<= maxTotalCells`; otherwise throw `V4DiffBudgetExceededError`. Use two score rows and `Uint8Array` direction storage for the bounded gap, never nested JS cell objects. Coalesce only directly adjacent `V4LineChange` runs.

- [ ] **Step 5: Add edge tests**

Add malformed UTF-8, LF↔CRLF-only change, lone CR, final newline, huge single line, repeated-line determinism, insert/delete at file boundaries, emoji, identical input, and 40,001-line budget rejection.

- [ ] **Step 6: Verify green**

Run: `node scripts/run-tests.mjs --tier=fast --filter=conflict-text-diff`

Expected: PASS.

- [ ] **Step 7: Commit and push**

```bash
git add src/lib/v4/text-diff.ts src/lib/v4/conflicts.ts tests/v4/conflict-text-diff.test.ts
git commit -m "feat: add bounded exact text diff"
git push origin HEAD:agent/conflict-history-ui
```

### Task 3: Editable three-way merge model

**Files:**
- Create: `src/lib/v4/conflict-merge-model.ts`
- Create: `tests/v4/conflict-merge-model.test.ts`

**Interfaces:**
- Consumes: Task 2 diff contracts.
- Produces: `V4ConflictMergeModel`, `V4MergeHunk`, `createV4ConflictMergeModel()`.

- [ ] **Step 1: Write failing merge/action/manual-edit tests**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { createV4ConflictMergeModel } from "../../src/lib/v4/conflict-merge-model";
const enc = (s: string) => new TextEncoder().encode(s);

test("disjoint remote edit auto-applies while overlap stays BASE", () => {
  const m = createV4ConflictMergeModel({ baseBytes: enc("one\ntwo\nthree"), localBytes: enc("LOCAL\ntwo\nthree"), remoteBytes: enc("REMOTE\ntwo\nTHREE") });
  assert.equal(m.unresolvedCount, 1);
  assert.equal(m.text, "one\ntwo\nTHREE");
});

test("Accept both is literal local then remote", () => {
  const m = createV4ConflictMergeModel({ baseBytes: enc("x\n"), localBytes: enc("L\n"), remoteBytes: enc("R\n") });
  const h = m.hunks.find(x => x.kind === "conflict")!;
  m.applyHunkAction(h.id, "accepted-both");
  assert.equal(m.text, "L\nR\n");
});
```

- [ ] **Step 2: Verify red**

Run: `node scripts/run-tests.mjs --tier=fast --filter=conflict-merge-model`

Expected: FAIL because the module is missing.

- [ ] **Step 3: Implement BASE-relative grouping/classification**

```ts
export type V4MergeResolution = "unresolved" | "accepted-local" | "accepted-remote" | "accepted-both" | "discarded-both" | "manually-resolved" | "auto";
export interface V4MergeHunk {
  id: string;
  kind: "auto" | "conflict";
  baseStart: number;
  baseEnd: number;
  baseText: string;
  localText: string;
  remoteText: string;
  from: number;
  to: number;
  resolution: V4MergeResolution;
}
```

Compute BASE→LOCAL and BASE→REMOTE changes, sweep in BASE order, group overlapping ranges; zero-width insertions at the same BASE position overlap. Auto-resolve local-only, remote-only, and exactly equal BASE-range/replacement changes. Everything else is a conflict. Initial merged text applies auto changes and inserts exact BASE text for unresolved regions.

- [ ] **Step 4: Implement action and manual range mapping**

Expose `text`, `hunks`, `unresolvedCount`, `applyHunkAction()`, `applyManualText()`, `reset()`, `toBytes()`. A hunk action replaces only its mapped `[from,to)` and shifts later mappings by `delta`. `applyManualText()` finds the shortest changed span by common prefix/suffix; every unresolved mapped range intersected by that edit becomes `manually-resolved`, including multiple hunks. Edits outside unresolved ranges change final text but do not resolve hunks. `reset()` restores the immutable initial auto-merge state.

- [ ] **Step 5: Add edge tests**

Cover competing insertions, delete-vs-edit, same insertion, adjacent changes, CRLF/BOM/final newline, empty file, emoji, manual edit across two hunks, edit outside hunk, action after manual resolution, reset, and paste-equivalent whole-value changes.

- [ ] **Step 6: Verify green**

Run: `node scripts/run-tests.mjs --tier=fast --filter=conflict-merge-model`

Expected: PASS.

- [ ] **Step 7: Commit and push**

```bash
git add src/lib/v4/conflict-merge-model.ts tests/v4/conflict-merge-model.test.ts
git commit -m "feat: add three-way conflict merge model"
git push origin HEAD:agent/conflict-history-ui
```

### Task 4: Generation-aware in-memory conflict coordinator

**Files:**
- Create: `src/lib/v4/conflict-coordinator.ts`
- Create: `tests/v4/conflict-coordinator.test.ts`

**Interfaces:**
- Consumes: Task 1 batch contracts and existing cancellation types.
- Produces: `V4ConflictResolutionCoordinator`, immutable `V4ConflictCoordinatorSnapshot`.

- [ ] **Step 1: Write failing lifecycle/reuse/abort tests**

Create generation 1, set a file resolution, Continue, then generation 2 with same fingerprint and assert it is reused. Generation 3 with changed fingerprint must be unresolved. Unsubscribing/closing the view must not settle the wait. AbortSignal and explicit cancel must reject promptly with cancellation and clear `pending`.

- [ ] **Step 2: Verify red**

Run: `node scripts/run-tests.mjs --tier=fast --filter=conflict-coordinator`

Expected: FAIL because coordinator module is missing.

- [ ] **Step 3: Implement single-run pending state**

Store current request/promise resolver, listener set, and `resolutionCache` keyed by `${fileId}:${fingerprint}`. `resolveBatch()` only accepts the same `runId/contextKey` while a logical run is active, hydrates matching cached resolutions, and attaches one abort listener. `materialize(fileId)` delegates with current generation and rejects a result whose `generation` no longer matches. `continueBatch()` validates every file has a current-fingerprint resolution and every `requiresReview` file is reviewed. `completeRun(runId)` clears cache/state only after sync success/cancel.

- [ ] **Step 4: Add stale materializer test**

Start generation-1 materialization, advance to generation 2, resolve the old promise, and assert no coordinator state/DOM-facing snapshot changes.

- [ ] **Step 5: Verify green**

Run: `node scripts/run-tests.mjs --tier=fast --filter=conflict-coordinator`

Expected: PASS.

- [ ] **Step 6: Commit and push**

```bash
git add src/lib/v4/conflict-coordinator.ts tests/v4/conflict-coordinator.test.ts
git commit -m "feat: add conflict batch coordinator"
git push origin HEAD:agent/conflict-history-ui
```

### Task 5: Batch session integration and policy semantics

**Files:**
- Modify: `src/lib/v4/conflicts.ts`
- Modify: `src/lib/v4/sync-session.ts`
- Modify: `tests/v4/conflicts.test.ts`
- Create: `tests/v4/conflict-session.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces: `V4SyncSessionInput.resolveConflictBatch`, structural classifier/lazy materializer, generation increment in `V4SyncRunState`.

- [ ] **Step 1: Write failing session integration tests**

Use in-memory GitHub/vault helpers and a deferred `resolveConflictBatch`. Assert two planner conflicts produce one batch call, no ref publication occurs while deferred, `copy/newer` produce zero batch calls, force operations produce zero batch calls, `merge` clean disjoint text auto-resolves, `merge` overlap calls the batch, and divergent rename is file-level.

- [ ] **Step 2: Verify red**

Run: `node scripts/run-tests.mjs --tier=fast --filter=conflict-session`

Expected: FAIL because current session still awaits `askConflict` once per conflict.

- [ ] **Step 3: Replace callback contract**

```ts
resolveConflictBatch?: (
  request: V4ConflictBatchRequest,
  signal?: AbortSignal,
) => Promise<V4ConflictBatchResolution>;
```

Remove the per-file `askConflict` callback. Add `conflictGeneration?: number` to `V4SyncRunState` and increment once per unresolved batch plan.

- [ ] **Step 4: Add structural classification**

Represent each planner side with Task 1 snapshots. Hunk text is allowed only when all three sides exist and paths resolve to one target: one-sided rename adopts changed path; same rename adopts shared path. Divergent rename, edit/delete, rename/delete, and no-BASE competing create are file-level. Target paths must still pass existing path/case-collision rules before application.

- [ ] **Step 5: Add generation-scoped lazy materializer**

Load only requested sides, using `readLocal()` and `readRecord()`/base record at the recorded commit. Check generation before and after awaits. Qualify text with extension/2 MiB/fatal UTF-8/binary-looking/work-budget checks. Decode/diff budget failure downgrades this conflict to file-level instead of failing the sync run.

- [ ] **Step 6: Apply policies before building unresolved summaries**

Keep `copy` and `newer` exact. `ask` adds every planner conflict with `requiresReview:true`. `merge` runs Task 3 sequentially when structural/text-safe; if zero unresolved hunks, emit automatic merged bytes, otherwise add to workspace. Change current `resolveV4Conflict(policy:"merge")` overlap fallback to `{action:"ask"}` and update `conflicts.test.ts`; equal-mtime newer/copy regression assertions remain unchanged.

- [ ] **Step 7: Translate one returned batch to existing resolved bindings**

Validate run ID, generation, file ID uniqueness, and fingerprints first. Translate `use-remote` to pull, `use-local` to local push, `keep-both` through current `runState.conflictCopies/conflictCopyStages`, and `merged` through current stage→push→staged-local-write logic. Missing/foreign/duplicate entries fail before conflict-dependent publication.

- [ ] **Step 8: Verify green**

Run:

```bash
node scripts/run-tests.mjs --tier=fast --filter=conflicts
node scripts/run-tests.mjs --tier=fast --filter=conflict-session
```

Expected: PASS.

- [ ] **Step 9: Commit and push**

```bash
git add src/lib/v4/conflicts.ts src/lib/v4/sync-session.ts tests/v4/conflicts.test.ts tests/v4/conflict-session.test.ts
git commit -m "feat: resolve V4 conflicts as one batch"
git push origin HEAD:agent/conflict-history-ui
```

### Task 6: Post-Continue revalidation and final pre-publish conflict guard

**Files:**
- Modify: `src/lib/v4/sync-session.ts`
- Modify: `src/lib/v4/runtime.ts`
- Create: `tests/v4/conflict-revalidation.test.ts`
- Create: `tests/recovery/conflict-publish-guard.test.ts`

**Interfaces:**
- Produces: `V4ConflictReplanRequiredError`, recognized by the existing runtime CAS retry loop.

- [ ] **Step 1: Write failing race tests**

Race A: remote HEAD changes while resolver is open; Continue must trigger replan before conflict application. Race B: local conflict file changes after Continue but before `publishV4CandidateRef`; assert the stale candidate's `updateGitRef` call count is zero.

- [ ] **Step 2: Verify red**

Run:

```bash
node scripts/run-tests.mjs --tier=fast --filter=conflict-revalidation
node scripts/run-tests.mjs --tier=recovery --filter=conflict-publish-guard
```

Expected: FAIL because no conflict-specific pre-publish local guard exists.

- [ ] **Step 3: Add replan error and remote-head recheck**

```ts
export class V4ConflictReplanRequiredError extends Error {
  constructor(message: string) { super(message); this.name = "V4ConflictReplanRequiredError"; }
}
```

After accepting a batch result, re-read branch ref and compare to the planning ref. Mismatch throws this error.

- [ ] **Step 4: Guard every user-presented LOCAL input twice**

Capture each accepted-generation LOCAL side snapshot. Revalidate once after Continue and once immediately before `publishV4CandidateRef`. Absence must remain absent. Presence/path/hash must remain equal. Use stat only as a fast path; when stat differs or full verification is required, reuse existing bounded `hashLocal()`/content-source logic. Guard `use-remote` and `keep-both` too, not only merged files.

- [ ] **Step 5: Retry within existing top-level run**

In runtime retry predicate treat `V4ConflictReplanRequiredError` like `V4RecoveryReplanRequiredError` for normal sync, preserving the three-attempt cap and `runState.runId`. The next coordinator generation reuses only matching fingerprints.

- [ ] **Step 6: Verify green**

Run the two commands from Step 2; both must PASS.

- [ ] **Step 7: Commit and push**

```bash
git add src/lib/v4/sync-session.ts src/lib/v4/runtime.ts tests/v4/conflict-revalidation.test.ts tests/recovery/conflict-publish-guard.test.ts
git commit -m "fix: guard resolved conflicts before publish"
git push origin HEAD:agent/conflict-history-ui
```

### Task 7: Runtime ownership, truthful status, settings, and Conflict ItemView in one compiling slice

**Files:**
- Create: `src/views/v4-diff-preview.ts`
- Create: `src/views/conflict-resolution.ts`
- Modify: `src/lib/v4/runtime.ts`
- Modify: `src/lib/v4/progress.ts`
- Modify: `src/lib/v4/status.ts`
- Modify: `src/setting.tsx`
- Modify: `src/main.ts`
- Modify: `src/styles.scss`
- Modify: `tests/stubs/obsidian.ts`
- Create: `tests/v4/conflict-runtime-view.test.ts`

**Interfaces:**
- Consumes: Tasks 1–6.
- Produces: `V4_CONFLICT_RESOLUTION_VIEW`, `V4ConflictResolutionView`, runtime conflict subscription/open/cancel APIs, shared preview primitives.

- [ ] **Step 1: Extend Obsidian stubs and write failing UI/runtime tests**

Add `ElementStub.value`, `oninput`, `onchange`, `scrollTop`, event listener registry, and sufficient `WorkspaceLeaf.setViewState/getViewState` behavior. Tests cover desktop auto Split, mobile auto Unified, one resolver leaf only, text action updates merged textarea, textarea manual edit, binary file-level actions, no-active-batch placeholder, close does not cancel, explicit Cancel does, stale render generation ignored, all image URLs revoked, status click opens resolver, and settings change cancels a pending batch.

- [ ] **Step 2: Add `cancelled` lifecycle and conflict-aware status text**

```ts
export type V4SyncLifecycle = "idle" | "waiting" | "active" | "success" | "no-change" | "failed" | "cancelled";
```

Allow `finish("cancelled")`; format it `GH Sync: Cancelled`. While pending resolver, keep lifecycle `active`, phase `resolving-conflicts`, and display `Waiting for conflict resolution` with counts when available.

- [ ] **Step 3: Make runtime own one `V4ConflictResolutionCoordinator`**

Expose `hasPendingConflicts`, immutable `conflictSnapshot`, `subscribeConflicts()`, and `cancelConflictResolution()`. Pass the coordinator's `resolveBatch` to sessions. On successful run call `completeRun(runId)`. On `V4CancelledError`, finish progress as `cancelled` without a failure Notice. `dispose()` cancels the pending resolver. `credentialsChanged()` cancels a pending batch before incrementing generation so saved repository/scope/mode changes cannot reuse old decisions.

- [ ] **Step 4: Add setting in the same commit slice**

Add `conflictViewMode: "auto" | "split" | "unified"` default `auto`, plus dropdown. Change visible merge policy description to `Merge text; ask when unresolved` without changing stored enum value.

- [ ] **Step 5: Implement shared preview object-url bag and basic text renderer**

`V4PreviewObjectUrlBag` stores every generated URL in a Set and revokes all on replacement/close. Add read-only text-line and binary metadata render helpers in `v4-diff-preview.ts`; History plan will extend this file later.

- [ ] **Step 6: Implement Conflict ItemView**

Register `V4_CONFLICT_RESOLUTION_VIEW = "github-sync-v4-conflict-resolution"`. On open subscribe to coordinator; on close unsubscribe/revoke URLs only. Effective mode is explicit setting or `Platform.isDesktopApp ? "split" : "unified"`. Split renders LOCAL/read-only actions/REMOTE plus editable merged textarea. Unified renders BASE/LOCAL/REMOTE blocks plus `Local / Remote / Both / Base`. An `ask` file with zero unresolved hunks requires explicit `Confirm merged result` or a manual edit before considered reviewed. Structural/binary conflicts expose valid `Use local / Use remote / Keep both` only; hide Keep both if one side is absent. Preview failure never disables resolution.

- [ ] **Step 7: Register/reveal one view and route status click**

In `main.ts`, register the view and implement `openConflictResolution()` using existing leaf if present; otherwise create one compatible leaf and reveal it. Status click precedence: pending conflicts → open resolver; idle → manual sync; active non-conflict → no second sync. This step and Step 6 are in the same task/commit so there is no intermediate undefined method/view constant.

- [ ] **Step 8: Add responsive theme CSS**

Root `.github-sync-conflicts`; Obsidian theme variables only. Desktop Split grid, mobile Unified stack, horizontal file tabs, sticky navigation, minimum 44px touch actions. State is communicated with text/icons as well as color.

- [ ] **Step 9: Verify UI/runtime/build**

Run:

```bash
node scripts/run-tests.mjs --tier=fast --filter=conflict-runtime-view
pnpm build
```

Expected: PASS.

- [ ] **Step 10: Commit and push**

```bash
git add src/views/v4-diff-preview.ts src/views/conflict-resolution.ts src/lib/v4/runtime.ts src/lib/v4/progress.ts src/lib/v4/status.ts src/setting.tsx src/main.ts src/styles.scss tests/stubs/obsidian.ts tests/v4/conflict-runtime-view.test.ts
git commit -m "feat: add conflict resolution workspace"
git push origin HEAD:agent/conflict-history-ui
```

### Task 8: Collision/resource/recovery/full verification

**Files:**
- Create: `tests/resource/conflict-workspace-resource.test.ts`
- Create: `tests/recovery/conflict-workspace-recovery.test.ts`
- Modify: prior conflict tests only to add concrete regression cases.

**Interfaces:**
- Verifies all prior tasks; no planned new public API.

- [ ] **Step 1: Add lazy/resource tests**

Build 100 conflict summaries and assert selecting one materializes only that file plus at most one explicitly implemented adjacent prefetch. Assert 40,001 lines and a repeated-line input exceeding 2,000,000 DP cells downgrade to file-level without unbounded allocation.

- [ ] **Step 2: Add Keep-both collision tests**

Reserve a conflict-copy path, create an unrelated occupant while resolver is open, then Continue. Assert no overwrite: re-reserve safely or invalidate review. Add a case-insensitive collision variant.

- [ ] **Step 3: Add recovery tests**

Confirmed merged bytes must use existing staging/recovery. Test crash/recovery around published candidate, local precondition change before publication (zero ref update), and source/recovery behavior after confirmed publication.

- [ ] **Step 4: Add stale context/render tests**

Change repository/settings generation during pending resolver and assert cancellation. Resolve an old materializer/render promise after generation change and assert no state/DOM mutation.

- [ ] **Step 5: Run full verification gates**

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

- [ ] **Step 6: License/dependency scan**

```bash
git grep -n "github-gitless-sync\|silvanocerza" -- src tests package.json pnpm-lock.yaml || true
node -e "const p=require('./package.json'); if (Object.keys(p.dependencies||{}).length) process.exit(1)"
```

Expected: no reference implementation identifiers in source/tests and runtime dependencies remain empty.

- [ ] **Step 7: Commit and push hardening**

```bash
git add src tests
git commit -m "test: harden conflict workspace edge cases"
git push origin HEAD:agent/conflict-history-ui
```

## Self-Review Coverage

- Structural rename/delete/create semantics and path-aware reuse: Tasks 1, 5, 8.
- Bounded exact-EOL/BOM text diff: Task 2.
- Hunk actions/manual final authority: Task 3.
- One batch, close/reopen, abort, generation reuse: Task 4.
- Policy compatibility and force-operation exclusion: Task 5.
- Remote replan and immediate pre-publish local guard: Task 6.
- Runtime lifecycle/status/settings + Desktop/Mobile UI + binary preview: Task 7.
- Resource/collision/recovery/full CI: Task 8.

No task may weaken current `copy`, `newer`, CAS, recovery, source-stability, scope, encryption, or change-guard behavior to make the new UI pass.