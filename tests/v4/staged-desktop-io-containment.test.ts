import assert from "node:assert/strict"
import { renameSync, symlinkSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile, stat } from "node:fs/promises"
import { createRequire, syncBuiltinESMExports } from "node:module"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { sha256Hex } from "../../src/lib/bytes"
import { collectV4ContentSource } from "../../src/lib/v4/content-source"
import { createV4PlatformIo } from "../../src/lib/v4/platform-io"

const unchanged = new Uint8Array([7, 8, 9])
const added = new Uint8Array([4, 5, 6])

async function withOutsideDirectoryLink(t: { skip(message?: string): void }, testCase: (input: {
  root: string
  external: string
  io: ReturnType<typeof createV4PlatformIo>
}) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "v4-io-root-"))
  const external = await mkdtemp(path.join(os.tmpdir(), "v4-io-external-"))
  try {
    await mkdir(path.join(root, "safe"))
    try {
      await symlink(external, path.join(root, "linked"), process.platform === "win32" ? "junction" : "dir")
    } catch (error) {
      if (["EPERM", "EACCES", "ENOSYS"].includes((error as { code?: string }).code ?? "")) {
        t.skip("Symlink/junction creation is unavailable in this environment")
        return
      }
      throw error
    }
    const io = createV4PlatformIo({
      platform: "desktop", desktopRootPath: root,
      resolveDesktopPath: logical => path.join(root, logical),
    })
    await testCase({ root, external, io })
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(external, { recursive: true, force: true })
  }
}

test("D3 bounded read cannot read a file through a junction escaping the configured vault root", async t => {
  await withOutsideDirectoryLink(t, async ({ external, io }) => {
    await writeFile(path.join(external, "secret.bin"), unchanged)
    const source = await io.openBoundedSource("linked/secret.bin", unchanged.byteLength)
    await assert.rejects(
      () => collectV4ContentSource(source, unchanged.byteLength),
      /symlink|junction|vault|outside|unsafe|review/i,
    )
    assert.deepEqual(new Uint8Array(await readFile(path.join(external, "secret.bin"))), unchanged)
  })
})

test("D3 staging write refuses a junction target outside the vault", async t => {
  await withOutsideDirectoryLink(t, async ({ external, io }) => {
    await assert.rejects(() => io.writeStage("linked/new.bin", added), /symlink|junction|vault|outside|unsafe|review/i)
    await assert.rejects(readFile(path.join(external, "new.bin")), { code: "ENOENT" })
  })
})

test("D3 append refuses an external staged file even when its parent appears inside the vault", async t => {
  await withOutsideDirectoryLink(t, async ({ external, io }) => {
    await writeFile(path.join(external, "existing.bin"), unchanged)
    await assert.rejects(() => io.appendStage("linked/existing.bin", added), /symlink|junction|vault|outside|unsafe|review/i)
    assert.deepEqual(new Uint8Array(await readFile(path.join(external, "existing.bin"))), unchanged)
  })
})

test("D3 stage cleanup refuses to follow a link outside the vault", async t => {
  await withOutsideDirectoryLink(t, async ({ external, io }) => {
    await writeFile(path.join(external, "recovery.bin"), unchanged)
    await assert.rejects(() => io.removeStage("linked/recovery.bin"), /symlink|junction|vault|outside|unsafe|review/i)
    assert.deepEqual(new Uint8Array(await readFile(path.join(external, "recovery.bin"))), unchanged)
  })
})

