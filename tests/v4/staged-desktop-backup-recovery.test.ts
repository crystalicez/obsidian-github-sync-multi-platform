import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { sha256Hex } from "../../src/lib/bytes"
import { createV4PlatformIo } from "../../src/lib/v4/platform-io"

const original = new Uint8Array([1, 2, 3])
const replacement = new Uint8Array([9, 8, 7, 6])
const edited = new Uint8Array([4, 4, 4, 4, 4])

async function fixture(run: (ctx: {
  io: ReturnType<typeof createV4PlatformIo>
  stage: string; target: string; backup: string
  expected: { expectedTarget: { exists: boolean; size: number }; expectedStageSize: number; expectedStageSha256: string }
}) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "v4-safe-recovery-"))
  const stage = path.join(root, "stage.bin")
  const target = path.join(root, "target.bin")
  const backup = stage + ".target-backup"
  const io = createV4PlatformIo({ platform: "desktop", resolveDesktopPath: value => value, desktopRootPath: root })
  const expected = { expectedTarget: { exists: true, size: original.byteLength, hash: await sha256Hex(original) }, expectedStageSize: replacement.byteLength, expectedStageSha256: await sha256Hex(replacement) }
  try { await run({ io, stage, target, backup, expected }) }
  finally { await rm(root, { recursive: true, force: true }) }
}

async function exists(path: string) { try { await stat(path); return true } catch (err) { if ((err as { code?: string }).code === "ENOENT") return false; throw err } }

test("D2: crash after original moved to private backup restores original without changing staged payload", async () => fixture(async ({ io, stage, target, backup, expected }) => {
  await writeFile(stage, replacement)
  await writeFile(backup, original)
  await io.rollbackStage(stage, target, expected)
  assert.deepEqual(new Uint8Array(await readFile(target)), original)
  assert.deepEqual(new Uint8Array(await readFile(stage)), replacement)
  assert.equal(await exists(backup), false)
}))

test("D2: crashed replacement is rolled back only when target has the exact expected staged SHA", async () => fixture(async ({ io, stage, target, backup, expected }) => {
  await writeFile(target, replacement)
  await writeFile(backup, original)
  await io.rollbackStage(stage, target, expected)
  assert.deepEqual(new Uint8Array(await readFile(target)), original)
  assert.equal(await exists(backup), false)
}))

test("D2: a post-crash user edit leaves original backup and user target byte-for-byte unchanged", async () => fixture(async ({ io, stage, target, backup, expected }) => {
  await writeFile(stage, replacement)
  await writeFile(backup, original)
  await writeFile(target, edited)
  await assert.rejects(() => io.rollbackStage(stage, target, expected), /manual|intervention|ambiguous|unsafe/i)
  assert.deepEqual(new Uint8Array(await readFile(target)), edited)
  assert.deepEqual(new Uint8Array(await readFile(backup)), original)
  assert.deepEqual(new Uint8Array(await readFile(stage)), replacement)
}))

test("D2: mismatched backup cannot be automatically restored, and stage remains intact", async () => fixture(async ({ io, stage, target, backup, expected }) => {
  await writeFile(stage, replacement)
  await writeFile(backup, edited)
  await assert.rejects(() => io.rollbackStage(stage, target, expected), /manual|intervention|ambiguous|unsafe/i)
  assert.equal(await exists(target), false)
  assert.deepEqual(new Uint8Array(await readFile(backup)), edited)
  assert.deepEqual(new Uint8Array(await readFile(stage)), replacement)
}))

test("D2: new commit never removes an unverified orphaned backup", async () => fixture(async ({ io, stage, target, backup, expected }) => {
  await writeFile(stage, replacement)
  await writeFile(target, original)
  await writeFile(backup, edited)
  await assert.rejects(() => io.commitStage(stage, target, expected), /manual|intervention|ambiguous|unsafe/i)
  assert.deepEqual(new Uint8Array(await readFile(target)), original)
  assert.deepEqual(new Uint8Array(await readFile(backup)), edited)
  assert.deepEqual(new Uint8Array(await readFile(stage)), replacement)
}))

test("D2: lost receipt after successful staged rename clears backup only with verified target and original", async () => fixture(async ({ io, stage, target, backup, expected }) => {
  await writeFile(target, replacement)
  await writeFile(backup, original)
  await io.finalizeStage(stage, target, expected)
  assert.deepEqual(new Uint8Array(await readFile(target)), replacement)
  assert.equal(await exists(backup), false)
}))

test("D2: finalization refuses ambiguous target and retains the recovery backup", async () => fixture(async ({ io, stage, target, backup, expected }) => {
  await writeFile(target, edited)
  await writeFile(backup, original)
  await assert.rejects(() => io.finalizeStage(stage, target, expected), /manual|intervention|ambiguous|unsafe/i)
  assert.deepEqual(new Uint8Array(await readFile(target)), edited)
  assert.deepEqual(new Uint8Array(await readFile(backup)), original)
}))

