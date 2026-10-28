import assert from "node:assert/strict"
import test from "node:test"
import { mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  assessV4ReencryptionCutoverDurability,
} from "../../src/lib/v4/reencryption-cutover-durability-readiness"

/**
 * A real Node filesystem observation on a disposable Windows directory.
 * Even a successful directory sync would not certify Obsidian saveData,
 * SecretStorage, cross-surface commit or actual power-loss survival.
 */
test("D140 Windows: real directory-sync probe cannot grant crash-safe local cutover", {
  skip: process.platform !== "win32",
}, async () => {
  const scratch = join(process.cwd(), ".tmp")
  await mkdir(scratch, { recursive: true })
  const root = await mkdtemp(join(scratch, "d140-durability-"))
  let directorySync: "supported" | "unsupported" = "unsupported"
  try {
    const filePath = join(root, "sentinel.json")
    await writeFile(filePath, '{"phase":"prepared-uncommitted"}', "utf8")
    const fileHandle = await open(filePath, "r+")
    try { await fileHandle.sync() } finally { await fileHandle.close() }
    let directoryHandle: Awaited<ReturnType<typeof open>> | undefined
    try {
      directoryHandle = await open(root, "r")
      await directoryHandle.sync()
      directorySync = "supported"
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (!["EPERM", "EACCES", "EINVAL", "ENOTSUP", "EISDIR"].includes(code ?? "")) throw error
    } finally {
      await directoryHandle?.close()
    }
    const report = assessV4ReencryptionCutoverDurability({
      platform: "windows-desktop",
      evidence: [{
        requirement: "encrypted-wal-and-parent-directories",
        platform: "windows-desktop",
        level: "process-restart-only",
        mechanism: "Node directory sync probe " + directorySync + "; no hardware power-loss test",
      }],
    })
    assert.equal(report.platform, "windows-desktop")
    assert.equal(report.state, "proofs-missing")
    assert.equal(report.requirements[0]?.diagnostic, "process-only")
    assert.equal(report.requirements[3]?.diagnostic, "missing")
    assert.equal(report.requirements[4]?.diagnostic, "missing")
    assert.equal(report.requirements[6]?.diagnostic, "missing")
    assert.equal(report.localCutoverAuthorized, false)
    assert.equal(report.resumeSyncAuthorized, false)
    assert.equal(report.oldPassphraseCleanupAuthorized, false)
    console.log("D140 Windows Node directory-sync capability: " + directorySync +
      " (NOT proof of power-loss durability)")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
