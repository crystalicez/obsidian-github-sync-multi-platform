import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"

import { sha256Hex, utf8ToBytes } from "../../src/lib/bytes"
import { createV4WholeBufferContentSource } from "../../src/lib/v4/content-source"
import type { V4LocalIndexAdapter } from "../../src/lib/v4/local-index"
import type { V4LocalIo } from "../../src/lib/v4/local-io"
import { createV4PlatformIo, V4ManualRecoveryRequiredError } from "../../src/lib/v4/platform-io"
import { createV4RecoveryStore, recoverV4PendingState } from "../../src/lib/v4/recovery-store"
import type { V4RecoveryPayload } from "../../src/lib/v4/recovery-types"
import type { V4StagingStore } from "../../src/lib/v4/staging-store"

const utf8 = (value: string): Uint8Array => utf8ToBytes(value)
const HEAD = "a".repeat(40)
const BASE = "b".repeat(40)
const OTHER_HEAD = "c".repeat(40)

async function exists(filename: string): Promise<boolean> {
  try { await stat(filename); return true }
  catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return false
    throw e
  }
}

async function fixture(run: (ctx: {
  root: string
  aTarget: string
  bTarget: string
  aStage: string
  bStage: string
  aBackup: string
  store: ReturnType<typeof createV4RecoveryStore>
  io: V4LocalIo
  events: string[]
  initialBmtime: number
}) => Promise<void>, bState: "user-edit" | "missing-stage" | "no-change" = "no-change") {
  const parent = path.join(process.cwd(), ".tmp")
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(path.join(parent, "d57-receipt-"))
  const aTarget = path.join(root, "A.md")
  const bTarget = path.join(root, "B.md")
  const aStage = path.join(root, "stageA57.bin")
  const bStage = path.join(root, "stageB57.bin")
  const aBackup = aStage + ".target-backup"
  try {
    await writeFile(aTarget, utf8("new-A"))
    await writeFile(bTarget, utf8("old-B"))
    const initialBmtime = (await stat(bTarget)).mtimeMs
    await writeFile(aBackup, utf8("old-A"))
    await writeFile(aStage, utf8("new-A"))
    if (bState !== "missing-stage") await writeFile(bStage, utf8("new-B"))
    if (bState === "user-edit") await writeFile(bTarget, utf8("user!"))

    const adapter: V4LocalIndexAdapter = {
      read: filename => readFile(path.join(root, filename), "utf8"),
      write: async (filename, content) => {
        const absolute = path.join(root, filename)
        await mkdir(path.dirname(absolute), { recursive: true })
        await writeFile(absolute, content)
      },
      exists: filename => exists(path.join(root, filename)),
      mkdir: filename => mkdir(path.join(root, filename), { recursive: true }).then(() => undefined),
    }
    const store = createV4RecoveryStore({ adapter, root: "wal", repoId: "o/r#main" })
    const desktop = createV4PlatformIo({
      platform: "desktop", desktopRootPath: root, resolveDesktopPath: value => value,
    })
    const events: string[] = []
    const stagePath = (stageId: string) => {
      if (stageId === "stageA57") return aStage
      if (stageId === "stageB57") return bStage
      throw new Error("unapproved synthetic stage")
    }
    const staging: V4StagingStore = {
      async beginStage() { throw Error("no new stage during replay") },
      async stageSource() { throw Error("no new stage during replay") },
      async open(ref) {
        events.push("open:" + ref.stageId)
        const filename = stagePath(ref.stageId)
        return createV4WholeBufferContentSource(new Uint8Array(await readFile(filename)))
      },
      async remove(ref) {
        events.push("remove:" + ref.stageId)
        await rm(stagePath(ref.stageId), { force: true })
      },
      pathFor: stagePath,
    }
    const io: V4LocalIo = {
      async listFiles() { return [] },
      async stat(relative) {
        const filename = path.join(root, relative)
        try {
          const info = await stat(filename)
          return {
            path: relative, size: info.size,
            // Deliberately hold the synthetic scan's stat timestamp for B:
            // prove content-hash guard catches a same-stat external edit.
            mtime: bState === "user-edit" && relative === "B.md" ? initialBmtime : info.mtimeMs,
          }
        } catch (e) {
          if ((e as { code?: string }).code === "ENOENT") return null
          throw e
        }
      },
      async read(relative) { return new Uint8Array(await readFile(path.join(root, relative))) },
      async write(relative, bytes, mtime) {
        events.push("write:" + relative)
        await writeFile(path.join(root, relative), bytes)
        void mtime
      },
      async trash(relative) {
        events.push("trash:" + relative)
        await rm(path.join(root, relative))
      },
      staging,
      async finalizeStage({ stage, path: relative, precondition }) {
        events.push("finalize:" + relative)
        await desktop.finalizeStage(stagePath(stage.stageId), path.join(root, relative), {
          expectedTarget: precondition,
          expectedStageSize: stage.size,
          expectedStageSha256: stage.hash,
        })
      },
    }
    await run({ root, aTarget, bTarget, aStage, bStage, aBackup, store, io, events, initialBmtime })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function twoMutationPayload(aOriginalMtime: number, bOriginalMtime: number): Promise<V4RecoveryPayload> {
  return {
    mutations: [
      {
        kind: "stage-write", id: "done:A", path: "A.md",
        stage: { stageId: "stageA57", hash: await sha256Hex(utf8("new-A")), size: 5, mtime: 10 },
        precondition: {
          path: "A.md", exists: true, size: 5, mtime: aOriginalMtime,
          hash: await sha256Hex(utf8("old-A")),
        },
      },
      {
        kind: "stage-write", id: "pending:B", path: "B.md",
        stage: { stageId: "stageB57", hash: await sha256Hex(utf8("new-B")), size: 5, mtime: 11 },
        precondition: {
          path: "B.md", exists: true, size: 5, mtime: bOriginalMtime,
          hash: await sha256Hex(utf8("old-B")),
        },
      },
    ],
    completedMutationIds: ["done:A"],
  }
}

test("D57 native multi-receipt replay finalizes verified A but preserves same-stat user-edited B", async () =>
  fixture(async v => {
    const wal = await v.store.save({
      runId: "d57-local-edit", phase: "local-committing",
      expectedRemoteHead: BASE, verifiedRemoteHead: HEAD,
      payload: await twoMutationPayload((await stat(v.aBackup)).mtimeMs, v.initialBmtime),
    })
    const result = await recoverV4PendingState({
      store: v.store, snapshot: wal, io: v.io, currentRemoteHead: HEAD,
    })
    assert.equal(result.replanRequired, true)
    assert.equal(result.snapshot.header.phase, "replan-required")
    assert.deepEqual(result.snapshot.payload?.completedMutationIds, ["done:A"])
    assert.deepEqual(new Uint8Array(await readFile(v.aTarget)), utf8("new-A"))
    assert.equal(await exists(v.aBackup), false, "A backup may be finalized only after native SHA+mtime proof")
    assert.equal(await exists(v.aStage), false)
    assert.deepEqual(new Uint8Array(await readFile(v.bTarget)), utf8("user!"), "B user edit must survive")
    assert.deepEqual(new Uint8Array(await readFile(v.bStage)), utf8("new-B"), "pending B stage must not be auto-discarded by replay")
    assert.deepEqual(v.events, ["finalize:A.md", "remove:stageA57"])
  }, "user-edit"))

test("D57 completed A receipt followed by missing B stage retains WAL and unmodified B", async () =>
  fixture(async v => {
    const wal = await v.store.save({
      runId: "d57-missing-stage", phase: "local-committing",
      expectedRemoteHead: BASE, verifiedRemoteHead: HEAD,
      payload: await twoMutationPayload((await stat(v.aBackup)).mtimeMs, v.initialBmtime),
    })
    await assert.rejects(
      () => recoverV4PendingState({ store: v.store, snapshot: wal, io: v.io, currentRemoteHead: HEAD }),
      (error: unknown) => (error as { code?: string }).code === "ENOENT",
    )
    const persisted = await v.store.load()
    assert.equal(persisted?.header.phase, "local-committing")
    assert.deepEqual(persisted.payload?.completedMutationIds, ["done:A"])
    assert.deepEqual(new Uint8Array(await readFile(v.aTarget)), utf8("new-A"))
    assert.equal(await exists(v.aBackup), false)
    assert.equal(await exists(v.aStage), false)
    assert.deepEqual(new Uint8Array(await readFile(v.bTarget)), utf8("old-B"))
    assert.equal(await exists(v.bStage), false)
    assert.deepEqual(v.events, ["finalize:A.md", "remove:stageA57", "open:stageB57"])
  }, "missing-stage"))

test("D57 stale remote HEAD blocks all native receipt finalization and keeps original backup", async () =>
  fixture(async v => {
    const wal = await v.store.save({
      runId: "d57-other-head", phase: "local-committing",
      expectedRemoteHead: BASE, verifiedRemoteHead: HEAD,
      payload: await twoMutationPayload((await stat(v.aBackup)).mtimeMs, v.initialBmtime),
    })
    const result = await recoverV4PendingState({
      store: v.store, snapshot: wal, io: v.io, currentRemoteHead: OTHER_HEAD,
    })
    assert.equal(result.replanRequired, true)
    assert.equal(result.snapshot.header.phase, "replan-required")
    assert.deepEqual(v.events, [], "remote HEAD proof must precede native finalize and stage cleanup")
    assert.deepEqual(new Uint8Array(await readFile(v.aBackup)), utf8("old-A"))
    assert.deepEqual(new Uint8Array(await readFile(v.aStage)), utf8("new-A"))
    assert.deepEqual(new Uint8Array(await readFile(v.bTarget)), utf8("old-B"))
  }))
