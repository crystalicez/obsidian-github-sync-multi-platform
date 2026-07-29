import assert from "node:assert/strict"
import test from "node:test"

import {
  assertV4LocalTargetPrecondition,
  V4LocalTargetChangedError,
  type V4LocalIo,
  type V4LocalTargetPrecondition,
} from "../../src/lib/v4/local-io"
import { createV4StagingStore } from "../../src/lib/v4/staging-store"
import { createV4WholeBufferContentSource } from "../../src/lib/v4/content-source"

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
