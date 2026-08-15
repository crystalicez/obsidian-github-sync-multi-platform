# Conflict Resolution Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace per-file conflict modals with one generation-aware, resource-bounded conflict workspace that resolves structural and text conflicts safely before the existing V4 publication/recovery pipeline proceeds.

**Architecture:** `V4SyncSession` remains the owner of planning, Git/CAS, staging, recovery, and final safety checks. A runtime-scoped `V4ConflictResolutionCoordinator` provides one awaitable batch boundary and retains in-memory decisions across pane close/reopen and CAS replans. Pure TypeScript modules handle structural fingerprints, bounded exact-EOL diff, and editable three-way merge; the ItemView only renders/edits coordinator state. During incremental implementation, the old per-file `askConflict` callback remains as a compatibility fallback until the ItemView/runtime slice is ready, so every intermediate commit still builds and remains usable.

**Tech Stack:** TypeScript 5.9, Obsidian native DOM/ItemView, existing V4 codec/staging/resource-controller APIs, Node `node:test`, no new runtime dependency.

## Global Constraints

- Keep `V4_MAX_MERGE_BYTES = 2 * 1024 * 1024`.
- Diff bounds: 40,000 logical line tokens per side, 250,000 DP cells per fallback segment, 2,000,000 DP cells total per two-way diff.
- `copy` and `newer` preserve current automatic semantics; `ask` opens the workspace for every planner conflict once runtime switches to the batch coordinator; `merge` auto-merges only fully safe cases and asks for unresolved structural/content conflicts.
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
- Modify `src/lib/v4/conflicts.ts`, `sync-session.ts`, `runtime.ts`, `progress.ts`, `status.ts`, `setting.tsx`, `main.ts`, `styles.scss`, and `tests/stubs/obsidian.ts` only at their current boundaries.

---

### Task 1: Structural side snapshots, context keys, and path-aware fingerprints

**Files:**
- Create: `src/lib/v4/conflict-types.ts`
- Create: `tests/v4/conflict-fingerprint.test.ts`

**Interfaces:**
- Produces: `V4ConflictSideSnapshot`, `V4ConflictFileSummary`, `V4ConflictMaterializedFile`, `V4ConflictFileResolution`, `V4ConflictBatchRequest`, `V4ConflictBatchResolution`, `fingerprintV4ConflictFile()`, `buildV4ConflictContextKey()`.
- Consumes: `normalizeV4VaultPath`, `sha256Hex`, `utf8ToBytes`.

- [ ] **Step 1: Write failing fingerprint/context tests**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { buildV4ConflictContextKey, fingerprintV4ConflictFile } from "../../src/lib/v4/conflict-types";

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

test("context key changes when saved target/scope generation changes", async () => {
  const a = await buildV4ConflictContextKey({ repoId: "o/r#main", mode: "plaintext", pathLayout: "logical-v1", settingsGeneration: 1, scopeSignature: "scope-a" });
  const b = await buildV4ConflictContextKey({ repoId: "o/r#main", mode: "plaintext", pathLayout: "logical-v1", settingsGeneration: 2, scopeSignature: "scope-a" });
  assert.notEqual(a, b);
});
```

- [ ] **Step 2: Verify red**

Run: `node scripts/run-tests.mjs --tier=fast --filter=conflict-fingerprint`

Expected: FAIL because `conflict-types.ts` does not exist.

- [ ] **Step 3: Implement canonical contracts**

```ts
import { sha256Hex, utf8ToBytes } from "../bytes";
import { normalizeV4VaultPath } from "./paths";

export type V4ConflictSideSnapshot =
  | { exists: false }
  | { exists: true; path: string; hash: string; size: number; mtime: number };

function canonicalSide(side: V4ConflictSideSnapshot): object {
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
  return sha256Hex(utf8ToBytes(JSON.stringify({ fileId: input.fileId, base: canonicalSide(input.base), local: canonicalSide(input.local), remote: canonicalSide(input.remote) })));
}

export async function buildV4ConflictContextKey(input: {
  repoId: string;
  mode: string;
  pathLayout: string;
  settingsGeneration: number;
  scopeSignature: string;
}): Promise<string> {
  return sha256Hex(utf8ToBytes(JSON.stringify(input)));
}

