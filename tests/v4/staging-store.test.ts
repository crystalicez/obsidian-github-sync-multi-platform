import assert from "node:assert/strict";
import test from "node:test";

import { collectV4ContentSource, type V4ContentSource } from "../../src/lib/v4/content-source";
import {
  createV4StagingStore,
  estimateV4StagingSpace,
  V4InsufficientStagingSpaceError,
  V4UnknownStagingSpaceError,
  V4StagingCleanupError,
} from "../../src/lib/v4/staging-store";

function source(data: Uint8Array, width = 3): V4ContentSource {
  return {
    size: data.byteLength,
    async *chunks() {
      for (let offset = 0; offset < data.byteLength; offset += width) yield data.slice(offset, offset + width);
    },
  };
}


function gate() {
  let open!: () => void;
  const promise = new Promise<void>(resolve => { open = resolve; });
  return { promise, open };
}

test("D405 queued staging appends retain the supplied bytes after caller buffer reuse", async () => {
  const files = new Map<string, Uint8Array>();
  const firstEntered = gate(), continueFirst = gate();
  const store = createV4StagingStore({
    root: "private/stage", wholeBufferCeilingBytes: 8, randomId: () => "buffer-reuse",
    backend: {
      boundedAppend: true,
      async write(path, bytes) {
        firstEntered.open();
        await continueFirst.promise;
        files.set(path, new Uint8Array(bytes));
      },
      async append(path, bytes) {
        const previous = files.get(path) ?? new Uint8Array();
        const next = new Uint8Array(previous.length + bytes.length);
        next.set(previous); next.set(bytes, previous.length); files.set(path, next);
      },
      async remove(path) { files.delete(path); },
      async openSource() { throw new Error("not needed"); },
      async freeBytes() { return 1024; },
    },
  });
  const sink = await store.beginStage({
    expectedSize: 4, existingTargetBytes: 0, atomicReplace: true, mtime: 7,
  });
  const firstBuffer = new Uint8Array([1, 2]);
  const pendingFirst = sink.append(firstBuffer);
  await firstEntered.promise;
  const secondBuffer = new Uint8Array([3, 4]);
  const pendingSecond = sink.append(secondBuffer);
  // Streaming callers may release/recycle a byte buffer while another
  // queued operation is waiting for the OS backend. Stage must own its input.
  firstBuffer.fill(9);
  secondBuffer.fill(8);
  continueFirst.open();
  await Promise.all([pendingFirst, pendingSecond]);
  const claimedHash = "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a";
  const stage = await sink.finish({ plaintextSha256: claimedHash, size: 4 });
  assert.equal(stage.size, 4);
  assert.deepEqual(files.get("private/stage/buffer-reuse.bin"), new Uint8Array([1, 2, 3, 4]),
    "queued writes must preserve both chunks as originally submitted");
});

test("staging serializes two overlapping appends and finish never certifies pending bytes", async () => {
  const files = new Map<string, Uint8Array>();
  const firstWriteEntered = gate();
  const allowFirstWrite = gate();
  const actions: string[] = [];
  const store = createV4StagingStore({
    root: "private/stage",
    wholeBufferCeilingBytes: 16,
    randomId: () => "overlap",
    backend: {
      boundedAppend: true,
      async write(path, data) {
        actions.push("write-start"); firstWriteEntered.open();
        await allowFirstWrite.promise;
        files.set(path, new Uint8Array(data)); actions.push("write-end");
      },
      async append(path, data) {
        actions.push("append");
        const previous = files.get(path) ?? new Uint8Array();
        const next = new Uint8Array(previous.length + data.length);
        next.set(previous); next.set(data, previous.length); files.set(path, next);
      },
      async remove(path) { files.delete(path); },
      async openSource() { throw new Error("not used"); },
      async freeBytes() { return 1024; },
    },
  });
  const sink = await store.beginStage({ expectedSize: 3, existingTargetBytes: 0, atomicReplace: true, mtime: 1 });
  const first = sink.append(new Uint8Array([1, 2]));
  await firstWriteEntered.promise;
  const second = sink.append(new Uint8Array([3]));
  let finished = false;
  const finish = sink.finish({ plaintextSha256: "a".repeat(64), size: 3 }).then(v => { finished = true; return v; });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(finished, false);
  allowFirstWrite.open();
  await Promise.all([first, second]);
  const result = await finish;
  assert.equal(result.size, 3);
  assert.deepEqual(files.get("private/stage/overlap.bin"), new Uint8Array([1, 2, 3]));
  assert.deepEqual(actions, ["write-start", "write-end", "append"]);
});

