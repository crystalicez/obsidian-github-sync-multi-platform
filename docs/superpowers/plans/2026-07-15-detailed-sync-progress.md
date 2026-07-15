# Detailed Sync Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the real sync phase, current logical path, and independent pull/push completed and remaining counts across the status bar and Sync Center, plus a per-phase timing summary in the Sync Center, without rapid UI flicker.

**Architecture:** Add one typed progress model and throttled runtime store. `V4SyncSession` and the atomic Git writer emit observational events from the work they actually perform; `V4PluginRuntime` owns the snapshot and lifecycle, while the status bar and Sync Center subscribe to the same source. Logical paths remain memory-only.

**Tech Stack:** TypeScript 5.9, Obsidian Plugin API, Node test runner, esbuild, GitHub REST Git Data API.

## Global Constraints

- Phase changes publish immediately.
- Path and counter changes publish at most once every 400 milliseconds, deduplicate equal snapshots, and flush before phase or terminal transitions.
- Pull and push counts are independent and count logical files, not blobs, parts, packs, or metadata shards.
- Pull completes only after the corresponding local mutation succeeds.
- Push progress may reach its total during staging/upload, but success appears only after atomic branch publication and local-index persistence succeed.
- Unknown totals render as unknown, never as `0/0`.
- Current logical paths live only in runtime memory and local UI; they are never persisted or sent as plaintext metadata in encrypted mode.
- Phase timing uses a monotonic clock, aggregates repeated phases, refreshes the active interval every 1,000 milliseconds, and flushes exact durations at phase and terminal boundaries.
- A completed timing summary remains in memory until the next run starts; timing data is never persisted.
- Durations render to one decimal second; positive durations below 100 milliseconds render as `<0.1s`; occurrence counts render as attempts only when greater than one.
- Existing sync ordering, conflict policies, modification guard, debounce, retry, encryption, history, and atomic compare-and-swap behavior must not change.
- No new runtime dependency is added.

## File Structure

- Create `src/lib/v4/progress.ts`: progress types, normalization, throttled store, monotonic phase timing, subscriptions, and pure display model.
- Modify `src/lib/v4/status.ts`: format compact status-bar text and detailed tooltip from a progress snapshot.
- Modify `src/lib/v4/git-tree-writer.ts`: report logical-file blob completion and the transition from upload to commit.
- Modify `src/lib/v4/sync-session.ts`: emit phase/path/directional progress at actual work boundaries.
- Modify `src/lib/v4/runtime.ts`: own the store, translate coordinator/session events, and preserve failure/retry context.
- Modify `src/main.ts`: consume runtime progress instead of maintaining a second mutable progress object.
- Modify `src/views/sync-center.ts`: add a live status card and subscribe/unsubscribe without rerendering history.
- Modify `src/styles.scss` and generated `styles.css`: style the live status card and middle-truncated path.
- Modify `tests/stubs/obsidian.ts`: provide only the minimal ItemView/element behavior required by the Sync Center lifecycle test.
- Modify `scripts/run-tests.mjs`: register new progress and Sync Center tests.
- Create `tests/v4/progress.test.ts`: normalization, throttling, deduplication, flushing, monotonic timing aggregation, one-second refresh, subscription isolation, and persistence-safe shape.
- Modify `tests/v4/status.test.ts`: compact text, tooltip, unknown totals, remaining counts, failure context.
- Modify `tests/v4/git-tree-writer.test.ts`: logical completion across single blobs, parts, and shared packs.
- Modify `tests/v4/sync-session.test.ts`: phase ordering and pull/push counters for normal and force operations.
- Modify `tests/v4/settings-secrets.test.ts`: runtime lifecycle, retry, failure context, and persistence exclusion.
- Create `tests/v4/sync-center-progress.test.ts`: live-card-only updates and unsubscribe-on-close.
- Modify `README.md`: document the detailed status behavior.

---

### Task 1: Typed Progress Store and Status Formatting

**Files:**
- Create: `src/lib/v4/progress.ts`
- Modify: `src/lib/v4/status.ts`
- Create: `tests/v4/progress.test.ts`
- Modify: `tests/v4/status.test.ts`
- Modify: `scripts/run-tests.mjs`

**Interfaces:**
- Produces: `V4SyncPhase`, `V4PhaseTiming`, `V4SyncProgressSnapshot`, `V4SyncProgressPatch`, `V4ProgressStore`, `createIdleV4Progress()`, `formatV4Duration(elapsedMs)`, `formatV4PhaseTiming(timing)`, `middleTruncateV4Path(path, maximumLength)`, and `formatV4ActiveSyncStatus(snapshot)`.
- Consumes: `V4SyncOperation` from `src/lib/v4/planner.ts` and `V4SyncTrigger` from `src/lib/v4/sync-coordinator.ts` as type-only imports.

- [ ] **Step 1: Register and write failing progress-store tests**

