import assert from "node:assert/strict"
import test from "node:test"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { acquireV4DesktopRekeyWalStorage, V4DesktopRekeyWalLockError } from "../../src/lib/v4/reencryption-desktop-wal"
import { sealV4ReencryptionSeparatedSelectorTestVector } from "../../src/lib/v4/reencryption-separated-selector-prototype"
import type { V4ReencryptionProposedCommitIdentity } from "../../src/lib/v4/reencryption-proposed-commit-receipt"

/**
 * Real filesystem experiment, NOT a production Selector writer or a sudden
 * power-loss qualification. Reuses the strict existing desktop WAL lock,
 * file fsync, rename and parent-directory fsync barrier. All files are in a
 * fresh disposable .tmp directory, never an installed Obsidian vault.
 */
test("D147 encrypted Selector test vector survives new Node lease, but unproved directory durability blocks cutover", async t => {
  const scratch = join(process.cwd(), ".tmp")
  await mkdir(scratch, { recursive: true })
  const disposable = await mkdtemp(join(scratch, "d147-selector-durability-"))
  const journalRoot = "rekey/selector"
  const slot = journalRoot + "/slot-0.json"
  const identity: V4ReencryptionProposedCommitIdentity = {
    runId: "d147_real_probe", walGeneration: 27, indexRoot: "private/index-v4",
    deviceId: "device147", sourceRepoId: "owner/vault#main",
    backupRepoId: "owner/vault#backup/rekey", destinationRepoId: "owner/vault#rekey/2026",
    sourceCommitSha: "a".repeat(40), sourceTreeSha: "c".repeat(40),
    destinationCommitSha: "b".repeat(40), destinationTreeSha: "d".repeat(40),
    manifestSha256: "e".repeat(64),
    sourcePassphraseSecretId: "secret-old", destinationPassphraseSecretId: "secret-new",
  }
  const vector = await sealV4ReencryptionSeparatedSelectorTestVector(
    identity, new Uint8Array(32).fill(73))
  let first: Awaited<ReturnType<typeof acquireV4DesktopRekeyWalStorage>> | undefined
  let second: Awaited<ReturnType<typeof acquireV4DesktopRekeyWalStorage>> | undefined
  try {
    first = await acquireV4DesktopRekeyWalStorage({
      rootAbsolute: disposable, journalRoot,
    })
    await first.adapter.write(slot, vector)
    const raw = await readFile(join(disposable, "rekey", "selector", "slot-0.json"), "utf8")
    assert.equal(raw, vector, "the test payload is actually on disk, not only in memory")
    assert.equal(await first.adapter.read(slot), vector)
    assert.ok(raw.startsWith("T0dTNA"), "sealed selector has V4 encrypted magic header")
    assert.doesNotMatch(raw, /secret-old|secret-new|owner\/vault|d147_real_probe/)
    await assert.rejects(() => acquireV4DesktopRekeyWalStorage({
      rootAbsolute: disposable, journalRoot,
    }), V4DesktopRekeyWalLockError, "OS exclusive lock must exclude a second holder")

    let firstQualified = false
    try { await first.assertCrashDurable(); firstQualified = true }
    catch (error) {
      assert.match(String(error), /fsync|durability/i)
    }
    // Windows Node on this project previously returned EPERM on directory
    // fsync. The test records the actual platform behavior; a new Node build
    // with different behavior must NOT be misreported as power-loss proof.
    t.diagnostic("D147 " + process.platform + " Node directory-sync claim after rename: "
      + (firstQualified ? "reported supported (NOT qualified by power-loss)" : "refused; cutover blocked"))
    await first.release()
    first = undefined

    second = await acquireV4DesktopRekeyWalStorage({ rootAbsolute: disposable, journalRoot })
    assert.equal(await second.adapter.read(slot), vector, "fresh OS file handle reopens sealed selector")
    assert.equal(await second.adapter.exists(slot), true)
    let reopenQualified = false
    try { await second.assertCrashDurable(); reopenQualified = true }
    catch (error) { assert.match(String(error), /fsync|durability/i) }
    t.diagnostic("D147 " + process.platform + " Node directory-sync claim after reopen: "
      + (reopenQualified ? "reported supported (NOT qualified by power-loss)" : "refused; cutover blocked"))
    if (process.platform === "win32" && !firstQualified && !reopenQualified) {
      await assert.rejects(() => second.assertCrashDurable(), /fsync|durability/i,
        "opening the same selector again must not upgrade a failed durability proof")
    }
    // Both cases are diagnostic, NOT production permission. No physical
    // power cut, SecretStorage, multi-process vault edit fence or Git ref proof.
    assert.ok(Object.isFrozen(second))
  } finally {
    if (second) await second.release()
    if (first) await first.release()
    await rm(disposable, { recursive: true, force: true })
  }
})
