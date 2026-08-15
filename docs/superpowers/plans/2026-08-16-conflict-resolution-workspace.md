# Conflict Resolution Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace per-file conflict modals with one generation-aware, resource-bounded conflict workspace that resolves structural and text conflicts safely before the existing V4 publication/recovery pipeline proceeds.

**Architecture:** Keep Git/CAS/recovery ownership inside `V4SyncSession`, introduce a runtime-scoped `V4ConflictResolutionCoordinator` as the single async boundary between the session and UI, and keep three-way diff/merge logic in pure TypeScript. The ItemView renders coordinator state only; it never publishes Git mutations. User-resolved inputs get an additional local fingerprint guard immediately before ref publication.

**Tech Stack:** TypeScript 5.9, Obsidian ItemView/native DOM, Node `node:test`, existing V4 codec/staging/resource-controller APIs, no new runtime dependency.

## Global Constraints

- Keep the existing `V4_MAX_MERGE_BYTES = 2 * 1024 * 1024` text ceiling.
- Add CPU bounds: at most 40,000 logical line tokens per side, at most 250,000 DP cells in one fallback segment, and at most 2,000,000 DP cells across one two-way diff.
- `copy` and `newer` retain current automatic semantics; `ask` opens the workspace for every planner conflict; `merge` auto-merges only fully safe cases and opens the workspace for unresolved structural/content conflicts.
- Force Push and Force Pull never invoke the conflict workspace.
- Desktop `auto` view mode resolves to Split; mobile `auto` resolves to Unified.
- Conflict drafts are memory-only before confirmation; confirmed bytes may use the existing V4 staging/recovery mechanism.
- Preserve the repository's no-runtime-dependency posture.
- Do not copy source, CSS, or component implementation from `silvanocerza/github-gitless-sync`; UX inspiration only.
- Every task ends with targeted tests, then a commit, then `git push origin HEAD:agent/conflict-history-ui` so GitHub remains the source of truth.

---

## File Structure

Create focused files instead of expanding `sync-session.ts` and `runtime.ts` with UI/model logic:

- `src/lib/v4/conflict-types.ts` — structural side snapshots, fingerprints, batch/materializer/resolution interfaces.
- `src/lib/v4/text-diff.ts` — exact-EOL tokenization and bounded deterministic two-way diff.
- `src/lib/v4/conflict-merge-model.ts` — three-way hunk construction, merged-document mapping, hunk actions, manual edit application.
- `src/lib/v4/conflict-coordinator.ts` — in-memory pending batch lifecycle, subscriptions, generation/reuse, cancellation.
- `src/views/v4-diff-preview.ts` — shared read-only text/image/binary rendering primitives; History will reuse this later.
- `src/views/conflict-resolution.ts` — ItemView for Split/Unified conflict resolution.

Modify existing integration files only at their current responsibility boundary:

- `src/lib/v4/conflicts.ts` — policy decisions and text qualification entry points.
- `src/lib/v4/sync-session.ts` — one batch callback, lazy materialization, resolution-to-batch bindings, pre-publish guard.
- `src/lib/v4/runtime.ts` — own coordinator, bridge session callback, open/reveal view, finish/cancel behavior.
- `src/lib/v4/progress.ts` / `src/lib/v4/status.ts` — truthful cancelled/waiting-for-conflict status.
- `src/setting.tsx` — `conflictViewMode` and updated merge-policy description.
- `src/main.ts` — register/reveal conflict view and status-bar routing.
- `src/styles.scss` — scoped conflict/diff workspace CSS using Obsidian variables.
- `tests/stubs/obsidian.ts` — textarea/input/event/view behavior needed by UI tests.

## Task 1: Structural conflict snapshots and stable fingerprints

**Files:**
- Create: `src/lib/v4/conflict-types.ts`
- Create: `tests/v4/conflict-fingerprint.test.ts`
- Modify: `src/lib/v4/conflicts.ts`

**Interfaces:**
- Produces: `V4ConflictSideSnapshot`, `V4ConflictFileSummary`, `V4ConflictMaterializedFile`, `V4ConflictFileResolution`, `V4ConflictBatchRequest`, `V4ConflictBatchResolution`, `fingerprintV4ConflictFile()`.
- Consumes: `normalizeV4VaultPath`, `sha256Hex`, `utf8ToBytes`, existing `V4ConflictPolicy`.

- [ ] **Step 1: Write the failing structural fingerprint tests**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { fingerprintV4ConflictFile } from "../../src/lib/v4/conflict-types";

const present = (path: string, hash = "a".repeat(64)) => ({
  exists: true as const,
  path,
  hash,
  size: 10,
  mtime: 1,
});
const absent = { exists: false as const };

test("conflict fingerprint changes for rename with identical bytes", async () => {
  const first = await fingerprintV4ConflictFile({
    fileId: "f1",
    base: present("a.md"),
    local: present("a.md"),
    remote: present("remote.md"),
  });
  const second = await fingerprintV4ConflictFile({
    fileId: "f1",
    base: present("a.md"),
    local: present("local.md"),
    remote: present("remote.md"),
  });
  assert.notEqual(first, second);
});

test("conflict fingerprint distinguishes deletion from empty content", async () => {
  const deleted = await fingerprintV4ConflictFile({ fileId: "f1", base: present("a.md"), local: absent, remote: present("a.md") });
  const empty = await fingerprintV4ConflictFile({ fileId: "f1", base: present("a.md"), local: present("a.md", "e".repeat(64)), remote: present("a.md") });
  assert.notEqual(deleted, empty);
});
```

- [ ] **Step 2: Run the fingerprint test and verify it fails because the module is missing**

Run: `node scripts/run-tests.mjs --tier=fast --filter=conflict-fingerprint`

Expected: FAIL during bundle/typecheck with `Could not resolve "../../src/lib/v4/conflict-types"`.

- [ ] **Step 3: Add exact structural types and canonical fingerprinting**

```ts
import { sha256Hex, utf8ToBytes } from "../bytes";
import { normalizeV4VaultPath } from "./paths";

