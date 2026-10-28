import assert from "node:assert/strict"
import test from "node:test"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { join, resolve, sep } from "node:path"
import { createEmptyV4LocalIndex, saveV4LocalIndex, type V4LocalIndexAdapter } from "../../src/lib/v4/local-index"
import {
  inspectV4ReencryptionProposedCommitAfterRestart,
  sealV4ReencryptionProposedCommitTestVector,
  type V4ReencryptionProposedCommitIdentity,
} from "../../src/lib/v4/reencryption-proposed-commit-receipt"
import type { V4ReencryptionJournalSnapshot } from "../../src/lib/v4/reencryption-recovery-journal"

/**
 * Real Windows disk/reopen; NO power-loss simulation and WAL is a stub.
 * The receipt is hypothetical; no production migration is invoked.
 */
test("D142 Windows: read-only fresh adapter authenticates reopened marker yet cannot resume cutover", {
  skip: process.platform !== "win32",
}, async () => {
  const scratch = join(process.cwd(), ".tmp")
  await mkdir(scratch, { recursive: true })
  const root = await mkdtemp(join(scratch, "d142-proposed-"))
  const identity: V4ReencryptionProposedCommitIdentity = {
    runId: "win_d142_1234", walGeneration: 14, indexRoot: "private/v4-index",
    deviceId: "device142", sourceRepoId: "owner/vault#main",
    backupRepoId: "owner/vault#backup/rekey", destinationRepoId: "owner/vault#rekey/2026",
    sourceCommitSha: "a".repeat(40), sourceTreeSha: "c".repeat(40),
    destinationCommitSha: "b".repeat(40), destinationTreeSha: "d".repeat(40),
    manifestSha256: "e".repeat(64),
    sourcePassphraseSecretId: "old-secret", destinationPassphraseSecretId: "new-secret",
  }
  const key = new Uint8Array(32).fill(17)
  const settings = {
    githubOwner: "owner", githubRepo: "vault", githubBranch: "rekey/2026",
    encryptionMode: "encrypted", encryptionPassphraseSecretId: "new-secret", vault: identity.deviceId,
  }
  const markerPath = identity.indexRoot + "-rekey-proposed-" + identity.runId + "/marker.json"
  const shadowRoot = identity.indexRoot + "-rekey-" + identity.runId
  const absolute = (path: string): string => {
    const value = resolve(root, path.replaceAll("/", sep))
    if (!value.startsWith(root + sep)) throw new Error("outside disposable test root")
    return value
  }
  const disk: V4LocalIndexAdapter = {
    async exists(path) {
      try { await stat(absolute(path)); return true }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return false
        throw e
      }
    },
    async read(path) { return readFile(absolute(path), "utf8") },
    async mkdir(path) { await mkdir(absolute(path), { recursive: true }) },
    async write(path, value) { await writeFile(absolute(path), value, "utf8") },
    async stat(path) {
      try { return { size: (await stat(absolute(path))).size } }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return null
        throw e
      }
    },
  }
  const wal: V4ReencryptionJournalSnapshot = {
    generation: 14, receipts: [], pendingIntents: [], pendingRefIntents: [],
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
    candidatePreparationSha256: "f".repeat(64),
    stageHandoffStarted: true, requiresRemoteRevalidation: true,
    permissionToPublish: false, cutoverAuthorized: false,
  }
  try {
    const index = createEmptyV4LocalIndex({
      repoId: identity.destinationRepoId, deviceId: identity.deviceId, mode: "encrypted",
    })
    index.remoteCommitSha = identity.destinationCommitSha
    await saveV4LocalIndex(disk, identity.indexRoot, index)
    await saveV4LocalIndex(disk, shadowRoot, index)
    await disk.mkdir!(markerPath.slice(0, markerPath.lastIndexOf("/")))
    await disk.write(markerPath, await sealV4ReencryptionProposedCommitTestVector(identity, key))
    const settingsPath = join(root, "saved-settings.json")
    await writeFile(settingsPath, JSON.stringify(settings), "utf8")
    const reader: V4LocalIndexAdapter = {
      read: disk.read, exists: disk.exists, stat: disk.stat,
      async mkdir() { throw new Error("read-only inspection attempted mkdir") },
      async write() { throw new Error("read-only inspection attempted write") },
    }
    const journal = {
      sourceCommitSha: identity.sourceCommitSha, destinationRepoId: identity.destinationRepoId,
      async assertHealthySnapshot(generation: number) {
        assert.equal(generation, 14)
        return structuredClone(wal)
      },
    }
    let oldSecret = "old-passphrase"
    const inspect = async () => {
      const settingsOnDisk = JSON.parse(await readFile(settingsPath, "utf8")) as typeof settings
      const before = await Promise.all([
        readFile(absolute(markerPath)), readFile(absolute(identity.indexRoot + "/index.json")),
        readFile(absolute(shadowRoot + "/index.json")), readFile(settingsPath),
      ])
      const result = await inspectV4ReencryptionProposedCommitAfterRestart({
        identity, journalKey: key, adapter: reader, settings: settingsOnDisk, journal,
        getSecret: id => id === "old-secret" ? oldSecret : id === "new-secret" ? "new-passphrase" : null,
        withExclusiveInitiatorLease: async body => body(),
        assertExclusiveInitiatorLease: async () => {},
        assertCrashDurable: async () => {},
      })
      const after = await Promise.all([
        readFile(absolute(markerPath)), readFile(absolute(identity.indexRoot + "/index.json")),
        readFile(absolute(shadowRoot + "/index.json")), readFile(settingsPath),
      ])
      assert.deepEqual(after, before)
      assert.equal(result.localCutoverAuthorized, false)
      assert.equal(result.resumeSyncAuthorized, false)
      assert.equal(result.oldPassphraseCleanupAuthorized, false)
      return result.observation
    }
    assert.equal(await inspect(), "authenticated-marker-with-destination-observed-uncommitted")
    oldSecret = ""
    assert.equal(await inspect(), "manual-recovery-required")
    oldSecret = "old-passphrase"
    await writeFile(absolute(markerPath), "torn", "utf8")
    assert.equal(await inspect(), "manual-recovery-required")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
