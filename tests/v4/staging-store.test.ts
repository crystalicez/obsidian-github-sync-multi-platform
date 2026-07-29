import assert from "node:assert/strict";
import test from "node:test";

import { collectV4ContentSource, type V4ContentSource } from "../../src/lib/v4/content-source";
import {
  createV4StagingStore,
  estimateV4StagingSpace,
  V4InsufficientStagingSpaceError,
  V4UnknownStagingSpaceError,
} from "../../src/lib/v4/staging-store";

function source(data: Uint8Array, width = 3): V4ContentSource {
  return {
    size: data.byteLength,
    async *chunks() {
      for (let offset = 0; offset < data.byteLength; offset += width) yield data.slice(offset, offset + width);
    },
  };
}

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