test("abort during an in-flight initial stage write cannot leave a resurrected partial file", async () => {
  const files = new Map<string, Uint8Array>();
  const entered = gate(), proceed = gate();
  const stagePath = "private/stage/abort-race.bin";
  const store = createV4StagingStore({
    root: "private/stage", wholeBufferCeilingBytes: 16, randomId: () => "abort-race",
    backend: {
      boundedAppend: true,
      async write(path, data) { entered.open(); await proceed.promise; files.set(path, new Uint8Array(data)); },
      async append() { throw new Error("not used"); },
      async remove(path) { files.delete(path); },
      async openSource() { throw new Error("not used"); },
      async freeBytes() { return 1024; },
    },
  });
  const sink = await store.beginStage({ expectedSize: 2, existingTargetBytes: 0, atomicReplace: true, mtime: 1 });
  const writing = sink.append(new Uint8Array([1, 2]));
  await entered.promise;
  const aborted = sink.abort();
  proceed.open();
  await Promise.all([writing, aborted]);
  assert.equal(files.has(stagePath), false);
  await assert.rejects(sink.append(new Uint8Array([3])), /closed|abort/i);
  await assert.rejects(sink.finish({ plaintextSha256: "b".repeat(64), size: 2 }), /closed|abort/i);
});


test("D407 stageSource preserves both source failure and failed abort cleanup", async () => {
  const partial = new Map<string, Uint8Array>();
  const sourceFailure = new Error("injected streaming source lost its next chunk");
  const cleanupFailure = new Error("injected access denied deleting partial stage");
  let removals = 0;
  const store = createV4StagingStore({
    root: "private/stage", wholeBufferCeilingBytes: 16, randomId: () => "stream-fail",
    backend: {
      boundedAppend: true,
      async write(path, bytes) { partial.set(path, new Uint8Array(bytes)); },
      async append() { throw new Error("unexpected append"); },
      async remove() { removals++; throw cleanupFailure; },
      async openSource() { throw new Error("unexpected read"); },
      async freeBytes() { return 1024; },
    },
  });
  const interruptedSource: V4ContentSource = {
    size: 4,
    async *chunks() {
      yield new Uint8Array([7, 8]);
      throw sourceFailure;
    },
  };
  await assert.rejects(
    store.stageSource(interruptedSource, { mtime: 1, existingTargetBytes: 0, atomicReplace: true }),
    error => error instanceof V4StagingCleanupError
      && error.stageFailure === sourceFailure
      && error.cleanupFailure === cleanupFailure
      && error.partialPath === "private/stage/stream-fail.bin",
    "the streaming error must remain visible even if abort cannot remove the partial stage",
  );
  assert.equal(removals, 1);
  assert.deepEqual(partial.get("private/stage/stream-fail.bin"), new Uint8Array([7, 8]));
});

test("D407 stageSource reports its original write failure after abort successfully recovers a failed first cleanup", async () => {
  const partial = new Map<string, Uint8Array>();
  const writeFailure = new Error("injected partial stage write failure");
  const transientRemoveFailure = new Error("injected transient cleanup failure");
  let removals = 0;
  const store = createV4StagingStore({
    root: "private/stage", wholeBufferCeilingBytes: 16, randomId: () => "retry-clean",
    backend: {
      boundedAppend: true,
      async write(path, bytes) {
        partial.set(path, new Uint8Array(bytes));
        throw writeFailure;
      },
      async append() { throw new Error("unexpected append"); },
      async remove(path) {
        if (++removals === 1) throw transientRemoveFailure;
        partial.delete(path);
      },
      async openSource() { throw new Error("unexpected read"); },
      async freeBytes() { return 1024; },
    },
  });
  await assert.rejects(
    store.stageSource(source(new Uint8Array([5, 6])), {
      mtime: 1, existingTargetBytes: 0, atomicReplace: true,
    }),
    error => error === writeFailure,
    "once cleanup succeeds, the original write error must be returned, not a stale cleanup warning",
  );
  assert.equal(removals, 2);
  assert.equal(partial.size, 0);
});