Add `tests/v4/progress.test.ts` to `tsEntries` in `scripts/run-tests.mjs`, then create tests using a fake scheduler:

```ts
function createProgressFixture() {
  let monotonicNow = 0
  let nextHandle = 1
  const scheduled = new Map<number, { callback: () => void; delay: number }>()
  const store = new V4ProgressStore({
    throttleMs: 400,
    timingRefreshMs: 1_000,
    schedule: (callback, delay) => { const handle = nextHandle++; scheduled.set(handle, { callback, delay }); return handle },
    cancel: handle => { scheduled.delete(handle as number) },
    monotonicNow: () => monotonicNow,
  })
  return {
    store,
    scheduled,
    setNow(value: number) { monotonicNow = value },
    runScheduledCallbackAt(delay: number) {
      const entry = [...scheduled.entries()].find(([, value]) => value.delay === delay)
      assert.ok(entry, `no callback scheduled at ${delay}ms`)
      scheduled.delete(entry[0])
      entry[1].callback()
    },
  }
}

test("phase changes publish immediately while path and counters throttle", () => {
  const { store, scheduled, runScheduledCallbackAt } = createProgressFixture()
  const seen: V4SyncProgressSnapshot[] = []
  store.subscribe(snapshot => seen.push(snapshot))
  store.update({ lifecycle: "active", phase: "checking-remote", operation: "normal", trigger: "manual" })
  store.update({ phase: "scanning-local", currentPath: "A.md" })
  store.update({ currentPath: "B.md", pull: { completed: 1, total: 3 } })
  store.update({ currentPath: "C.md", pull: { completed: 2, total: 3 } })

  assert.equal(seen.at(-1)?.currentPath, "A.md")
  assert.equal([...scheduled.values()].some(item => item.delay === 400), true)
  runScheduledCallbackAt(400)
  assert.equal(seen.at(-1)?.currentPath, "C.md")
  assert.deepEqual(seen.at(-1)?.pull, { completed: 2, total: 3 })
})

test("a phase transition flushes the pending path before publishing the next phase", () => {
  const { store } = createProgressFixture()
  const seen: V4SyncProgressSnapshot[] = []
  store.subscribe(snapshot => seen.push(snapshot))
  store.update({ lifecycle: "active", phase: "hashing", currentPath: "A.md" })
  store.update({ currentPath: "B.md" })
  store.update({ phase: "encrypting", currentPath: "B.md" })
  assert.deepEqual(seen.slice(-2).map(item => [item.phase, item.currentPath]), [
    ["hashing", "B.md"],
    ["encrypting", "B.md"],
  ])
})

test("normalization clamps counts and computes remaining only for known totals", () => {
  const { store } = createProgressFixture()
  store.update({ lifecycle: "active", phase: "uploading", push: { completed: 7, total: 5 } })
  assert.deepEqual(store.snapshot.push, { completed: 5, total: 5 })
  assert.equal(remainingV4Progress(store.snapshot.push), 0)
  assert.equal(remainingV4Progress({ completed: 2 }), undefined)
})

test("phase timing aggregates retries with a monotonic clock", () => {
  const { store, setNow } = createProgressFixture()
  store.beginRun({ lifecycle: "active", phase: "checking-remote", attempt: 1 })
  setNow(600)
  store.update({ phase: "scanning-local" })
  setNow(1_000)
  store.update({ phase: "checking-remote", attempt: 2 })
  setNow(2_800)
  store.finish("success", { lastSyncTime: 123 })

  assert.deepEqual(store.snapshot.timings, [
    { phase: "checking-remote", elapsedMs: 2_400, occurrences: 2 },
    { phase: "scanning-local", elapsedMs: 400, occurrences: 1 },
  ])
  assert.equal(store.snapshot.totalElapsedMs, 2_800)
})

test("active timing refreshes once per second and terminal transition flushes exact time", () => {
  const { store, setNow, runScheduledCallbackAt } = createProgressFixture()
  const seen: V4SyncProgressSnapshot[] = []
  store.subscribe(snapshot => seen.push(snapshot))
  store.beginRun({ lifecycle: "active", phase: "encrypting" })
  setNow(1_000)
  runScheduledCallbackAt(1_000)
  assert.equal(seen.at(-1)?.timings[0].elapsedMs, 1_000)
  setNow(1_250)
  store.finish("success", { lastSyncTime: 999 })
  assert.equal(store.snapshot.timings[0].elapsedMs, 1_250)
})

test("completed timings remain until the next run begins", () => {
  const { store, setNow } = createProgressFixture()
  store.beginRun({ lifecycle: "active", phase: "planning" })
  setNow(300)
  store.finish("success", { lastSyncTime: 1 })
  const completed = structuredClone(store.snapshot.timings)
  store.update({ currentPath: undefined })
  assert.deepEqual(store.snapshot.timings, completed)
  store.beginRun({ lifecycle: "active", phase: "checking-remote" })
  assert.deepEqual(store.snapshot.timings, [{ phase: "checking-remote", elapsedMs: 0, occurrences: 1 }])
})

test("duration formatting shows sub-tenth and repeated attempts", () => {
  assert.equal(formatV4Duration(50), "<0.1s")
  assert.equal(formatV4Duration(1_240), "1.2s")
  assert.equal(formatV4PhaseTiming({ phase: "checking-remote", elapsedMs: 2_400, occurrences: 2 }), "Checking remote 2.4s · 2 attempts")
})
```

