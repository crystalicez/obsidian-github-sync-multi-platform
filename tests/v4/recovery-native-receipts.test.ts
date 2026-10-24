import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"

import { sha256Hex, utf8ToBytes } from "../../src/lib/bytes"
import type { V4LocalIndexAdapter } from "../../src/lib/v4/local-index"
import type { V4LocalIo } from "../../src/lib/v4/local-io"
import { createV4PlatformIo, V4ManualRecoveryRequiredError } from "../../src/lib/v4/platform-io"
import { createV4RecoveryStore, recoverV4PendingState } from "../../src/lib/v4/recovery-store"
import type { V4RecoveryPayload } from "../../src/lib/v4/recovery-types"
import type { V4StagingStore } from "../../src/lib/v4/staging-store"

const enc = (value: string) => utf8ToBytes(value)
const REMOTE = "a".repeat(40)
const BASE = "b".repeat(40)

async function exists(filename: string): Promise<boolean> {
  try { await stat(filename); return true }
  catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return false
    throw error
  }
}

async function fixture(run: (v: {
  root: string
  target: string
  stage: string
  backup: string
  recovery: ReturnType<typeof createV4RecoveryStore>
  io: V4LocalIo
  removals: string[]
  writes: string[]
}) => Promise<void>): Promise<void> {
  const parent = path.join(process.cwd(), ".tmp")
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(path.join(parent, "d56-wal-receipt-"))
  const target = path.join(root, "user.md")
  const stage = path.join(root, "stage.bin")
  const backup = stage + ".target-backup"
  const adapter: V4LocalIndexAdapter = {
    read: filename => readFile(path.join(root, filename), "utf8"),
    write: async (filename, value) => {
      const resolved = path.join(root, filename)
      await mkdir(path.dirname(resolved), { recursive: true })
      await writeFile(resolved, value)
    },
    exists: filename => exists(path.join(root, filename)),
    mkdir: filename => mkdir(path.join(root, filename), { recursive: true }).then(() => undefined),
  }
  const recovery = createV4RecoveryStore({ adapter, root: "wal", repoId: "o/r#main" })
  const platform = createV4PlatformIo({
    platform: "desktop", desktopRootPath: root, resolveDesktopPath: value => value,
  })
  const removals: string[] = []
  const writes: string[] = []
  const staging: V4StagingStore = {
    async beginStage() { throw Error("Replay must not start a new stage") },
    async stageSource() { throw Error("Replay must not stage new source") },
    async open() { throw Error("Replay must not open stage after durable completion") },
    async remove(ref) { removals.push(ref.stageId); await rm(stage, { force: true }) },
    pathFor: () => stage,
  }
  const io: V4LocalIo = {
    async listFiles() { return [] },
    async stat(relative) {
      const filename = path.join(root, relative)
      try {
        const info = await stat(filename)
        return { path: relative, size: info.size, mtime: info.mtimeMs }
      } catch (error) {
        if ((error as { code?: string }).code === "ENOENT") return null
        throw error
      }
    },
    async read(relative) { return new Uint8Array(await readFile(path.join(root, relative))) },
    async write(relative, data) { writes.push(relative); await writeFile(path.join(root, relative), data) },
    async trash(relative) { writes.push("trash:" + relative); await rm(path.join(root, relative)) },
    staging,
    async finalizeStage({ stage: ref, path: relative, precondition }) {
      await platform.finalizeStage(stage, path.join(root, relative), {
        expectedTarget: precondition,
        expectedStageSize: ref.size,
        expectedStageSha256: ref.hash,
      })
    },
  }
  try { await run({ root, target, stage, backup, recovery, io, removals, writes }) }
  finally { await rm(root, { recursive: true, force: true }) }
}

async function storedWritePayload(completed: boolean, originalMtime: number): Promise<V4RecoveryPayload> {
  return {
    mutations: [{
      id: "write:user", kind: "stage-write", path: "user.md",
      stage: { stageId: "stage56", size: 5, mtime: 9, hash: await sha256Hex(enc("new-B")) },
      precondition: { path: "user.md", exists: true, size: 5, mtime: originalMtime, hash: await sha256Hex(enc("old-B")) },
    }],
    completedMutationIds: completed ? ["write:user"] : [],
  }
}

