import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import test from "node:test"
import { mkdir, mkdtemp, open, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import {
  acquireV4DesktopRekeyWalStorage, V4DesktopRekeyWalLockError,
} from "../../src/lib/v4/reencryption-desktop-wal"
import {
  authenticateV4ReencryptionSeparatedSelectorTestVector,
  sealV4ReencryptionSeparatedSelectorTestVector,
} from "../../src/lib/v4/reencryption-separated-selector-prototype"
import type { V4ReencryptionProposedCommitIdentity } from "../../src/lib/v4/reencryption-proposed-commit-receipt"

const identity: V4ReencryptionProposedCommitIdentity = {
  runId: "d150_foreign_writer", walGeneration: 45, indexRoot: "private/index-v4",
  deviceId: "device150", sourceRepoId: "owner/vault#main",
  backupRepoId: "owner/vault#backup/rekey", destinationRepoId: "owner/vault#rekey/2026",
  sourceCommitSha: "a".repeat(40), sourceTreeSha: "c".repeat(40),
  destinationCommitSha: "b".repeat(40), destinationTreeSha: "d".repeat(40),
  manifestSha256: "e".repeat(64), sourcePassphraseSecretId: "old-id",
  destinationPassphraseSecretId: "new-id",
}
const key = new Uint8Array(32).fill(81)

test("D150 real Windows WAL exclusive lease blocks cooperating writer but cannot fence foreign fixed-slot OS writer", {
  skip: process.platform !== "win32", timeout: 90000,
}, async t => {
  const scratch = join(process.cwd(), ".tmp")
  await mkdir(scratch, { recursive: true })
  const root = await mkdtemp(join(scratch, "d150-foreign-writer-"))
  const journalRoot = "rekey/selector"
  const worker = join(process.cwd(),
    "tests/recovery/support/reencryption-fixed-slot-process-kill-child.mjs")
  const vector = await sealV4ReencryptionSeparatedSelectorTestVector(identity, key)
  try {
    for (const [target, phase, expected] of [
      ["slot-1.json", "after-open", "authenticated-uncommitted"],
      ["slot-1.json", "after-partial", "manual-recovery-required"],
      ["slot-1.json", "after-full", "manual-recovery-required"],
      ["slot-0.json", "after-truncate", "manual-recovery-required"],
    ] as const) {
      const caseRoot = join(root, target + "-" + phase)
      await mkdir(caseRoot)
      let lease: Awaited<ReturnType<typeof acquireV4DesktopRekeyWalStorage>> | undefined
      try {
        lease = await acquireV4DesktopRekeyWalStorage({
          rootAbsolute: caseRoot, journalRoot,
        })
        const walDir = join(caseRoot, "rekey", "selector")
        const firstSlot = join(walDir, "slot-0.json")
        const secondSlot = join(walDir, "slot-1.json")
        // Provision ONLY disposable test files. These directory entries have
        // NOT been qualified as power-loss durable by Node on Windows.
        for (const [name, bytes] of [[firstSlot, vector], [secondSlot, ""]] as const) {
          const handle = await open(name, "wx+")
          try {
            await handle.writeFile(bytes, "utf8")
            await handle.sync()
          } finally { await handle.close() }
        }
        // A second COOPERATING writer refuses to claim the lock.
        await assert.rejects(
          () => acquireV4DesktopRekeyWalStorage({
            rootAbsolute: caseRoot, journalRoot,
          }),
          V4DesktopRekeyWalLockError,
        )
        await lease.assertExclusiveStageLease()
        const heldToken = await readFile(lease.lockPath, "utf8")
        assert.ok(heldToken.length > 0)
        // A non-cooperating real Node process can modify the same candidate
        // path while the lease is held, without consulting .exclusive.lock.
        const child = spawnSync(process.execPath,
          [worker, walDir, target, phase, vector],
          { cwd: process.cwd(), encoding: "utf8", timeout: 15000, windowsHide: true })
        if (child.error) throw child.error
        assert.notEqual(child.status, 0, "foreign writer must reach intentional SIGKILL")
        assert.equal(child.stderr, "", "the child must not fail due to a sharing violation")
        assert.equal(await readFile(join(walDir, "reached-phase.txt"), "utf8"), phase)
        assert.equal(await readFile(lease.lockPath, "utf8"), heldToken)
        await lease.assertExclusiveStageLease() // token remains valid; not an editor fence
        const observed = await Promise.all([firstSlot, secondSlot].map(name => readFile(name, "utf8")))
        const populated = observed.filter(value => value.length > 0)
        const outcome = populated.length === 1
          && await authenticateV4ReencryptionSeparatedSelectorTestVector(
            populated[0]!, identity, key)
          ? "authenticated-uncommitted" : "manual-recovery-required"
        assert.equal(outcome, expected,
          "a foreign writer cannot make damaged/ambiguous evidence look like a committed cutover")
        if (phase === "after-partial") {
          assert.equal(observed[1], vector.slice(0, 17),
            "foreign writer actually damaged the spare slot under a held lease")
        }
        // Even with correct bytes, physical directory fsync and global editor
        // fencing are not certified. A reported successful directory sync
        // would still need power-cut/cross-store qualification.
        let directorySyncReported = false
        try { await lease.assertCrashDurable(); directorySyncReported = true }
        catch (error) { assert.match(String(error), /fsync|durability/i) }
        t.diagnostic(`D150 ${target}/${phase}: foreign writer accessed leased journal; ${outcome}; directory fsync ${directorySyncReported ? "reported supported" : "refused"}; NO cutover`)
      } finally {
        await lease?.release()
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
