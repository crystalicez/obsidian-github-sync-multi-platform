import assert from "node:assert/strict"
import test from "node:test"

import { sha256Hex, utf8ToBytes } from "../../src/lib/bytes"
import type { V4LocalIndexAdapter } from "../../src/lib/v4/local-index"
import type { V4LocalIo } from "../../src/lib/v4/local-io"
import {
  createV4RecoveryStore,
  recoverV4PendingState,
  V4RecoveryRequiredError,
} from "../../src/lib/v4/recovery-store"
import type { V4RecoveryPayload } from "../../src/lib/v4/recovery-types"
import { createV4StagingStore } from "../../src/lib/v4/staging-store"

const REMOTE = "a".repeat(40)
const BASE = "b".repeat(40)
const bytes = (value: string): Uint8Array => utf8ToBytes(value)

function memoryAdapter() {
  const slots = new Map<string, string>()
  const adapter: V4LocalIndexAdapter = {
    async read(path) {
      const value = slots.get(path)
      if (value === undefined) throw new Error("Missing slot")
      return value
    },
    async write(path, value) { slots.set(path, value) },
    async exists(path) { return slots.has(path) },
    async mkdir() {},
  }
  return { adapter, slots }
}

const emptyPayload = (): V4RecoveryPayload => ({ mutations: [], completedMutationIds: [] })
function input(phase: "remote-verified" | "local-committing", runId: string) {
  return {
    runId, phase, expectedRemoteHead: BASE,
    verifiedRemoteHead: REMOTE, payload: emptyPayload(),
  } as const
}

test("D54 empty recovery slots return null; corrupt both fail closed instead of assuming no WAL", async () => {
  const { adapter, slots } = memoryAdapter()
  const store = createV4RecoveryStore({ adapter, root: "d54/recovery", repoId: "o/r#main" })
  assert.equal(await store.load(), null)
  await store.save(input("remote-verified", "run-one"))
  for (const path of slots.keys()) slots.set(path, "{truncated")
  await assert.rejects(() => store.load(), error => error instanceof V4RecoveryRequiredError)
  await assert.rejects(() => store.save(input("local-committing", "run-two")), error => error instanceof V4RecoveryRequiredError)
})

test("D54 torn newest slot uses integrity-checked previous generation; never trusts partial JSON", async () => {
  const { adapter, slots } = memoryAdapter()
  const store = createV4RecoveryStore({ adapter, root: "d54/recovery", repoId: "o/r#main" })
  const first = await store.save(input("remote-verified", "run-one"))
  assert.equal(first.header.generation, 1)
  const second = await store.save(input("local-committing", "run-one"))
  assert.equal(second.header.generation, 2)
  const newSlot = "d54/recovery/slot-0.json"
  assert.ok(slots.has(newSlot))
  slots.set(newSlot, JSON.stringify({ ...second.header, integrity: "0".repeat(64) }))
  const retained = await store.load()
  assert.equal(retained?.header.generation, 1)
  assert.equal(retained.header.phase, "remote-verified")
  assert.equal(retained.header.integrity, first.header.integrity)
  const next = await store.save(input("local-committing", "run-one"))
  assert.equal(next.header.generation, 2, "recovered generation must not exceed the latest integrity-verified slot")
  assert.equal((await store.load())?.header.generation, 2)
})

test("D54 encrypted newest WAL with wrong key fails closed rather than selecting an older slot", async () => {
  const { adapter } = memoryAdapter()
  const good = new Uint8Array(32).fill(17)
  const wrong = new Uint8Array(32).fill(19)
  const store = createV4RecoveryStore({ adapter, root: "d54/recovery", repoId: "o/r#main", payloadKey: good })
  await store.save(input("remote-verified", "run-one"))
  await store.save(input("local-committing", "run-one"))
  const unexpectedKey = createV4RecoveryStore({ adapter, root: "d54/recovery", repoId: "o/r#main", payloadKey: wrong })
  await assert.rejects(() => unexpectedKey.load(), error => error instanceof V4RecoveryRequiredError)
  assert.equal((await store.load())?.header.generation, 2)
})

