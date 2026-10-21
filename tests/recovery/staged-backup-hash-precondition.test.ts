import assert from "node:assert/strict"
import test from "node:test"
import { sha256Hex } from "../../src/lib/bytes"
import { assertV4LocalTargetPrecondition, V4LocalTargetChangedError } from "../../src/lib/v4/local-io"
import { createV4RecoveryStore, V4RecoveryRequiredError } from "../../src/lib/v4/recovery-store"

const original = new Uint8Array([1, 2, 3])
const edited = new Uint8Array([3, 2, 1])

test("D2 same-size same-mtime user edit fails the original-content hash guard", async () => {
  let reads = 0
  const expectedHash = await sha256Hex(original)
  await assert.rejects(() => assertV4LocalTargetPrecondition({
    async stat() { return { path: "note.md", size: 3, mtime: 10 } },
    async read() { reads++; return edited },
  }, { path: "note.md", exists: true, size: 3, mtime: 10, hash: expectedHash }), V4LocalTargetChangedError)
  assert.equal(reads, 1)
})

test("D2 valid original hash is accepted without changing preexisting recovery semantics", async () => {
  await assert.doesNotReject(() => assertV4LocalTargetPrecondition({
    async stat() { return { path: "note.md", size: 3, mtime: 10 } },
    async read() { return original },
  }, { path: "note.md", exists: true, size: 3, mtime: 10, hash: "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81" }))
})

test("D2 recovery writer refuses malformed optional original SHA before touching storage", async () => {
  const values = new Map<string, string>()
  const store = createV4RecoveryStore({
    root: "recovery", repoId: "test/branch",
    adapter: {
      async exists(p) { return values.has(p) },
      async read(p) { return values.get(p)! },
      async write(p, v) { values.set(p, v) },
      async mkdir() {},
    },
  })
  await assert.rejects(() => store.save({
    runId: "unsafe", phase: "remote-verified", expectedRemoteHead: "old", verifiedRemoteHead: "new",
    payload: { mutations: [{ id: "write", kind: "trash", path: "note.md",
      precondition: { path: "note.md", exists: true, size: 3, mtime: 10, hash: "bad" },
    }], completedMutationIds: [] },
  }), V4RecoveryRequiredError)
  assert.equal(values.size, 0)
})