test("D2: a legacy WAL without original SHA never authorizes automatic backup restore", async () => fixture(async ({ io, stage, target, backup, expected }) => {
  await writeFile(stage, replacement)
  await writeFile(backup, original)
  const legacy = { ...expected, expectedTarget: { exists: true, size: original.byteLength } }
  await assert.rejects(() => io.rollbackStage(stage, target, legacy), /review|manual|evidence/i)
  assert.equal(await exists(target), false)
  assert.deepEqual(new Uint8Array(await readFile(backup)), original)
}))

test("D2: target edit retaining the same byte length cannot pass the stored original SHA", async () => fixture(async ({ io, stage, target, expected }) => {
  await writeFile(stage, replacement)
  await writeFile(target, new Uint8Array([3, 2, 1]))
  await assert.rejects(() => io.commitStage(stage, target, expected), /review|manual|hash/i)
  assert.deepEqual(new Uint8Array(await readFile(target)), new Uint8Array([3, 2, 1]))
  assert.deepEqual(new Uint8Array(await readFile(stage)), replacement)
}))

test("D2: a symlinked recovery backup is never read or restored automatically", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v4-safe-backup-link-"))
  const outside = await mkdtemp(path.join(os.tmpdir(), "v4-safe-backup-external-"))
  try {
    const linked = path.join(root, "stage.bin.target-backup")
    const foreign = path.join(outside, "foreign.bin")
    await writeFile(foreign, original)
    try { await symlink(foreign, linked) }
    catch (err) {
      if (["EPERM", "EACCES", "ENOSYS"].includes((err as { code?: string }).code ?? "")) { t.skip("symlink permission unavailable"); return }
      throw err
    }
    const io = createV4PlatformIo({ platform: "desktop", resolveDesktopPath: v => v, desktopRootPath: root })
    const originalHash = await sha256Hex(original)
    const stagedHash = await sha256Hex(replacement)
    await assert.rejects(() => io.rollbackStage(path.join(root, "stage.bin"), path.join(root, "target.bin"), {
      expectedTarget: { exists: true, size: original.byteLength, hash: originalHash },
      expectedStageSize: replacement.byteLength, expectedStageSha256: stagedHash,
    }), /symlink|junction|review|manual/i)
    assert.deepEqual(new Uint8Array(await readFile(foreign)), original)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test("D2: second crash during rollback restores backup and safely removes verified parked replacement", async () => fixture(async ({ io, stage, target, backup, expected }) => {
  const parked = stage + ".replacement-residue"
  await writeFile(backup, original)
  await writeFile(parked, replacement)
  await io.rollbackStage(stage, target, expected)
  assert.deepEqual(new Uint8Array(await readFile(target)), original)
  assert.equal(await exists(backup), false)
  assert.equal(await exists(parked), false)
}))

test("D2: an unrelated rollback residue is never removed or mistaken for staged content", async () => fixture(async ({ io, stage, target, backup, expected }) => {
  const parked = stage + ".replacement-residue"
  await writeFile(backup, original)
  await writeFile(parked, edited)
  await assert.rejects(() => io.rollbackStage(stage, target, expected), /review|manual|unverified/i)
  assert.deepEqual(new Uint8Array(await readFile(backup)), original)
  assert.deepEqual(new Uint8Array(await readFile(parked)), edited)
  assert.equal(await exists(target), false)
}))

test("D2: residue without original backup is a manual-review state, never silently finalized or discarded", async () => fixture(async ({ io, stage, target, expected }) => {
  const parked = stage + ".replacement-residue"
  await writeFile(parked, replacement)
  await assert.rejects(() => io.rollbackStage(stage, target, expected), /review|manual|residue/i)
  await assert.rejects(() => io.finalizeStage(stage, target, expected), /review|manual|residue/i)
  assert.deepEqual(new Uint8Array(await readFile(parked)), replacement)
  assert.equal(await exists(target), false)
}))

test("D2: staged commit refuses a linked target folder outside the configured vault root", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v4-commit-guard-"))
  const external = await mkdtemp(path.join(os.tmpdir(), "v4-commit-external-"))
  try {
    const linkedFolder = path.join(root, "linked")
    try { await symlink(external, linkedFolder, process.platform === "win32" ? "junction" : "dir") }
    catch (err) {
      if (["EPERM", "EACCES", "ENOSYS"].includes((err as { code?: string }).code ?? "")) { t.skip("directory link permission unavailable"); return }
      throw err
    }
    const stage = path.join(root, "stage.bin")
    const target = path.join(linkedFolder, "target.bin")
    await writeFile(stage, replacement)
    await writeFile(path.join(external, "target.bin"), original)
    const io = createV4PlatformIo({ platform: "desktop", resolveDesktopPath: v => v, desktopRootPath: root })
    const originalHash = await sha256Hex(original)
    const stagedHash = await sha256Hex(replacement)
    await assert.rejects(() => io.commitStage(stage, target, {
      expectedTarget: { exists: true, size: original.byteLength, hash: originalHash },
      expectedStageSize: replacement.byteLength, expectedStageSha256: stagedHash,
    }), /symlink|junction|review|manual/i)
    assert.deepEqual(new Uint8Array(await readFile(path.join(external, "target.bin"))), original)
    assert.deepEqual(new Uint8Array(await readFile(stage)), replacement)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(external, { recursive: true, force: true })
  }
})