export type V4ConflictSideSnapshot =
  | { exists: false }
  | { exists: true; path: string; hash: string; size: number; mtime: number };

export interface V4ConflictFileFingerprintInput {
  fileId: string;
  base: V4ConflictSideSnapshot;
  local: V4ConflictSideSnapshot;
  remote: V4ConflictSideSnapshot;
}

function canonicalSide(side: V4ConflictSideSnapshot): object {
  if (!side.exists) return { exists: false };
  return {
    exists: true,
    path: normalizeV4VaultPath(side.path).normalize("NFC"),
    hash: side.hash,
  };
}

export async function fingerprintV4ConflictFile(input: V4ConflictFileFingerprintInput): Promise<string> {
  return sha256Hex(utf8ToBytes(JSON.stringify({
    fileId: input.fileId,
    base: canonicalSide(input.base),
    local: canonicalSide(input.local),
    remote: canonicalSide(input.remote),
  })));
}

export type V4ConflictResolutionKind = "use-local" | "use-remote" | "keep-both" | "merged";

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

Also replace any new path fingerprint logic elsewhere with this helper; do not build a second path/hash identity format in the session or view.

- [ ] **Step 4: Add policy regression coverage to existing `conflicts.test.ts`**

Add assertions that `copy` and `newer` remain byte-for-byte behavior compatible and change the `merge` overlap expectation from `keep-local-copy-remote` to `ask` once Task 5 wires the new merge path. Until Task 5, leave the old overlap assertion and mark this exact assertion change as part of Task 5 rather than weakening it now.

- [ ] **Step 5: Run targeted tests**

Run: `node scripts/run-tests.mjs --tier=fast --filter=conflict-fingerprint`

Expected: PASS.

- [ ] **Step 6: Commit and push**

```bash
git add src/lib/v4/conflict-types.ts tests/v4/conflict-fingerprint.test.ts
git commit -m "feat: define structural conflict fingerprints"
git push origin HEAD:agent/conflict-history-ui
```

## Task 2: Exact-EOL bounded two-way diff core

**Files:**
- Create: `src/lib/v4/text-diff.ts`
- Create: `tests/v4/conflict-text-diff.test.ts`
- Modify: `src/lib/v4/conflicts.ts`

**Interfaces:**
- Produces: `V4LineToken`, `V4LineChange`, `V4TextDocument`, `V4DiffBudgetExceededError`, `decodeV4TextDocument()`, `diffV4TextLines()`.
- Consumes: `V4_MAX_MERGE_BYTES` from `conflicts.ts`.

- [ ] **Step 1: Write failing tests for exact tokenization and budget failure**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeV4TextDocument,
  diffV4TextLines,
  V4DiffBudgetExceededError,
} from "../../src/lib/v4/text-diff";

const enc = (value: string) => new TextEncoder().encode(value);

test("tokenizer preserves BOM, mixed EOL, and final newline", () => {
  const doc = decodeV4TextDocument(enc("\uFEFFa\r\nb\nc\rd"));
  assert.equal(doc.bom, "\uFEFF");
  assert.deepEqual(doc.lines.map(line => [line.text, line.eol]), [
    ["a", "\r\n"], ["b", "\n"], ["c", "\r"], ["d", ""],
  ]);
});

test("NUL-containing pseudo text is rejected", () => {
  assert.throws(() => decodeV4TextDocument(new Uint8Array([0x61, 0x00, 0x62])), /binary-looking/u);
});

test("pathological repeated-line input fails closed at the work budget", () => {
  const base = { bom: "", lines: Array.from({ length: 2000 }, () => ({ text: "x", eol: "\n" as const })) };
  const changed = { bom: "", lines: Array.from({ length: 2000 }, (_, index) => ({ text: index === 1000 ? "y" : "x", eol: "\n" as const })) };
  assert.throws(() => diffV4TextLines(base, changed, { maxLines: 40000, maxSegmentCells: 1000, maxTotalCells: 1000 }), V4DiffBudgetExceededError);
});
```

- [ ] **Step 2: Run the text-diff tests and verify they fail because the module is missing**

Run: `node scripts/run-tests.mjs --tier=fast --filter=conflict-text-diff`

Expected: FAIL during bundle/typecheck.

- [ ] **Step 3: Implement exact text decoding and tokenization**

Use these exported contracts and constants:

```ts
export const V4_MAX_DIFF_LINES = 40_000;
export const V4_MAX_DIFF_SEGMENT_CELLS = 250_000;
export const V4_MAX_DIFF_TOTAL_CELLS = 2_000_000;

export type V4Eol = "\n" | "\r\n" | "\r" | "";
export interface V4LineToken { text: string; eol: V4Eol; }
export interface V4TextDocument { bom: "" | "\uFEFF"; lines: V4LineToken[]; }
export interface V4LineChange { baseStart: number; baseEnd: number; replacement: V4LineToken[]; }

