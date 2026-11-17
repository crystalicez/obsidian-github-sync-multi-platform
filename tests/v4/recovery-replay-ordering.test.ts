import assert from "node:assert/strict"
import test from "node:test"

import { sha256Hex, utf8ToBytes } from "../../src/lib/bytes"
import { createV4WholeBufferContentSource } from "../../src/lib/v4/content-source"
import type { V4LocalIndexAdapter } from "../../src/lib/v4/local-index"
import type { V4LocalIo } from "../../src/lib/v4/local-io"
import { applyV4RecoveryLocalMutations, createV4RecoveryStore, discardV4RecoveryStages, recoverV4PendingState, V4RecoveryRequiredError } from "../../src/lib/v4/recovery-store"
import type { V4RecoveryPayload } from "../../src/lib/v4/recovery-types"
import { createV4StagingStore } from "../../src/lib/v4/staging-store"

const BASE = "b".repeat(40)
const REMOTE = "a".repeat(40)
const OTHER_REMOTE = "c".repeat(40)
const asBytes = (content: string) => utf8ToBytes(content)

function recoveryAdapter() {
  const slots = new Map<string, string>()
  const adapter: V4LocalIndexAdapter = {
    async read(path) {
      const value = slots.get(path)
      if (value === undefined) throw Error("Missing WAL slot")
      return value
    },
    async write(path, text) { slots.set(path, text) },
    async exists(path) { return slots.has(path) },
    async mkdir() {},
  }
  return { adapter, slots }
}

async function sharedStageDiscardFixture(completedMutationIds: string[] = []) {
  const { adapter } = recoveryAdapter()
  const store = createV4RecoveryStore({ adapter, root: "d408/wal", repoId: "o/r#main" })
  const stage = {
    stageId: "shared-stage", hash: "a".repeat(64), size: 2, mtime: 10,
  }
  const mutations: V4RecoveryPayload["mutations"] = ["first.md", "second.md"].map((path, i) => ({
    kind: "stage-write" as const, id: `write-${i}`, path, stage,
    precondition: { path, exists: false },
  }))
  const snapshot = await store.save({
    runId: "d408-stage-reuse", phase: "replan-required", expectedRemoteHead: null,
    payload: { mutations, completedMutationIds },
  })
  // The WAL accepts two distinct write mutations with one shared stage id.
  assert.equal(snapshot.payload?.mutations.length, 2)
  const operations: string[] = []
  let stageExists = true
  const staging = createV4StagingStore({
    root: "d408/private-stage", wholeBufferCeilingBytes: 16,
    backend: {
      boundedAppend: true,
      async write() { throw new Error("not staging any new data") },
      async append() { throw new Error("not appending new data") },
      async remove(path) {
        assert.equal(path, "d408/private-stage/shared-stage.bin")
        assert.equal(stageExists, true, "stage must not be removed twice")
        operations.push("remove:shared-stage")
        stageExists = false
      },
      async openSource() { throw new Error("not reading staged data") },
      async freeBytes() { return 1024 },
    },
  })
  const denied = async () => { throw new Error("unexpected local mutation") }
  const io: V4LocalIo = {
    listFiles: denied, read: denied, write: denied, trash: denied,
    staging,
    async rollbackStage({ path }) {
      assert.equal(stageExists, true, "stage must still exist during every rollback")
      operations.push(`rollback:${path}`)
    },
    async finalizeStage({ path }) {
      assert.equal(stageExists, true, "stage must still exist during every finalization")
      operations.push(`finalize:${path}`)
    },
  }
  return { store, snapshot, io, operations, stageExists: () => stageExists }
}

test("D408 shared recovery stage must finish each target rollback/finalize before deleting the stage", async () => {
  const fixture = await sharedStageDiscardFixture(["write-0"])
  await discardV4RecoveryStages(fixture.snapshot, fixture.io)
  assert.deepEqual(fixture.operations, [
    "finalize:first.md", "rollback:second.md", "remove:shared-stage",
  ])
  assert.equal(fixture.stageExists(), false)
})