test("D3 direct path traversal cannot escape the vault even without a symlink", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v4-io-containment-"))
  try {
    const io = createV4PlatformIo({ platform: "desktop", desktopRootPath: root, resolveDesktopPath: logical => path.join(root, logical) })
    await assert.rejects(() => io.writeStage("../escaped.bin", added), /vault|escape|outside|unsafe|review/i)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("D3 safe paths retain Desktop staging and bounded read behavior", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v4-io-contained-"))
  try {
    const io = createV4PlatformIo({ platform: "desktop", desktopRootPath: root, resolveDesktopPath: logical => path.join(root, logical) })
    await io.writeStage("private/staged.bin", unchanged)
    await io.appendStage("private/staged.bin", added)
    const expected = new Uint8Array([...unchanged, ...added])
    const result = await collectV4ContentSource(await io.openBoundedSource("private/staged.bin", expected.byteLength), expected.byteLength)
    assert.deepEqual(result, expected)
    await io.removeStage("private/staged.bin")
    await assert.rejects(readFile(path.join(root, "private", "staged.bin")), { code: "ENOENT" })
  } finally { await rm(root, { recursive: true, force: true }) }
})


test("D3 staged commit refuses a corrupted stage before moving or deleting the existing target", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v4-stage-preflight-"))
  try {
    const io = createV4PlatformIo({ platform: "desktop", desktopRootPath: root, resolveDesktopPath: logical => path.join(root, logical) })
    await writeFile(path.join(root, "target.bin"), unchanged)
    await writeFile(path.join(root, "stage.bin"), unchanged)
    const mismatchedStageHash = await sha256Hex(added)
    await assert.rejects(() => io.commitStage("stage.bin", "target.bin", {
      expectedTarget: { exists: true, size: unchanged.byteLength },
      expectedStageSize: unchanged.byteLength,
      expectedStageSha256: mismatchedStageHash,
    }), /hash|stage|mismatch|corrupt/i)
    assert.deepEqual(new Uint8Array(await readFile(path.join(root, "target.bin"))), unchanged)
    assert.deepEqual(new Uint8Array(await readFile(path.join(root, "stage.bin"))), unchanged)
    await assert.rejects(readFile(path.join(root, "stage.bin.target-backup")), { code: "ENOENT" })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("D3 staged commit refuses a corrupted stage before creating a previously absent target", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v4-stage-preflight-new-"))
  try {
    const io = createV4PlatformIo({ platform: "desktop", desktopRootPath: root, resolveDesktopPath: logical => path.join(root, logical) })
    await writeFile(path.join(root, "stage.bin"), unchanged)
    const mismatchedStageHash = await sha256Hex(added)
    await assert.rejects(() => io.commitStage("stage.bin", "new.bin", {
      expectedTarget: { exists: false }, expectedStageSize: unchanged.byteLength, expectedStageSha256: mismatchedStageHash,
    }), /hash|stage|mismatch|corrupt/i)
    assert.deepEqual(new Uint8Array(await readFile(path.join(root, "stage.bin"))), unchanged)
    await assert.rejects(readFile(path.join(root, "new.bin")), { code: "ENOENT" })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("D3 desktop whole-file read refuses a junction escape even when the adapter has readBinary", async t => {
  await withOutsideDirectoryLink(t, async ({ external, io }) => {
    await writeFile(path.join(external, "private.bin"), unchanged)
    await assert.rejects(() => io.readWhole("linked/private.bin"), /symlink|junction|vault|outside|unsafe|review/i)
    assert.deepEqual(new Uint8Array(await readFile(path.join(external, "private.bin"))), unchanged)
  })
})

test("D12: a parent junction appearing after async preflight cannot redirect staged commit outside the vault", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v4-stage-path-swap-"))
  const external = await mkdtemp(path.join(os.tmpdir(), "v4-stage-path-outside-"))
  try {
    const folder = path.join(root, "notes")
    const savedFolder = path.join(root, "saved-notes")
    await mkdir(folder)
    await writeFile(path.join(folder, "note.md"), unchanged)
    await writeFile(path.join(root, "stage.bin"), added)
    try {
      await symlink(external, path.join(root, "link-probe"), process.platform === "win32" ? "junction" : "dir")
      await rm(path.join(root, "link-probe"))
    } catch (error) {
      if (["EPERM", "EACCES", "ENOSYS"].includes((error as { code?: string }).code ?? "")) {
        t.skip("Directory links unavailable on this host")
        return
      }
      throw error
    }
    const io = createV4PlatformIo({
      platform: "desktop", desktopRootPath: root, resolveDesktopPath: logical => path.join(root, logical),
    })
    const before = await stat(path.join(folder, "note.md"))
    const originalHash = await sha256Hex(unchanged)
    const candidateHash = await sha256Hex(added)
    let guards = 0
    await assert.rejects(() => io.commitStage("stage.bin", "notes/note.md", {
      expectedTarget: { exists: true, size: unchanged.byteLength, mtime: Math.round(before.mtimeMs), hash: originalHash },
      expectedStageSize: added.byteLength, expectedStageSha256: candidateHash,
      assertNoOpenEditor: () => {
        if (++guards !== 2) return
        renameSync(folder, savedFolder)
        symlinkSync(external, folder, process.platform === "win32" ? "junction" : "dir")
      },
    }), /symlink|junction|vault|unsafe|review/i)
    assert.equal(guards, 2)
    await assert.rejects(readFile(path.join(savedFolder, "note.md")), { code: "ENOENT" })
    await assert.rejects(readFile(path.join(external, "note.md")), { code: "ENOENT" })
    assert.deepEqual(new Uint8Array(await readFile(path.join(root, "stage.bin"))), added)
    assert.deepEqual(new Uint8Array(await readFile(path.join(root, "stage.bin.target-backup"))), unchanged)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(external, { recursive: true, force: true })
  }
})

test("D12: rollback refuses a junction installed immediately before restoring the original", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v4-rollback-path-swap-"))
  const external = await mkdtemp(path.join(os.tmpdir(), "v4-rollback-path-outside-"))
  try {
    const folder = path.join(root, "notes")
    const parked = path.join(root, "saved-notes")
    await mkdir(folder)
    await writeFile(path.join(folder, "note.md"), added)
    await writeFile(path.join(root, "stage.bin.target-backup"), unchanged)
    await writeFile(path.join(external, "note.md"), new Uint8Array([42, 43, 44]))
    try {
      await symlink(external, path.join(root, "link-probe"), process.platform === "win32" ? "junction" : "dir")
      await rm(path.join(root, "link-probe"))
    } catch (error) {
      if (["EPERM", "EACCES", "ENOSYS"].includes((error as { code?: string }).code ?? "")) {
        t.skip("Directory links unavailable on this host")
        return
      }
      throw error
    }
    const io = createV4PlatformIo({
      platform: "desktop", desktopRootPath: root, resolveDesktopPath: logical => path.join(root, logical),
    })
    const originalHash = await sha256Hex(unchanged)
    const stagedHash = await sha256Hex(added)
    let guardAlreadySwapped = false
    await assert.rejects(() => io.rollbackStage("stage.bin", "notes/note.md", {
      expectedTarget: { exists: true, size: unchanged.byteLength, hash: originalHash },
      expectedStageSize: added.byteLength, expectedStageSha256: stagedHash,
      assertNoOpenEditor: () => {
        if (guardAlreadySwapped) return
        guardAlreadySwapped = true
        renameSync(folder, parked)
        symlinkSync(external, folder, process.platform === "win32" ? "junction" : "dir")
      },
    }), /symlink|junction|vault|unsafe|review/i)
    assert.deepEqual(new Uint8Array(await readFile(path.join(external, "note.md"))), new Uint8Array([42, 43, 44]))
    assert.deepEqual(new Uint8Array(await readFile(path.join(parked, "note.md"))), added)
    assert.deepEqual(new Uint8Array(await readFile(path.join(root, "stage.bin.target-backup"))), unchanged)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(external, { recursive: true, force: true })
  }
})

test("D15: finalizeStage refuses a late parent junction before deleting a verified original backup", async t => {
  const scratch = path.join(process.cwd(), ".tmp")
  await mkdir(scratch, { recursive: true })
  const root = await mkdtemp(path.join(scratch, "d15-finalize-root-"))
  const external = await mkdtemp(path.join(scratch, "d15-finalize-external-"))
  const promisedFs = createRequire(import.meta.url)("node:fs/promises") as typeof import("node:fs/promises")
  const originalStat = promisedFs.stat
  const folder = path.join(root, "notes")
  const parked = path.join(root, "parked-notes")
  const target = path.join(folder, "note.md")
  const backup = path.join(folder, "stage.bin.target-backup")
  const outsideBackup = path.join(external, "stage.bin.target-backup")
  let targetStats = 0
  let swapped = false
  try {
    await mkdir(folder)
    await writeFile(target, added)
    await writeFile(backup, unchanged)
    await writeFile(outsideBackup, new Uint8Array([42, 43, 44]))
    try {
      const probe = path.join(root, "link-probe")
      await symlink(external, probe, process.platform === "win32" ? "junction" : "dir")
      await rm(probe)
    } catch (error) {
      if (["EPERM", "EACCES", "ENOSYS"].includes((error as { code?: string }).code ?? "")) {
        t.skip("Directory junctions/symlinks unavailable")
        return
      }
      throw error
    }
    const io = createV4PlatformIo({
      platform: "desktop", desktopRootPath: root,
      resolveDesktopPath: logical => path.join(root, logical),
    })
    const originalHash = await sha256Hex(unchanged)
    const stageHash = await sha256Hex(added)
    promisedFs.stat = (async (...args: Parameters<typeof originalStat>) => {
      const result = await originalStat(...args)
      if (String(args[0]) === target && ++targetStats === 3) {
        // Last async stat in the target hash verification. Before cleanup,
        // another process replaces the proven directory with a junction.
        renameSync(folder, parked)
        symlinkSync(external, folder, process.platform === "win32" ? "junction" : "dir")
        swapped = true
      }
      return result
    }) as typeof originalStat
    syncBuiltinESMExports()
    let finalizationError: unknown
    try {
      await io.finalizeStage("notes/stage.bin", "notes/note.md", {
        expectedTarget: { exists: true, size: unchanged.byteLength, hash: originalHash },
        expectedStageSize: added.byteLength, expectedStageSha256: stageHash,
      })
    } catch (error) { finalizationError = error }
    assert.equal(swapped, true, `the external directory swap must occur (target stats: ${targetStats})`)
    assert.match(String(finalizationError), /symlink|junction|unsafe|review/i)
    assert.deepEqual(new Uint8Array(await readFile(outsideBackup)), new Uint8Array([42, 43, 44]))
    assert.deepEqual(new Uint8Array(await readFile(path.join(parked, "stage.bin.target-backup"))), unchanged)
  } finally {
    promisedFs.stat = originalStat
    syncBuiltinESMExports()
    await rm(root, { recursive: true, force: true })
    await rm(external, { recursive: true, force: true })
  }
})

test("D15: rollback residue cleanup refuses a junction installed after its last original-content proof", async t => {
  const scratch = path.join(process.cwd(), ".tmp")
  await mkdir(scratch, { recursive: true })
  const root = await mkdtemp(path.join(scratch, "d15-rollback-root-"))
  const external = await mkdtemp(path.join(scratch, "d15-rollback-external-"))
  const promisedFs = createRequire(import.meta.url)("node:fs/promises") as typeof import("node:fs/promises")
  const originalStat = promisedFs.stat
  const folder = path.join(root, "notes")
  const parked = path.join(root, "parked-notes")
  const target = path.join(folder, "note.md")
  const residue = path.join(folder, "stage.bin.replacement-residue")
  const outsideResidue = path.join(external, "stage.bin.replacement-residue")
  let targetStats = 0
  let swapped = false
  try {
    await mkdir(folder)
    await writeFile(target, unchanged)
    await writeFile(residue, added)
    await writeFile(outsideResidue, new Uint8Array([42, 43, 44]))
    try {
      const probe = path.join(root, "link-probe")
      await symlink(external, probe, process.platform === "win32" ? "junction" : "dir")
      await rm(probe)
    } catch (error) {
      if (["EPERM", "EACCES", "ENOSYS"].includes((error as { code?: string }).code ?? "")) {
        t.skip("Directory junctions/symlinks unavailable")
        return
      }
      throw error
    }
    const io = createV4PlatformIo({
      platform: "desktop", desktopRootPath: root,
      resolveDesktopPath: logical => path.join(root, logical),
    })
    const originalHash = await sha256Hex(unchanged)
    const stageHash = await sha256Hex(added)
    promisedFs.stat = (async (...args: Parameters<typeof originalStat>) => {
      const result = await originalStat(...args)
      if (String(args[0]) === target && ++targetStats === 8) {
        // There is no original-backup left: recovery has proof of restored
        // target and verified candidate residue. The last proof yields.
        renameSync(folder, parked)
        symlinkSync(external, folder, process.platform === "win32" ? "junction" : "dir")
        swapped = true
      }
      return result
    }) as typeof originalStat
    syncBuiltinESMExports()
    let rollbackError: unknown
    try {
      await io.rollbackStage("notes/stage.bin", "notes/note.md", {
        expectedTarget: { exists: true, size: unchanged.byteLength, hash: originalHash },
        expectedStageSize: added.byteLength, expectedStageSha256: stageHash,
      })
    } catch (error) { rollbackError = error }
    assert.equal(swapped, true, `late swap must occur (target stats: ${targetStats}; rollback error: ${String(rollbackError)})`)
    assert.match(String(rollbackError), /symlink|junction|unsafe|review/i)
    assert.deepEqual(new Uint8Array(await readFile(outsideResidue)), new Uint8Array([42, 43, 44]))
    assert.deepEqual(new Uint8Array(await readFile(path.join(parked, "stage.bin.replacement-residue"))), added)
    assert.deepEqual(new Uint8Array(await readFile(path.join(parked, "note.md"))), unchanged)
  } finally {
    promisedFs.stat = originalStat
    syncBuiltinESMExports()
    await rm(root, { recursive: true, force: true })
    await rm(external, { recursive: true, force: true })
  }
})

test("D3 direct staged-file symlink cannot be overwritten, appended, read, or removed", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v4-staged-file-link-"))
  const external = await mkdtemp(path.join(os.tmpdir(), "v4-staged-file-outside-"))
  try {
    const target = path.join(external, "user.bin")
    const link = path.join(root, "stage.bin")
    await writeFile(target, unchanged)
    try { await symlink(target, link, "file") }
    catch (error) {
      if (["EPERM", "EACCES", "ENOSYS"].includes((error as { code?: string }).code ?? "")) { t.skip("File symlink unavailable"); return }
      throw error
    }
    const io = createV4PlatformIo({ platform: "desktop", desktopRootPath: root, resolveDesktopPath: logical => path.join(root, logical) })
    await assert.rejects(() => io.writeStage("stage.bin", added), /symlink|junction|vault|outside|unsafe|review/i)
    await assert.rejects(() => io.appendStage("stage.bin", added), /symlink|junction|vault|outside|unsafe|review/i)
    await assert.rejects(() => io.readWhole("stage.bin"), /symlink|junction|vault|outside|unsafe|review/i)
    await assert.rejects(() => io.removeStage("stage.bin"), /symlink|junction|vault|outside|unsafe|review/i)
    assert.deepEqual(new Uint8Array(await readFile(target)), unchanged)
  } finally { await rm(root, { recursive: true, force: true }); await rm(external, { recursive: true, force: true }) }
})