export class V4DiffBudgetExceededError extends Error {
  constructor(message = "V4 text diff work budget exceeded.") {
    super(message);
    this.name = "V4DiffBudgetExceededError";
  }
}
```

`decodeV4TextDocument(bytes)` must:

1. reject bytes over `V4_MAX_MERGE_BYTES` before decoding;
2. decode with `new TextDecoder("utf-8", { fatal: true })`;
3. strip one leading BOM into `doc.bom`;
4. reject NUL and reject control-heavy bodies when more than 2% of non-EOL characters are C0 controls other than tab;
5. scan the string once, emitting a token for `\r\n`, `\n`, lone `\r`, or final no-EOL text;
6. represent the empty file as `lines: []`, while `"\n"` becomes one `{text:"", eol:"\n"}` token.

- [ ] **Step 4: Implement deterministic patience-anchor diff with bounded DP gaps**

Use exact token equality (`text` and `eol`). The algorithm is:

1. trim common prefix and suffix;
2. build token-frequency maps for each middle segment;
3. pair tokens that are unique on both sides;
4. choose a monotonic anchor chain by LIS over variant indices;
5. for every gap between anchors, run LCS DP only if `(baseGap + 1) * (variantGap + 1) <= maxSegmentCells` and cumulative cells stay `<= maxTotalCells`;
6. throw `V4DiffBudgetExceededError` rather than allocate beyond either limit;
7. convert unmatched runs into `V4LineChange` values and coalesce only directly adjacent changes.

Keep the DP memory bounded to two score rows plus a compact direction matrix for the current bounded segment. Since the segment is capped at 250,000 cells, the direction matrix must be a `Uint8Array`, not nested JS arrays.

The public signature is:

```ts
export function diffV4TextLines(
  base: V4TextDocument,
  variant: V4TextDocument,
  limits: { maxLines?: number; maxSegmentCells?: number; maxTotalCells?: number } = {},
): V4LineChange[];
```

Throw `V4DiffBudgetExceededError` if either document exceeds `maxLines`.

- [ ] **Step 5: Add deterministic diff cases**

Extend the test file with start/end insertions, deletions, repeated lines, huge single line, LF↔CRLF-only change, no-final-newline change, malformed UTF-8, emoji, and identical input. For identical input assert an empty change list.

- [ ] **Step 6: Run targeted tests**

Run: `node scripts/run-tests.mjs --tier=fast --filter=conflict-text-diff`

Expected: PASS.

- [ ] **Step 7: Commit and push**

```bash
git add src/lib/v4/text-diff.ts src/lib/v4/conflicts.ts tests/v4/conflict-text-diff.test.ts
git commit -m "feat: add bounded exact text diff"
git push origin HEAD:agent/conflict-history-ui
```

## Task 3: Three-way merge model and manual edit mapping

**Files:**
- Create: `src/lib/v4/conflict-merge-model.ts`
- Create: `tests/v4/conflict-merge-model.test.ts`

**Interfaces:**
- Consumes: `decodeV4TextDocument()`, `diffV4TextLines()`, `V4LineChange`.
- Produces: `V4ConflictMergeModel`, `V4MergeHunk`, `createV4ConflictMergeModel()`.

- [ ] **Step 1: Write failing hunk/action/manual-edit tests**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { createV4ConflictMergeModel } from "../../src/lib/v4/conflict-merge-model";

const enc = (value: string) => new TextEncoder().encode(value);

test("three-way merge auto-applies disjoint edits and leaves overlap on BASE", () => {
  const model = createV4ConflictMergeModel({
    baseBytes: enc("one\ntwo\nthree"),
    localBytes: enc("LOCAL\ntwo\nthree"),
    remoteBytes: enc("REMOTE\ntwo\nTHREE"),
  });
  assert.equal(model.unresolvedCount, 1);
  assert.equal(model.text, "one\ntwo\nTHREE");
});

test("Accept both is local then remote with no deduplication", () => {
  const model = createV4ConflictMergeModel({ baseBytes: enc("x\n"), localBytes: enc("L\n"), remoteBytes: enc("R\n") });
  const hunk = model.hunks.find(item => item.kind === "conflict")!;
  model.applyHunkAction(hunk.id, "accepted-both");
  assert.equal(model.text, "L\nR\n");
});

test("manual edit crossing two unresolved ranges resolves both and shifts later mappings", () => {
  const model = createV4ConflictMergeModel({
    baseBytes: enc("a\nb\nc\nd\n"),
    localBytes: enc("A\nb\nC\nd\n"),
    remoteBytes: enc("R\nb\nS\nd\n"),
  });
  model.applyManualText("manual\nd\n");
  assert.equal(model.unresolvedCount, 0);
  assert.ok(model.hunks.filter(hunk => hunk.kind === "conflict").every(hunk => hunk.resolution === "manually-resolved"));
});
```

- [ ] **Step 2: Run and verify failure**

Run: `node scripts/run-tests.mjs --tier=fast --filter=conflict-merge-model`

Expected: FAIL because the merge-model module does not exist.

- [ ] **Step 3: Implement hunk construction from two BASE-relative change lists**

Define:

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

Build `base→local` and `base→remote` changes, sweep them in BASE order, and group changes when their BASE ranges overlap. For zero-length insertions, two insertions overlap when their `baseStart` is equal. A grouped region is:

- auto local when only LOCAL contributes;
- auto remote when only REMOTE contributes;
- auto same-change when BASE range and exact replacement tokens are equal;
- conflict otherwise.

Generate the initial merged document by applying auto regions and BASE text for conflict regions. Preserve BOM/EOL tokens exactly when converting regions back to text.

- [ ] **Step 4: Implement mapped range updates and hunk actions**

Expose:

```ts
export class V4ConflictMergeModel {
  get text(): string;
  get hunks(): readonly V4MergeHunk[];
  get unresolvedCount(): number;
  applyHunkAction(id: string, action: Exclude<V4MergeResolution, "unresolved" | "auto" | "manually-resolved">): void;
  applyManualText(next: string): void;
  reset(): void;
  toBytes(): Uint8Array;
}
```

For an action, replace only `[hunk.from, hunk.to)` and then update all mappings with:

```ts
const delta = replacement.length - (to - from);
for (const candidate of hunks) {
  if (candidate.id === target.id) {
    candidate.to = candidate.from + replacement.length;
    continue;
  }
  if (candidate.from >= to) {
    candidate.from += delta;
    candidate.to += delta;
  }
}
```

For `applyManualText(next)`, compute the shortest changed span using common prefix and common suffix between current and next text. Every unresolved hunk whose mapped interval intersects the old changed span, or whose zero-width insertion point lies inside it, becomes `manually-resolved`. Shift later mappings by the text delta and expand intersected hunk mappings to cover the replacement boundary deterministically.

