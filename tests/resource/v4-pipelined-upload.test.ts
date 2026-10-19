import assert from "node:assert/strict"
import test from "node:test"
import { uploadV4ObjectStream } from "../../src/lib/v4/git-tree-writer"

test("streamed Git blobs upload in bounded pairs and publish tree entries in source order", async () => {
  const written: string[] = []
  const released: string[] = []
  let unblockFirst!: () => void
  const waitForFirst = new Promise<void>(resolve => { unblockFirst = resolve })
  let active = 0
  let peak = 0
  const github = {
    createGitBlob: async (bytes: Uint8Array) => {
      active++
      peak = Math.max(active, peak)
      const id = bytes[0]
      if (id === 0) await waitForFirst
      written.push(String(id))
      active--
      return String(id).padStart(40, "0")
    },
  }
  async function* objects() {
    for (let i = 0; i < 4; i++) {
      yield { path: `${i}.part`, bytes: new Uint8Array([i]), release: () => released.push(String(i)) }
    }
  }
  const task = uploadV4ObjectStream(github as never, { objects: objects() })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(written, ["1"], "second blob must complete before the first is released")
  assert.equal(peak, 2)
  assert.deepEqual(released, ["1"])
  unblockFirst()
  const result = await task
  assert.deepEqual(result.entries.map(e => e.path), ["0.part", "1.part", "2.part", "3.part"])
  assert.deepEqual(released.sort(), ["0", "1", "2", "3"])
  assert.equal(peak, 2)
})

test("mobile upload retains one blob and waits for each before opening the next", async () => {
  let releaseFirst!: () => void
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve })
  const attempted: number[] = []
  let live = 0
  let maxLive = 0
  const uploads = {
    async createGitBlob(bytes: Uint8Array) {
      attempted.push(bytes[0])
      if (bytes[0] === 0) await firstGate
      return String(bytes[0]).padStart(40, "0")
    },
  }
  async function* objects() {
    for (let index = 0; index < 3; index++) {
      live++
      maxLive = Math.max(live, maxLive)
      yield { path: `${index}.part`, bytes: new Uint8Array([index]), release: () => { live-- } }
    }
  }
  const job = uploadV4ObjectStream(uploads as never, { objects: objects(), maxConcurrentUploads: 1 })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(attempted, [0])
  assert.equal(maxLive, 1)
  releaseFirst()
  const result = await job
  assert.deepEqual(result.entries.map(entry => entry.path), ["0.part", "1.part", "2.part"])
  assert.equal(maxLive, 1)
  assert.equal(live, 0)
})

test("failed streamed blob write releases every admitted buffer and never reports completion", async () => {
  const released: number[] = []
  let complete = false
  async function* objects() {
    for(let i = 0; i < 3; i++)yield { path: `${i}.part`, bytes: new Uint8Array([i]), release: () => released.push(i) }
  }
  await assert.rejects(uploadV4ObjectStream({
    async createGitBlob(bytes: Uint8Array) {
      if(bytes[0] === 1) throw new Error("upload interrupted")
      return "sha"
    },
  } as never, { objects: objects(), onLogicalFileUploaded: () => { complete = true }, progressItem: { fileId: "f", path: "asset" } }), /upload interrupted/u)
  assert.deepEqual(released.sort(), [0, 1, 2])
  assert.equal(complete, false)
})