Also test equal-patch deduplication, subscriber exceptions not escaping `update`, unsubscribe stopping delivery, `dispose()` cancelling both pending timers, a decreasing fake clock clamping elapsed deltas at zero, and no arbitrary persistence/serialization method existing on the store.

Add a pure path-display test so UI truncation never mutates the actual value:

```ts
test("path display keeps both ends while the snapshot retains the full path", () => {
  const path = "Projects/very/long/folder/with/context/important-note.md"
  assert.equal(middleTruncateV4Path(path, 33), "Projects/very/…/important-note.md")
  assert.equal(path, "Projects/very/long/folder/with/context/important-note.md")
})
```

- [ ] **Step 2: Write failing status-format tests**

Replace the two zero-counter inference tests in `tests/v4/status.test.ts` with explicit snapshots:

```ts
test("status formats phase and separate directional counts", () => {
  const snapshot = createIdleV4Progress()
  Object.assign(snapshot, {
    lifecycle: "active",
    phase: "uploading",
    currentPath: "Notes/project.md",
    pull: { completed: 10, total: 10 },
    push: { completed: 2, total: 7 },
  })
  assert.deepEqual(formatV4ActiveSyncStatus(snapshot), {
    text: "⏳ GH Sync: Uploading · ↓10/10 ↑2/7",
    title: "Uploading\nPath: Notes/project.md\nPull: 10/10 · remaining 0\nPush: 2/7 · remaining 5",
  })
})

test("unknown totals never render as zero totals", () => {
  const snapshot = { ...createIdleV4Progress(), lifecycle: "active" as const, phase: "scanning-local" as const }
  const display = formatV4ActiveSyncStatus(snapshot)
  assert.equal(display.text, "⏳ GH Sync: Scanning local…")
  assert.doesNotMatch(display.title, /0\/0/u)
})

test("failure tooltip keeps phase path counters and error", () => {
  const snapshot: V4SyncProgressSnapshot = {
    ...createIdleV4Progress(),
    lifecycle: "failed",
    phase: "uploading",
    currentPath: "A.md",
    failurePhase: "uploading",
    failurePath: "A.md",
    errorMessage: "network down",
  }
  assert.match(formatV4ActiveSyncStatus(snapshot).title, /Failed during Uploading.*A\.md.*network down/su)
})
```

- [ ] **Step 3: Run RED**

Run: `npm test`

Expected: FAIL because `progress.ts`, `V4ProgressStore`, and the snapshot-based formatter do not exist.

- [ ] **Step 4: Implement the model and store**

Create these exact public types in `src/lib/v4/progress.ts`:

```ts
export type V4SyncLifecycle = "idle" | "waiting" | "active" | "success" | "no-change" | "failed"
export type V4SyncPhase =
  | "debouncing" | "checking-remote" | "loading-index" | "scanning-local" | "planning"
  | "blocked" | "resolving-conflicts" | "downloading" | "applying" | "hashing"
  | "encrypting" | "uploading" | "committing" | "saving-index" | "retrying"
export type V4SyncDirection = "pull" | "push"
export interface V4DirectionalProgress { completed: number; total?: number }
export interface V4PhaseTiming { phase: V4SyncPhase; elapsedMs: number; occurrences: number }
export interface V4SyncProgressSnapshot {
  lifecycle: V4SyncLifecycle
  phase?: V4SyncPhase
  currentPath?: string
  currentDirection?: V4SyncDirection
  pull: V4DirectionalProgress
  push: V4DirectionalProgress
  operation?: V4SyncOperation
  trigger?: V4SyncTrigger
  attempt: number
  timings: V4PhaseTiming[]
  totalElapsedMs: number
  lastSyncTime: number
  errorMessage?: string
  failurePhase?: V4SyncPhase
  failurePath?: string
}
export type V4SyncProgressPatch = Partial<Omit<V4SyncProgressSnapshot, "pull" | "push" | "timings" | "totalElapsedMs">> & {
  pull?: Partial<V4DirectionalProgress>
  push?: Partial<V4DirectionalProgress>
}
```