`reset()` restores the immutable initial text/hunk ranges captured at construction.

- [ ] **Step 5: Add full merge-model edge coverage**

Add tests for delete-vs-edit, competing insertions, same insertion, adjacent non-overlap, BOM, CRLF, final newline, empty file, emoji, manual edit outside hunk, action after manual resolution, reset, paste-equivalent whole-value update, and no model mutation from a Split/Unified presentation flag stored outside the model.

- [ ] **Step 6: Run targeted tests**

Run: `node scripts/run-tests.mjs --tier=fast --filter=conflict-merge-model`

Expected: PASS.

- [ ] **Step 7: Commit and push**

```bash
git add src/lib/v4/conflict-merge-model.ts tests/v4/conflict-merge-model.test.ts
git commit -m "feat: add three-way conflict merge model"
git push origin HEAD:agent/conflict-history-ui
```

## Task 4: Runtime-scoped conflict coordinator

**Files:**
- Create: `src/lib/v4/conflict-coordinator.ts`
- Create: `tests/v4/conflict-coordinator.test.ts`
- Modify: `src/lib/v4/cancellation.ts` only if a reusable cancellation constructor/export is missing.

**Interfaces:**
- Consumes: `V4ConflictBatchRequest`, `V4ConflictBatchResolution`, `V4ConflictFileResolution`, `V4CancelledError`.
- Produces: `V4ConflictResolutionCoordinator`, `V4ConflictCoordinatorSnapshot`.

- [ ] **Step 1: Write failing coordinator lifecycle tests**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { V4ConflictResolutionCoordinator } from "../../src/lib/v4/conflict-coordinator";

function batch(generation: number, fingerprint: string) {
  return {
    runId: "run-1",
    generation,
    contextKey: "repo#main|plaintext|scope-a",
    expectedRemoteHead: "head-1",
    files: [{
      fileId: "f1", displayPath: "note.md", fingerprint,
      base: { exists: false as const }, local: { exists: false as const }, remote: { exists: false as const },
      textEligible: false, requiresReview: true,
    }],
    async materialize() { throw new Error("not needed"); },
  };
}

test("closing subscribers does not settle a pending batch", async () => {
  const coordinator = new V4ConflictResolutionCoordinator();
  const pending = coordinator.resolveBatch(batch(1, "fp-1"));
  const unsubscribe = coordinator.subscribe(() => undefined);
  unsubscribe();
  assert.equal(coordinator.snapshot.pending, true);
  coordinator.setFileResolution({ fileId: "f1", fingerprint: "fp-1", kind: "use-local" });
  coordinator.continueBatch();
  assert.equal((await pending).generation, 1);
});

test("matching fingerprint is reused across generation and changed fingerprint is not", async () => {
  const coordinator = new V4ConflictResolutionCoordinator();
  const first = coordinator.resolveBatch(batch(1, "fp-1"));
  coordinator.setFileResolution({ fileId: "f1", fingerprint: "fp-1", kind: "use-local" });
  coordinator.continueBatch();
  await first;
  const second = coordinator.resolveBatch(batch(2, "fp-1"));
  assert.equal(coordinator.snapshot.files[0].resolved, true);
  coordinator.continueBatch();
  await second;
  const third = coordinator.resolveBatch(batch(3, "fp-2"));
  assert.equal(coordinator.snapshot.files[0].resolved, false);
  coordinator.cancel();
  await assert.rejects(third, /cancel/iu);
});
```

- [ ] **Step 2: Run and verify failure**

Run: `node scripts/run-tests.mjs --tier=fast --filter=conflict-coordinator`

Expected: FAIL because coordinator module is missing.

- [ ] **Step 3: Implement one-pending-batch state machine**

The coordinator must keep:

```ts
private current?: {
  request: V4ConflictBatchRequest;
  resolve: (value: V4ConflictBatchResolution) => void;
  reject: (reason: unknown) => void;
};
private readonly resolutionCache = new Map<string, V4ConflictFileResolution>();
private readonly listeners = new Set<(snapshot: V4ConflictCoordinatorSnapshot) => void>();
```

Cache keys are `${fileId}:${fingerprint}`. `resolveBatch()` accepts a newer generation for the same `runId/contextKey`, hydrates compatible cached resolutions, and rejects attempts to attach a different run/context while another batch is pending.

`materialize(fileId)` delegates to the current request with the current generation and throws if the returned generation is stale.

`continueBatch()` validates every current file has a compatible resolution and every `requiresReview` file has been explicitly reviewed; then resolves the session promise but retains the resolution cache until `completeRun(runId)`.

`cancel(reason)` rejects the pending promise with `V4CancelledError`, clears the batch, and notifies subscribers.

- [ ] **Step 4: Wire AbortSignal settlement**

`resolveBatch(request, signal?)` must attach one abort listener that calls `cancel(signal.reason)` and must remove it on resolve/reject. Add a test that aborts the controller and asserts the promise rejects promptly and `snapshot.pending === false`.

- [ ] **Step 5: Add stale materializer test**

Create generation 1, start a materialization promise, replace with generation 2 before it resolves, then assert generation-1 completion is rejected/ignored and does not alter coordinator state.

- [ ] **Step 6: Run targeted tests**

Run: `node scripts/run-tests.mjs --tier=fast --filter=conflict-coordinator`

Expected: PASS.

- [ ] **Step 7: Commit and push**

```bash
git add src/lib/v4/conflict-coordinator.ts src/lib/v4/cancellation.ts tests/v4/conflict-coordinator.test.ts
git commit -m "feat: add conflict batch coordinator"
git push origin HEAD:agent/conflict-history-ui
```

## Task 5: Replace per-file session callback with batch resolution and policy-aware lazy materialization

**Files:**
- Modify: `src/lib/v4/sync-session.ts`
- Modify: `src/lib/v4/conflicts.ts`
- Modify: `tests/v4/conflicts.test.ts`
- Create: `tests/v4/conflict-session.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4 types/model; existing `V4ResolvedBatch`, `V4StageRef`, `V4StorageCodec`, resource controller.
- Produces: `V4ConflictReplanRequiredError`; `V4SyncSessionInput.resolveConflictBatch?: (request, signal) => Promise<V4ConflictBatchResolution>`.

