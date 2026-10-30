import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { acquireV4DesktopRekeyWalStorage } from "../../src/lib/v4/reencryption-desktop-wal"
import { createV4ReencryptionRecoveryJournal } from "../../src/lib/v4/reencryption-recovery-journal"
import { inspectV4BestEffortWalRecovery, type V4BestEffortWalRecoveryInput } from "../../src/lib/v4/reencryption-best-effort-wal-recovery"

const sourceCommitSha = "a".repeat(40)
const destinationRepoId = "owner/repo#rekey/d165"
const rootName = "rekey/wal"
const journalKey = new Uint8Array(32).fill(0x47)
const runId = "d165-recovery"
const object = {
  path: `.obsidian-github-sync-v4/data/aa/${"a".repeat(64)}.enc`,
  sha: "b".repeat(40),
  byteLength: 100,
}

async function sandbox() {
  const parent = join(process.cwd(), ".tmp")
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, "d165-best-effort-recovery-"))
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) }
}

function makeJournal(adapter: Parameters<typeof createV4ReencryptionRecoveryJournal>[0]["adapter"]) {
  return createV4ReencryptionRecoveryJournal({
    adapter, root: rootName, sourceCommitSha, destinationRepoId, journalKey, runId,
  })
}

const expected = (generation: number) => ({ sourceCommitSha, destinationRepoId, generation })

test("D165 real Windows WAL returns authenticated-but-uncommitted only after three checkpoint readbacks and two authenticated journal reads", async () => {
  const t = await sandbox()
  try {
    const storage = await acquireV4DesktopRekeyWalStorage({ rootAbsolute: t.root, journalRoot: rootName })
    try {
      const journal = makeJournal(storage.adapter)
      const start = await journal.begin()
      const state = await journal.recordUploadIntent(object, start.generation)
      let checkpoints = 0
      let authenticated = 0
      const input: V4BestEffortWalRecoveryInput = {
        storage: {
          assertBestEffortCheckpoint: async () => {
            checkpoints++
            return storage.assertBestEffortCheckpoint()
          },
        },
        journal: {
          sourceCommitSha, destinationRepoId,
          assertHealthySnapshot: async generation => {
            authenticated++
            return journal.assertHealthySnapshot(generation)
          },
        },
        expected: expected(state.generation),
      }
      const result = await inspectV4BestEffortWalRecovery(input)
      assert.deepEqual(result, {
        evidence: "best-effort-readback-not-power-loss-durable",
        observation: "authenticated-uncommitted",
        generation: 2,
        localCutoverAuthorized: false,
        resumeSyncAuthorized: false,
        rollbackAuthorized: false,
        remoteWritesAuthorized: false,
        oldPassphraseCleanupAuthorized: false,
      })
      assert.equal(checkpoints, 3)
      assert.equal(authenticated, 2)
      assert.deepEqual((await journal.assertHealthySnapshot(2)).pendingIntents, [object])
      assert.deepEqual(await inspectV4BestEffortWalRecovery(input), result)
    } finally { await storage.release() }
  } finally { await t.cleanup() }
})

test("D165 missing, mismatched, corrupt, or foreign WAL evidence requires manual recovery and preserves the damaged file", async () => {
  const t = await sandbox()
  try {
    const storage = await acquireV4DesktopRekeyWalStorage({ rootAbsolute: t.root, journalRoot: rootName })
    try {
      const journal = makeJournal(storage.adapter)
      const input = { storage, journal, expected: expected(1) }
      const manual = {
        evidence: "best-effort-readback-not-power-loss-durable",
        observation: "manual-recovery-required",
        generation: null,
        localCutoverAuthorized: false,
        resumeSyncAuthorized: false,
        rollbackAuthorized: false,
        remoteWritesAuthorized: false,
        oldPassphraseCleanupAuthorized: false,
      }
      assert.deepEqual(await inspectV4BestEffortWalRecovery(input), manual)
      await journal.begin()
      assert.deepEqual(await inspectV4BestEffortWalRecovery({ ...input, expected: expected(3) }), manual)
      const file = join(t.root, "rekey", "wal", "slot-1.json")
      await writeFile(file, "bad-and-stable")
      assert.deepEqual(await inspectV4BestEffortWalRecovery(input), manual)
      assert.equal(await readFile(file, "utf8"), "bad-and-stable")
      await writeFile(join(t.root, "rekey", "wal", ".slot-interrupted.tmp"), "keep")
      assert.deepEqual(await inspectV4BestEffortWalRecovery(input), manual)
      assert.equal(await readFile(file, "utf8"), "bad-and-stable")
    } finally { await storage.release() }
  } finally { await t.cleanup() }
})