test("D406 abort reports failed partial cleanup and retries instead of falsely claiming deletion", async () => {
  const files = new Map<string, Uint8Array>();
  const stagePath = "private/stage/remove-failure.bin";
  const cleanupFailure = new Error("simulated access denied during stage removal");
  let removes = 0;
  const store = createV4StagingStore({
    root: "private/stage", wholeBufferCeilingBytes: 16, randomId: () => "remove-failure",
    backend: {
      boundedAppend: true,
      async write(path, data) { files.set(path, new Uint8Array(data)); },
      async append() { throw new Error("unexpected append"); },
      async remove(path) {
        if (++removes === 1) throw cleanupFailure;
        files.delete(path);
      },
      async openSource() { throw new Error("unused"); },
      async freeBytes() { return 1024; },
    },
  });
  const sink = await store.beginStage({
    expectedSize: 2, existingTargetBytes: 0, atomicReplace: true, mtime: 1,
  });
  await sink.append(new Uint8Array([5, 6]));
  const firstAbort = sink.abort();
  const concurrentAbort = sink.abort();
  for (const pendingAbort of [firstAbort, concurrentAbort]) {
    await assert.rejects(pendingAbort, error =>
      error instanceof V4StagingCleanupError
      && error.cleanupFailure === cleanupFailure
      && error.partialPath === stagePath,
      "both concurrent abort callers must observe the same typed cleanup failure");
  }
  assert.deepEqual(files.get(stagePath), new Uint8Array([5, 6]),
    "unknown partial data remains after the failed cleanup");
  await sink.abort();
  assert.equal(removes, 2, "a subsequent abort must retry removing the remaining file");
  assert.equal(files.has(stagePath), false);
});

test("D406 abort with an explicit absent stage is idempotent, not a recovery failure", async () => {
  const missing = Object.assign(new Error("stage never created"), { code: "ENOENT" });
  let attempts = 0;
  const store = createV4StagingStore({
    root: "private/stage", wholeBufferCeilingBytes: 16, randomId: () => "never-created",
    backend: {
      boundedAppend: true,
      async write() { throw new Error("unexpected write"); },
      async append() { throw new Error("unexpected append"); },
      async remove() { attempts++; throw missing; },
      async openSource() { throw new Error("unused"); },
      async freeBytes() { return 1024; },
    },
  });
  const sink = await store.beginStage({
    expectedSize: 2, existingTargetBytes: 0, atomicReplace: true, mtime: 1,
  });
  await sink.abort();
  await sink.abort();
  assert.equal(attempts, 1, "a reported ENOENT proves no stage remains to retry");
});

test("D406 failed staged write does not hide a second failure to remove its partial bytes", async () => {
  const files = new Map<string, Uint8Array>();
  const stagePath = "private/stage/failed-write-cleanup.bin";
  const failedWrite = new Error("simulated write failed after partial persistence");
  const cleanupFailure = new Error("simulated stage cleanup disk error");
  let removes = 0;
  const store = createV4StagingStore({
    root: "private/stage", wholeBufferCeilingBytes: 16,
    randomId: () => "failed-write-cleanup",
    backend: {
      boundedAppend: true,
      async write(path, data) {
        files.set(path, new Uint8Array(data));
        throw failedWrite;
      },
      async append() { throw new Error("append must never happen"); },
      async remove(path) {
        if (++removes === 1) throw cleanupFailure;
        files.delete(path);
      },
      async openSource() { throw new Error("unused"); },
      async freeBytes() { return 1024; },
    },
  });
  const sink = await store.beginStage({
    expectedSize: 2, existingTargetBytes: 0, atomicReplace: true, mtime: 1,
  });
  await assert.rejects(
    sink.append(new Uint8Array([7, 8])),
    error => error instanceof V4StagingCleanupError
      && error.stageFailure === failedWrite
      && error.cleanupFailure === cleanupFailure
      && error.partialPath === stagePath,
    "both the original partial write error and failed cleanup must remain observable",
  );
  assert.equal(files.has(stagePath), true);
  await sink.abort();
  assert.equal(files.has(stagePath), false, "caller must be able to retry partial cleanup");
  await assert.rejects(sink.finish({ plaintextSha256: "a".repeat(64), size: 2 }), /closed/i);
});