- [ ] **Step 1: Write failing session tests for one batch, policy behavior, and structural conflict**

Build the test with the same in-memory GitHub/vault style already used by `history-service.test.ts`. Cover these assertions in one new file:

```ts
assert.equal(batchCalls, 1);
assert.deepEqual(batchFiles.map(file => file.fileId).sort(), ["f1", "f2"]);
assert.equal(publishedBeforeResolution, false);
assert.equal(copyPolicyBatchCalls, 0);
assert.equal(newerPolicyBatchCalls, 0);
assert.equal(forcePushBatchCalls, 0);
assert.equal(forcePullBatchCalls, 0);
assert.equal(mergeOverlapBatchCalls, 1);
assert.equal(divergentRenameFile.textEligible, false);
```

Use a deferred promise for `resolveConflictBatch` and assert the Git ref is unchanged until the promise is resolved.

- [ ] **Step 2: Run and verify current code fails because it still calls `askConflict` per file**

Run: `node scripts/run-tests.mjs --tier=fast --filter=conflict-session`

Expected: FAIL on callback shape/count expectations.

- [ ] **Step 3: Change the session input and run state contracts**

Replace:

```ts
askConflict?: (input: { path: string; localMtime: number; remoteMtime: number }) => Promise<V4ConflictResolution>
```

with:

```ts
resolveConflictBatch?: (
  request: V4ConflictBatchRequest,
  signal?: AbortSignal,
) => Promise<V4ConflictBatchResolution>;
```

Extend `V4SyncRunState` with:

```ts
conflictGeneration?: number;
```

Increment it once for every newly planned unresolved batch.

- [ ] **Step 4: Factor conflict side snapshots and structural classification out of the current loop**

Add private helpers inside `V4SyncSession`:

```ts
private sideSnapshot(file?: V4LogicalFile): V4ConflictSideSnapshot {
  return file ? { exists: true, path: file.path, hash: file.hash, size: file.size, mtime: file.mtime } : { exists: false };
}

private structurallyMergeable(conflict: V4PlannedConflict): boolean {
  if (!conflict.base || !conflict.local || !conflict.remote) return false;
  const basePath = conflict.base.path;
  const localChangedPath = conflict.local.path !== basePath;
  const remoteChangedPath = conflict.remote.path !== basePath;
  return !localChangedPath || !remoteChangedPath || conflict.local.path === conflict.remote.path;
}
```

For one-sided rename, use the renamed path as the target path. For same rename, use that shared path. Divergent rename, edit/delete, rename/delete, and no-BASE competing create are structural file-level conflicts.

- [ ] **Step 5: Implement generation-scoped lazy materialization**

Create a `materializeConflict(conflict, generation, expectedGeneration)` helper that:

1. checks generation before I/O;
2. reads LOCAL only if present and needed;
3. reads REMOTE through `readRecord(remoteRecord, remoteCommitSha)` only if present;
4. reads BASE from REMOTE bytes when `remoteVersion` proves identity, otherwise from the recorded base commit;
5. checks generation again after each awaited read;
6. returns `V4ConflictMaterializedFile` with no persistent disk draft.

Use `canAttemptV4TextMerge()` plus fatal decoding/work-budget probing to set `textEligible`. If decoding or diff budget fails, mark file-level rather than throwing the sync run.

- [ ] **Step 6: Implement automatic policy pass before building the unresolved batch**

Process `plan.conflicts` in deterministic path order:

- `copy`: existing `keep-local-copy-remote` path.
- `newer`: existing mtime choice/equal-copy fallback.
- `ask`: add every planner conflict to unresolved summaries; `requiresReview: true`.
- `merge`: if structurally mergeable and all required text sides materialize, build `V4ConflictMergeModel`; if `unresolvedCount === 0`, emit a `merged` resolution automatically; otherwise add the file to unresolved summaries. Structural conflicts go straight to unresolved summaries.

Update `resolveV4Conflict()` so `policy:"merge"` returns `{action:"ask"}` on unsafe/unresolved overlap instead of `keep-local-copy-remote`; preserve the old behavior for `copy` and `newer` exactly.

- [ ] **Step 7: Await exactly one unresolved batch and translate returned resolutions into the existing `V4ResolvedBatch`**

Build `V4ConflictBatchRequest`, call `resolveConflictBatch`, validate `runId`, generation, file IDs, and fingerprints, then reuse the existing binding logic:

- `use-remote` → `changeBetween(local, remote)` pull.
- `merged` → stage returned bytes, create `mergedAfter`, push and staged local write exactly as current merged path does.
- `use-local` → local push.
- `keep-both` → existing `runState.conflictCopies` reservation/staging path plus local push.

Reject missing/duplicate/foreign resolution entries before any conflict-dependent publication.

- [ ] **Step 8: Update policy tests**

In `tests/v4/conflicts.test.ts`, make overlap under `merge` assert `action === "ask"`. Keep copy/newer/equal-mtime expectations unchanged.

- [ ] **Step 9: Run targeted tests**

Run:

```bash
node scripts/run-tests.mjs --tier=fast --filter=conflicts
node scripts/run-tests.mjs --tier=fast --filter=conflict-session
```

Expected: PASS.

- [ ] **Step 10: Commit and push**

```bash
git add src/lib/v4/sync-session.ts src/lib/v4/conflicts.ts tests/v4/conflicts.test.ts tests/v4/conflict-session.test.ts
git commit -m "feat: resolve V4 conflicts as one batch"
git push origin HEAD:agent/conflict-history-ui
```