Implement `V4ProgressStore` with `snapshot`, `subscribe`, `beginRun`, `update`, `finish`, `flush`, and `dispose`. Keep `runStartedAt`, `activePhaseStartedAt`, first-seen phase order, and accumulated closed intervals internally. Use only `monotonicNow` for elapsed durations; clamp each delta with `Math.max(0, now - startedAt)`. `beginRun` replaces the previous timing ledger, `update` closes and opens intervals on phase transitions, and `finish` closes the active interval but retains the completed snapshot. A separate 1,000-millisecond timer publishes the active interval without closing it. Merge directional patches, clamp counts, freeze/copy snapshots before notifying, publish phase/lifecycle transitions immediately, and throttle only same-phase path/counter changes. Notify each subscriber inside its own `try/catch`. Implement `formatV4Duration` and `formatV4PhaseTiming` from one shared phase-label map; implement `middleTruncateV4Path` by preserving a head segment and the filename/tail segment around one `…`.

- [ ] **Step 5: Implement snapshot-based formatting**

Change `formatV4ActiveSyncStatus` to accept `V4SyncProgressSnapshot`. Use a total formatter that omits absent directions and prints `completed/?` only after completed work exists with an unknown total. Build remaining values only when total is known. Terminal copy must be `No changes`, `Success`, and `Failed`, never inferred from counters.

- [ ] **Step 6: Run GREEN and commit**

Run: `npm test`

Expected: all tests pass.

Commit:

```bash
git add scripts/run-tests.mjs src/lib/v4/progress.ts src/lib/v4/status.ts tests/v4/progress.test.ts tests/v4/status.test.ts
git commit -m "feat: add structured V4 progress state"
```

---

### Task 2: Accurate Logical Upload Accounting

**Files:**
- Modify: `src/lib/v4/git-tree-writer.ts`
- Modify: `tests/v4/git-tree-writer.test.ts`

**Interfaces:**
- Consumes: logical push identifiers and paths attached by Task 3.
- Produces: optional `progressItems` on `V4GitTreeFile`, `onLogicalFileUploadStarted`, `onLogicalFileUploaded`, and `onUploadsComplete` callbacks on `V4GitTreeWriteInput`.

- [ ] **Step 1: Write failing single/parts/pack accounting tests**

Add tests which pass these files to `publishV4TreeChanges`:

```ts
const files = [
  { path: "one.enc", bytes: bytes("1"), progressItems: [{ fileId: "one", path: "A.md" }] },
  { path: "p1.enc", bytes: bytes("2"), progressItems: [{ fileId: "large", path: "Large.bin" }] },
  { path: "p2.enc", bytes: bytes("3"), progressItems: [{ fileId: "large", path: "Large.bin" }] },
  { path: "pack.enc", bytes: bytes("4"), progressItems: [
    { fileId: "packed-a", path: "P/A.md" },
    { fileId: "packed-b", path: "P/B.md" },
  ] },
  { path: ".obsidian-github-sync-v4/head.enc", bytes: bytes("metadata") },
]
```

Assert `onLogicalFileUploadStarted` fires once per logical ID when its first blob begins, `onLogicalFileUploaded` fires exactly once for `one`, once only after both blobs for `large`, once each for both packed IDs, never for metadata, and `onUploadsComplete` runs after all logical completion callbacks but before `createGitTree`.

- [ ] **Step 2: Run RED**

Run: `npm test`

Expected: FAIL because the writer input has no logical progress metadata or callbacks.

- [ ] **Step 3: Implement upload completion tracking**

Add:

```ts
export interface V4GitTreeProgressItem { fileId: string; path: string }
export interface V4GitTreeFile {
  path: string
  bytes: Uint8Array
  progressItems?: V4GitTreeProgressItem[]
}
export interface V4GitTreeWriteInput {
  message: string
  files: V4GitTreeFile[]
  deletions?: string[]
  expectedHeadSha?: string | null
  onLogicalFileUploadStarted?: (item: V4GitTreeProgressItem) => void
  onLogicalFileUploaded?: (item: V4GitTreeProgressItem) => void
  onUploadsComplete?: () => void
}
```

Before blob writes, count how many distinct input files contain each `fileId`. At the start of a blob mapper call, invoke `onLogicalFileUploadStarted` once for every logical ID not seen before. After each blob succeeds, decrement those IDs and call `onLogicalFileUploaded` when an ID reaches zero. Catch callback exceptions, then invoke `onUploadsComplete` once before tree creation. Do not change concurrency or CAS checks.

- [ ] **Step 4: Run GREEN and commit**

Run: `npm test`

Expected: all tests pass, including existing atomic-writer tests.

Commit:

```bash
git add src/lib/v4/git-tree-writer.ts tests/v4/git-tree-writer.test.ts
git commit -m "feat: report logical V4 upload progress"
```

---

### Task 3: Session Phase, Path, Pull, and Push Events

**Files:**
- Modify: `src/lib/v4/sync-session.ts`
- Modify: `tests/v4/sync-session.test.ts`

