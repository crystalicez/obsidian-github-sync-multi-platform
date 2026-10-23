/**
 * Disposable Windows/native crash harness. This is compiled to CommonJS
 * into a unique .tmp test directory and executed in a child process.
 * All paths are pinned inside the caller's disposable fixture root.
 * Never kill Obsidian, a user process, or a real vault.
 */
import { readFile, writeFile, mkdir, stat, rm, utimes } from "node:fs/promises"
import nodeFs from "node:fs"
import path from "node:path"
import { createV4PlatformIo } from "../../../src/lib/v4/platform-io"
import { createV4RecoveryStore, applyV4RecoveryLocalMutations, discardV4RecoveryStages } from "../../../src/lib/v4/recovery-store"
import { sha256Hex } from "../../../src/lib/bytes"
import { createV4WholeBufferContentSource } from "../../../src/lib/v4/content-source"

const original = new Uint8Array([1, 2, 3, 4, 5, 6])
const staged = new Uint8Array([6, 5, 4, 3, 2, 1, 0])
const [mode, root, crashAt] = process.argv.slice(2)
if (!["prepare", "prepare-rollback", "crash", "rollback-crash", "after-commit-crash", "resume", "discard"].includes(mode)
  || !path.isAbsolute(root ?? "") || !root.includes("native-kill-d11-")
  || !["", "1", "2"].includes(crashAt ?? "")) throw new Error("Refusing unsafe child invocation")

const stagePath = "stage.bin"
const targetPath = "note.md"
const physical = (logical: string) => path.join(root, logical)
const platform = createV4PlatformIo({
  platform: "desktop", desktopRootPath: root, resolveDesktopPath: physical,
})
const fileAdapter = {
  exists: async (p: string) => nodeFs.existsSync(physical(p)),
  read: async (p: string) => readFile(physical(p), "utf8"),
  write: async (p: string, value: string) => {
    await mkdir(path.dirname(physical(p)), { recursive: true })
    await writeFile(physical(p), value)
  },
  mkdir: async (p: string) => { await mkdir(physical(p), { recursive: true }) },
}
const store = createV4RecoveryStore({ root: "wal", repoId: "disposable/test#branch", adapter: fileAdapter })
async function main() {
const stageHash = await sha256Hex(staged)
const originalHash = await sha256Hex(original)
const precondition = { path: targetPath, exists: true, size: original.byteLength, mtime: 10, hash: originalHash }
const stage = { stageId: "stage-1", size: staged.byteLength, hash: stageHash, mtime: 25 }
const mutation = { id: "write:note", kind: "stage-write" as const, path: targetPath, stage, precondition }
const options = { expectedTarget: precondition, expectedStageSize: stage.size, expectedStageSha256: stage.hash }
const io = {
  preferStagedCommit: true,
  async listFiles() { return [] },
  async stat(p: string) {
    const s = await platform.statFile(p)
    return s ? { path: p, ...s } : null
  },
  async read(p: string) { return platform.readWhole(p) },
  async write() { throw new Error("unsafe in-place write invoked") },
  async trash() { throw new Error("unexpected trash") },
  staging: {
    pathFor() { return stagePath },
    async open() { return createV4WholeBufferContentSource(staged) },
    async remove() { await platform.removeStage(stagePath) },
    async beginStage() { throw new Error("unexpected beginStage") },
    async stageSource() { throw new Error("unexpected stageSource") },
  },
  async commitStage() { await platform.commitStage(stagePath, targetPath, options) },
  async rollbackStage() { await platform.rollbackStage(stagePath, targetPath, options) },
  async finalizeStage() { await platform.finalizeStage(stagePath, targetPath, options) },
}

if (mode === "prepare" || mode === "prepare-rollback") {
  await mkdir(root, { recursive: true })
  await writeFile(physical(targetPath), original)
  await utimes(physical(targetPath), new Date(10), new Date(10))
  await writeFile(physical(stagePath), staged)
  await store.save({
    runId: "crash-run", phase: "remote-verified", verifiedRemoteHead: "new",
    expectedRemoteHead: "old", payload: { mutations: [mutation], completedMutationIds: [] },
  })
  if (mode === "prepare-rollback") {
    nodeFs.renameSync(physical(targetPath), physical(stagePath+".target-backup"))
    nodeFs.renameSync(physical(stagePath), physical(targetPath))
  }
  process.stdout.write("prepared\n")
} else if (mode === "after-commit-crash") {
  // The commit completed but caller has NOT yet persisted its WAL receipt.
  await platform.commitStage(stagePath, targetPath, options)
  process.exit(93)
} else if (mode === "crash" || mode === "rollback-crash") {
  const realRename = nodeFs.renameSync
  let count = 0
  nodeFs.renameSync = ((from: string, to: string) => {
    realRename(from, to)
    count++
    if (count === Number(crashAt)) {
      // Hard exit exactly AFTER this native rename, before JS can perform
      // another operation, WAL receipt, catch/finally, or cleanup.
      process.exit(90 + count)
    }
  }) as typeof nodeFs.renameSync
  if (mode === "crash") await platform.commitStage(stagePath, targetPath, options)
  else await platform.rollbackStage(stagePath, targetPath, options)
  throw new Error("Fault injection did not terminate the child")
} else {
  const snapshot = await store.load()
  if (!snapshot) throw new Error("Missing persisted WAL after real process exit")
  if (mode === "discard") {
    await discardV4RecoveryStages(snapshot, io)
    const bytes = await readFile(physical(targetPath))
    if (Buffer.compare(bytes, Buffer.from(original)) !== 0) throw new Error("Original not restored from backup")
    const remaining = nodeFs.existsSync(physical(stagePath+".target-backup"))
      || nodeFs.existsSync(physical(stagePath+".replacement-residue"))
    if (remaining) throw new Error("Unresolved filesystem backup/residue after discard")
    process.stdout.write("original-restored\n")
  } else {
    const result = await applyV4RecoveryLocalMutations({ store, snapshot, io })
    if (result.replanRequired) throw new Error("Fresh-process recovery unexpectedly requires replan")
    const bytes = await readFile(physical(targetPath))
    if (Buffer.compare(bytes, Buffer.from(staged)) !== 0) throw new Error("Staged content not recovered")
    const latest = await store.load()
    if (!latest?.payload?.completedMutationIds.includes("write:note")) throw new Error("WAL receipt missing")
    const remaining = nodeFs.existsSync(physical(stagePath+".target-backup"))
      || nodeFs.existsSync(physical(stagePath+".replacement-residue"))
    if (remaining) throw new Error("Unresolved backup/residue after recovery")
    process.stdout.write("remote-recovered\n")
  }
}
}
main().catch(error => { console.error(error); process.exitCode = 2 })