## Task 6: Remote revalidation and final pre-publish local conflict guard

**Files:**
- Modify: `src/lib/v4/sync-session.ts`
- Modify: `src/lib/v4/runtime.ts`
- Create: `tests/v4/conflict-revalidation.test.ts`
- Create: `tests/recovery/conflict-publish-guard.test.ts`

**Interfaces:**
- Produces: `V4ConflictReplanRequiredError` recognized by runtime CAS retry loop.
- Consumes: conflict side snapshots/fingerprints and existing bounded local hashing.

- [ ] **Step 1: Write failing revalidation tests**

Cover two separate races:

1. remote HEAD changes while the batch promise is pending; after Continue the session must throw a replan signal before applying/staging final mutations;
2. local conflict file changes after Continue but immediately before `publishV4CandidateRef`; the candidate ref must not be updated.

The publication test must assert the GitHub stub's `updateGitRef` call count remains zero for the stale candidate.

- [ ] **Step 2: Run and verify the tests fail under current publication order**

Run:

```bash
node scripts/run-tests.mjs --tier=fast --filter=conflict-revalidation
node scripts/run-tests.mjs --tier=recovery --filter=conflict-publish-guard
```

Expected: FAIL because no conflict-specific pre-publish guard exists.

- [ ] **Step 3: Add a dedicated replan error and post-Continue remote-head check**

```ts
export class V4ConflictReplanRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "V4ConflictReplanRequiredError";
  }
}
```

Immediately after the batch result is accepted:

```ts
const observedHead = (await this.input.github.getGitRefOrNull())?.sha ?? null;
if (observedHead !== (ref?.sha ?? null)) {
  throw new V4ConflictReplanRequiredError("Remote head changed while conflict resolution was open.");
}
```

- [ ] **Step 4: Capture local guards for every user-presented conflict**

Keep an array of `{fileId, local: V4ConflictSideSnapshot}` for the accepted generation. Do not guard only merged files; `use-remote` also needs protection because a new local edit after the user's decision must not be overwritten by a stale remote choice.

- [ ] **Step 5: Implement bounded local revalidation helper**

For absent LOCAL, assert the original path remains absent. For present LOCAL:

1. stat current path;
2. if absent, path/size/mtime differ, hash it using existing `hashLocal(path, size, mtime)` rather than trusting stat alone;
3. compare the resulting path/hash/presence with the captured side snapshot;
4. throw `V4ConflictReplanRequiredError` on any mismatch.

Run this helper once after Continue and again immediately before `publishV4CandidateRef`.

- [ ] **Step 6: Teach runtime retry loop to retry this error in the same top-level run**

Change the retry predicate to treat `V4ConflictReplanRequiredError` like `V4RecoveryReplanRequiredError` for normal sync. Keep the three-attempt cap. `runState.runId` and coordinator cache survive the retry; the next batch generation decides which fingerprints can reuse decisions.

- [ ] **Step 7: Run targeted revalidation/recovery tests**

Run:

```bash
node scripts/run-tests.mjs --tier=fast --filter=conflict-revalidation
node scripts/run-tests.mjs --tier=recovery --filter=conflict-publish-guard
```

Expected: PASS, including zero stale-ref publication.

- [ ] **Step 8: Commit and push**

```bash
git add src/lib/v4/sync-session.ts src/lib/v4/runtime.ts tests/v4/conflict-revalidation.test.ts tests/recovery/conflict-publish-guard.test.ts
git commit -m "fix: guard resolved conflicts before publish"
git push origin HEAD:agent/conflict-history-ui
```

## Task 7: Runtime coordinator ownership, cancellation lifecycle, and status routing

**Files:**
- Modify: `src/lib/v4/runtime.ts`
- Modify: `src/lib/v4/progress.ts`
- Modify: `src/lib/v4/status.ts`
- Modify: `src/main.ts`
- Create: `tests/v4/conflict-runtime.test.ts`
- Modify: existing progress/status tests if present.

**Interfaces:**
- Consumes: `V4ConflictResolutionCoordinator` and session `resolveConflictBatch` callback.
- Produces runtime methods: `hasPendingConflicts`, `conflictSnapshot`, `subscribeConflicts()`, `openConflictResolution()`, `cancelConflictResolution()`.

- [ ] **Step 1: Write failing runtime/status tests**

Assert:

```ts
assert.equal(runtime.hasPendingConflicts, true);
assert.equal(runtime.progressSnapshot.phase, "resolving-conflicts");
assert.match(formatV4ActiveSyncStatus(runtime.progressSnapshot).text, /conflict/iu);
```

Also test explicit cancel finishes lifecycle as `cancelled`, plugin unload aborts the pending batch, and a settings/credential generation change invalidates a pending batch.

- [ ] **Step 2: Extend progress lifecycle with `cancelled`**

Change:

```ts
export type V4SyncLifecycle = "idle" | "waiting" | "active" | "success" | "no-change" | "failed" | "cancelled";
```

Allow `V4ProgressStore.finish()` to accept `cancelled`; format it as `GH Sync: Cancelled`. Keep conflict wait itself as lifecycle `active`, phase `resolving-conflicts`.

- [ ] **Step 3: Own one coordinator inside `V4PluginRuntime`**

Add:

```ts
private readonly conflictCoordinator = new V4ConflictResolutionCoordinator();
get hasPendingConflicts(): boolean { return this.conflictCoordinator.snapshot.pending; }
get conflictSnapshot() { return this.conflictCoordinator.snapshot; }
subscribeConflicts(listener: Parameters<V4ConflictResolutionCoordinator["subscribe"]>[0]) {
  return this.conflictCoordinator.subscribe(listener);
}
```

Pass `resolveConflictBatch: (batch, batchSignal) => this.conflictCoordinator.resolveBatch(batch, batchSignal ?? signal)` into every `V4SyncSession`.