**Interfaces:**
- Consumes: `V4SyncProgressPatch` and Task 2 writer callbacks.
- Produces: optional `onProgress?: (patch: V4SyncProgressPatch) => void` on `V4SyncSessionInput`.

- [ ] **Step 1: Write failing normal pull-push event test**

Extend the existing normal pull-before-push fixture with an event collector:

```ts
const events: V4SyncProgressPatch[] = []
function phases(input: V4SyncProgressPatch[]): string[] {
  return input.flatMap(event => event.phase ? [event.phase] : [])
}
function assertOrderedPhases(input: V4SyncProgressPatch[], expected: string[]): void {
  const actual = phases(input)
  let cursor = -1
  for (const phase of expected) {
    cursor = actual.indexOf(phase, cursor + 1)
    assert.notEqual(cursor, -1, `missing ordered phase ${phase}: ${actual.join(", ")}`)
  }
}
function lastDirectional(input: V4SyncProgressPatch[], direction: "pull" | "push") {
  return [...input].reverse().find(event => event[direction])?.[direction]
}
const session = new V4SyncSession({
  ...fixture,
  onProgress: event => events.push(structuredClone(event)),
})
const result = await session.sync({ operation: "normal", allowThresholdOverride: false })

assert.equal(result.mode, "pull-push")
assertOrderedPhases(events, [
  "checking-remote", "scanning-local", "hashing", "planning",
  "downloading", "applying", "uploading", "committing",
])
assert.deepEqual(lastDirectional(events, "pull"), { completed: 1, total: 1 })
assert.deepEqual(lastDirectional(events, "push"), { completed: 1, total: 1 })
assert.equal(events.some(event => event.currentPath === "remote.md" && event.currentDirection === "pull"), true)
assert.equal(events.some(event => event.currentPath === "local.md" && event.currentDirection === "push"), true)
```

- [ ] **Step 2: Write failing force, no-change, conflict, and failure tests**

Add focused assertions:

```ts
assert.equal(forcePushEvents.some(event => (event.pull?.completed ?? 0) > 0), false)
assert.equal(forcePushEvents.some(event => (event.push?.total ?? 0) > 0), true)
assert.equal(forcePullEvents.some(event => (event.push?.completed ?? 0) > 0), false)
assert.equal(forcePullEvents.some(event => (event.pull?.total ?? 0) > 0), true)
assert.equal(noChangeEvents.at(-1)?.phase, "planning")
assert.equal(conflictEvents.some(event => event.phase === "resolving-conflicts" && event.currentPath === "conflict.md"), true)
assert.equal(failedPullEvents.at(-1)?.currentPath, "broken.md")
```

For a plan with conflicts, assert totals stay absent while direction is unresolved, then become exact after the conflict decision. For `use-remote`, increment pull total before applying that conflict action; for `use-local`, increment push total before staging it.

- [ ] **Step 3: Run RED**

Run: `npm test`

Expected: FAIL because `V4SyncSessionInput` has no reporter and no phases are emitted.

- [ ] **Step 4: Add the isolated reporter and phase boundaries**

Add to the session input and class:

```ts
onProgress?: (patch: V4SyncProgressPatch) => void

private report(patch: V4SyncProgressPatch): void {
  try { this.input.onProgress?.(patch) } catch { /* progress is observational */ }
}
```

Emit `checking-remote` before the first ref read, `scanning-local` before each scan, `planning` before `planV4Sync`, `blocked` before throwing `V4ChangeGuardError`, and `resolving-conflicts` with the conflicted path before asking or applying policy.

- [ ] **Step 5: Instrument local scan and pull completion**

During changed-path and full scans, emit `scanning-local` with the path before stat/read and `hashing` before content hashing. In `applyPull`, emit `downloading` before `readRecord`, `applying` immediately before vault mutation, and increment pull completed only after all mutation calls for that logical change return successfully.

If conflicts exist, publish direction totals as unknown until resolved; retain completed values. After each decision, update the affected total before executing its action. After the final conflict, publish exact pull and push totals.

- [ ] **Step 6: Attach logical progress to staged content and publish callbacks**

Type the session `files` array as `V4GitTreeFile[]`. Map prepared content files as:

```ts
files.push(...prepared.files.map(file => ({
  ...file,
  progressItems: [{ fileId: after.fileId, path: after.path }],
})))
```

For a pack, attach every grouped logical file. Parts naturally repeat one item across their blobs. Before encrypted preparation emit `encrypting`; for plaintext preparation retain `hashing`. Pass writer callbacks which emit `uploading` with the most recently started logical path, increment push completed only from `onLogicalFileUploaded`, then emit `committing` from `onUploadsComplete`.

Track push IDs completed without content uploads (delete, metadata-only rename, unchanged reused object). Immediately before publication, count those as staged exactly once so the push total can reach completion without inventing blob uploads.

