import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import test from "node:test"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { join, resolve, sep } from "node:path"
import { createEmptyV4LocalIndex, saveV4LocalIndex, type V4LocalIndexAdapter } from "../../src/lib/v4/local-index"
import { planV4ReencryptionSeparatedRoots } from "../../src/lib/v4/reencryption-separated-selector"
import { inspectV4ReencryptionSeparatedSelectorAfterRestart, sealV4ReencryptionSeparatedSelectorTestVector }
  from "../../src/lib/v4/reencryption-separated-selector-prototype"
import type { V4ReencryptionProposedCommitIdentity } from "../../src/lib/v4/reencryption-proposed-commit-receipt"
import type { V4ReencryptionJournalSnapshot } from "../../src/lib/v4/reencryption-recovery-journal"

test("D146/D151 Windows reopened selector detects foreign drift but cannot fence ABA", {
  skip: process.platform !== "win32",
}, async () => {
  const scratch = join(process.cwd(), ".tmp")
  await mkdir(scratch, { recursive: true })
  const directory = await mkdtemp(join(scratch, "d146-selector-"))
  const identity: V4ReencryptionProposedCommitIdentity = {
    runId: "d146_disk_run", walGeneration: 7, indexRoot: "private/index-v4",
    deviceId: "device146", sourceRepoId: "owner/vault#main",
    backupRepoId: "owner/vault#backup/rekey", destinationRepoId: "owner/vault#rekey/2026",
    sourceCommitSha: "a".repeat(40), sourceTreeSha: "c".repeat(40),
    destinationCommitSha: "b".repeat(40), destinationTreeSha: "d".repeat(40),
    manifestSha256: "e".repeat(64), sourcePassphraseSecretId: "old-secret",
    destinationPassphraseSecretId: "new-secret",
  }
  const roots = planV4ReencryptionSeparatedRoots(identity.indexRoot, identity.runId)
  const key = new Uint8Array(32).fill(25)
  const path = (relative: string): string => {
    const full = resolve(directory, relative.replaceAll("/", sep))
    if (!full.startsWith(directory + sep)) throw new Error("outside disposable selector root")
    return full
  }
  const disk: V4LocalIndexAdapter = {
    async read(p) { return readFile(path(p), "utf8") },
    async write(p, value) { await mkdir(resolve(path(p), ".."), { recursive: true }); await writeFile(path(p), value, "utf8") },
    async mkdir(p) { await mkdir(path(p), { recursive: true }) },
    async exists(p) {
      try { await stat(path(p)); return true }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error }
    },
    async stat(p) {
      try { return { size: (await stat(path(p))).size } }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error }
    },
  }
  const wal: V4ReencryptionJournalSnapshot = {
    generation: 7, receipts: [], pendingIntents: [], pendingRefIntents: [],
    verifiedRefObservations: [
      { role: "backup", repoId: identity.backupRepoId,
        commitSha: identity.sourceCommitSha, treeSha: identity.sourceTreeSha },
      { role: "destination", repoId: identity.destinationRepoId,
        commitSha: identity.destinationCommitSha, treeSha: identity.destinationTreeSha,
        manifestSha256: identity.manifestSha256 },
    ],
    preparedCandidateReceipt: {
      commitSha: identity.destinationCommitSha, treeSha: identity.destinationTreeSha,
      manifestSha256: identity.manifestSha256,
    },
    candidatePreparationSha256: "f".repeat(64), stageHandoffStarted: true,
    requiresRemoteRevalidation: true, cutoverAuthorized: false, permissionToPublish: false,
  }
  try {
    for (const role of ["source", "destination"] as const) {
      const index = createEmptyV4LocalIndex({
        repoId: role === "source" ? identity.sourceRepoId : identity.destinationRepoId,
        deviceId: identity.deviceId, mode: "encrypted",
      })
      index.remoteCommitSha = role === "source" ? identity.sourceCommitSha : identity.destinationCommitSha
      await saveV4LocalIndex(disk, role === "source" ? roots.sourceIndexRoot : roots.shadowIndexRoot, index)
    }
    const originalSelector = await sealV4ReencryptionSeparatedSelectorTestVector(identity, key)
    const alternateSelector = await sealV4ReencryptionSeparatedSelectorTestVector(identity, key)
    assert.notEqual(originalSelector, alternateSelector,
      "independent AES-GCM nonce creates different authenticated bytes for the same identity")
    await disk.write(roots.selectorPath, originalSelector)
    const reader: V4LocalIndexAdapter = {
      read: disk.read, exists: disk.exists, stat: disk.stat,
      async write() { throw new Error("reader wrote to disk") },
      async mkdir() { throw new Error("reader created a directory") },
    }
    const settings = {
      githubOwner: "owner", githubRepo: "vault", githubBranch: "rekey/2026",
      encryptionMode: "encrypted", encryptionPassphraseSecretId: "new-secret", vault: identity.deviceId,
    }
    let oldSecret = "old-passphrase"
    let foreignMutation: "none" | "replace" | "restore" = "none"
    let walReads = 0
    const foreignWriter = join(process.cwd(),
      "tests/recovery/support/reencryption-selector-aba-child.mjs")
    const inspect = () => inspectV4ReencryptionSeparatedSelectorAfterRestart({
      identity, journalKey: key, adapter: reader, settings,
      journal: { sourceCommitSha: identity.sourceCommitSha,
        destinationRepoId: identity.destinationRepoId,
        assertHealthySnapshot: async () => {
          walReads++
          // WAL is observed between the two Selector readbacks. A REAL
          // independent OS process mutates Selector. This fixture supplies
          // no-op lease callbacks; D150 separately tested the held D86 lease.
          if (walReads === 1 && foreignMutation !== "none") {
            const child = spawnSync(process.execPath, [
              foreignWriter, path(roots.selectorPath),
              originalSelector, alternateSelector, foreignMutation,
            ], { cwd: process.cwd(), encoding: "utf8", windowsHide: true, timeout: 15000 })
            if (child.error) throw child.error
            assert.equal(child.status, 0, child.stderr)
            assert.equal(child.stdout, foreignMutation === "replace"
              ? "d151-replaced" : "d151-aba-restored")
          }
          return structuredClone(wal)
        } },
      getSecret: id => id === "old-secret" ? oldSecret : id === "new-secret" ? "new-passphrase" : null,
      withExclusiveInitiatorLease: async body => body(),
      assertExclusiveInitiatorLease: async () => {},
      assertCrashDurable: async () => {},
    })
    const before = await Promise.all([disk.read(roots.selectorPath),
      disk.read(roots.sourceIndexRoot + "/index.json"),
      disk.read(roots.shadowIndexRoot + "/index.json")])
    assert.equal((await inspect()).observation, "authenticated-selector-with-both-indices-uncommitted")
    assert.deepEqual(await Promise.all([disk.read(roots.selectorPath),
      disk.read(roots.sourceIndexRoot + "/index.json"),
      disk.read(roots.shadowIndexRoot + "/index.json")]), before)
    oldSecret = ""
    assert.equal((await inspect()).observation, "manual-recovery-required")
    oldSecret = "old-passphrase"
    await disk.write(roots.selectorPath, "torn")
    assert.equal((await inspect()).observation, "manual-recovery-required")

    // D151: a non-cooperating Node process replaces the Selector after the
    // first authenticated scan but before the second scan. Both ciphertexts
    // independently authenticate the SAME migration identity; byte drift
    // still forces manual recovery, never cutover.
    await disk.write(roots.selectorPath, originalSelector)
    walReads = 0
    foreignMutation = "replace"
    const drifted = await inspect()
    assert.equal(drifted.observation, "manual-recovery-required")
    assert.equal(await disk.read(roots.selectorPath), alternateSelector)
    assert.equal(drifted.localCutoverAuthorized, false)
    assert.equal(drifted.remoteWritesAuthorized, false)

    // More important: a separate process can swap to another fully valid
    // ciphertext and restore the original BEFORE the next reader snapshot.
    // Two equal reads cannot detect this ABA. The reader may still observe
    // valid UNCOMMITTED bytes, but must NEVER claim an exclusive editor fence.
    await disk.write(roots.selectorPath, originalSelector)
    walReads = 0
    foreignMutation = "restore"
    const aba = await inspect()
    assert.equal(aba.observation, "authenticated-selector-with-both-indices-uncommitted")
    assert.equal(await disk.read(roots.selectorPath), originalSelector)
    assert.equal(aba.localCutoverAuthorized, false)
    assert.equal(aba.resumeSyncAuthorized, false)
    assert.equal(aba.rollbackAuthorized, false)
    assert.equal(aba.remoteWritesAuthorized, false)
    assert.equal(aba.oldPassphraseCleanupAuthorized, false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