test("staging preserves first backend write failure and skips queued writes or finish", async () => {
  const entered = gate(), proceed = gate();
  const files = new Map<string, Uint8Array>();
  const failedWrite = new Error("injected disk full");
  let attempted = 0;
  const store = createV4StagingStore({
    root: "private/stage", wholeBufferCeilingBytes: 16, randomId: () => "failed-write",
    backend: {
      boundedAppend: true,
      async write(path, data) { attempted++; files.set(path, data); entered.open(); await proceed.promise; throw failedWrite; },
      async append() { attempted++; throw new Error("must not append after failure"); },
      async remove(path) { files.delete(path); },
      async openSource() { throw new Error("not used"); },
      async freeBytes() { return 1024; },
    },
  });
  const sink = await store.beginStage({ expectedSize: 2, existingTargetBytes: 0, atomicReplace: true, mtime: 1 });
  const first = sink.append(new Uint8Array([1]));
  await entered.promise;
  const second = sink.append(new Uint8Array([2]));
  const finishing = sink.finish({ plaintextSha256: "a".repeat(64), size: 2 });
  proceed.open();
  for (const promise of [first, second, finishing]) await assert.rejects(promise, e => e === failedWrite);
  assert.equal(attempted, 1);
  assert.equal(files.size, 0);
});

test("staging abort preempts queued finish and waits for the in-flight write to settle", async () => {
  const entered = gate(), proceed = gate();
  const files = new Map<string, Uint8Array>();
  const store = createV4StagingStore({
    root: "private/stage", wholeBufferCeilingBytes: 16, randomId: () => "preempt",
    backend: {
      boundedAppend: true,
      async write(path, data) { entered.open(); await proceed.promise; files.set(path, new Uint8Array(data)); },
      async append() { throw new Error("not used"); },
      async remove(path) { files.delete(path); },
      async openSource() { throw new Error("not used"); },
      async freeBytes() { return 1024; },
    },
  });
  const sink = await store.beginStage({ expectedSize: 1, existingTargetBytes: 0, atomicReplace: true, mtime: 1 });
  const writing = sink.append(new Uint8Array([1]));
  await entered.promise;
  const finishing = sink.finish({ plaintextSha256: "a".repeat(64), size: 1 });
  const cancelled = sink.abort();
  const cancelledAgain = sink.abort();
  proceed.open();
  await writing;
  await assert.rejects(finishing, /already closed/i);
  await Promise.all([cancelled, cancelledAgain]);
  assert.equal(files.size, 0);
});

test("staging rejects overrun and invalid finish proof without leaving provisional bytes", async () => {
  const files = new Map<string, Uint8Array>();
  let removals = 0;
  const store = createV4StagingStore({
    root: "private/stage", wholeBufferCeilingBytes: 16, randomId: () => "overrun",
    backend: {
      boundedAppend: true,
      async write(path, data) { files.set(path, new Uint8Array(data)); },
      async append() { throw new Error("not used"); },
      async remove(path) { removals++; files.delete(path); },
      async openSource() { throw new Error("not used"); },
      async freeBytes() { return 1024; },
    },
  });
  const sink = await store.beginStage({ expectedSize: 1, existingTargetBytes: 0, atomicReplace: true, mtime: 1 });
  await sink.append(new Uint8Array([1]));
  await assert.rejects(sink.append(new Uint8Array([2])), /more bytes than declared/);
  assert.equal(files.size, 0);
  assert.ok(removals >= 1);
  await assert.rejects(sink.finish({ plaintextSha256: "a".repeat(64), size: 1 }), /closed/i);

  const sink2 = await store.beginStage({ expectedSize: 1, existingTargetBytes: 0, atomicReplace: true, mtime: 1 });
  await sink2.append(new Uint8Array([3]));
  await assert.rejects(sink2.finish({ plaintextSha256: "not-a-hash", size: 1 }), /SHA-256/);
  assert.equal(files.size, 0);
});

