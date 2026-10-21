import assert from "node:assert/strict"
import test from "node:test"

import { createEmptyV4LocalIndex, fitsV4LocalJsonSizeLimit, loadV4LocalIndex, saveV4LocalIndex } from "../../src/lib/v4/local-index"

function fixture() {
  const map = new Map<string, string>()
  return {
    map,
    async read(path: string) { const value = map.get(path); if (value === undefined) throw Error(path); return value },
    async write(path: string, value: string) { map.set(path, value) },
    async exists(path: string) { return map.has(path) },
    async mkdir() {},
  }
}

test("local cache byte limit exactly matches UTF-8 for ASCII/BMP/astral/unpaired", () => {
  for (const text of ["ASCII", "中", "🙂", "A中🙂", String.fromCharCode(0xd800)]) {
    const size = new TextEncoder().encode(text).byteLength
    assert.equal(fitsV4LocalJsonSizeLimit(text, size), true)
    assert.equal(fitsV4LocalJsonSizeLimit(text, size - 1), false)
  }
})

test("oversized cache header cannot authorize stale remote SHA on a restarted client", async () => {
  const io = fixture()
  const index = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "device", mode: "plaintext" })
  index.remoteCommitSha = "untrusted"
  await saveV4LocalIndex(io, "idx", index)
  const original = JSON.parse(io.map.get("idx/index.json")!)
  io.map.set("idx/index.json", JSON.stringify({ ...original, padding: "z".repeat(66 * 1024) }))
  const loaded = await loadV4LocalIndex(io, "idx")
  assert.equal(loaded.remoteCommitSha, undefined)
  assert.equal(loaded.generation, 0)
})

test("oversized cache header write is rejected before persistence", async () => {
  const io = fixture()
  const index = createEmptyV4LocalIndex({ repoId: "中".repeat(24 * 1024), deviceId: "d", mode: "plaintext" })
  await assert.rejects(() => saveV4LocalIndex(io, "idx", index), /cache limit/)
  assert.equal(io.map.has("idx/index.json"), false)
})

test("stat size hint prevents reading oversized local cache; stale small hints are rechecked", async () => {
  const backing = fixture()
  const index = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "d", mode: "plaintext" })
  await saveV4LocalIndex(backing, "idx", index)
  let reads = 0
  const oversized = { ...backing, async stat() { return { size: 67 * 1024 } }, async read(path: string) { reads++; return backing.read(path) } }
  assert.equal((await loadV4LocalIndex(oversized, "idx")).repoId, "")
  assert.equal(reads, 0)
  const header = JSON.parse(backing.map.get("idx/index.json")!)
  backing.map.set("idx/index.json", JSON.stringify({ ...header, repoId: "中".repeat(23 * 1024) }))
  const undersized = { ...backing, async stat() { return { size: 1024 } } }
  assert.equal((await loadV4LocalIndex(undersized, "idx")).repoId, "")
})