test("D56 received stage-write receipt: native finalize preserves user edit and original backup", async () => fixture(async v => {
  await writeFile(v.target, enc("user!"))
  await writeFile(v.backup, enc("old-B"))
  await writeFile(v.stage, enc("new-B"))
  const snapshot = await v.recovery.save({
    runId: "d56-user-edit", phase: "local-committing",
    expectedRemoteHead: BASE, verifiedRemoteHead: REMOTE,
    payload: await storedWritePayload(true, (await stat(v.backup)).mtimeMs),
  })
  await assert.rejects(
    () => recoverV4PendingState({ store: v.recovery, snapshot, io: v.io, currentRemoteHead: REMOTE }),
    error => error instanceof V4ManualRecoveryRequiredError,
  )
  assert.deepEqual(new Uint8Array(await readFile(v.target)), enc("user!"))
  assert.deepEqual(new Uint8Array(await readFile(v.backup)), enc("old-B"))
  assert.deepEqual(new Uint8Array(await readFile(v.stage)), enc("new-B"))
  assert.deepEqual(v.removals, [], "the stage must remain for manual recovery")
  assert.deepEqual(v.writes, [], "no local content write/trash may occur on ambiguous user edit")
  assert.equal((await v.recovery.load())?.header.phase, "local-committing")
}))

test("D56 received stage-write receipt: native finalize safely removes only verified backup", async () => fixture(async v => {
  await writeFile(v.target, enc("new-B"))
  await writeFile(v.backup, enc("old-B"))
  await writeFile(v.stage, enc("new-B"))
  const snapshot = await v.recovery.save({
    runId: "d56-completed", phase: "local-committing",
    expectedRemoteHead: BASE, verifiedRemoteHead: REMOTE,
    payload: await storedWritePayload(true, (await stat(v.backup)).mtimeMs),
  })
  const result = await recoverV4PendingState({
    store: v.recovery, snapshot, io: v.io, currentRemoteHead: REMOTE,
  })
  assert.equal(result.replanRequired, true)
  assert.equal(result.snapshot.header.phase, "replan-required")
  assert.deepEqual(new Uint8Array(await readFile(v.target)), enc("new-B"))
  assert.equal(await exists(v.backup), false)
  assert.equal(await exists(v.stage), false)
  assert.deepEqual(v.removals, ["stage56"])
  assert.deepEqual(v.writes, [])
}))

test("D56 missing receipt after native target replacement: matching target finalizes safely with absent stage", async () => fixture(async v => {
  await writeFile(v.target, enc("new-B"))
  await writeFile(v.backup, enc("old-B"))
  assert.equal(await exists(v.stage), false)
  const snapshot = await v.recovery.save({
    runId: "d56-lost-receipt", phase: "remote-verified",
    expectedRemoteHead: BASE, verifiedRemoteHead: REMOTE,
    payload: await storedWritePayload(false, (await stat(v.backup)).mtimeMs),
  })
  const result = await recoverV4PendingState({
    store: v.recovery, snapshot, io: v.io, currentRemoteHead: REMOTE,
  })
  assert.equal(result.replanRequired, true)
  assert.equal(result.snapshot.header.phase, "replan-required")
  assert.deepEqual(result.snapshot.payload?.completedMutationIds, ["write:user"])
  assert.deepEqual(new Uint8Array(await readFile(v.target)), enc("new-B"))
  assert.equal(await exists(v.backup), false)
  assert.deepEqual(v.writes, [])
  assert.deepEqual(v.removals, ["stage56"])
}))

test("D56 previously receipted Trash never removes a note recreated after crash", async () => fixture(async v => {
  await writeFile(v.target, enc("user!"))
  const snapshot = await v.recovery.save({
    runId: "d56-recreated", phase: "local-committing",
    expectedRemoteHead: BASE, verifiedRemoteHead: REMOTE,
    payload: { mutations: [{
      id: "trash:user", kind: "trash", path: "user.md",
      precondition: { path: "user.md", exists: true, size: 5, mtime: 8, hash: await sha256Hex(enc("old-B")) },
    }], completedMutationIds: ["trash:user"] },
  })
  const result = await recoverV4PendingState({
    store: v.recovery, snapshot, io: v.io, currentRemoteHead: REMOTE,
  })
  assert.equal(result.replanRequired, true)
  assert.deepEqual(new Uint8Array(await readFile(v.target)), enc("user!"))
  assert.deepEqual(v.writes, [])
}))