test("D165 concurrent WAL generation advance between authenticated reads cannot look stable or authorize recovery", async () => {
  const t = await sandbox()
  try {
    const storage = await acquireV4DesktopRekeyWalStorage({ rootAbsolute: t.root, journalRoot: rootName })
    try {
      const journal = makeJournal(storage.adapter)
      await journal.begin()
      let reads = 0
      const result = await inspectV4BestEffortWalRecovery({
        storage,
        journal: {
          sourceCommitSha, destinationRepoId,
          assertHealthySnapshot: async generation => {
            reads++
            const snapshot = await journal.assertHealthySnapshot(generation)
            if (reads === 1) await journal.recordUploadIntent(object, generation)
            return snapshot
          },
        },
        expected: expected(1),
      })
      assert.equal(result.observation, "manual-recovery-required")
      assert.equal(result.resumeSyncAuthorized, false)
      assert.equal(result.remoteWritesAuthorized, false)
      assert.equal((await journal.assertHealthySnapshot(2)).generation, 2)
    } finally { await storage.release() }
  } finally { await t.cleanup() }
})

test("D165 a torn temporary slot appearing after the second authenticated read still forces manual recovery", async () => {
  const t = await sandbox()
  try {
    const storage = await acquireV4DesktopRekeyWalStorage({ rootAbsolute: t.root, journalRoot: rootName })
    try {
      const journal = makeJournal(storage.adapter)
      await journal.begin()
      let reads = 0
      const residue = join(t.root, "rekey", "wal", ".slot-torn.tmp")
      const report = await inspectV4BestEffortWalRecovery({
        storage,
        journal: {
          sourceCommitSha, destinationRepoId,
          assertHealthySnapshot: async generation => {
            const state = await journal.assertHealthySnapshot(generation)
            reads++
            if (reads === 2) await writeFile(residue, "interrupted-writer")
            return state
          },
        },
        expected: expected(1),
      })
      assert.equal(reads, 2)
      assert.equal(report.observation, "manual-recovery-required")
      assert.equal(report.localCutoverAuthorized, false)
      assert.equal(report.oldPassphraseCleanupAuthorized, false)
      assert.equal(await readFile(residue, "utf8"), "interrupted-writer")
    } finally { await storage.release() }
  } finally { await t.cleanup() }
})

test("D165 changed runtime identity and swapped readers are rejected without trusting caller-supplied evidence", async () => {
  const t = await sandbox()
  try {
    const storage = await acquireV4DesktopRekeyWalStorage({ rootAbsolute: t.root, journalRoot: rootName })
    try {
      const journal = makeJournal(storage.adapter)
      await journal.begin()
      let calls = 0
      const input = {
        storage: {
          assertBestEffortCheckpoint: async () => {
            calls++
            return storage.assertBestEffortCheckpoint()
          },
        },
        journal: {
          sourceCommitSha, destinationRepoId,
          assertHealthySnapshot: async (generation: number) => {
            input.expected.generation = 2
            return journal.assertHealthySnapshot(generation)
          },
        },
        expected: { ...expected(1) },
      }
      const result = await inspectV4BestEffortWalRecovery(input)
      assert.equal(result.observation, "manual-recovery-required")
      assert.equal(result.generation, null)
      assert.equal(calls, 1)
      await assert.rejects(() => inspectV4BestEffortWalRecovery({
        ...input, journal: { ...input.journal, sourceCommitSha: "f".repeat(40) },
      }), /identity/i)
    } finally { await storage.release() }
  } finally { await t.cleanup() }
})
