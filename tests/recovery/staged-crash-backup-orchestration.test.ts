import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile, stat, utimes } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import test from "node:test"
import { sha256Hex } from "../../src/lib/bytes"
import { applyV4RecoveryLocalMutations, createV4RecoveryStore, discardV4RecoveryStages } from "../../src/lib/v4/recovery-store"
import { createV4PlatformIo } from "../../src/lib/v4/platform-io"
import { createV4WholeBufferContentSource } from "../../src/lib/v4/content-source"

const original = new Uint8Array([1, 2, 3])
const remote = new Uint8Array([9, 8, 7, 6])
const changed = new Uint8Array([8, 8, 8, 8, 8])

async function exists(file: string) {
  try { await stat(file); return true } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return false
    throw error
  }
}

async function fixture(run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const f = await setup()
  try { await run(f) } finally { await rm(f.root, { recursive: true, force: true }) }
}
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "v4-wal-backup-"))
  const stagePath = path.join(root, "stage.bin")
  const targetPath = path.join(root, "note.md")
  const backupPath = stagePath + ".target-backup"
  const platform = createV4PlatformIo({ platform: "desktop", resolveDesktopPath: v => path.join(root, v), desktopRootPath: root })
  const stage = { stageId: "wal-stage", hash: await sha256Hex(remote), size: remote.byteLength, mtime: 20 }
  const precondition = { path: "note.md", exists: true, size: original.byteLength, mtime: 10, hash: await sha256Hex(original) }
  const storeData = new Map<string, string>()
  const store = createV4RecoveryStore({
    root: "recovery", repoId: "disposable/branch",
    adapter: {
      async write(k, v) { storeData.set(k, v) },
      async read(k) { const v = storeData.get(k); if (v === undefined) throw new Error(k); return v },
      async exists(k) { return storeData.has(k) },
      async mkdir() {},
    },
  })
  const snapshot = await store.save({
    runId: "crash-recovery", phase: "remote-verified", expectedRemoteHead: "previous",
    verifiedRemoteHead: "head", payload: {
      mutations: [{ id: "write:note", kind: "stage-write", path: "note.md", stage, precondition }],
      completedMutationIds: [],
    },
  })
  const io = {
    async listFiles() { return [] },
    async stat(p: string) {
      try { const v = await stat(path.join(root, p)); return { path: p, size: v.size, mtime: 10 } }
      catch (error) { if ((error as { code?: string }).code === "ENOENT") return null; throw error }
    },
    async read(p: string) { return new Uint8Array(await readFile(path.join(root, p))) },
    async write(p: string, bytes: Uint8Array) { await writeFile(path.join(root, p), bytes) },
    async trash(p: string) { await rm(path.join(root, p)) },
    staging: {
      pathFor(id: string) { return "stage.bin" },
      async open() { return createV4WholeBufferContentSource(remote) },
      async remove() { await platform.removeStage("stage.bin") },
      async beginStage(): Promise<never> { throw new Error("not used") },
      async stageSource(): Promise<never> { throw new Error("not used") },
    },
    async rollbackStage() {
      await platform.rollbackStage("stage.bin", "note.md", {
        expectedTarget: precondition, expectedStageSize: stage.size, expectedStageSha256: stage.hash,
      })
    },
    async finalizeStage() {
      await platform.finalizeStage("stage.bin", "note.md", {
        expectedTarget: precondition, expectedStageSize: stage.size, expectedStageSha256: stage.hash,
      })
    },
  }
  return { root, stagePath, targetPath, backupPath, platform, store, snapshot, stage, precondition, io }
}

test("D2 WAL: aborted recovery restores backup-only crash before deleting staged evidence", async () => fixture(async f => {
  await writeFile(f.backupPath, original)
  await utimes(f.backupPath, new Date(10), new Date(10))
  await writeFile(f.stagePath, remote)
  await discardV4RecoveryStages(f.snapshot, f.io)
  assert.deepEqual(new Uint8Array(await readFile(f.targetPath)), original)
  assert.equal(await exists(f.backupPath), false)
  assert.equal(await exists(f.stagePath), false)
}))

test("D2 WAL: ambiguous manual review prevents stage cleanup and preserves user target and backup", async () => fixture(async f => {
  await writeFile(f.backupPath, original)
  await utimes(f.backupPath, new Date(10), new Date(10))
  await writeFile(f.targetPath, changed)
  await writeFile(f.stagePath, remote)
  await assert.rejects(() => discardV4RecoveryStages(f.snapshot, f.io), /manual|review|ambiguous/i)
  assert.deepEqual(new Uint8Array(await readFile(f.targetPath)), changed)
  assert.deepEqual(new Uint8Array(await readFile(f.backupPath)), original)
  assert.deepEqual(new Uint8Array(await readFile(f.stagePath)), remote)
}))

test("D2 WAL: lost receipt after staged rename is durably recorded before clearing verified backup", async () => fixture(async f => {
  await writeFile(f.backupPath, original)
  await utimes(f.backupPath, new Date(10), new Date(10))
  await writeFile(f.targetPath, remote)
  const result = await applyV4RecoveryLocalMutations({ store: f.store, snapshot: f.snapshot, io: f.io })
  assert.equal(result.replanRequired, false)
  assert.deepEqual((await f.store.load())?.payload?.completedMutationIds, ["write:note"])
  assert.equal(await exists(f.backupPath), false)
  assert.deepEqual(new Uint8Array(await readFile(f.targetPath)), remote)
}))

test("D2 WAL: a saved completion only finalizes a matching target and retains backup otherwise", async () => fixture(async f => {
  await writeFile(f.backupPath, original)
  await utimes(f.backupPath, new Date(10), new Date(10))
  await writeFile(f.targetPath, changed)
  const recorded = await f.store.save({
    runId: "crash-recovery", phase: "local-committing", expectedRemoteHead: "previous",
    verifiedRemoteHead: "head", payload: {
      mutations: f.snapshot.payload!.mutations, completedMutationIds: ["write:note"],
    },
  })
  await assert.rejects(() => applyV4RecoveryLocalMutations({ store: f.store, snapshot: recorded, io: f.io }), /manual|review|ambiguous/i)
  assert.deepEqual(new Uint8Array(await readFile(f.targetPath)), changed)
  assert.deepEqual(new Uint8Array(await readFile(f.backupPath)), original)
}))