test("abort racing the zero-byte finish write leaves no stage and no receipt", async () => {
  const entered = gate(), proceed = gate();
  const files = new Map<string, Uint8Array>();
  const store = createV4StagingStore({
    root: "private/stage", wholeBufferCeilingBytes: 16, randomId: () => "empty",
    backend: {
      boundedAppend: true,
      async write(path, data) { entered.open(); await proceed.promise; files.set(path, data); },
      async append() { throw new Error("not used"); },
      async remove(path) { files.delete(path); },
      async openSource() { throw new Error("not used"); },
      async freeBytes() { return 1024; },
    },
  });
  const sink = await store.beginStage({ expectedSize: 0, existingTargetBytes: 0, atomicReplace: true, mtime: 1 });
  const finishing = sink.finish({ plaintextSha256: "a".repeat(64), size: 0 });
  await entered.promise;
  const aborting = sink.abort();
  proceed.open();
  await assert.rejects(finishing, /closed/);
  await aborting;
  assert.equal(files.size, 0);
});

test("staging uses opaque ids under the plugin-private excluded root and hashes while appending", async () => {
  const files = new Map<string, Uint8Array>();
  const backend = {
    boundedAppend: true,
    async write(path: string, data: Uint8Array) { files.set(path, new Uint8Array(data)); },
    async append(path: string, data: Uint8Array) {
      const current = files.get(path) ?? new Uint8Array();
      const merged = new Uint8Array(current.byteLength + data.byteLength);
      merged.set(current); merged.set(data, current.byteLength); files.set(path, merged);
    },
    async remove(path: string) { files.delete(path); },
    async openSource(path: string, size: number) {
      const data = files.get(path)!;
      return { size, async *chunks(chunkBytes: number) { for (let offset = 0; offset < data.byteLength; offset += chunkBytes) yield data.slice(offset, offset + chunkBytes); } };
    },
    async freeBytes() { return 1024 * 1024; },
  };
  const store = createV4StagingStore({ root: ".obsidian/plugins/example/github-sync-v4-stage", backend, wholeBufferCeilingBytes: 8, randomId: () => "opaque123" });
  const data = new TextEncoder().encode("hello staged world");
  const ref = await store.stageSource(source(data, 4), { mtime: 42, existingTargetBytes: 7, atomicReplace: false });
  assert.equal(ref.stageId, "opaque123");
  assert.equal(ref.size, data.byteLength);
  assert.equal(ref.mtime, 42);
  assert.match(ref.hash, /^[0-9a-f]{64}$/u);
  assert.deepEqual([...files.keys()], [".obsidian/plugins/example/github-sync-v4-stage/opaque123.bin"]);
  assert.deepEqual(await collectV4ContentSource(await store.open(ref), 64), data);
});

test("staging rejects arithmetic overflow and malformed lengths before touching the backend", async () => {
  const max = Number.MAX_SAFE_INTEGER;
  assert.throws(
    () => estimateV4StagingSpace({ stageBytes: 2, existingTargetBytes: max - 1, atomicReplace: false }),
    /safe integer|range|overflow/i,
  );
  assert.throws(
    () => estimateV4StagingSpace({ stageBytes: 1, existingTargetBytes: max, atomicReplace: true }),
    /safe integer|range|overflow/i,
  );
  assert.deepEqual(estimateV4StagingSpace({ stageBytes: 0, existingTargetBytes: max, atomicReplace: true }), {
    existingTargetBytes: max,
    stageBytes: 0,
    backupBytes: 0,
    peakFootprintBytes: max,
    additionalFreeBytesRequired: 0,
  });

  let calls = 0;
  const store = createV4StagingStore({
    root: "private/stage",
    wholeBufferCeilingBytes: 16,
    randomId: () => "bad",
    backend: {
      boundedAppend: true,
      async write() { calls++; },
      async append() { calls++; },
      async remove() { calls++; },
      async freeBytes() { calls++; return max; },
      async openSource() { calls++; throw new Error("not used"); },
    },
  });
  for (const [expectedSize, existingTargetBytes] of [
    [-1, 0], [0.5, 0], [Number.NaN, 0], [1, -1], [1, 0.5],
    [1, max],
  ]) {
    await assert.rejects(
      store.beginStage({ expectedSize, existingTargetBytes, atomicReplace: true, mtime: 1 }),
      /safe integer|range|overflow/i,
    );
  }
  assert.equal(calls, 0, "invalid staging inputs must not trigger backend I/O");
});