Call `completeRun(runState.runId)` only after the session result/index save succeeds. On explicit cancel, reject the pending batch. On `dispose()` cancel/clear it before waiting for the sync coordinator to become idle.

- [ ] **Step 4: Make configuration changes invalidate pending conflict context**

In `credentialsChanged()`, if a batch is pending call `conflictCoordinator.cancel(new V4CancelledError("V4 conflict resolution cancelled because repository settings changed."))` before incrementing credential generation. This covers owner/repo/branch/mode/scope changes because `saveSettings()` already routes through this method.

- [ ] **Step 5: Finish cancellation truthfully in runtime execute**

Replace the current early cancellation return with:

```ts
if (error instanceof V4CancelledError) {
  this.progressStore.finish("cancelled");
  return { changedFiles: 0 };
}
```

Do not emit a failure Notice for user cancellation.

- [ ] **Step 6: Route status-bar clicks by pending conflict state**

In `main.ts`, status click behavior becomes:

```ts
span.onclick = () => {
  if (this.unloaded || !runtime) return;
  if (runtime.hasPendingConflicts) {
    void this.openConflictResolution();
    return;
  }
  if (!runtime.isSyncing) void runtime.manualSync();
};
```

`openConflictResolution()` is implemented in Task 8; until then keep the method declaration compiling with the registered view constant introduced there in the same commit sequence.

- [ ] **Step 7: Run targeted tests**

Run: `node scripts/run-tests.mjs --tier=fast --filter=conflict-runtime`

Expected: PASS.

- [ ] **Step 8: Commit and push**

```bash
git add src/lib/v4/runtime.ts src/lib/v4/progress.ts src/lib/v4/status.ts src/main.ts tests/v4/conflict-runtime.test.ts
git commit -m "feat: integrate conflict lifecycle with V4 runtime"
git push origin HEAD:agent/conflict-history-ui
```

## Task 8: Conflict ItemView, Split/Unified UI, binary preview, and settings

**Files:**
- Create: `src/views/v4-diff-preview.ts`
- Create: `src/views/conflict-resolution.ts`
- Modify: `src/main.ts`
- Modify: `src/setting.tsx`
- Modify: `src/styles.scss`
- Modify: `tests/stubs/obsidian.ts`
- Create: `tests/v4/conflict-view.test.ts`

**Interfaces:**
- Consumes: coordinator snapshot/materializer/model APIs.
- Produces: `V4_CONFLICT_RESOLUTION_VIEW`, `V4ConflictResolutionView`, shared preview helpers reused by the History plan.

- [ ] **Step 1: Extend Obsidian stubs before writing view tests**

Add `ElementStub.value`, `oninput`, `onchange`, `scrollTop`, and a minimal event listener registry:

```ts
value = "";
oninput?: () => void;
onchange?: () => void;
scrollTop = 0;
private listeners = new Map<string, Array<(event: any) => void>>();
addEventListener(type: string, listener: (event: any) => void) {
  const list = this.listeners.get(type) ?? [];
  list.push(listener);
  this.listeners.set(type, list);
}
dispatchEvent(event: { type: string }) {
  for (const listener of this.listeners.get(event.type) ?? []) listener(event);
  return true;
}
```

Give `WorkspaceLeaf` test methods `setViewState()` and `getViewState()` sufficient for registration/reveal tests.

- [ ] **Step 2: Write failing view behavior tests**

Cover:

- desktop + `auto` renders Split markers;
- mobile + `auto` renders Unified markers;
- changing mode does not replace the existing merge-model text;
- one coordinator batch shows file tabs and unresolved counts;
- a text hunk button updates the merged textarea;
- textarea input calls `applyManualText`;
- no active batch renders `No active conflicts`;
- closing the view does not call cancel;
- image object URLs are all revoked on rerender/close;
- stale render generation/materialization result does not mutate current DOM.

- [ ] **Step 3: Add persisted conflict view setting**

Extend `PluginSettings` and defaults:

```ts
conflictViewMode: "auto" | "split" | "unified";
```

Default `auto`. Add a dropdown with `Auto`, `Split`, `Unified`. Update merge policy label/description to `Merge text; ask when unresolved` while leaving the stored policy value `merge` unchanged.

- [ ] **Step 4: Implement shared read-only diff/preview helpers**

`src/views/v4-diff-preview.ts` owns DOM-only rendering:

```ts
export interface V4PreviewObjectUrlBag {
  add(url: string): void;
  revokeAll(): void;
}

export function renderV4TextLines(container: HTMLElement, lines: readonly { number?: number; text: string; className?: string }[]): void;
export function renderV4BinaryMetadata(container: HTMLElement, input: { path: string; size?: number; mtime?: number; hash?: string }): void;
```

Implement `V4PreviewObjectUrlBag` with a `Set<string>` and `URL.revokeObjectURL` for every stored URL.

- [ ] **Step 5: Implement the ItemView shell and mode resolution**

```ts
export const V4_CONFLICT_RESOLUTION_VIEW = "github-sync-v4-conflict-resolution";

function effectiveMode(setting: "auto" | "split" | "unified"): "split" | "unified" {
  if (setting !== "auto") return setting;
  return Platform.isMobile ? "unified" : "split";
}
```

If the installed Obsidian type exposes only `Platform.isDesktopApp`, use `Platform.isDesktopApp ? "split" : "unified"` and mirror that in tests.

The view subscribes to coordinator state on open and unsubscribes on close. It never cancels in `onClose()`.

- [ ] **Step 6: Render text conflicts**

Split layout:

```text
[file tabs + progress + mode]
LOCAL read-only | hunk action column | REMOTE read-only
Merged Result textarea
Previous | Next | Show resolved | Resolve all & continue
```

Unified layout renders each conflict hunk as BASE context, LOCAL block, REMOTE block, then `Local / Remote / Both / Base` actions. For `ask` files with zero unresolved text hunks, show `Confirm merged result`; set the coordinator file as reviewed only when the user presses it or manually edits the result.