- [ ] **Step 7: Run GREEN and commit**

Run: `npm test`

Expected: all session and existing encryption/history/migration tests pass.

Commit:

```bash
git add src/lib/v4/sync-session.ts tests/v4/sync-session.test.ts
git commit -m "feat: emit detailed V4 session progress"
```

---

### Task 4: Runtime Lifecycle, Retry, Failure, and Persistence Safety

**Files:**
- Modify: `src/lib/v4/runtime.ts`
- Modify: `src/main.ts`
- Modify: `tests/v4/settings-secrets.test.ts`

**Interfaces:**
- Consumes: `V4ProgressStore`, `V4SyncProgressSnapshot`, and session `onProgress` from Tasks 1 and 3.
- Produces: `V4PluginRuntime.progressSnapshot` and `V4PluginRuntime.subscribeProgress(listener)`.

- [ ] **Step 1: Write failing runtime lifecycle tests**

Update runtime fixtures to read the runtime instead of `plugin.syncProgress`, then add:

```ts
test("runtime publishes loading saving and terminal phases", async () => {
  const seen: V4SyncProgressSnapshot[] = []
  const dispose = runtime.subscribeProgress(snapshot => seen.push(snapshot))
  await runtime.forcePush()
  dispose()
  const actual = seen.flatMap(snapshot => snapshot.phase ? [snapshot.phase] : [])
  let cursor = -1
  for (const phase of ["checking-remote", "loading-index", "scanning-local", "planning", "uploading", "committing", "saving-index"]) {
    cursor = actual.indexOf(phase, cursor + 1)
    assert.notEqual(cursor, -1, `missing ordered phase ${phase}: ${actual.join(", ")}`)
  }
  assert.equal(seen.at(-1)?.lifecycle, "success")
})

test("runtime keeps the exact failure phase and path", async () => {
  await failingRuntime.forcePush()
  assert.equal(failingRuntime.progressSnapshot.lifecycle, "failed")
  assert.equal(failingRuntime.progressSnapshot.failurePhase, "uploading")
  assert.equal(failingRuntime.progressSnapshot.failurePath, "secret.md")
})

test("CAS retry resets attempt counters", async () => {
  await racingRuntime.manualSync()
  const retry = seen.find(item => item.phase === "retrying")!
  assert.equal(retry.attempt, 2)
  assert.deepEqual(retry.pull, { completed: 0 })
  assert.deepEqual(retry.push, { completed: 0 })
  assert.equal(racingRuntime.progressSnapshot.timings.find(item => item.phase === "checking-remote")?.occurrences, 2)
})

test("runtime retains the latest completed timing summary until a new run starts", async () => {
  await runtime.forcePush()
  const completed = structuredClone(runtime.progressSnapshot.timings)
  assert.equal(completed.length > 0, true)
  await Promise.resolve()
  assert.deepEqual(runtime.progressSnapshot.timings, completed)
  const nextRun = runtime.manualSync()
  assert.notDeepEqual(runtime.progressSnapshot.timings, completed)
  await nextRun
})
```

Also assert `sanitizeV4SettingsForPersistence`, plugin `persistData`, and local-index writes contain none of `phase`, `currentPath`, `failurePath`, `pull`, or `push` from the runtime snapshot.

- [ ] **Step 2: Run RED**

Run: `npm test`

Expected: FAIL because runtime has no store/subscription API and still mutates `plugin.syncProgress`.

- [ ] **Step 3: Make runtime the single progress owner**

Add:

```ts
private readonly progressStore = new V4ProgressStore()
get progressSnapshot(): V4SyncProgressSnapshot { return this.progressStore.snapshot }
subscribeProgress(listener: (snapshot: V4SyncProgressSnapshot) => void): () => void {
  return this.progressStore.subscribe(listener)
}
```

Change `dispose()` to dispose both coordinator and store, including its 400-millisecond throttle and 1,000-millisecond timing timer. `markWaiting()` starts a new run with `{ lifecycle: "waiting", phase: "debouncing" }` only when the coordinator enters a new debounce cycle; repeated events in the same debounce update counts without clearing timings. For manual, startup, scheduled, and force operations without an existing debounce run, call `beginRun` before checking remote. At execute start publish active operation/trigger, zero completed values, unknown totals, and attempt 1 without clearing a ledger already started by debouncing.

Publish `checking-remote` before `remoteOrNewConfig`, `loading-index` before `loadIndex`, forward session patches, `saving-index` before `saveIndex`, then terminal `no-change` or `success`. Preserve the existing manual no-change notice.

- [ ] **Step 4: Preserve retry and failure context**

Before a CAS retry, publish `retrying` immediately with incremented attempt and reset directional completed values, then start checking remote again without starting a new timing ledger. This makes repeated phase occurrences aggregate across attempts. Before the threshold override modal publish `blocked` while retaining totals. On catch, copy the current phase/path into `failurePhase`/`failurePath`, call `finish("failed", ...)`, and retain the closed timing ledger. Successful and no-change paths call `finish` only after local-index persistence is complete.

