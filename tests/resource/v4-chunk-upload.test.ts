import assert from "node:assert/strict"
import test from "node:test"

import type { V4ContentSource } from "../../src/lib/v4/content-source"
import { uploadV4ObjectStream } from "../../src/lib/v4/git-tree-writer"
import { V4_PART_BYTES } from "../../src/lib/v4/large-files"
import { V4StorageCodec } from "../../src/lib/v4/storage-codec"

const GiB = 1024 * 1024 * 1024

test("virtual 5 GiB stream planning does not read or allocate the logical file", async () => {
  let opened = 0
  const source: V4ContentSource = {
    size: 5 * GiB,
    async *chunks() { opened++; throw new Error("virtual source must stay lazy during preparation") },
  }
  const codec = new V4StorageCodec({ mode: "plaintext", pathLayout: "plaintext-v1" })
  const prepared = await codec.prepareFromSource({
    logicalPath: "virtual-5g.bin",
    source,
    expectedHash: "0".repeat(64),
    version: "virtual",
    mtime: 1,
    fileId: "virtual-file",
    partBytes: V4_PART_BYTES,
  })
  assert.equal(opened, 0)
  assert.equal(prepared.objectCount, 107)
  assert.equal(prepared.objectPaths.length, 107)
})

test("stream uploader releases each object before requesting the next one", async () => {
  let live = 0
  let maxLive = 0
  async function* objects() {
    for (let index = 0; index < 5; index++) {
      live++
      maxLive = Math.max(maxLive, live)
      yield {
        path: `${index}.part`,
        bytes: new Uint8Array(1024),
        release: () => { live-- },
      }
      assert.equal(live, 0)
    }
  }
  const github = {
    async getGitRefOrNull() { return null },
    async getGitCommit() { throw new Error("not used") },
    async createGitBlob() { return "sha" },
    async createGitTree() { throw new Error("not used") },
    async createGitCommit() { throw new Error("not used") },
    async createGitRef() {},
    async updateGitRef() {},
  }
  const uploaded = await uploadV4ObjectStream(github, { objects: objects() })
  assert.equal(uploaded.entries.length, 5)
  assert.equal(maxLive, 1)
  assert.equal(live, 0)
})