test("D54 missing stage after a preceding WAL trash exposes partial replay and retains a durable receipt", async () => {
  const { adapter } = memoryAdapter()
  const store = createV4RecoveryStore({ adapter, root: "d54/recovery", repoId: "o/r#main" })
  const contents = new Map([
    ["A-delete.md", { bytes: bytes("old-A"), mtime: 7 }],
    ["B-replace.md", { bytes: bytes("old-B"), mtime: 8 }],
  ])
  const initial = new Map([...contents].map(([path, value]) =>
    [path, { bytes: new Uint8Array(value.bytes), mtime: value.mtime }] as const))
  const trashEvents: string[] = []
  const attemptedWrites: string[] = []
  const oldA = await sha256Hex(contents.get("A-delete.md")!.bytes)
  const oldB = await sha256Hex(contents.get("B-replace.md")!.bytes)
  const newB = await sha256Hex(bytes("new-B"))
  const stage = { stageId: "intentionally_missing", hash: newB, size: 5, mtime: 9 }
  const payload: V4RecoveryPayload = {
    mutations: [
      { id: "delete:A", kind: "trash", path: "A-delete.md",
        precondition: { path: "A-delete.md", exists: true, size: 5, mtime: 7, hash: oldA } },
      { id: "write:B", kind: "stage-write", path: "B-replace.md", stage,
        precondition: { path: "B-replace.md", exists: true, size: 5, mtime: 8, hash: oldB } },
    ],
    completedMutationIds: [],
  }
  const saved = await store.save({
    runId: "d54-missing-stage", phase: "remote-verified", expectedRemoteHead: BASE,
    verifiedRemoteHead: REMOTE, payload,
  })
  const staging = createV4StagingStore({
    root: "d54-private-stage",
    wholeBufferCeilingBytes: 1024,
    randomId: () => "unrelated",
    backend: {
      boundedAppend: true,
      async write() { throw Error("Unexpected stage write") },
      async append() { throw Error("Unexpected stage append") },
      async remove() {},
      async openSource() { throw Error("d54-intentionally-missing-stage") },
      async freeBytes() { return 1024 },
    },
  })
  const io: V4LocalIo = {
    async listFiles() { return [...contents].map(([path, v]) => ({ path, size: v.bytes.byteLength, mtime: v.mtime })) },
    async stat(path) {
      const item = contents.get(path)
      return item ? { path, size: item.bytes.byteLength, mtime: item.mtime } : null
    },
    async read(path) {
      const item = contents.get(path)
      if (!item) throw Error("Missing local file")
      return new Uint8Array(item.bytes)
    },
    async write(path, value, mtime = 0) {
      attemptedWrites.push(path)
      contents.set(path, { bytes: new Uint8Array(value), mtime })
    },
    async trash(path) {
      trashEvents.push(path)
      contents.delete(path) // Models destructive MemoryVault, NOT recoverable Obsidian Trash.
    },
    staging,
  }
  await assert.rejects(
    () => recoverV4PendingState({ store, snapshot: saved, io, currentRemoteHead: REMOTE }),
    /d54-intentionally-missing-stage/u,
  )
  const latest = await store.load()
  assert.equal(latest?.header.phase, "local-committing")
  assert.deepEqual(latest.payload?.completedMutationIds, ["delete:A"])
  assert.deepEqual(trashEvents, ["A-delete.md"])
  assert.deepEqual(attemptedWrites, [])
  assert.equal(contents.has("A-delete.md"), false,
    "Characterization: replay can trash an earlier path before discovering a later stage is absent")
  assert.deepEqual(contents.get("B-replace.md"), initial.get("B-replace.md"))
  // A real Obsidian fileManager.trashFile is recoverable; this RED safety
  // exposure in a destructive mock is not evidence of permanent native loss.
})
