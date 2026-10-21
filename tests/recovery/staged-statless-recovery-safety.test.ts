import assert from "node:assert/strict"
import test from "node:test"

import { applyV4RecoveryLocalMutations, createV4RecoveryStore } from "../../src/lib/v4/recovery-store"
import { assertV4LocalTargetPrecondition, V4LocalTargetChangedError } from "../../src/lib/v4/local-io"

function adapter() {
  const values = new Map<string, string>()
  return {
    async exists(path: string) { return values.has(path) },
    async read(path: string) { const value = values.get(path); if (value === undefined) throw new Error("missing"); return value },
    async write(path: string, value: string) { values.set(path, value) },
    async mkdir() {},
  }
}

test("missing stat never counts as proof of unchanged target in a destructive local precondition", async () => {
  await assert.rejects(
    () => assertV4LocalTargetPrecondition({} as never, { path: "note.md", exists: true, size: 3, mtime: 10 }),
    V4LocalTargetChangedError,
  )
  await assert.rejects(
    () => assertV4LocalTargetPrecondition({} as never, { path: "note.md", exists: false }),
    V4LocalTargetChangedError,
  )
})

test("interrupted WAL cannot trash a user's file when stat evidence is unavailable", async () => {
  const store = createV4RecoveryStore({ adapter: adapter(), root: "recovery", repoId: "owner/repo#branch" })
  const snapshot = await store.save({
    runId: "replay-without-stat", phase: "remote-verified",
    expectedRemoteHead: "old", verifiedRemoteHead: "new",
    payload: {
      mutations: [{ id: "delete:note", kind: "trash", path: "note.md", precondition: { path: "note.md", exists: true, size: 3, mtime: 10 } }],
      completedMutationIds: [],
    },
  })
  let trashed = false
  const result = await applyV4RecoveryLocalMutations({
    store, snapshot,
    io: {
      async listFiles() { return [{ path: "note.md", size: 3, mtime: 10 }] },
      async read() { return new Uint8Array([1, 2, 3]) },
      async write() { throw new Error("unexpected write") },
      async trash() { trashed = true },
    },
  })
  assert.equal(result.replanRequired, true)
  assert.equal(trashed, false)
  assert.equal((await store.load())?.header.phase, "replan-required")
})
