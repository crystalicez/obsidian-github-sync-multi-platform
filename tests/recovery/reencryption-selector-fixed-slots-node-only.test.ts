import assert from "node:assert/strict"
import test from "node:test"
import { constants } from "node:fs"
import { lstat, mkdir, mkdtemp, open, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import {
  authenticateV4ReencryptionSeparatedSelectorTestVector,
  sealV4ReencryptionSeparatedSelectorTestVector,
} from "../../src/lib/v4/reencryption-separated-selector-prototype"
import type { V4ReencryptionProposedCommitIdentity } from "../../src/lib/v4/reencryption-proposed-commit-receipt"

const identity: V4ReencryptionProposedCommitIdentity = {
  runId: "d148_fixed_slots", walGeneration: 42, indexRoot: "private/index-v4",
  deviceId: "device148", sourceRepoId: "owner/vault#main",
  backupRepoId: "owner/vault#backup/rekey", destinationRepoId: "owner/vault#rekey/2026",
  sourceCommitSha: "a".repeat(40), sourceTreeSha: "c".repeat(40),
  destinationCommitSha: "b".repeat(40), destinationTreeSha: "d".repeat(40),
  manifestSha256: "e".repeat(64), sourcePassphraseSecretId: "old-id",
  destinationPassphraseSecretId: "new-id",
}
const key = new Uint8Array(32).fill(48)

/** Test-only no-rename write on an ALREADY EXISTING file. Not a WAL or Selector writer. */
async function overwriteFixedFile(filename: string, contents: string): Promise<void> {
  // libuv maps O_DSYNC to FILE_FLAG_WRITE_THROUGH on Windows.
  // Do not silently fall back to buffered writes if the capability is absent.
  const handle = await open(filename, constants.O_RDWR | constants.O_DSYNC)
  try {
    await handle.truncate(0)
    await handle.writeFile(contents, "utf8")
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/** A failed/missing/ambiguous candidate is manual; no fallback to the other slot. */
async function inspectFixedFiles(files: readonly [string, string],
  expected: V4ReencryptionProposedCommitIdentity,
  journalKey: Uint8Array): Promise<"authenticated-uncommitted" | "manual-recovery-required"> {
  const contents: string[] = []
  for (const filename of files) {
    try {
      const stat = await lstat(filename)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
        || stat.size > 8192) return "manual-recovery-required"
      contents.push(await readFile(filename, "utf8"))
    } catch { return "manual-recovery-required" }
  }
  const populated = contents.filter(value => value.length !== 0)
  if (populated.length !== 1) return "manual-recovery-required"
  const only = populated[0]!
  return await authenticateV4ReencryptionSeparatedSelectorTestVector(only, expected, journalKey)
    ? "authenticated-uncommitted" : "manual-recovery-required"
}

test("D148 Windows Node-only fixed pre-existing files: O_DSYNC and file sync survive reopen, but cannot certify power-loss cutover", {
  skip: process.platform !== "win32",
}, async t => {
  const scratch = join(process.cwd(), ".tmp")
  await mkdir(scratch, { recursive: true })
  const root = await mkdtemp(join(scratch, "d148-fixed-slots-"))
  const paths = [join(root, "slot-a.bin"), join(root, "slot-b.bin")] as const
  const report = "manual-recovery-required"
  try {
    // One-time provisioning is NOT proven physically durable, because its
    // new directory entries cannot be parent-fsynced via Node on Windows.
    for (const name of paths) {
      const handle = await open(name, "wx+")
      try { await handle.sync() } finally { await handle.close() }
    }
    assert.equal(await inspectFixedFiles(paths, identity, key), report)
    const sealed = await sealV4ReencryptionSeparatedSelectorTestVector(identity, key)
    await overwriteFixedFile(paths[0], sealed)
    assert.equal(await readFile(paths[0], "utf8"), sealed)
    assert.equal(await inspectFixedFiles(paths, identity, key), "authenticated-uncommitted")
    t.diagnostic("D148 " + process.platform
      + ": O_DSYNC + FileHandle.sync + fresh handle read succeeded on pre-existing file; NO power-loss proof")
    assert.equal(await inspectFixedFiles(paths, { ...identity, walGeneration: 43 }, key), report)
    assert.equal(await inspectFixedFiles(paths, identity, new Uint8Array(32).fill(49)), report)

    // This is the dangerous window: an old valid slot survives while a new
    // write starts and is interrupted. Never automatically select the old.
    await overwriteFixedFile(paths[1], sealed.slice(0, 17))
    assert.equal(await inspectFixedFiles(paths, identity, key), report)
    await overwriteFixedFile(paths[1], sealed)
    assert.equal(await inspectFixedFiles(paths, identity, key), report,
      "two valid slots require independent WAL generation/commit authority")
    await overwriteFixedFile(paths[0], "")
    assert.equal(await inspectFixedFiles(paths, identity, key), "authenticated-uncommitted")
    await overwriteFixedFile(paths[1], sealed.slice(0, -2))
    assert.equal(await inspectFixedFiles(paths, identity, key), report)
    await overwriteFixedFile(paths[1], "")
    assert.equal(await inspectFixedFiles(paths, identity, key), report)

    // Unlike the older rename WAL, the candidate never mutates the directory
    // during a transaction. That avoids a new rename-dir-sync need ONLY
    // after someone has independently established durable file provisioning.
    const directory = await open(root, "r")
    try {
      // Record the capability instead of hardcoding that every future Windows
      // Node version or filesystem must return EPERM. Even success here would
      // NOT independently qualify power-loss durability.
      try {
        await directory.sync()
        t.diagnostic("D148 directory fsync reported success; NOT power-loss qualification")
      } catch (error) {
        assert.ok(["EPERM", "EACCES", "EINVAL", "ENOTSUP", "EISDIR"].includes(
          (error as NodeJS.ErrnoException).code ?? ""), String(error))
        t.diagnostic("D148 directory fsync unsupported on tested Windows filesystem")
      }
    } finally { await directory.close() }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