Remove all writes to `plugin.syncProgress`. Remove the mutable `syncProgress` field from `FastSync`; status rendering will be migrated in Task 5. During this task, keep `updateStatusBar()` compiling by reading `this.v4Runtime?.progressSnapshot ?? createIdleV4Progress()`.

- [ ] **Step 5: Run GREEN and commit**

Run: `npm test`

Expected: all tests pass and runtime progress paths are absent from persisted data.

Commit:

```bash
git add src/lib/v4/runtime.ts src/main.ts tests/v4/settings-secrets.test.ts
git commit -m "feat: own V4 progress in the runtime"
```

---

### Task 5: Status Bar and Live Sync Center Card

**Files:**
- Modify: `src/main.ts`
- Modify: `src/views/sync-center.ts`
- Modify: `src/styles.scss`
- Modify: `styles.css`
- Modify: `tests/stubs/obsidian.ts`
- Create: `tests/v4/main-progress.test.ts`
- Create: `tests/v4/sync-center-progress.test.ts`
- Modify: `scripts/run-tests.mjs`
- Modify: `README.md`

**Interfaces:**
- Consumes: `runtime.progressSnapshot`, `runtime.subscribeProgress`, and `formatV4ActiveSyncStatus`.
- Produces: one live card in every Sync Center mode with isolated rendering and deterministic cleanup.

- [ ] **Step 1: Write the failing status-bar subscription test**

Register `tests/v4/main-progress.test.ts` in `scripts/run-tests.mjs`. Add a test fixture which constructs the plugin/runtime, captures status-bar text/title, exposes `publishProgressForTest` only on the fake runtime object (not production code), and asserts:

```ts
const { plugin, runtime, statusSpan, unsubscribeCalls } = createMainProgressFixture()
await plugin.onload()
runtime.publishProgressForTest(uploadingFixture)
assert.equal(statusSpan.text, "⏳ GH Sync: Uploading · ↓10/10 ↑2/7")
assert.match(statusSpan.title, /Path: Notes\/project\.md/u)
await plugin.onunload()
assert.equal(unsubscribeCalls.value, 1)
```

Implement `createMainProgressFixture` in the test with a fake runtime exposing the production-shaped `progressSnapshot`, `subscribeProgress`, and `isSyncing` API. Its `publishProgressForTest` replaces the fake snapshot and invokes copied listeners; its unsubscribe closure increments `unsubscribeCalls.value` exactly once.

- [ ] **Step 2: Write the failing Sync Center lifecycle test**

Register `tests/v4/sync-center-progress.test.ts` in `scripts/run-tests.mjs`. Extend the Obsidian stub only with `WorkspaceLeaf`, `ItemView`, and element operations used by the view. The test must prove:

```ts
const source = new FakeProgressSource()
let historyLoadCount = 0
const plugin = createSyncCenterPluginFixture(source, () => { historyLoadCount++ })
const view = new V4SyncCenterView(new WorkspaceLeaf(), plugin)
await view.onOpen()
source.publish(uploadingFixture)
assert.match(view.contentEl.flattenText(), /Uploading.*Pull 10\/10.*Push 2\/7.*Notes\/project\.md.*Total 8\.9s.*Checking remote 2\.4s · 2 attempts.*Encryption 1\.2s/su)
assert.equal(historyLoadCount, 1)

const rendersBeforeClose = view.contentEl.mutationCount
await view.onClose()
source.publish(committingFixture)
assert.equal(view.contentEl.mutationCount, rendersBeforeClose)
```

Define `uploadingFixture.timings` in first-seen order with checking remote at 2,400 milliseconds and two occurrences, then encryption at 1,200 milliseconds; set `totalElapsedMs` to 8,900. Implement `FakeProgressSource` with production-shaped `progressSnapshot` and `subscribeProgress`; implement `createSyncCenterPluginFixture` with a history service whose `listCommits` invokes the supplied counter. Extend `ElementStub` with child tracking, `empty`, `remove`, `setAttribute`, `title`, `flattenText()`, and a root-shared `mutationCount`. Also switch between Commit and Current file modes, publish another progress snapshot, and assert selected/page/history state remains unchanged.

Add a fake-scheduler assertion that a store timing tick updates only the status card once per second, does not reload history, and stops mutating the view after `onClose`.

- [ ] **Step 3: Run RED**

Run: `npm test`

Expected: FAIL because the plugin and view do not subscribe and no live card exists.

- [ ] **Step 4: Subscribe the status bar to runtime progress**

After constructing `V4PluginRuntime` in `onload`, register one subscription:

```ts
this.register(this.v4Runtime.subscribeProgress(() => this.updateStatusBar()))
```

