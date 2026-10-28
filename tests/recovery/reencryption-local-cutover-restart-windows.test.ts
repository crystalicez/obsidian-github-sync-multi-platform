import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { join, resolve, sep } from "node:path"
import { createEmptyV4LocalIndex, saveV4LocalIndex, type V4LocalIndexAdapter } from "../../src/lib/v4/local-index"
import { prepareV4ReencryptionLocalCutoverIntent } from "../../src/lib/v4/reencryption-local-cutover-intent"
import { inspectV4ReencryptionRestartEvidence } from "../../src/lib/v4/reencryption-local-cutover-restart"
import type { V4ReencryptionJournalSnapshot } from "../../src/lib/v4/reencryption-recovery-journal"

test("D136 real Windows: a separately reopened reader inspects staged intent and refuses damaged restart evidence without writes", {
  skip: process.platform !== "win32",
}, async () => {
  const temporary = await mkdtemp(join(process.cwd(), ".tmp", "d136-restart-"))
  const root = "private/v4-index"
  const runId = "windowsrun1234"
  const shadow = root + "-rekey-" + runId
  const intentPath = root + "-rekey-intent-" + runId + "/intent.json"
  const source = "owner/vault#main"
  const backup = "owner/vault#backup/test"
  const destination = "owner/vault#rekey/test"
  const oldSha = "a".repeat(40)
  const newSha = "b".repeat(40)
  const oldSecret = "old-passphrase-id"
  const newSecret = "new-passphrase-id"
  const absolute = (path: string) => {
    const found = resolve(temporary, path.replaceAll("/", sep))
    if (!found.startsWith(temporary + sep)) throw Error("outside disposable directory")
    return found
  }
  const disk: V4LocalIndexAdapter = {
    async exists(path) {
      try { await stat(absolute(path)); return true }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error }
    },
    async mkdir(path) { await mkdir(absolute(path), { recursive: true }) },
    async write(path, value) { await writeFile(absolute(path), value, "utf8") },
    async read(path) { return readFile(absolute(path), "utf8") },
  }
  const verified: V4ReencryptionJournalSnapshot = {
    generation: 13, receipts: [], pendingIntents: [], pendingRefIntents: [],
    verifiedRefObservations: [
      { role: "backup", repoId: backup, commitSha: oldSha, treeSha: "c".repeat(40) },
      { role: "destination", repoId: destination, commitSha: newSha,
        treeSha: "d".repeat(40), manifestSha256: "e".repeat(64) },
    ],
    stageHandoffStarted: true, candidatePreparationSha256: "f".repeat(64),
    preparedCandidateReceipt: { commitSha: newSha, treeSha: "d".repeat(40), manifestSha256: "e".repeat(64) },
    requiresRemoteRevalidation: true, permissionToPublish: false, cutoverAuthorized: false,
  }
  const journal = {
    sourceCommitSha: oldSha, destinationRepoId: destination,
    async assertHealthySnapshot(generation: number) {
      assert.equal(generation, 13)
      return verified
    },
  }
  const index = (repoId: string, commitSha: string) => {
    const v = createEmptyV4LocalIndex({ repoId, mode: "encrypted", deviceId: "device1" })
    v.remoteCommitSha = commitSha
    return v
  }
  const lease = async () => {}
  const durable = async () => {}
  try {
    await saveV4LocalIndex(disk, root, index(source, oldSha))
    await saveV4LocalIndex(disk, shadow, index(destination, newSha))
    await prepareV4ReencryptionLocalCutoverIntent({
      adapter: disk, activeIndexRoot: root, runId,
      sourceRepoId: source, backupRepoId: backup, destinationRepoId: destination,
      sourceCommitSha: oldSha, destinationCommitSha: newSha,
      sourcePassphraseSecretId: oldSecret, destinationPassphraseSecretId: newSecret,
      deviceId: "device1", walGeneration: 13,
      assertExclusiveInitiatorLease: lease, assertCrashDurable: durable,
    })
    const sourceBefore = await readFile(absolute(root + "/index.json"))
    const shadowBefore = await readFile(absolute(shadow + "/index.json"))
    const intentBefore = await readFile(absolute(intentPath))
    const reopened: V4LocalIndexAdapter = {
      exists: disk.exists,
      read: disk.read,
      async write() { throw Error("read-only reopened adapter must not write") },
      async mkdir() { throw Error("read-only reopened adapter must not create directories") },
    }
    const input = {
      runId, expected: {
        sourceRepoId: source, destinationRepoId: destination, destinationCommitSha: newSha,
        sourcePassphraseSecretId: oldSecret, destinationPassphraseSecretId: newSecret, deviceId: "device1",
      },
      sourceCommitSha: oldSha, backupRepoId: backup, expectedWalGeneration: 13,
      indexRoot: root, indexAdapter: reopened, journal,
      settings: {
        githubOwner: "owner", githubRepo: "vault", githubBranch: "main",
        encryptionMode: "encrypted", encryptionPassphraseSecretId: oldSecret, vault: "device1",
      },
      getSecret: (id: string) => id === oldSecret || id === newSecret ? "test-only-key" : null,
      assertExclusiveInitiatorLease: lease, assertCrashDurable: durable,
    }
    const valid = await inspectV4ReencryptionRestartEvidence(input)
    assert.equal(valid.observation, "source-with-prepared-intent-uncommitted")
    assert.equal(valid.resumeSyncAuthorized, false)
    assert.equal(valid.oldPassphraseCleanupAuthorized, false)
    await writeFile(absolute(intentPath), "{truncated", "utf8")
    assert.equal((await inspectV4ReencryptionRestartEvidence(input)).observation, "manual-recovery-required")
    assert.deepEqual(await readFile(absolute(root + "/index.json")), sourceBefore)
    assert.deepEqual(await readFile(absolute(shadow + "/index.json")), shadowBefore)
    await writeFile(absolute(intentPath), intentBefore)
    assert.equal((await inspectV4ReencryptionRestartEvidence(input)).observation, "source-with-prepared-intent-uncommitted")
  } finally {
    await rm(temporary, { force: true, recursive: true })
  }
})
