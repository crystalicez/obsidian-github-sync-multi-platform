import assert from "node:assert/strict"
import test from "node:test"

import { sha256Hex } from "../../src/lib/bytes"
import { createV4WholeBufferContentSource } from "../../src/lib/v4/content-source"
import type { V4LocalIndexAdapter } from "../../src/lib/v4/local-index"
import type { V4SessionVault } from "../../src/lib/v4/local-io"
import {
  applyV4RecoveryLocalMutations,
  createV4RecoveryStore,
  markV4RecoveryIndexCommitted,
  recoverV4PendingState,
} from "../../src/lib/v4/recovery-store"
import type { V4RecoveryPayload, V4RecoverySnapshot } from "../../src/lib/v4/recovery-types"
import type { V4StageRef, V4StagingStore } from "../../src/lib/v4/staging-store"

const enc = (value: string) => new TextEncoder().encode(value)

class Adapter implements V4LocalIndexAdapter {
  readonly values = new Map<string, string>()
  failWriteAt = -1
  writes = 0
  async read(path: string) { const value = this.values.get(path); if (value === undefined) throw new Error(`missing:${path}`); return value }
  async write(path: string, value: string) { this.writes++; if (this.writes === this.failWriteAt) throw new Error("crash:recovery-write"); this.values.set(path, value) }
  async exists(path: string) { return this.values.has(path) }
  async mkdir() {}
}

class Staging implements V4StagingStore {
  readonly stages = new Map<string, Uint8Array>()
  throwCleanup = false
  async beginStage(): Promise<never> { throw new Error("not used") }
  async stageSource(): Promise<never> { throw new Error("not used") }
  async open(ref: Pick<V4StageRef, "stageId" | "size">) {
    const bytes = this.stages.get(ref.stageId)
    if (!bytes) throw new Error(`missing:${ref.stageId}`)
    return createV4WholeBufferContentSource(bytes)
  }
  async remove(ref: Pick<V4StageRef, "stageId">) {
    if (this.throwCleanup) throw new Error("crash:cleanup")
    this.stages.delete(ref.stageId)
  }
}

class Vault implements V4SessionVault {
  readonly files = new Map<string, { bytes: Uint8Array; mtime: number }>()
  readonly staging = new Staging()
  writes = 0
  trashes = 0
  crashAfterSwap = false
  async listFiles() { return [...this.files].map(([path, file]) => ({ path, size: file.bytes.byteLength, mtime: file.mtime })) }
  async stat(path: string) { const file = this.files.get(path); return file ? { path, size: file.bytes.byteLength, mtime: file.mtime } : null }
  async read(path: string) { const file = this.files.get(path); if (!file) throw new Error(`missing:${path}`); return new Uint8Array(file.bytes) }
  async write(path: string, bytes: Uint8Array, mtime = 0) { this.writes++; this.files.set(path, { bytes: new Uint8Array(bytes), mtime }) }
  async trash(path: string) { this.trashes++; this.files.delete(path) }
  async commitStage({ stage, path }: { stage: V4StageRef; path: string }) {
    const bytes = this.staging.stages.get(stage.stageId)
    if (!bytes) throw new Error("missing stage")
    this.files.set(path, { bytes: new Uint8Array(bytes), mtime: stage.mtime })
    this.staging.stages.delete(stage.stageId)
    if (this.crashAfterSwap) { this.crashAfterSwap = false; throw new Error("crash:after-swap") }
  }
}

async function stage(stageId: string, value: string): Promise<{ ref: V4StageRef; bytes: Uint8Array }> {
  const bytes = enc(value)
  return { ref: { stageId, hash: await sha256Hex(bytes), size: bytes.byteLength, mtime: 20 }, bytes }
}

async function saveIntent(adapter: Adapter, payload: V4RecoveryPayload): Promise<{ store: ReturnType<typeof createV4RecoveryStore>; snapshot: V4RecoverySnapshot }> {
  const store = createV4RecoveryStore({ adapter, root: "recovery", repoId: "owner/repo#main" })
  const snapshot = await store.save({
    runId: "run-crash",
    journalId: "journal-crash",
    phase: "publish-intent",
    expectedRemoteHead: "head-before",
    candidateCommitSha: "candidate",
    payload,
  })
  return { store, snapshot }
}

test("crash matrix: candidate created before publish-intent cannot mutate local state", async () => {
  const adapter = new Adapter()
  const vault = new Vault()
  const store = createV4RecoveryStore({ adapter, root: "recovery", repoId: "owner/repo#main" })
  assert.equal(await store.load(), null)
  assert.equal(vault.files.size, 0)
})

test("crash matrix: before ref mutation replans twice without replaying local payload", async () => {
  const adapter = new Adapter()
  const vault = new Vault()
  const staged = await stage("s-before-ref", "remote")
  vault.staging.stages.set(staged.ref.stageId, staged.bytes)
  const { store, snapshot } = await saveIntent(adapter, {
    mutations: [{ id: "write", kind: "stage-write", path: "note.md", stage: staged.ref, precondition: { path: "note.md", exists: false } }],
    completedMutationIds: [],
  })
  const first = await recoverV4PendingState({ store, snapshot, io: vault, currentRemoteHead: "head-before" })
  const second = await recoverV4PendingState({ store, snapshot: first.snapshot, io: vault, currentRemoteHead: "head-before" })
  assert.equal(first.replanRequired, true)
  assert.equal(second.replanRequired, true)
  assert.equal(vault.files.has("note.md"), false)
})

