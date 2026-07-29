import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import { createV4RecoveryStore, V4RecoveryRequiredError } from "../../src/lib/v4/recovery-store"
import type { V4LocalIndexAdapter } from "../../src/lib/v4/local-index"

class MemoryAdapter implements V4LocalIndexAdapter {
  readonly values = new Map<string, string>()
  async read(path: string) { const value = this.values.get(path); if (value === undefined) throw new Error(`missing:${path}`); return value }
  async write(path: string, value: string) { this.values.set(path, value) }
  async exists(path: string) { return this.values.has(path) }
  async mkdir() {}
}

const payload = (path = "Private/secret.md") => ({
  mutations: [{
    id: "m1",
    kind: "trash" as const,
    path,
    precondition: { path, exists: true, size: 7, mtime: 11 },
  }],
  completedMutationIds: [],
})

function input(runId: string, phase: "publish-intent" | "remote-verified" = "publish-intent") {
  return {
    runId,
    journalId: phase === "publish-intent" ? "journal-1" : undefined,
    phase,
    expectedRemoteHead: "head-old" as string | null,
    candidateCommitSha: phase === "publish-intent" ? "candidate-1" : undefined,
    verifiedRemoteHead: phase === "remote-verified" ? "head-new" : undefined,
    payload: payload(),
  }
}

test("recovery store falls back to the previous valid generation when the newest slot is torn", async () => {
  const adapter = new MemoryAdapter()
  const store = createV4RecoveryStore({ adapter, root: "recovery", repoId: "owner/repo#main" })
  const first = await store.save(input("run-1"))
  const second = await store.save({ ...input("run-1"), phase: "remote-verified", verifiedRemoteHead: "candidate-1" })
  assert.equal(first.header.generation, 1)
  assert.equal(second.header.generation, 2)

  const newestPath = `recovery/slot-${second.header.generation % 2}.json`
  adapter.values.set(newestPath, adapter.values.get(newestPath)!.slice(0, 19))
  const recovered = await store.load()
  assert.equal(recovered?.header.generation, 1)
  assert.equal(recovered?.header.phase, "publish-intent")
})

test("recovery store chooses the highest valid generation even when slot contents are swapped", async () => {
  const adapter = new MemoryAdapter()
  const store = createV4RecoveryStore({ adapter, root: "recovery", repoId: "owner/repo#main" })
  await store.save(input("run-2"))
  const second = await store.save({ ...input("run-2"), phase: "remote-verified", verifiedRemoteHead: "candidate-1" })
  const zero = adapter.values.get("recovery/slot-0.json")!
  const one = adapter.values.get("recovery/slot-1.json")!
  adapter.values.set("recovery/slot-0.json", one)
  adapter.values.set("recovery/slot-1.json", zero)
  const recovered = await store.load()
  assert.equal(recovered?.header.generation, second.header.generation)
  assert.equal(recovered?.header.phase, "remote-verified")
})

test("recovery store raises a typed recovery-required error when all present generations are invalid", async () => {
  const adapter = new MemoryAdapter()
  adapter.values.set("recovery/slot-0.json", "{broken")
  adapter.values.set("recovery/slot-1.json", "also-broken")
  const store = createV4RecoveryStore({ adapter, root: "recovery", repoId: "owner/repo#main" })
  await assert.rejects(() => store.load(), V4RecoveryRequiredError)
})

test("encrypted recovery keeps logical paths out of clear local state and decrypts the payload", async () => {
  const adapter = new MemoryAdapter()
  const key = new Uint8Array(32).fill(0x5a)
  const store = createV4RecoveryStore({ adapter, root: "recovery", repoId: "owner/repo#main", payloadKey: key })
  const saved = await store.save(input("opaque-run"))
  const serialized = adapter.values.get(`recovery/slot-${saved.header.generation % 2}.json`)!
  assert.equal(serialized.includes("Private/secret.md"), false)
  assert.equal(serialized.includes("owner/repo#main"), false)
  const recovered = await store.load()
  assert.equal(recovered?.payload?.mutations[0]?.path, "Private/secret.md")
})