Make `updateStatusBar()` format `this.v4Runtime?.progressSnapshot ?? createIdleV4Progress()`. Retain pending/waiting/terminal colors, but use the typed lifecycle and phase rather than `isSyncInProgress` or zero counters. Clicking the status bar still starts manual sync only when the coordinator is idle.

- [ ] **Step 5: Add an isolated live status card**

In `V4SyncCenterView`, add:

```ts
private progressCard?: HTMLElement
private unsubscribeProgress?: () => void

async onOpen(): Promise<void> {
  this.unsubscribeProgress = this.plugin.v4Runtime.subscribeProgress(snapshot => this.renderProgressCard(snapshot))
  await this.renderCommitMode()
}

async onClose(): Promise<void> {
  this.unsubscribeProgress?.()
  this.unsubscribeProgress = undefined
  this.releaseObjectUrl()
}
```

`shell()` creates or replaces only the card container and then calls `renderProgressCard(currentSnapshot)`. `renderProgressCard` empties only that element, renders phase, path, pull and push rows with completed/total/remaining, final time, total elapsed time, and failure details. Render the ordered timing ledger with `formatV4PhaseTiming`; omit phases that never occurred and omit the attempts suffix when occurrences equals one. Set the full path as `title`; render a child with the truncation class. Do not call `renderCommitMode`, `renderFileMode`, history service methods, or preview methods from the progress callback.

- [ ] **Step 6: Add responsive card styles and documentation**

Add SCSS for `.github-sync-center__progress`, directional rows, `.github-sync-center__timings`, timing rows with aligned labels/durations, terminal/error modifiers, and:

```scss
.github-sync-center__progress-path {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
}
```

Render `middleTruncateV4Path(fullPath, 72)` as the visible path while assigning `fullPath` to the element title. Mirror the same declarations in `styles.css`, because the existing production build does not compile Sass. Update README status documentation with phase/path display, separate pull/push counts, 400 ms UI batching, one-second active timing refresh, aggregated phase attempts, latest-run memory retention, and memory-only paths/timings.

- [ ] **Step 7: Run GREEN, production build, and commit**

Run:

```bash
npm test
npm run build
git diff --check
```

Expected: all tests pass, production TypeScript/esbuild/Sass output succeeds, and diff check is clean.

Commit:

```bash
git add README.md scripts/run-tests.mjs src/main.ts src/views/sync-center.ts src/styles.scss styles.css tests/stubs/obsidian.ts tests/v4/main-progress.test.ts tests/v4/sync-center-progress.test.ts
git commit -m "feat: show detailed sync progress in Obsidian"
```

---

### Task 6: Whole-Feature Verification and Review Gate

**Files:**
- Review all files changed by Tasks 1–5.
- Update no production file unless a failing verification or review finding requires a TDD fix.

**Interfaces:**
- Consumes: the complete detailed-progress feature.
- Produces: verified local and live GitHub behavior with no Critical/Important review findings.

- [ ] **Step 1: Run the full local gates from a clean process**

Run:

```bash
npm test
npm run build
git diff --check
$env:GITHUB_E2E_COMPILE_ONLY='1'; try { npm run test:github-e2e } finally { Remove-Item Env:GITHUB_E2E_COMPILE_ONLY -ErrorAction SilentlyContinue }
```

Expected: every command exits zero; the test count includes all newly registered suites.

- [ ] **Step 2: Run live GitHub REST quick E2E**

Run: `npm run test:github-e2e:quick`

Expected: plaintext and encrypted V4 round trip passes and `e2e-destructive` cleanup is verified. The E2E does not need to assert UI text, but runtime instrumentation must not alter remote bytes, commit atomicity, or cleanup.

- [ ] **Step 3: Inspect privacy and persistence mechanically**

Run:

```bash
rg -n "currentPath|failurePath|timings|totalElapsedMs|V4SyncProgressSnapshot" src
rg -n "currentPath|failurePath|timings|totalElapsedMs|syncProgress" src/setting.tsx src/lib/v4/secrets.ts src/lib/v4/local-index.ts
```

Expected: progress paths and timing ledgers occur only in progress/session/runtime/UI code; no settings, secret, or local-index serializer accepts them.

- [ ] **Step 4: Request whole-feature review**

Review the complete feature range against `docs/superpowers/specs/2026-07-15-detailed-sync-progress-design.md`. Reject completion for any inaccurate phase, counter that can reach completion before its documented boundary, non-monotonic or double-counted timing, lost repeated-phase attempts, timer leak, path/timing persistence, subscriber leak, status-card history reload, or Critical/Important runtime finding.

- [ ] **Step 5: Fix findings with a fresh RED/GREEN cycle, then rerun all gates**

For each accepted finding, add the smallest failing regression first, confirm RED, implement the minimal fix, confirm GREEN, and rerun Steps 1–3. Commit each coherent fix separately with `fix: ...`.