test("crash matrix: after ref mutation applies local payload once and recovery is idempotent", async () => {
  const adapter = new Adapter()
  const vault = new Vault()
  const staged = await stage("s-after-ref", "remote")
  vault.staging.stages.set(staged.ref.stageId, staged.bytes)
  const { store, snapshot } = await saveIntent(adapter, {
    mutations: [{ id: "write", kind: "stage-write", path: "note.md", stage: staged.ref, precondition: { path: "note.md", exists: false } }],
    completedMutationIds: [],
  })
  const first = await recoverV4PendingState({ store, snapshot, io: vault, currentRemoteHead: "candidate" })
  const writes = vault.writes
  const second = await recoverV4PendingState({ store, snapshot: first.snapshot, io: vault, currentRemoteHead: "candidate" })
  assert.equal(new TextDecoder().decode(vault.files.get("note.md")!.bytes), "remote")
  assert.equal(vault.writes, writes)
  assert.equal(second.replanRequired, true)
})

test("crash matrix: lost stage-write receipt after non-atomic swap is recovered by target hash", async () => {
  const adapter = new Adapter()
  const vault = new Vault()
  const staged = await stage("s-swap", "large")
  const largeRef = { ...staged.ref, size: 33 * 1024 * 1024 }
  // The bytes are intentionally tiny; commitStage simulates the platform swap while the ref forces the large path.
  vault.staging.stages.set(largeRef.stageId, staged.bytes)
  vault.crashAfterSwap = true
  const store = createV4RecoveryStore({ adapter, root: "recovery", repoId: "owner/repo#main" })
  let snapshot = await store.save({
    runId: "run-swap",
    phase: "remote-verified",
    expectedRemoteHead: "candidate",
    verifiedRemoteHead: "candidate",
    payload: { mutations: [{ id: "swap", kind: "stage-write", path: "large.bin", stage: largeRef, precondition: { path: "large.bin", exists: false } }], completedMutationIds: [] },
  })
  await assert.rejects(applyV4RecoveryLocalMutations({ store, snapshot, io: vault }), /crash:after-swap/u)
  // Make the committed target describe the advertised stage so the lost receipt is recognizable.
  const committed = vault.files.get("large.bin")!
  const targetBytes = staged.bytes
  snapshot = (await store.load())!
  snapshot.payload!.mutations[0] = { ...snapshot.payload!.mutations[0], stage: { ...staged.ref } } as typeof snapshot.payload.mutations[number]
  committed.bytes = targetBytes
  const resumed = await applyV4RecoveryLocalMutations({ store, snapshot, io: vault })
  const twice = await applyV4RecoveryLocalMutations({ store, snapshot: resumed.snapshot, io: vault })
  assert.equal(resumed.replanRequired, false)
  assert.equal(twice.replanRequired, false)
  assert.deepEqual((await store.load())?.payload?.completedMutationIds, ["swap"])
})

test("crash matrix: receipts before and after each local mutation remain idempotent", async () => {
  for (const completed of [false, true]) {
    const adapter = new Adapter()
    const vault = new Vault()
    vault.files.set("trash.md", { bytes: enc("old"), mtime: 10 })
    const store = createV4RecoveryStore({ adapter, root: `recovery-${completed}`, repoId: "owner/repo#main" })
    const snapshot = await store.save({
      runId: `run-${completed}`,
      phase: "local-committing",
      expectedRemoteHead: "candidate",
      verifiedRemoteHead: "candidate",
      payload: { mutations: [{ id: "trash", kind: "trash", path: "trash.md", precondition: { path: "trash.md", exists: true, size: 3, mtime: 10 } }], completedMutationIds: completed ? ["trash"] : [] },
    })
    if (completed) vault.files.delete("trash.md")
    const first = await applyV4RecoveryLocalMutations({ store, snapshot, io: vault })
    const count = vault.trashes
    await applyV4RecoveryLocalMutations({ store, snapshot: first.snapshot, io: vault })
    assert.equal(vault.trashes, count)
  }
})

test("crash matrix: cleanup failure cannot erase a durable mutation receipt", async () => {
  const adapter = new Adapter()
  const vault = new Vault()
  const staged = await stage("s-cleanup", "done")
  vault.staging.stages.set(staged.ref.stageId, staged.bytes)
  vault.staging.throwCleanup = true
  const store = createV4RecoveryStore({ adapter, root: "cleanup", repoId: "owner/repo#main" })
  const snapshot = await store.save({
    runId: "run-cleanup",
    phase: "remote-verified",
    expectedRemoteHead: "candidate",
    verifiedRemoteHead: "candidate",
    payload: { mutations: [{ id: "write", kind: "stage-write", path: "note.md", stage: staged.ref, precondition: { path: "note.md", exists: false } }], completedMutationIds: [] },
  })
  const first = await applyV4RecoveryLocalMutations({ store, snapshot, io: vault })
  const writes = vault.writes
  await applyV4RecoveryLocalMutations({ store, snapshot: first.snapshot, io: vault })
  assert.equal(vault.writes, writes)
  assert.deepEqual((await store.load())?.payload?.completedMutationIds, ["write"])
})

test("crash matrix: index-save recovery can be terminalized twice only after durable index evidence", async () => {
  const adapter = new Adapter()
  const store = createV4RecoveryStore({ adapter, root: "index", repoId: "owner/repo#main" })
  await store.save({ runId: "run-index", phase: "replan-required", expectedRemoteHead: "old", verifiedRemoteHead: "candidate" })
  const first = await markV4RecoveryIndexCommitted(store, "run-index")
  const second = await markV4RecoveryIndexCommitted(store, "run-index")
  assert.equal(first?.header.phase, "index-committed")
  assert.equal(second?.header.phase, "index-committed")
  assert.equal(second?.header.generation, first?.header.generation)
})