test("D408 recovery discard retains shared stage when a later target rollback fails", async () => {
  const fixture = await sharedStageDiscardFixture()
  const laterFailure = new Error("second target's original is not safely restored")
  let attempts = 0
  fixture.io.rollbackStage = async ({ path }) => {
    attempts++
    if (attempts === 2) throw laterFailure
    assert.equal(fixture.stageExists(), true)
    fixture.operations.push(`rollback:${path}`)
  }
  await assert.rejects(
    discardV4RecoveryStages(fixture.snapshot, fixture.io),
    error => error === laterFailure,
    "a failed subsequent rollback must not be bypassed or converted to cleanup success",
  )
  assert.equal(fixture.stageExists(), true,
    "shared stage must remain available for manual recovery if any rollback fails")
  assert.deepEqual(fixture.operations, ["rollback:first.md"])
})

test("D409 Native recovery refuses shared stage IDs before any target commit or receipt", async () => {
  const fixture = await sharedStageDiscardFixture()
  const { snapshot, io, operations } = fixture
  let localOps = 0
  io.preferStagedCommit = true
  io.commitStage = async () => { localOps++; throw new Error("native commit must never run with ambiguous shared staging") }
  io.stat = async () => { localOps++; throw new Error("local stat must not precede shared-stage ownership rejection") }
  const { store } = fixture
  // Use the persisted fixture WAL; the guard must run before any receipt.
  await assert.rejects(
    applyV4RecoveryLocalMutations({ store, snapshot, io }),
    error => error instanceof V4RecoveryRequiredError && /shared.*stage|stage.*multiple.*target/i.test(error.message),
    "the same stage cannot be consumed as the native replacement for two targets",
  )
  assert.equal(localOps, 0)
  assert.deepEqual(operations, [])
  assert.equal(fixture.stageExists(), true)
})

test("D409 Native recovery discard rejects shared stage IDs before touching any sidecar or target", async () => {
  const fixture = await sharedStageDiscardFixture(["write-0"])
  fixture.io.preferStagedCommit = true
  await assert.rejects(
    discardV4RecoveryStages(fixture.snapshot, fixture.io),
    error => error instanceof V4RecoveryRequiredError && /shared.*stage|stage.*multiple.*target/i.test(error.message),
    "stage-derived .target-backup and .replacement-residue cannot identify two different original targets",
  )
  assert.deepEqual(fixture.operations, [], "must reject before first finalize or rollback")
  assert.equal(fixture.stageExists(), true, "do not delete either target's recovery evidence")
})

