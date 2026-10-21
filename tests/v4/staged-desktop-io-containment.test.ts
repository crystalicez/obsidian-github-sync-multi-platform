import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
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