export interface V4ConflictFileSummary {
  fileId: string;
  displayPath: string;
  fingerprint: string;
  base: V4ConflictSideSnapshot;
  local: V4ConflictSideSnapshot;
  remote: V4ConflictSideSnapshot;
  textCandidate: boolean;
  requiresReview: boolean;
}

export interface V4ConflictMaterializedFile {
  generation: number;
  summary: V4ConflictFileSummary;
  mode: "text" | "file";
  downgradeReason?: string;
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

`textCandidate` means metadata says text editing might be possible; only materialization may return `mode:"text"` after fatal decode/binary/work-budget checks.

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

Expected: FAIL because the module is missing.

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

Decoder checks 2 MiB before fatal UTF-8 decode, separates one BOM, rejects NUL/control-heavy content (>2% non-tab C0 controls), scans CRLF/LF/lone-CR exactly once, and represents empty file as zero tokens.

- [ ] **Step 4: Implement patience anchors plus bounded DP gaps**

Trim exact common prefix/suffix; find tokens unique on both sides; select monotonic anchors by LIS; solve anchor gaps with LCS DP only if one gap stays ≤250,000 cells and cumulative work stays ≤2,000,000. Use two score rows plus `Uint8Array` direction storage; exceeding a limit throws `V4DiffBudgetExceededError`. Coalesce only directly adjacent changes.

- [ ] **Step 5: Add edge tests and verify green**

Add malformed UTF-8, LF↔CRLF, lone CR, final newline, huge single line, repeated-line determinism, boundaries, emoji, identical input, and 40,001-line rejection.

Run: `node scripts/run-tests.mjs --tier=fast --filter=conflict-text-diff`

Expected: PASS.

- [ ] **Step 6: Commit and push**

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
- Consumes: Task 2.
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

Expected: FAIL because module is missing.

- [ ] **Step 3: Implement BASE-relative grouping and exact action semantics**

```ts
export type V4MergeResolution = "unresolved" | "accepted-local" | "accepted-remote" | "accepted-both" | "discarded-both" | "manually-resolved" | "auto";
export interface V4MergeHunk {
  id: string; kind: "auto" | "conflict"; baseStart: number; baseEnd: number;
  baseText: string; localText: string; remoteText: string;
  from: number; to: number; resolution: V4MergeResolution;
}
```

Sweep BASE→LOCAL and BASE→REMOTE changes in BASE order. Same-position zero-width insertions overlap. Local-only/remote-only/equal replacement auto-resolve; incompatible overlap conflicts. Initial merged document uses exact BASE text for unresolved regions. `accepted-both` is exact LOCAL then REMOTE; `discarded-both` is exact BASE.

- [ ] **Step 4: Implement mapped manual edits**

Expose `text`, `hunks`, `unresolvedCount`, `applyHunkAction()`, `applyManualText()`, `reset()`, `toBytes()`. Actions replace only mapped hunk output and shift later offsets. `applyManualText()` computes shortest old/new change span by common prefix/suffix; every unresolved mapped range intersected becomes `manually-resolved`; edits outside unresolved ranges do not resolve a hunk. Reset restores immutable initial auto-merge text/ranges.

- [ ] **Step 5: Add edge tests and verify green**

Cover competing insertion, delete-vs-edit, same insertion, adjacent edits, CRLF/BOM/final newline, empty file, emoji, multi-hunk manual edit, outside-hunk edit, action after manual edit, reset, paste-equivalent changes.

Run: `node scripts/run-tests.mjs --tier=fast --filter=conflict-merge-model`

Expected: PASS.

- [ ] **Step 6: Commit and push**

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
- Consumes: Task 1 + existing cancellation types.
- Produces: `V4ConflictResolutionCoordinator`, immutable coordinator snapshot.

- [ ] **Step 1: Write failing lifecycle/reuse/abort tests**

Test same fingerprint reuse across generation, changed fingerprint invalidation, close/unsubscribe not settling wait, AbortSignal rejection, explicit cancel, and stale materializer completion after generation change.

- [ ] **Step 2: Verify red**

Run: `node scripts/run-tests.mjs --tier=fast --filter=conflict-coordinator`

Expected: FAIL because coordinator is missing.

- [ ] **Step 3: Implement one logical-run state machine**

Keep current request/promise resolver, listeners, and cache keyed by `${fileId}:${fingerprint}`. `resolveBatch()` accepts newer generation only for the same `runId/contextKey`, hydrates matching resolutions, and adds/removes one abort listener. `materialize(fileId)` delegates with current generation and rejects stale completion. `continueBatch()` requires every current file resolved and each `requiresReview` file explicitly reviewed. `completeRun(runId)` clears state/cache; `cancel()` rejects pending work and clears state/cache for that run.

- [ ] **Step 4: Verify green and commit**

Run: `node scripts/run-tests.mjs --tier=fast --filter=conflict-coordinator`

Expected: PASS.

```bash
git add src/lib/v4/conflict-coordinator.ts tests/v4/conflict-coordinator.test.ts
git commit -m "feat: add conflict batch coordinator"
git push origin HEAD:agent/conflict-history-ui
```

### Task 5: Batch-capable session with compatibility fallback and policy semantics

**Files:**
- Modify: `src/lib/v4/conflicts.ts`
- Modify: `src/lib/v4/sync-session.ts`
- Modify: `tests/v4/conflicts.test.ts`
- Create: `tests/v4/conflict-session.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces: optional `V4SyncSessionInput.resolveConflictBatch` while retaining existing `askConflict` fallback until Task 7; `conflictGeneration` in run state.

- [ ] **Step 1: Write failing batch-session tests**

Use a deferred `resolveConflictBatch` in the test input and assert two planner conflicts become one batch, ref is unchanged while deferred, copy/newer/force operations produce no batch, merge clean text auto-resolves, merge overlap produces a batch, and divergent rename materializes as file-level.

- [ ] **Step 2: Verify red**

Run: `node scripts/run-tests.mjs --tier=fast --filter=conflict-session`

Expected: FAIL because session has no batch path.

- [ ] **Step 3: Add optional batch callback without breaking runtime**

Keep existing `askConflict` temporarily and add:

```ts
resolveConflictBatch?: (request: V4ConflictBatchRequest, signal?: AbortSignal) => Promise<V4ConflictBatchResolution>;
conflictContextKey?: string;
```

Add `conflictGeneration?: number` to `V4SyncRunState`. When `resolveConflictBatch` is absent, preserve current per-file `askConflict` behavior so this commit remains usable. Task 7 removes the production modal bridge after the ItemView exists.

- [ ] **Step 4: Structural classification and metadata summaries**

Create side snapshots/fingerprint for every planner conflict. `textCandidate` is true only when metadata supports text size/type and all three content sides exist after structural target resolution. One-sided rename adopts changed path; same rename adopts shared path. Divergent rename, edit/delete, rename/delete, competing no-BASE create are file-level. Default batch `contextKey` is derived from config repoId/mode/pathLayout when tests do not supply `conflictContextKey`; production runtime supplies the stronger saved-settings/scope key in Task 7.

- [ ] **Step 5: Generation-scoped materializer and safe downgrade**

Read only requested sides using existing local/record/base commit paths; check generation before/after awaits. Fatal UTF-8, binary-looking content, or Task 2 budget failure returns `mode:"file"` plus reason; it does not fail sync.

- [ ] **Step 6: Policy pass**

Keep copy/newer exact. For `merge`, run Task 3 sequentially only when structural/text materialization is safe; zero unresolved hunks auto-stage merged bytes, unresolved text/structural cases go to batch when callback exists or legacy `askConflict` fallback otherwise. Change overlap result in `resolveV4Conflict(policy:"merge")` from copy fallback to `ask` and update `conflicts.test.ts`. `ask` uses the batch callback for every planner conflict when supplied.

- [ ] **Step 7: Translate returned batch to existing bindings**

Validate run ID/generation/unique file IDs/fingerprints before mutations. `use-remote`→pull, `use-local`→push, `keep-both`→existing conflict-copy reservation/staging, `merged`→existing stage/push/staged-local-write path.

- [ ] **Step 8: Verify green and commit**

```bash
node scripts/run-tests.mjs --tier=fast --filter=conflicts
node scripts/run-tests.mjs --tier=fast --filter=conflict-session
```

Expected: PASS and existing runtime still builds through `askConflict` fallback.

```bash
git add src/lib/v4/conflicts.ts src/lib/v4/sync-session.ts tests/v4/conflicts.test.ts tests/v4/conflict-session.test.ts
git commit -m "feat: add batch V4 conflict resolution path"
git push origin HEAD:agent/conflict-history-ui
```

### Task 6: Post-Continue remote check and final pre-publish local conflict guard

**Files:**
- Modify: `src/lib/v4/sync-session.ts`
- Modify: `src/lib/v4/runtime.ts`
- Create: `tests/v4/conflict-revalidation.test.ts`
- Create: `tests/recovery/conflict-publish-guard.test.ts`

**Interfaces:**
- Produces: `V4ConflictReplanRequiredError` recognized by runtime retry.

- [ ] **Step 1: Write failing race tests**

Race A: remote HEAD changes while batch resolver waits; Continue must replan before applying conflict result. Race B: local conflict input changes after Continue but before ref publication; stale candidate `updateGitRef` count must remain zero.

- [ ] **Step 2: Verify red**

```bash
node scripts/run-tests.mjs --tier=fast --filter=conflict-revalidation
node scripts/run-tests.mjs --tier=recovery --filter=conflict-publish-guard
```

Expected: FAIL because conflict-local pre-publish guard is absent.

- [ ] **Step 3: Add error and post-Continue remote ref check**

```ts
export class V4ConflictReplanRequiredError extends Error {
  constructor(message: string) { super(message); this.name = "V4ConflictReplanRequiredError"; }
}
```

After accepted batch resolution, re-read configured branch ref and compare planning SHA/null. Mismatch throws.

- [ ] **Step 4: Guard all user-presented LOCAL inputs twice**

Capture local side snapshot for every file returned by user batch. Verify after Continue and immediately before `publishV4CandidateRef`. Absence stays absent; path/presence/hash must match. Stat is only fast path; use existing bounded `hashLocal()`/content-source hashing when required. Guard remote-choice and keep-both files too.

- [ ] **Step 5: Retry in current top-level run**

Runtime treats `V4ConflictReplanRequiredError` as a normal-sync replan reason alongside recovery replan/stale ref, preserving three-attempt cap and `runState.runId`.

- [ ] **Step 6: Verify green and commit**

Run Step 2 commands; expect PASS.

```bash
git add src/lib/v4/sync-session.ts src/lib/v4/runtime.ts tests/v4/conflict-revalidation.test.ts tests/recovery/conflict-publish-guard.test.ts
git commit -m "fix: guard resolved conflicts before publish"
git push origin HEAD:agent/conflict-history-ui
```

### Task 7: Switch production runtime to coordinator + Conflict ItemView in one compiling slice

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
- Produces: registered view, runtime coordinator APIs, full production `resolveConflictBatch` bridge; removes production per-file modal path.

- [ ] **Step 1: Extend stubs and write failing runtime/view tests**

Add textarea value/input/change/scroll/event support and WorkspaceLeaf view-state methods. Tests: desktop auto Split, mobile auto Unified, one resolver leaf, hunk action changes merged textarea, manual textarea edit, binary actions, no-active-batch placeholder, close≠cancel, explicit cancel, stale render/materializer ignored, all object URLs revoked, status click opens resolver, settings change cancels pending batch.

- [ ] **Step 2: Add truthful cancelled/status state**

Extend lifecycle with `cancelled`; allow `finish("cancelled")`; show `GH Sync: Cancelled`. Pending conflict remains lifecycle `active`, phase `resolving-conflicts`, with `Waiting for conflict resolution` label/counts.

- [ ] **Step 3: Own coordinator and compute strong production context key**

Runtime owns one `V4ConflictResolutionCoordinator`. Expose `hasPendingConflicts`, snapshot, subscribe, cancel. Before each session attempt compute `scopeSignature` from the saved sync-scope settings (`ignorePathRegex`, config/bookmark/plugin flags) and `contextKey = buildV4ConflictContextKey({repoId,mode,pathLayout,settingsGeneration:credentialGeneration,scopeSignature})`; pass it as `conflictContextKey` plus `resolveConflictBatch`. On successful run `completeRun(runId)`. `dispose()`/user cancel/settings change cancel coordinator. `credentialsChanged()` cancels pending batch before incrementing generation.

- [ ] **Step 4: Remove production `askConflict` modal bridge**

Stop passing `askConflict` from runtime once batch coordinator is active. Keep the optional session fallback only for isolated tests/backward internal call sites; no user production path should open the old conflict modal.

- [ ] **Step 5: Add `conflictViewMode` setting**

`"auto" | "split" | "unified"`, default `auto`; dropdown labels Auto/Split/Unified. Visible merge description becomes `Merge text; ask when unresolved`, stored enum stays `merge`.

- [ ] **Step 6: Shared preview + Conflict ItemView**

`V4PreviewObjectUrlBag` tracks all URLs and revokes all on rerender/close. ItemView subscribes on open, unsubscribes only on close. Effective mode explicit or `Platform.isDesktopApp ? "split" : "unified"`. Split: LOCAL/actions/REMOTE + merged textarea. Unified: BASE/LOCAL/REMOTE + Local/Remote/Both/Base. `ask` file with zero unresolved content requires explicit `Confirm merged result` or manual edit. Structural/binary uses only valid Use local/Use remote/Keep both; Keep both hidden when a side absent. Materializer `mode:"file"` downgrade reason is shown; resolution remains enabled.

- [ ] **Step 7: Register/reveal one view and route status click**

Register constant/view in `main.ts`; open existing leaf if one exists, else compatible new leaf. Status click: pending conflict→open resolver; idle→manual sync; active non-conflict→do nothing.

- [ ] **Step 8: Responsive/theme CSS**

Root `.github-sync-conflicts`, theme variables only, desktop Split grid, mobile Unified stack, horizontal tabs, sticky navigation, min 44px touch actions, labels/icons in addition to color.

- [ ] **Step 9: Verify green/build**

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
- Modify prior conflict tests only for concrete regression cases.

**Interfaces:** No planned new public API.

- [ ] **Step 1: Lazy/resource tests**

100 summaries: selecting one materializes only it plus at most one explicit adjacent prefetch. 40,001 lines and >2,000,000 DP-cell repeated-line cases downgrade to file-level without unbounded allocation.

- [ ] **Step 2: Keep-both/path collision tests**

Occupy reserved conflict-copy path while resolver waits; Continue must not overwrite. Re-reserve safely or invalidate review. Add case-insensitive collision.

- [ ] **Step 3: Recovery tests**

Confirmed merged bytes use current staging/recovery. Test crash/recovery around publication, local change before publication→zero ref update, and existing recovery behavior after confirmed publication.

- [ ] **Step 4: Stale context/render tests**

Saved settings/repository generation change cancels batch. Old generation materializer/render completion cannot mutate new snapshot/DOM.

- [ ] **Step 5: Full gates**

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

Expected: no copied-reference identifiers in implementation/tests and empty runtime dependencies.

- [ ] **Step 7: Commit and push**

```bash
git add src tests
git commit -m "test: harden conflict workspace edge cases"
git push origin HEAD:agent/conflict-history-ui
```

## Self-Review Coverage

- Structural path/presence + context-safe reuse: Tasks 1, 5, 7, 8.
- Exact-EOL/BOM bounded diff: Task 2.
- Hunk actions/manual authority: Task 3.
- One batch, generation reuse, close/reopen, abort: Task 4.
- Policy compatibility + incremental compatibility fallback: Task 5.
- Remote replan + immediate pre-publish local guard: Task 6.
- Production coordinator lifecycle/status/settings + Desktop/Mobile UI + binary downgrade: Task 7.
- Collision/resource/recovery/full CI: Task 8.

No task may weaken current `copy`, `newer`, CAS, recovery, source-stability, scope, encryption, or change-guard behavior to make the new UI pass.