Textarea input reads `textarea.value` and calls `model.applyManualText(value)`; rerender conflict counters without replacing the textarea node during active composition.

- [ ] **Step 7: Render structural/binary conflicts**

For file-level conflicts expose only valid actions. `Keep both` is hidden when either side is absent. Image preview uses object URLs when bytes are materialized and previewable; unknown binary shows path/size/mtime/hash metadata. Preview failure shows an inline error but leaves resolution buttons enabled.

- [ ] **Step 8: Register and reveal one conflict view**

In `main.ts` register the view once and add:

```ts
async openConflictResolution(): Promise<void> {
  const existing = this.app.workspace.getLeavesOfType(V4_CONFLICT_RESOLUTION_VIEW)[0];
  const leaf = existing ?? this.app.workspace.getLeaf("tab");
  if (!existing) await leaf.setViewState({ type: V4_CONFLICT_RESOLUTION_VIEW, active: true });
  await this.app.workspace.revealLeaf(leaf);
}
```

If this codebase's Obsidian typings do not support `getLeaf("tab")`, use the existing compatible `getRightLeaf(false)` pattern. Never create a second resolver leaf while one already exists.

- [ ] **Step 9: Add scoped responsive/theme CSS**

Use `.github-sync-conflicts` as the root class. Use Obsidian variables such as `--background-primary`, `--background-secondary`, `--text-normal`, `--text-muted`, `--interactive-accent`, `--background-modifier-error`, and `--background-modifier-success`. Do not encode state only by color; include labels/icons. Set mobile action min-height to at least `44px`.

- [ ] **Step 10: Run targeted UI tests and build**

Run:

```bash
node scripts/run-tests.mjs --tier=fast --filter=conflict-view
pnpm build
```

Expected: PASS.

- [ ] **Step 11: Commit and push**

```bash
git add src/views/v4-diff-preview.ts src/views/conflict-resolution.ts src/main.ts src/setting.tsx src/styles.scss tests/stubs/obsidian.ts tests/v4/conflict-view.test.ts
git commit -m "feat: add conflict resolution workspace"
git push origin HEAD:agent/conflict-history-ui
```

## Task 9: Resource, recovery, collision, and end-to-end regression gates

**Files:**
- Create: `tests/resource/conflict-workspace-resource.test.ts`
- Create: `tests/recovery/conflict-workspace-recovery.test.ts`
- Modify: `tests/v4/conflict-session.test.ts`
- Modify: `tests/v4/conflict-view.test.ts`
- Modify: implementation files only when a failing gate identifies a concrete defect.

**Interfaces:**
- Verifies all prior tasks; produces no new public API unless a test exposes a missing safety boundary.

- [ ] **Step 1: Add resource tests for lazy materialization and diff budget**

Construct a batch with at least 100 conflict summaries and instrument materializer calls. Opening the coordinator/view and selecting one file must materialize only that file (plus at most one explicitly implemented adjacent-prefetch file). Assert no loop eagerly reads all 100.

Create a 40,001-line text input and assert it is classified file-level without allocating a DP matrix. Create repeated-line input that hits the 2,000,000-cell total work budget and assert safe downgrade.

- [ ] **Step 2: Add recovery/publish tests**

Exercise a confirmed merged conflict through existing staging/recovery and assert:

- confirmed bytes are staged through current V4 mechanisms;
- crash/recovery can complete a published candidate;
- a local precondition change before publication causes replan and zero stale ref updates;
- a local precondition change after a successfully published candidate follows existing recovery semantics rather than silently disappearing.

- [ ] **Step 3: Add Keep-both collision regression**

Reserve a conflict-copy path, create an unrelated local file at that path while the resolver is open, then Continue. Assert the old reservation is not overwritten. The implementation must either invalidate/re-reserve to a new safe path or require review again. Reuse `assertNoCaseInsensitiveCollisions` semantics; add a case-only collision variant.

- [ ] **Step 4: Add config-generation and stale-render regression**

While a batch is pending, change repository settings/credential generation and assert the pending promise is cancelled. Resolve an old materializer promise after a new generation/view render and assert no DOM/state mutation.

- [ ] **Step 5: Run every required verification gate**

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

- [ ] **Step 6: Review diff against the approved design and scan for forbidden reference copying/dependencies**

Run:

```bash
git diff master...HEAD -- src tests package.json pnpm-lock.yaml
git grep -n "github-gitless-sync\|silvanocerza" -- src tests package.json pnpm-lock.yaml || true
node -e "const p=require('./package.json'); if (Object.keys(p.dependencies||{}).length) process.exit(1)"
```

Expected: implementation contains no copied-reference identifiers/source and runtime dependencies remain empty.

- [ ] **Step 7: Commit final hardening and push**

```bash
git add src tests package.json pnpm-lock.yaml
git commit -m "test: harden conflict workspace edge cases"
git push origin HEAD:agent/conflict-history-ui
```

If `package.json`/`pnpm-lock.yaml` are unchanged, omit them from `git add` rather than creating noise.

---

## Self-Review Checklist

Before executing this plan, verify these mappings against the approved spec:

- structural path/presence conflicts → Tasks 1 and 5;
- bounded exact text/EOL/BOM diff → Task 2;
- hunk actions/manual merged authority → Task 3;
- one batch, close/reopen, generation reuse, cancellation → Task 4;
- copy/newer/ask/merge/force semantics → Task 5;
- remote replan + final local pre-publish guard → Task 6;
- truthful cancelled/status/settings invalidation → Task 7;
- desktop/mobile UI, binary preview, one ItemView → Task 8;
- collision/resource/recovery/full CI → Task 9.

No task may weaken existing `copy`, `newer`, CAS, recovery, source-stability, scope, encryption, or change-guard behavior to make the new UI pass.