for (const ordering of ["stage-before-trash", "trash-before-stage"] as const) {
  test(`D55 replay of corrupted same-size stage (${ordering}) records only mutations actually applied`, async () => {
    const { adapter } = recoveryAdapter()
    const store = createV4RecoveryStore({ adapter, root: "d55/recovery", repoId: "o/r#main" })
    const original = new Map([
      ["A-delete.md", { bytes: asBytes("old-A"), mtime: 7 }],
      ["B-replace.md", { bytes: asBytes("old-B"), mtime: 8 }],
    ])
    const contents = new Map([...original].map(([path, item]) => [path, { bytes: new Uint8Array(item.bytes), mtime: item.mtime }]))
    const expectedStage = {
      stageId: "d55_corrupt_stage",
      hash: await sha256Hex(asBytes("new-B")),
      size: 5,
      mtime: 9,
    }
    const trashMutation = {
      kind: "trash" as const,
      id: "d55-trash-A",
      path: "A-delete.md",
      precondition: {
        path: "A-delete.md", exists: true,
        size: 5, mtime: 7, hash: await sha256Hex(asBytes("old-A")),
      },
    }
    const stageMutation = {
      kind: "stage-write" as const,
      id: "d55-write-B",
      path: "B-replace.md",
      stage: expectedStage,
      precondition: {
        path: "B-replace.md", exists: true,
        size: 5, mtime: 8, hash: await sha256Hex(asBytes("old-B")),
      },
    }
    const payload: V4RecoveryPayload = {
      mutations: ordering === "stage-before-trash"
        ? [stageMutation, trashMutation] : [trashMutation, stageMutation],
      completedMutationIds: [],
    }
    const saved = await store.save({
      runId: `d55-${ordering}`, phase: "remote-verified",
      expectedRemoteHead: BASE, verifiedRemoteHead: REMOTE, payload,
    })
    let openCount = 0
    const staging = createV4StagingStore({
      root: "d55-private-stage",
      wholeBufferCeilingBytes: 1024,
      randomId: () => "unused",
      backend: {
        boundedAppend: true,
        async write() { throw Error("stage write must not occur during replay") },
        async append() { throw Error("stage append must not occur during replay") },
        async remove() { throw Error("must not remove failed stage") },
        async freeBytes() { return 1024 },
        async openSource(_path, size) {
          openCount++
          assert.equal(size, 5)
          // Valid length, different SHA-256 than the WAL's authenticated ref.
          return createV4WholeBufferContentSource(asBytes("bad-B"))
        },
      },
    })
    const trashEvents: string[] = []
    const writeEvents: string[] = []
    const io: V4LocalIo = {
      async listFiles() { return [...contents].map(([path, item]) => ({ path, size: item.bytes.byteLength, mtime: item.mtime })) },
      async stat(path) {
        const item = contents.get(path)
        return item ? { path, size: item.bytes.byteLength, mtime: item.mtime } : null
      },
      async read(path) {
        const item = contents.get(path)
        if (!item) throw Error("Missing test file")
        return new Uint8Array(item.bytes)
      },
      async write(path, data, mtime = 0) {
        writeEvents.push(path)
        contents.set(path, { bytes: new Uint8Array(data), mtime })
      },
      async trash(path) {
        trashEvents.push(path)
        contents.delete(path) // Deliberately destructive mock; unlike Obsidian Trash.
      },
      staging,
    }

    await assert.rejects(
      () => recoverV4PendingState({ store, snapshot: saved, io, currentRemoteHead: REMOTE }),
      error => error instanceof V4RecoveryRequiredError && /stage hash mismatch/u.test(error.message),
    )
    assert.equal(openCount, 1, "same-length, mismatched-hash stage must have been read and rejected")
    assert.deepEqual(writeEvents, [], "the corrupted stage must never be committed to a local file")
    assert.deepEqual(contents.get("B-replace.md"), original.get("B-replace.md"))
    const last = await store.load()
    assert.ok(last)
    if (ordering === "stage-before-trash") {
      assert.deepEqual(trashEvents, [])
      assert.deepEqual(contents, original, "stage-first rejected corruption before any local change")
      assert.equal(last.header.phase, "remote-verified")
      assert.deepEqual(last.payload?.completedMutationIds, [])
    } else {
      assert.deepEqual(trashEvents, ["A-delete.md"])
      assert.equal(contents.has("A-delete.md"), false, "characterization: earlier Trash was already applied")
      assert.equal(last.header.phase, "local-committing")
      assert.deepEqual(last.payload?.completedMutationIds, ["d55-trash-A"])
    }
    // A passing characterization asserts the observed partial replay risk,
    // NOT that native Trash or the full WAL replay is transaction-atomic.
  })
}

test("D55 older valid WAL recovered from torn newest slot cannot replay when remote head changed", async () => {
  const { adapter, slots } = recoveryAdapter()
  const store = createV4RecoveryStore({ adapter, root: "d55/slots", repoId: "o/r#main" })
  const older = await store.save({
    runId: "d55-torn-head", phase: "remote-verified",
    expectedRemoteHead: BASE, verifiedRemoteHead: REMOTE,
    payload: { mutations: [{
      kind: "trash", id: "d55-old-trash", path: "Keep.md",
      precondition: { path: "Keep.md", exists: true, size: 4, mtime: 1, hash: await sha256Hex(asBytes("keep")) },
    }], completedMutationIds: [] },
  })
  await store.save({
    runId: "d55-torn-head", phase: "local-committing",
    expectedRemoteHead: BASE, verifiedRemoteHead: OTHER_REMOTE,
    payload: older.payload!,
  })
  const newestSlot = "d55/slots/slot-0.json"
  assert.ok(slots.has(newestSlot))
  slots.set(newestSlot, "{truncated-while-writing")
  const recovered = await store.load()
  assert.equal(recovered?.header.generation, 1)
  assert.equal(recovered.header.verifiedRemoteHead, REMOTE)
  let ioOperations = 0
  const denied = async () => { ioOperations++; throw Error("I/O forbidden before remote-head validation") }
  const io: V4LocalIo = {
    listFiles: denied,
    stat: denied,
    read: denied,
    write: denied,
    trash: denied,
  }
  const result = await recoverV4PendingState({
    store, snapshot: recovered, io, currentRemoteHead: OTHER_REMOTE,
  })
  assert.equal(result.replanRequired, true)
  assert.equal(result.snapshot.header.phase, "replan-required")
  assert.equal(ioOperations, 0, "must not replay stale WAL against a different immutable remote head")
  assert.deepEqual(result.snapshot.payload?.completedMutationIds, [])
  assert.equal((await store.load())?.header.phase, "replan-required")
})
