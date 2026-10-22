import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile, stat, utimes, rename } from "node:fs/promises"
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
    preferStagedCommit: true,
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
    async commitStage() {
      await platform.commitStage("stage.bin", "note.md", {
        expectedTarget: precondition, expectedStageSize: stage.size, expectedStageSha256: stage.hash,
      })
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



test("D9 fail-first: Desktop replacement contains no async rename gap after the final editor guard", async () => fixture(async f => {
  await writeFile(f.targetPath, original)
  await writeFile(f.stagePath, remote)
  const targetStat = await stat(f.targetPath)
  // Code-level contract supplements the runtime fault injection. In Node ESM,
  // import("node:fs/promises").rename is a stable named export and cannot be
  // replaced by patching its CommonJS/default object alone.
  const source = await readFile(path.join(process.cwd(), "src", "lib", "v4", "platform-io.ts"), "utf8")
  const commitSource = source.split("    async commitStage(stagePath, targetPath, commitOptions) {")[1]
  assert.ok(commitSource)
  assert.match(commitSource, /renameSync\(stage, target\)/, "the commit must use a non-yielding metadata rename")
  assert.doesNotMatch(commitSource, /await\s+fs\.rename\(stage,\s*target\)/, "async stage-to-target rename reopens an editor race")
  const precondition = { exists: true, size: targetStat.size, mtime: Math.trunc(targetStat.mtimeMs), hash: await sha256Hex(original) }
  // The old implementation awaits fs.promises.rename(stage,target) after the
  // last synchronous editor check. Simulate opening a note while that async
  // rename is being dispatched; its buffer could then be overwritten silently.
  const fsPromises = (await import("node:module")).createRequire(path.join(process.cwd(), "package.json"))("node:fs/promises") as typeof import("node:fs/promises")
  const actualRename = fsPromises.rename
  let editorOpen = false
  let lateOpens = 0
  let asyncRenameCalls = 0
  let editorChecks = 0
  try {
    fsPromises.rename = async (from, to) => {
      asyncRenameCalls++
      if (String(from) === f.stagePath && String(to) === f.targetPath) {
        await new Promise<void>(resolve => setImmediate(resolve))
        lateOpens++
        editorOpen = true
      }
      return actualRename(from, to)
    }
    await f.platform.commitStage("stage.bin", "note.md", {
      expectedTarget: precondition,
      expectedStageSize: remote.length,
      expectedStageSha256: await sha256Hex(remote),
      assertNoOpenEditor: () => {
        editorChecks++
        if (editorOpen) throw new Error("Opened editor must not be overwritten")
      },
    })
  } finally {
    fsPromises.rename = actualRename
  }
  assert.ok(editorChecks >= 2)
  assert.equal(asyncRenameCalls, 0, "rename pair must not yield to renderer between editor guard and replacement")
  assert.equal(lateOpens, 0, "no window for an editor to open during async rename")
  assert.deepEqual(new Uint8Array(await readFile(f.targetPath)), remote)
  assert.equal(await exists(f.backupPath), false)
}))

test("D9 fail-first: crash rollback also must not yield between editor guard and rename", async () => {
  const source = await readFile(path.join(process.cwd(), "src", "lib", "v4", "platform-io.ts"), "utf8")
  const rollbackSource = source.split("    async rollbackStage(stagePath, targetPath, commitOptions) {")[1]
    ?.split("    async finalizeStage(stagePath, targetPath, commitOptions) {")[0]
  assert.ok(rollbackSource)
  assert.match(rollbackSource, /renameSync\(target, residue\)/)
  assert.match(rollbackSource, /renameSync\(backup, target\)/)
  assert.doesNotMatch(rollbackSource, /await\s+fs\.rename\(/)
})

test("D8: editor opens during the awaited backup rename; original and stage remain intact", async () => fixture(async f => {
  await writeFile(f.targetPath, original)
  await writeFile(f.stagePath, remote)
  const before = await stat(f.targetPath)
  let checks = 0
  await assert.rejects(f.platform.commitStage("stage.bin", "note.md", {
    expectedTarget: { exists: true, size: before.size, mtime: Math.trunc(before.mtimeMs), hash: await sha256Hex(original) },
    expectedStageSize: remote.length, expectedStageSha256: await sha256Hex(remote),
    assertNoOpenEditor: () => {
      checks++
      if (checks === 2) throw new Error("editor became open during the filesystem preflight")
    },
  }), /editor became open/)
  assert.equal(checks, 2)
  assert.deepEqual(new Uint8Array(await readFile(f.targetPath)), original)
  assert.deepEqual(new Uint8Array(await readFile(f.stagePath)), remote)
  assert.equal(await exists(f.backupPath), false)
}))

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

test("D6 native filesystem: a real small staged commit preserves exact bytes with a durable receipt", async () => fixture(async f => {
  await writeFile(f.targetPath, original)
  await utimes(f.targetPath, new Date(10), new Date(10))
  await writeFile(f.stagePath, remote)
  let inPlaceWrites = 0
  f.io.write = async () => { inPlaceWrites++; throw new Error("unsafe in-place write called") }
  const result = await applyV4RecoveryLocalMutations({ store: f.store, snapshot: f.snapshot, io: f.io })
  assert.equal(result.replanRequired, false)
  assert.equal(inPlaceWrites, 0)
  assert.deepEqual(new Uint8Array(await readFile(f.targetPath)), remote)
  assert.equal(await exists(f.stagePath), false)
  assert.equal(await exists(f.backupPath), false)
  assert.deepEqual((await f.store.load())?.payload?.completedMutationIds, ["write:note"])
}))

test("D6 native filesystem: crash after parking original but before moving small stage safely restores original", async () => fixture(async f => {
  await writeFile(f.targetPath, original)
  await utimes(f.targetPath, new Date(10), new Date(10))
  await writeFile(f.stagePath, remote)
  await rename(f.targetPath, f.backupPath) // Inject process kill after first rename.
  await discardV4RecoveryStages(f.snapshot, f.io)
  assert.deepEqual(new Uint8Array(await readFile(f.targetPath)), original)
  assert.equal(await exists(f.backupPath), false)
  assert.equal(await exists(f.stagePath), false)
}))

test("D6 native filesystem: small stage swap with missing receipt is recognized on restart", async () => fixture(async f => {
  await writeFile(f.targetPath, original)
  await utimes(f.targetPath, new Date(10), new Date(10))
  await writeFile(f.stagePath, remote)
  await rename(f.targetPath, f.backupPath)
  await rename(f.stagePath, f.targetPath) // Inject process kill after replacement and before receipt.
  f.io.write = async () => { throw new Error("unsafe in-place write called") }
  const result = await applyV4RecoveryLocalMutations({ store: f.store, snapshot: f.snapshot, io: f.io })
  assert.equal(result.replanRequired, false)
  assert.deepEqual(new Uint8Array(await readFile(f.targetPath)), remote)
  assert.equal(await exists(f.backupPath), false)
  assert.deepEqual((await f.store.load())?.payload?.completedMutationIds, ["write:note"])
}))

test("D6 native filesystem: crash plus user edit keeps candidate and original for manual recovery", async () => fixture(async f => {
  await writeFile(f.targetPath, original)
  await utimes(f.targetPath, new Date(10), new Date(10))
  await writeFile(f.stagePath, remote)
  await rename(f.targetPath, f.backupPath)
  await rename(f.stagePath, f.targetPath)
  await writeFile(f.targetPath, changed)
  await assert.rejects(() => discardV4RecoveryStages(f.snapshot, f.io), /manual|review|ambiguous/i)
  assert.deepEqual(new Uint8Array(await readFile(f.targetPath)), changed)
  assert.deepEqual(new Uint8Array(await readFile(f.backupPath)), original)
}))