test("recovery phase surface has no generic prepared state", async () => {
  const source = await readFile("src/lib/v4/recovery-types.ts", "utf8")
  assert.doesNotMatch(source, /["']prepared["']/u)
  for (const phase of ["publish-intent", "remote-verified", "local-committing", "replan-required", "index-committed"]) {
    assert.match(source, new RegExp(`["']${phase}["']`, "u"))
  }
})

test("recovery store creates nested local directories without relying on recursive mkdir", async () => {
  class ParentStrictAdapter extends MemoryAdapter {
    readonly directories = new Set<string>()
    override async mkdir(path: string) {
      const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ""
      if (parent && !this.directories.has(parent)) throw new Error(`missing parent:${parent}`)
      this.directories.add(path)
    }
  }
  const adapter = new ParentStrictAdapter()
  const store = createV4RecoveryStore({ adapter, root: "recovery/repo-hash", repoId: "owner/repo#main" })
  await store.save(input("nested-run"))
  assert.equal(adapter.directories.has("recovery"), true)
  assert.equal(adapter.directories.has("recovery/repo-hash"), true)
})

test("v4 recovery cancellation waits for the current local mutation receipt before exiting", async () => {
  const { applyV4RecoveryLocalMutations, createV4RecoveryStore } = await import("../../src/lib/v4/recovery-store")
  const controller = new AbortController()
  const adapter = new MemoryAdapter()
  const store = createV4RecoveryStore({ adapter, root: "recovery", repoId: "repo" })
  let snapshot = await store.save({
    runId: "run-cancel",
    phase: "remote-verified",
    expectedRemoteHead: "old",
    candidateCommitSha: "candidate",
    verifiedRemoteHead: "candidate",
    payload: {
      mutations: [{ id: "trash:one", kind: "trash", path: "one.md", precondition: { path: "one.md", exists: true, size: 1, mtime: 1 } }],
      completedMutationIds: [],
    },
  })
  const events: string[] = []
  await assert.rejects(
    applyV4RecoveryLocalMutations({
      store,
      snapshot,
      signal: controller.signal,
      io: {
        async read() { return new Uint8Array([1]) },
        async write() {},
        async trash() { events.push("trash"); controller.abort("dispose") },
        async stat() { return { path: "one.md", size: 1, mtime: 1 } },
      },
    }),
    /dispose|cancel/iu,
  )
  snapshot = (await store.load())!
  assert.deepEqual(events, ["trash"])
  assert.deepEqual(snapshot.payload?.completedMutationIds, ["trash:one"])
  assert.equal(snapshot.header.phase, "local-committing")
})

test("v4 recovery cancellation during a large staged final commit waits for the durable receipt", async () => {
  const { applyV4RecoveryLocalMutations, createV4RecoveryStore } = await import("../../src/lib/v4/recovery-store")
  const { DEFAULT_V4_WHOLE_BUFFER_CEILING_BYTES } = await import("../../src/lib/v4/content-source")
  const controller = new AbortController()
  const adapter = new MemoryAdapter()
  const store = createV4RecoveryStore({ adapter, root: "recovery", repoId: "repo" })
  const stage = {
    stageId: "stage-large",
    hash: "f".repeat(64),
    size: DEFAULT_V4_WHOLE_BUFFER_CEILING_BYTES + 1,
    mtime: 22,
  }
  let current = { path: "large.bin", size: 1, mtime: 1 }
  let snapshot = await store.save({
    runId: "run-stage-cancel",
    phase: "remote-verified",
    expectedRemoteHead: "old",
    candidateCommitSha: "candidate",
    verifiedRemoteHead: "candidate",
    payload: {
      mutations: [{
        id: "stage:large",
        kind: "stage-write",
        path: "large.bin",
        stage,
        precondition: { path: "large.bin", exists: true, size: 1, mtime: 1 },
      }],
      completedMutationIds: [],
    },
  })
  const events: string[] = []
  await assert.rejects(
    applyV4RecoveryLocalMutations({
      store,
      snapshot,
      signal: controller.signal,
      io: {
        async read() { return new Uint8Array([1]) },
        async write() {},
        async trash() {},
        async stat() { return current },
        async commitStage() {
          events.push("commit-stage")
          current = { path: "large.bin", size: stage.size, mtime: stage.mtime }
          controller.abort("dispose-during-swap")
        },
      },
    }),
    /dispose-during-swap|cancel/iu,
  )
  snapshot = (await store.load())!
  assert.deepEqual(events, ["commit-stage"])
  assert.deepEqual(snapshot.payload?.completedMutationIds, ["stage:large"])
  assert.equal(snapshot.header.phase, "local-committing")
})
