import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import test from "node:test"
import { lstat, mkdir, mkdtemp, open, readFile, readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import {
  authenticateV4ReencryptionSeparatedSelectorTestVector,
  sealV4ReencryptionSeparatedSelectorTestVector,
} from "../../src/lib/v4/reencryption-separated-selector-prototype"
import type { V4ReencryptionProposedCommitIdentity } from "../../src/lib/v4/reencryption-proposed-commit-receipt"

const identity: V4ReencryptionProposedCommitIdentity = {
  runId: "d149_process_kill", walGeneration: 44, indexRoot: "private/index-v4",
  deviceId: "device149", sourceRepoId: "owner/vault#main",
  backupRepoId: "owner/vault#backup/rekey", destinationRepoId: "owner/vault#rekey/2026",
  sourceCommitSha: "a".repeat(40), sourceTreeSha: "c".repeat(40),
  destinationCommitSha: "b".repeat(40), destinationTreeSha: "d".repeat(40),
  manifestSha256: "e".repeat(64), sourcePassphraseSecretId: "old-id",
  destinationPassphraseSecretId: "new-id",
}
const key = new Uint8Array(32).fill(54)
const phases = ["before-open", "after-open", "after-truncate", "after-partial",
  "after-full", "after-sync"] as const

/**
 * Read-only, test-local classification. Authentication only means an exact
 * in-memory expected ciphertext; no write durability or cutover authority.
 * A corrupt second slot cannot be ignored even if the first is authentic.
 */
async function inspect(paths: readonly [string, string]):
  Promise<"authenticated-uncommitted" | "manual-recovery-required"> {
  const values: string[] = []
  for (const filename of paths) {
    try {
      const info = await lstat(filename)
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1
        || info.size > 8192) return "manual-recovery-required"
      values.push(await readFile(filename, "utf8"))
    } catch { return "manual-recovery-required" }
  }
  const nonempty = values.filter(Boolean)
  if (nonempty.length !== 1) return "manual-recovery-required"
  return await authenticateV4ReencryptionSeparatedSelectorTestVector(nonempty[0]!, identity, key)
    ? "authenticated-uncommitted" : "manual-recovery-required"
}

test("D149 independent Windows process SIGKILL at 12 O_DSYNC fixed-selector write boundaries cannot grant cutover", {
  skip: process.platform !== "win32",
  timeout: 120000,
}, async t => {
  const scratch = join(process.cwd(), ".tmp")
  await mkdir(scratch, { recursive: true })
  const root = await mkdtemp(join(scratch, "d149-process-killed-selector-"))
  const worker = join(process.cwd(), "tests/recovery/support/reencryption-fixed-slot-process-kill-child.mjs")
  const encrypted = await sealV4ReencryptionSeparatedSelectorTestVector(identity, key)
  try {
    for (const slot of ["slot-b.bin", "slot-a.bin"] as const) {
      for (const phase of phases) {
        const caseRoot = join(root, slot + "-" + phase)
        await mkdir(caseRoot)
        const paths = [join(caseRoot, "slot-a.bin"), join(caseRoot, "slot-b.bin")] as const
        for (let i = 0; i < paths.length; i++) {
          const handle = await open(paths[i]!, "wx+")
          try {
            if (i === 0) await handle.writeFile(encrypted, "utf8")
            await handle.sync()
          } finally { await handle.close() }
        }
        assert.equal(await inspect(paths), "authenticated-uncommitted")
        const initialFiles = await Promise.all(paths.map(name => lstat(name)))
        const result = spawnSync(process.execPath, [
          worker, caseRoot, slot, phase, encrypted,
        ], { cwd: process.cwd(), encoding: "utf8", windowsHide: true, timeout: 15000 })
        if (result.error) throw result.error
        assert.notEqual(result.status, 0, `${slot}/${phase}: child did not terminate abnormally`)
        assert.equal(result.stderr, "", `${slot}/${phase}: child threw instead of SIGKILL`)
        assert.equal(await readFile(join(caseRoot, "reached-phase.txt"), "utf8"), phase,
          `${slot}/${phase}: killed process never completed checkpoint`)
        assert.deepEqual((await readdir(caseRoot)).sort(),
          ["reached-phase.txt", "slot-a.bin", "slot-b.bin"],
          "fixed-file scheme must not create or rename extra slots during commit")
        const finalFiles = await Promise.all(paths.map(name => lstat(name)))
        for (let i = 0; i < paths.length; i++) {
          assert.equal(finalFiles[i]!.ino, initialFiles[i]!.ino,
            `${slot}/${phase}: in-place mutation must not silently replace the file`)
        }
        const report = await inspect(paths)
        // Updating the spare slot leaves a correct old record at earliest
        // stages, but it can never prove that a proposed new write did NOT
        // begin. That observation must never authorize an automatic cutover.
        const expected = slot === "slot-b.bin"
          ? (phase === "after-partial" || phase === "after-full" || phase === "after-sync"
            ? "manual-recovery-required" : "authenticated-uncommitted")
          : (phase === "after-truncate" || phase === "after-partial"
            ? "manual-recovery-required" : "authenticated-uncommitted")
        assert.equal(report, expected,
          `${slot}/${phase}: process-killed data classified with unsupported authority`)
        if (phase === "after-full" && slot === "slot-a.bin") {
          assert.equal(await readFile(paths[0], "utf8"), encrypted,
            "complete authenticated bytes may be visible even before explicit FileHandle.sync")
        }
        t.diagnostic(`D149 SIGKILL ${slot}/${phase}: ${report} (NOT power-loss proof)`)
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
