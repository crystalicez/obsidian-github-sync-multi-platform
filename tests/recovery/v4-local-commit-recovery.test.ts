import assert from "node:assert/strict"
import test from "node:test"

import { sha256Hex } from "../../src/lib/bytes"
import { createV4WholeBufferContentSource, type V4ContentHandle } from "../../src/lib/v4/content-source"
import { applyV4RecoveryLocalMutations, createV4RecoveryStore } from "../../src/lib/v4/recovery-store"
import type { V4LocalIndexAdapter } from "../../src/lib/v4/local-index"
import type { V4SessionVault } from "../../src/lib/v4/local-io"
import type { V4RecoveryPayload } from "../../src/lib/v4/recovery-types"
import type { V4StageRef, V4StagingStore } from "../../src/lib/v4/staging-store"

const encode = (value: string) => new TextEncoder().encode(value)

class MemoryAdapter implements V4LocalIndexAdapter {
  readonly values = new Map<string, string>()
  async read(path: string) { const value = this.values.get(path); if (value === undefined) throw new Error(`missing:${path}`); return value }
  async write(path: string, value: string) { this.values.set(path, value) }
  async exists(path: string) { return this.values.has(path) }
  async mkdir() {}
}

class MemoryStaging implements V4StagingStore {
  readonly stages = new Map<string, Uint8Array>()
  removed: string[] = []
  pathFor(stageId: string) { return `stage/${stageId}.bin` }
  async beginStage(): Promise<never> { throw new Error("not used") }
  async stageSource(): Promise<never> { throw new Error("not used") }
  async open(ref: Pick<V4StageRef, "stageId" | "size">) {
    const bytes = this.stages.get(ref.stageId)
    if (!bytes) throw new Error(`missing stage:${ref.stageId}`)
    return createV4WholeBufferContentSource(bytes)
  }
  async remove(ref: Pick<V4StageRef, "stageId">) { this.removed.push(ref.stageId); this.stages.delete(ref.stageId) }
}

class MemoryVault implements V4SessionVault {
  readonly files = new Map<string, { bytes: Uint8Array; mtime: number }>()
  readonly staging = new MemoryStaging()
  writes = 0
  async listFiles() { return [...this.files].map(([path, file]) => ({ path, size: file.bytes.byteLength, mtime: file.mtime })) }
  async stat(path: string) { const file = this.files.get(path); return file ? { path, size: file.bytes.byteLength, mtime: file.mtime } : null }
  async read(path: string) { const file = this.files.get(path); if (!file) throw new Error(`missing:${path}`); return new Uint8Array(file.bytes) }
  async write(path: string, bytes: Uint8Array, mtime = 0) { this.writes++; this.files.set(path, { bytes: new Uint8Array(bytes), mtime }) }
  async trash(path: string) { this.files.delete(path) }
  async openContentSource(handle: V4ContentHandle) {
    if (handle.kind !== "vault") throw new Error("only vault handles")
    return createV4WholeBufferContentSource((await this.read(handle.path)))
  }
}

async function stageRef(stageId: string, bytes: Uint8Array, mtime = 20): Promise<V4StageRef> {
  return { stageId, hash: await sha256Hex(bytes), size: bytes.byteLength, mtime }
}

async function savedSnapshot(payload: V4RecoveryPayload) {
  const adapter = new MemoryAdapter()
  const store = createV4RecoveryStore({ adapter, root: "recovery", repoId: "owner/repo#main" })
  const snapshot = await store.save({
    runId: "run-local",
    phase: "remote-verified",
    expectedRemoteHead: "old",
    verifiedRemoteHead: "new",
    payload,
  })
  return { adapter, store, snapshot }
}

test("local recovery persists a receipt after each durable mutation and removes consumed stages", async () => {
  const vault = new MemoryVault()
  vault.files.set("replace.md", { bytes: encode("old"), mtime: 10 })
  vault.files.set("delete.md", { bytes: encode("gone"), mtime: 11 })
  const bytes = encode("new")
  const stage = await stageRef("stage-a", bytes, 20)
  vault.staging.stages.set(stage.stageId, bytes)
  const payload: V4RecoveryPayload = {
    mutations: [
      { id: "write", kind: "stage-write", path: "replace.md", stage, precondition: { path: "replace.md", exists: true, size: 3, mtime: 10 } },
      { id: "trash", kind: "trash", path: "delete.md", precondition: { path: "delete.md", exists: true, size: 4, mtime: 11 } },
    ],
    completedMutationIds: [],
  }
  const { store, snapshot } = await savedSnapshot(payload)
  const result = await applyV4RecoveryLocalMutations({ store, snapshot, io: vault })
  assert.equal(result.replanRequired, false)
  assert.deepEqual([...vault.files.get("replace.md")!.bytes], [...bytes])
  assert.equal(vault.files.has("delete.md"), false)
  assert.deepEqual(vault.staging.removed, ["stage-a"])
  const latest = await store.load()
  assert.equal(latest?.header.phase, "local-committing")
  assert.deepEqual(latest?.payload?.completedMutationIds, ["write", "trash"])
})