test("large staging requires known free space and accounts for non-atomic backup overhead", async () => {
  assert.deepEqual(estimateV4StagingSpace({ stageBytes: 100, existingTargetBytes: 40, atomicReplace: false }), {
    existingTargetBytes: 40,
    stageBytes: 100,
    backupBytes: 40,
    peakFootprintBytes: 180,
    additionalFreeBytesRequired: 140,
  });
  const backend = {
    boundedAppend: true,
    async write() {}, async append() {}, async remove() {},
    async openSource() { throw new Error("not used"); },
    async freeBytes() { return undefined; },
  };
  const store = createV4StagingStore({ root: "private/stage", backend, wholeBufferCeilingBytes: 8, randomId: () => "x" });
  await assert.rejects(store.stageSource(source(new Uint8Array(9)), { mtime: 0, existingTargetBytes: 4, atomicReplace: false }), error => error instanceof V4UnknownStagingSpaceError);
});

test("large staging fails before writing when free space is insufficient", async () => {
  let writes = 0;
  const backend = {
    boundedAppend: true,
    async write() { writes++; }, async append() { writes++; }, async remove() {},
    async openSource() { throw new Error("not used"); },
    async freeBytes() { return 10; },
  };
  const store = createV4StagingStore({ root: "private/stage", backend, wholeBufferCeilingBytes: 8, randomId: () => "x" });
  await assert.rejects(store.stageSource(source(new Uint8Array(9)), { mtime: 0, existingTargetBytes: 4, atomicReplace: false }), error => error instanceof V4InsufficientStagingSpaceError);
  assert.equal(writes, 0);
});

test("small staging may use a bounded whole-buffer compatibility fallback when append is unavailable", async () => {
  const files = new Map<string, Uint8Array>();
  const backend = {
    boundedAppend: false,
    async write(path: string, data: Uint8Array) { files.set(path, new Uint8Array(data)); },
    async append() { throw new Error("append must not run"); },
    async remove(path: string) { files.delete(path); },
    async openSource(path: string, size: number) {
      const data = files.get(path)!;
      return { size, async *chunks() { yield data; } };
    },
    async freeBytes() { return undefined; },
  };
  const store = createV4StagingStore({ root: "private/stage", backend, wholeBufferCeilingBytes: 8, randomId: () => "small" });
  const ref = await store.stageSource(source(new Uint8Array([1, 2, 3]), 1), { mtime: 1, existingTargetBytes: 0, atomicReplace: true });
  assert.deepEqual(files.get("private/stage/small.bin"), new Uint8Array([1, 2, 3]));
  assert.equal(ref.size, 3);
});

test("large staging never falls back to whole-buffer writes when append is unavailable", async () => {
  const backend = {
    boundedAppend: false,
    async write() { throw new Error("whole write must not run"); },
    async append() { throw new Error("append must not run"); },
    async remove() {}, async openSource() { throw new Error("not used"); },
    async freeBytes() { return 1000; },
  };
  const store = createV4StagingStore({ root: "private/stage", backend, wholeBufferCeilingBytes: 8, randomId: () => "large" });
  await assert.rejects(store.stageSource(source(new Uint8Array(9)), { mtime: 0, existingTargetBytes: 0, atomicReplace: true }), /bounded append/i);
});
