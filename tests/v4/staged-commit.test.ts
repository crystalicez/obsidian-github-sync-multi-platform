import assert from "node:assert/strict"
import test from "node:test"

import {
  assertV4LocalTargetPrecondition,
  V4LocalTargetChangedError,
  type V4LocalIo,
  type V4LocalTargetPrecondition,
} from "../../src/lib/v4/local-io"
import { sha256Hex } from "../../src/lib/bytes"
import { createV4StagingStore } from "../../src/lib/v4/staging-store"
import { createV4WholeBufferContentSource, DEFAULT_V4_WHOLE_BUFFER_CEILING_BYTES } from "../../src/lib/v4/content-source"

function ioWithStat(current: { size: number; mtime: number } | null): V4LocalIo {
  return {
    async listFiles() { return [] },
    async stat(path) { return current ? { path, ...current } : null },
    async read() { return new Uint8Array() },
    async write() {},
    async trash() {},
  }
}

test("local target precondition rejects a post-network user edit before final mutation", async () => {
  const expected: V4LocalTargetPrecondition = { path: "note.md", exists: true, size: 4, mtime: 10 }
  await assert.rejects(
    assertV4LocalTargetPrecondition(ioWithStat({ size: 5, mtime: 20 }), expected),
    error => error instanceof V4LocalTargetChangedError,
  )
})

test("local target precondition preserves create semantics when a user creates the path during download", async () => {
  const expected: V4LocalTargetPrecondition = { path: "new.bin", exists: false }
  await assert.rejects(
    assertV4LocalTargetPrecondition(ioWithStat({ size: 1, mtime: 2 }), expected),
    error => error instanceof V4LocalTargetChangedError,
  )
})

test("reviewed-source hash rejects same-size same-mtime edits that stat-only guards miss", async () => {
  const original = new TextEncoder().encode("note");
  const newer = new TextEncoder().encode("N0TE");
  const expected: V4LocalTargetPrecondition = {
    path: "note.md", exists: true, size: original.byteLength, mtime: 10,
    hash: await sha256Hex(original),
  };
  const io = { ...ioWithStat({ size: 4, mtime: 10 }), async read() { return newer } };
  await assert.rejects(assertV4LocalTargetPrecondition(io, expected),
    error => error instanceof V4LocalTargetChangedError);
  await assert.doesNotReject(assertV4LocalTargetPrecondition(
    { ...io, async read() { return original } }, expected));
});

test("reviewed-source guard hashes larger-than-buffer-ceiling files as bounded chunks, not whole vault reads", async () => {
  const bytes = new Uint8Array(DEFAULT_V4_WHOLE_BUFFER_CEILING_BYTES + 1).fill(0x61)
  const expected: V4LocalTargetPrecondition = {
    path: "large.md", exists: true, size: bytes.length, mtime: 15,
    hash: await sha256Hex(bytes),
  }
  let wholeReads = 0
  let streamed = 0
  const io = {
    ...ioWithStat({ size: bytes.length, mtime: 15 }),
    async read() { wholeReads++; throw new Error("whole-file reads prohibited") },
    async openContentSource() {
      return { size: bytes.length, async *chunks(chunkBytes: number) {
        for (let start = 0; start < bytes.length; start += chunkBytes) {
          streamed++
          yield bytes.subarray(start, Math.min(bytes.length, start + chunkBytes))
        }
      } }
    },
  }
  await assert.doesNotReject(assertV4LocalTargetPrecondition(io, expected))
  assert.equal(wholeReads, 0)
  assert.ok(streamed > 1)
  bytes[bytes.length - 1] = 0x62
  await assert.rejects(assertV4LocalTargetPrecondition(io, expected),
    error => error instanceof V4LocalTargetChangedError)
  assert.equal(wholeReads, 0)
});

test("staged sink is invisible as a completed stage until finish and removes partial data on abort", async () => {
  const files = new Map<string, Uint8Array>()
  const backend = {
    boundedAppend: true,
    async write(path: string, bytes: Uint8Array) { files.set(path, new Uint8Array(bytes)) },
    async append(path: string, bytes: Uint8Array) {
      const before = files.get(path) ?? new Uint8Array()
      const after = new Uint8Array(before.byteLength + bytes.byteLength)
      after.set(before); after.set(bytes, before.byteLength); files.set(path, after)
    },
    async remove(path: string) { files.delete(path) },
    async openSource() { throw new Error("not used") },
    async freeBytes() { return 1024 },
  }
  const store = createV4StagingStore({ root: "private/stage", backend, wholeBufferCeilingBytes: 4, randomId: () => "sink1" })
  const sink = await store.beginStage({ expectedSize: 6, mtime: 9, existingTargetBytes: 3, atomicReplace: false })
  await sink.append(new Uint8Array([1, 2, 3]))
  assert.deepEqual([...files.keys()], ["private/stage/sink1.bin"])
  await sink.abort()
  assert.equal(files.size, 0)

  const sink2 = await store.beginStage({ expectedSize: 3, mtime: 10, existingTargetBytes: 0, atomicReplace: true })
  await sink2.append(new Uint8Array([4, 5, 6]))
  const ref = await sink2.finish({ plaintextSha256: "a".repeat(64), size: 3 })
  assert.deepEqual(ref, { stageId: "sink1", hash: "a".repeat(64), size: 3, mtime: 10 })
})

test("existing stageSource remains compatible beside beginStage", async () => {
  const files = new Map<string, Uint8Array>()
  const backend = {
    boundedAppend: true,
    async write(path: string, bytes: Uint8Array) { files.set(path, new Uint8Array(bytes)) },
    async append(path: string, bytes: Uint8Array) { files.set(path, new Uint8Array([...(files.get(path) ?? []), ...bytes])) },
    async remove(path: string) { files.delete(path) },
    async openSource(path: string, size: number) { const bytes = files.get(path)!; return { size, async *chunks() { yield bytes } } },
    async freeBytes() { return 1024 },
  }
  const store = createV4StagingStore({ root: "private/stage", backend, wholeBufferCeilingBytes: 4, randomId: () => "legacy" })
  const ref = await store.stageSource(createV4WholeBufferContentSource(new Uint8Array([1, 2, 3])), { mtime: 1, existingTargetBytes: 0, atomicReplace: true })
  assert.equal(ref.size, 3)
  assert.match(ref.hash, /^[0-9a-f]{64}$/u)
})
