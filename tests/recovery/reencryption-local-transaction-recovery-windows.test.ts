import assert from "node:assert/strict"
import test from "node:test"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { join, resolve, sep } from "node:path"
import {
  createEmptyV4LocalIndex, loadV4LocalIndex, saveV4LocalIndex, type V4LocalIndexAdapter,
} from "../../src/lib/v4/local-index"
import { prepareV4ReencryptionLocalCutoverIntent } from "../../src/lib/v4/reencryption-local-cutover-intent"
import { inspectV4ReencryptionLocalTransactionAfterCrash } from "../../src/lib/v4/reencryption-local-transaction-recovery"
import type { V4ReencryptionJournalSnapshot } from "../../src/lib/v4/reencryption-recovery-journal"

test("D139 Windows: separate reopened reader refuses both interrupted settings/index switch orders without writing", {
  skip: process.platform !== "win32",
}, async () => {
  const scratch = join(process.cwd(), ".tmp")
  await mkdir(scratch, { recursive: true })
  const temporary = await mkdtemp(join(scratch, "d139-recovery-"))
  const indexRoot = "private/v4-index"
  const runId = "win_d139_1234"
  const shadow = indexRoot + "-rekey-" + runId
  const source = "owner/vault#main"
  const backup = "owner/vault#backup/win"
  const destination = "owner/vault#rekey/win"
  const oldSha = "a".repeat(40)
  const newSha = "b".repeat(40)
  const oldId = "old-secret"
  const newId = "new-secret"

  const wal: V4ReencryptionJournalSnapshot = {
    generation: 14, receipts: [], pendingIntents: [], pendingRefIntents: [],
    verifiedRefObservations: [
      { role: "backup", repoId: backup, commitSha: oldSha, treeSha: "c".repeat(40) },
      { role: "destination", repoId: destination, commitSha: newSha,
        treeSha: "d".repeat(40), manifestSha256: "e".repeat(64) },
    ],
    preparedCandidateReceipt: {
      commitSha: newSha, treeSha: "d".repeat(40), manifestSha256: "e".repeat(64),
    },
    candidatePreparationSha256: "f".repeat(64), stageHandoffStarted: true,
    requiresRemoteRevalidation: true, permissionToPublish: false, cutoverAuthorized: false,
  }
  const expected = {
    sourceRepoId: source, destinationRepoId: destination, destinationCommitSha: newSha,
    sourcePassphraseSecretId: oldId, destinationPassphraseSecretId: newId,
    deviceId: "device1",
  }
  const sourceSettings = {
    githubOwner: "owner", githubRepo: "vault", githubBranch: "main",
    encryptionMode: "encrypted", encryptionPassphraseSecretId: oldId, vault: "device1",
  }
  const destinationSettings = {
    ...sourceSettings, githubBranch: "rekey/win", encryptionPassphraseSecretId: newId,
  }
  const sourceIndex = createEmptyV4LocalIndex({ repoId: source, deviceId: "device1", mode: "encrypted" })
  sourceIndex.remoteCommitSha = oldSha
  const destinationIndex = createEmptyV4LocalIndex({ repoId: destination, deviceId: "device1", mode: "encrypted" })
  destinationIndex.remoteCommitSha = newSha

  try {
    for (const order of ["settings-first", "index-first"] as const) {
      const isolated = join(temporary, order)
      await mkdir(isolated, { recursive: true })
      const absolute = (path: string) => {
        const value = resolve(isolated, path.replaceAll("/", sep))
        if (!value.startsWith(isolated + sep)) throw new Error("outside disposable test directory")
        return value
      }
      const disk: V4LocalIndexAdapter = {
        async exists(path) {
          try { await stat(absolute(path)); return true }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
            throw error
          }
        },
        async read(path) { return readFile(absolute(path), "utf8") },
        async write(path, value) { await writeFile(absolute(path), value, "utf8") },
        async mkdir(path) { await mkdir(absolute(path), { recursive: true }) },
      }
      const journal = {
        sourceCommitSha: oldSha, destinationRepoId: destination,
        async assertHealthySnapshot(generation: number) {
          assert.equal(generation, 14)
          return wal
        },
      }
      const lease = async () => {}
      const durable = async () => {}
      const holder = async <T>(body: () => Promise<T>): Promise<T> => body()
      const settingsPath = join(isolated, "settings.json")
      await saveV4LocalIndex(disk, indexRoot, sourceIndex)
      await saveV4LocalIndex(disk, shadow, destinationIndex)
      await writeFile(settingsPath, JSON.stringify(sourceSettings), "utf8")
      await prepareV4ReencryptionLocalCutoverIntent({
        adapter: disk, activeIndexRoot: indexRoot, runId,
        sourceRepoId: source, backupRepoId: backup, destinationRepoId: destination,
        sourceCommitSha: oldSha, destinationCommitSha: newSha,
        sourcePassphraseSecretId: oldId, destinationPassphraseSecretId: newId,
        deviceId: "device1", walGeneration: 14,
        assertExclusiveInitiatorLease: lease, assertCrashDurable: durable,
      })
      let oldSecretPresent = true
      const reopened: V4LocalIndexAdapter = {
        exists: disk.exists, read: disk.read,
        async write() { throw new Error("read-only recovery attempted to write") },
        async mkdir() { throw new Error("read-only recovery attempted to create a directory") },
      }
      const inspect = async () => {
        const saved = JSON.parse(await readFile(settingsPath, "utf8")) as typeof sourceSettings
        const activeBytes = await readFile(absolute(indexRoot + "/index.json"))
        const shadowBytes = await readFile(absolute(shadow + "/index.json"))
        const intentBytes = await readFile(absolute(indexRoot + "-rekey-intent-" + runId + "/intent.json"))
        const report = await inspectV4ReencryptionLocalTransactionAfterCrash({
          indexAdapter: reopened, indexRoot, runId, expected, settings: saved,
          sourceCommitSha: oldSha, backupRepoId: backup, expectedWalGeneration: 14,
          journal, getSecret: id => id === oldId
            ? (oldSecretPresent ? "old-key" : null)
            : (id === newId ? "new-key" : null),
          assertExclusiveInitiatorLease: lease, assertCrashDurable: durable,
          withExclusiveInitiatorLease: holder,
        })
        assert.deepEqual(await readFile(absolute(indexRoot + "/index.json")), activeBytes)
        assert.deepEqual(await readFile(absolute(shadow + "/index.json")), shadowBytes)
        assert.deepEqual(await readFile(absolute(indexRoot + "-rekey-intent-" + runId + "/intent.json")), intentBytes)
        assert.equal(report.localCutoverAuthorized, false)
        assert.equal(report.resumeSyncAuthorized, false)
        assert.equal(report.oldPassphraseCleanupAuthorized, false)
        return report.observation
      }
      assert.equal(await inspect(), "source-prepared-uncommitted")
      if (order === "settings-first") {
        await writeFile(settingsPath, JSON.stringify(destinationSettings), "utf8")
      } else {
        await saveV4LocalIndex(disk, indexRoot, destinationIndex)
      }
      assert.equal(await inspect(), "manual-recovery-required")
      if (order === "settings-first") {
        await saveV4LocalIndex(disk, indexRoot, destinationIndex)
      } else {
        await writeFile(settingsPath, JSON.stringify(destinationSettings), "utf8")
      }
      assert.equal(await inspect(), "destination-observed-without-commit-proof")
      oldSecretPresent = false
      assert.equal(await inspect(), "manual-recovery-required")
    }
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})