test("local recovery marks replan-required and preserves a post-publication user edit", async () => {
  const vault = new MemoryVault()
  vault.files.set("first.md", { bytes: encode("old"), mtime: 10 })
  vault.files.set("user.md", { bytes: encode("user-edit"), mtime: 99 })
  const bytes = encode("remote")
  const stage = await stageRef("stage-b", bytes, 20)
  vault.staging.stages.set(stage.stageId, bytes)
  const payload: V4RecoveryPayload = {
    mutations: [
      { id: "write", kind: "stage-write", path: "first.md", stage, precondition: { path: "first.md", exists: true, size: 3, mtime: 10 } },
      { id: "trash", kind: "trash", path: "user.md", precondition: { path: "user.md", exists: true, size: 4, mtime: 11 } },
    ],
    completedMutationIds: [],
  }
  const { store, snapshot } = await savedSnapshot(payload)
  const result = await applyV4RecoveryLocalMutations({ store, snapshot, io: vault })
  assert.equal(result.replanRequired, true)
  assert.equal(new TextDecoder().decode(vault.files.get("user.md")!.bytes), "user-edit")
  const latest = await store.load()
  assert.equal(latest?.header.phase, "replan-required")
  assert.deepEqual(latest?.payload?.completedMutationIds, ["write"])
})

test("local recovery treats an already committed staged target as idempotent after a lost receipt", async () => {
  const vault = new MemoryVault()
  const bytes = encode("already-committed")
  const stage = await stageRef("moved-stage", bytes, 20)
  vault.files.set("target.bin", { bytes, mtime: 20 })
  const payload: V4RecoveryPayload = {
    mutations: [{ id: "write", kind: "stage-write", path: "target.bin", stage, precondition: { path: "target.bin", exists: false } }],
    completedMutationIds: [],
  }
  const { store, snapshot } = await savedSnapshot(payload)
  const result = await applyV4RecoveryLocalMutations({ store, snapshot, io: vault })
  assert.equal(result.replanRequired, false)
  assert.equal(vault.writes, 0)
  assert.deepEqual((await store.load())?.payload?.completedMutationIds, ["write"])
})

test("startup recovery uses exact candidate SHA evidence and never replays a ref mutation", async () => {
  const mod = await import("../../src/lib/v4/recovery-store")
  assert.equal(typeof mod.recoverV4PendingState, "function")
  const vault = new MemoryVault()
  const bytes = encode("published")
  const stage = await stageRef("stage-c", bytes, 30)
  vault.staging.stages.set(stage.stageId, bytes)
  const adapter = new MemoryAdapter()
  const store = createV4RecoveryStore({ adapter, root: "recovery", repoId: "owner/repo#main" })
  const snapshot = await store.save({
    runId: "run-publish",
    journalId: "journal-publish",
    phase: "publish-intent",
    expectedRemoteHead: "old-head",
    candidateCommitSha: "candidate-head",
    payload: {
      mutations: [{ id: "write", kind: "stage-write", path: "published.md", stage, precondition: { path: "published.md", exists: false } }],
      completedMutationIds: [],
    },
  })
  const result = await mod.recoverV4PendingState({ store, snapshot, io: vault, currentRemoteHead: "candidate-head" })
  assert.equal(result.replanRequired, true)
  assert.equal(new TextDecoder().decode(vault.files.get("published.md")!.bytes), "published")
  assert.equal((await store.load())?.header.phase, "replan-required")
})

test("startup recovery marks an unobserved candidate for replan without applying its local payload", async () => {
  const { recoverV4PendingState } = await import("../../src/lib/v4/recovery-store")
  const vault = new MemoryVault()
  const bytes = encode("not-published")
  const stage = await stageRef("stage-d", bytes, 30)
  vault.staging.stages.set(stage.stageId, bytes)
  const adapter = new MemoryAdapter()
  const store = createV4RecoveryStore({ adapter, root: "recovery", repoId: "owner/repo#main" })
  const snapshot = await store.save({
    runId: "run-unpublished",
    journalId: "journal-unpublished",
    phase: "publish-intent",
    expectedRemoteHead: "old-head",
    candidateCommitSha: "candidate-head",
    payload: {
      mutations: [{ id: "write", kind: "stage-write", path: "must-not-write.md", stage, precondition: { path: "must-not-write.md", exists: false } }],
      completedMutationIds: [],
    },
  })
  const result = await recoverV4PendingState({ store, snapshot, io: vault, currentRemoteHead: "old-head" })
  assert.equal(result.replanRequired, true)
  assert.equal(vault.files.has("must-not-write.md"), false)
  assert.equal((await store.load())?.header.phase, "replan-required")
})

test("local recovery treats an already absent trash target as idempotent after a lost receipt", async () => {
  const vault = new MemoryVault()
  const payload: V4RecoveryPayload = {
    mutations: [{ id: "trash-lost-receipt", kind: "trash", path: "already-gone.md", precondition: { path: "already-gone.md", exists: true, size: 4, mtime: 11 } }],
    completedMutationIds: [],
  }
  const { store, snapshot } = await savedSnapshot(payload)
  const result = await applyV4RecoveryLocalMutations({ store, snapshot, io: vault })
  assert.equal(result.replanRequired, false)
  assert.deepEqual((await store.load())?.payload?.completedMutationIds, ["trash-lost-receipt"])
})
