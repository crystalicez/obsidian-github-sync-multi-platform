import assert from "node:assert/strict"
import test from "node:test"
import { sha256Hex } from "../../src/lib/bytes"
import { V4StorageCodec } from "../../src/lib/v4/storage-codec"

test("chunked download overlaps bounded remote reads while staging verified parts in order", async () => {
  const body = new Uint8Array([11, 22, 33, 44])
  const paths = ["0.enc", "1.enc", "2.enc", "3.enc"]
  let releaseFirst!: () => void
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve })
  const requested: string[] = []
  const appended: number[] = []
  let outstanding = 0
  let maxOutstanding = 0
  const codec = new V4StorageCodec({ mode: "plaintext", pathLayout: "plaintext-v1" })
  const job = codec.readToSink({
    record: {
      path: "asset.bin", pathId: "p", fileId: "f",
      plaintextSha256: await sha256Hex(body), size: body.byteLength, mtime: 1,
      remoteVersion: "v", remotePath: paths[0], storage: "chunked", partPaths: paths,
    },
    reader: async path => {
      requested.push(path)
      outstanding++
      maxOutstanding = Math.max(maxOutstanding, outstanding)
      if (path === paths[0]) await firstGate
      if (outstanding > 2) throw new Error("unbounded remote read")
      outstanding--
      return body.subarray(paths.indexOf(path), paths.indexOf(path) + 1)
    },
    sink: { async append(chunk) { appended.push(chunk[0]) } },
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(requested, paths.slice(0, 2), "second GitHub part starts before first one finishes")
  assert.deepEqual(appended, [], "staging cannot get ahead of ordered verified parts")
  releaseFirst()
  const result = await job
  assert.deepEqual(appended, [11, 22, 33, 44])
  assert.equal(maxOutstanding, 2)
  assert.deepEqual(result, { plaintextSha256: await sha256Hex(body), size: 4 })
})

test("mobile-sized transfer budget keeps remote part reads sequential", async () => {
  const body = new Uint8Array([11, 22])
  const paths = ["a.enc", "b.enc"]
  let releaseFirst!: () => void
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve })
  const requested: string[] = []
  const appended: number[] = []
  const codec = new V4StorageCodec({
    mode: "plaintext", pathLayout: "plaintext-v1", maxConcurrentPartReads: 1,
  })
  const task = codec.readToSink({
    record: {
      path: "asset.bin", pathId: "p", fileId: "f", plaintextSha256: await sha256Hex(body),
      size: 2, mtime: 1, remoteVersion: "v", remotePath: paths[0], storage: "chunked", partPaths: paths,
    },
    reader: async path => {
      requested.push(path)
      if (path === paths[0]) await firstGate
      return body.subarray(paths.indexOf(path), paths.indexOf(path) + 1)
    },
    sink: { async append(bytes) { appended.push(bytes[0]) } },
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(requested, ["a.enc"])
  releaseFirst()
  assert.deepEqual(await task, { plaintextSha256: await sha256Hex(body), size: 2 })
  assert.deepEqual(requested, ["a.enc", "b.enc"])
  assert.deepEqual(appended, [11, 22])
})

test("failed prefetched GitHub part never reaches the staged sink", async () => {
  const body = new Uint8Array([11, 22, 33])
  const paths = ["0.enc", "1.enc", "2.enc"]
  const codec = new V4StorageCodec({ mode: "plaintext", pathLayout: "plaintext-v1" })
  const appended: number[] = []
  await assert.rejects(codec.readToSink({
    record: {
      path: "failed.bin", pathId: "p", fileId: "f",
      plaintextSha256: await sha256Hex(body), size: body.byteLength, mtime: 1,
      remoteVersion: "v", remotePath: paths[0], storage: "chunked", partPaths: paths,
    },
    reader: async path => {
      if (path === paths[1]) throw new Error("GitHub part request failed")
      return body.subarray(paths.indexOf(path), paths.indexOf(path) + 1)
    },
    sink: { async append(chunk) { appended.push(chunk[0]) } },
  }), /GitHub part request failed/u)
  assert.deepEqual(appended, [11], "never append a failed or later part")
})
