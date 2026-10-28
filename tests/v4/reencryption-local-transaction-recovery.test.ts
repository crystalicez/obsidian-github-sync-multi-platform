import assert from "node:assert/strict"
import test from "node:test"
import {
  createEmptyV4LocalIndex, loadV4LocalIndex, saveV4LocalIndex,
  type V4LocalIndexAdapter,
} from "../../src/lib/v4/local-index"
import type { V4ReencryptionJournalSnapshot } from "../../src/lib/v4/reencryption-recovery-journal"
import { prepareV4ReencryptionLocalCutoverIntent } from "../../src/lib/v4/reencryption-local-cutover-intent"
import {
  classifyV4ReencryptionLocalRecovery,
  inspectV4ReencryptionLocalTransactionAfterCrash,
  type V4ReencryptionLocalCutoverSelection,
  type V4ReencryptionLocalRecoverySnapshot,
} from "../../src/lib/v4/reencryption-local-transaction-recovery"

const source = "owner/vault#main"
const backup = "owner/vault#backup/rekey"
const destination = "owner/vault#rekey/2026"
const sourceSha = "a".repeat(40)
const destinationSha = "b".repeat(40)
const indexRoot = "private/v4-index"
const runId = "run_d139_123"
const shadowRoot = indexRoot + "-rekey-" + runId
const intentPath = indexRoot + "-rekey-intent-" + runId + "/intent.json"

function fixture() {
  const files = new Map<string, string>()
  const dirs = new Set<string>()
  let writes = 0
  let walReads = 0
  const adapter: V4LocalIndexAdapter = {
    async exists(path) { return files.has(path) || dirs.has(path) },
    async mkdir(path) { dirs.add(path) },
    async read(path) {
      const value = files.get(path)
      if (value === undefined) throw new Error("missing file")
      return value
    },
    async write(path, value) { writes++; files.set(path, value) },
  }
  const makeIndex = (repoId: string, sha: string) => {
    const index = createEmptyV4LocalIndex({ repoId, deviceId: "device1", mode: "encrypted" })
    index.remoteCommitSha = sha
    return index
  }
  const expected = {
    sourceRepoId: source, destinationRepoId: destination, destinationCommitSha: destinationSha,
    sourcePassphraseSecretId: "secret-old", destinationPassphraseSecretId: "secret-new",
    deviceId: "device1",
  }
  const settings = {
    githubOwner: "owner", githubRepo: "vault", githubBranch: "main",
    encryptionMode: "encrypted", encryptionPassphraseSecretId: "secret-old", vault: "device1",
  }
  const secrets = new Map([["secret-old", "sensitive-old"], ["secret-new", "sensitive-new"]])
  let wal: V4ReencryptionJournalSnapshot = {
    generation: 14, receipts: [], pendingIntents: [], pendingRefIntents: [],
    verifiedRefObservations: [
      { role: "backup", repoId: backup, commitSha: sourceSha, treeSha: "c".repeat(40) },
      { role: "destination", repoId: destination, commitSha: destinationSha,
        treeSha: "d".repeat(40), manifestSha256: "e".repeat(64) },
    ],
    preparedCandidateReceipt: {
      commitSha: destinationSha, treeSha: "d".repeat(40), manifestSha256: "e".repeat(64),
    },
    candidatePreparationSha256: "f".repeat(64), stageHandoffStarted: true,
    requiresRemoteRevalidation: true, permissionToPublish: false, cutoverAuthorized: false,
  }
  const journal = {
    sourceCommitSha: sourceSha, destinationRepoId: destination,
    async assertHealthySnapshot(generation: number) {
      assert.equal(generation, 14)
      walReads++
      return wal
    },
  }
  let held = false
  let holdCount = 0
  let checkCount = 0
  const assertExclusiveInitiatorLease = async () => {
    checkCount++
    assert.equal(held, true, "every lease check must run inside holder")
  }
  const assertCrashDurable = async () => { assert.equal(held, true) }
  const withExclusiveInitiatorLease = async <T>(body: () => Promise<T>): Promise<T> => {
    assert.equal(held, false, "outer lease must not overlap")
    held = true
    holdCount++
    try { return await body() } finally { held = false }
  }
  const input = () => ({
    runId, indexRoot, expected, settings, indexAdapter: adapter,
    sourceCommitSha: sourceSha, backupRepoId: backup, expectedWalGeneration: 14,
    journal, getSecret: (id: string) => secrets.get(id) ?? null,
    assertExclusiveInitiatorLease, assertCrashDurable, withExclusiveInitiatorLease,
  })
  const seed = async (includeIntent = true) => {
    await saveV4LocalIndex(adapter, indexRoot, makeIndex(source, sourceSha))
    await saveV4LocalIndex(adapter, shadowRoot, makeIndex(destination, destinationSha))
    if (includeIntent) {
      // Intent writer requires both predicates, supplied here by a test-only held lease.
      await withExclusiveInitiatorLease(async () =>
        prepareV4ReencryptionLocalCutoverIntent({
          adapter, activeIndexRoot: indexRoot, runId,
          sourceRepoId: source, backupRepoId: backup, destinationRepoId: destination,
          sourceCommitSha: sourceSha, destinationCommitSha: destinationSha,
          sourcePassphraseSecretId: "secret-old", destinationPassphraseSecretId: "secret-new",
          deviceId: "device1", walGeneration: 14,
          assertExclusiveInitiatorLease, assertCrashDurable,
        }),
      )
    }
  }
  const selectDestinationSettings = () => {
    settings.githubBranch = "rekey/2026"
    settings.encryptionPassphraseSecretId = "secret-new"
  }
  const selectDestinationIndex = async () => {
    const destinationIndex = await loadV4LocalIndex(adapter, shadowRoot)
    await saveV4LocalIndex(adapter, indexRoot, destinationIndex)
  }
  return {
    files, dirs, adapter, seed, input, settings, secrets, journal, expected,
    selectDestinationSettings, selectDestinationIndex, makeIndex,
    setWal: (next: V4ReencryptionJournalSnapshot) => { wal = next },
    getWal: () => wal,
    counts: () => ({ writes, walReads, holdCount, checkCount, held }),
  }
}

const selectors: readonly V4ReencryptionLocalCutoverSelection[] = ["source", "destination", "mixed"]

test("D139 pure crash matrix never authorizes a cutover for any setting/index/secret combination", () => {
  let checked = 0
  for (const settings of selectors) {
    for (const activeIndex of selectors) {
      for (const shadowComplete of [false, true]) {
        for (const oldSecretAvailable of [false, true]) {
          for (const newSecretAvailable of [false, true]) {
            for (const authenticatedSourceIntentAndWal of [false, true]) {
              const input: V4ReencryptionLocalRecoverySnapshot = {
                settings, activeIndex, shadowComplete,
                oldSecretAvailable, newSecretAvailable, authenticatedSourceIntentAndWal,
              }
              const observed = classifyV4ReencryptionLocalRecovery(input)
              const expectedObservation = !shadowComplete || !oldSecretAvailable || !newSecretAvailable
                ? "manual-recovery-required"
                : settings === "source" && activeIndex === "source" && authenticatedSourceIntentAndWal
                  ? "source-prepared-uncommitted"
                  : settings === "destination" && activeIndex === "destination"
                    ? "destination-observed-without-commit-proof"
                    : "manual-recovery-required"
              assert.deepEqual(observed, {
                integrityScope: "read-only-local-transaction-crash-window",
                observation: expectedObservation,
                localCutoverAuthorized: false, resumeSyncAuthorized: false,
                rollbackAuthorized: false, remoteWritesAuthorized: false,
                oldPassphraseCleanupAuthorized: false,
              })
              checked++
            }
          }
        }
      }
    }
  }
  assert.equal(checked, 144)
})

test("D139 read-only Source with prepared Intent and authenticated WAL is still uncommitted", async () => {
  const s = fixture()
  await s.seed()
  const files = new Map(s.files)
  const before = s.counts()
  const outcome = await inspectV4ReencryptionLocalTransactionAfterCrash(s.input())
  assert.equal(outcome.observation, "source-prepared-uncommitted")
  assert.equal(outcome.resumeSyncAuthorized, false)
  assert.equal(outcome.oldPassphraseCleanupAuthorized, false)
  assert.deepEqual(s.files, files)
  assert.equal(s.counts().writes, before.writes)
  assert.equal(s.counts().holdCount, before.holdCount + 1)
  assert.equal(s.counts().walReads, before.walReads + 2)
  assert.equal(s.counts().held, false)
  assert.doesNotMatch(JSON.stringify(outcome), /sensitive-old|sensitive-new/)
})

test("D139 crash after Settings-only or Index-only switch is mixed and cannot resume", async () => {
  const settingsFirst = fixture()
  await settingsFirst.seed()
  settingsFirst.selectDestinationSettings()
  assert.equal((await inspectV4ReencryptionLocalTransactionAfterCrash(settingsFirst.input())).observation,
    "manual-recovery-required")
  const indexFirst = fixture()
  await indexFirst.seed()
  await indexFirst.selectDestinationIndex()
  assert.equal((await inspectV4ReencryptionLocalTransactionAfterCrash(indexFirst.input())).observation,
    "manual-recovery-required")
  assert.equal(settingsFirst.counts().walReads, 0)
  assert.equal(indexFirst.counts().walReads, 0)
})

test("D139 crash after both selections observes Destination but cannot claim a durable commit", async () => {
  for (const order of ["settings-first", "index-first"] as const) {
    const s = fixture()
    await s.seed()
    if (order === "settings-first") {
      s.selectDestinationSettings()
      await s.selectDestinationIndex()
    } else {
      await s.selectDestinationIndex()
      s.selectDestinationSettings()
    }
    const before = s.counts()
    const report = await inspectV4ReencryptionLocalTransactionAfterCrash(s.input())
    assert.equal(report.observation, "destination-observed-without-commit-proof")
    assert.equal(report.localCutoverAuthorized, false)
    assert.equal(report.resumeSyncAuthorized, false)
    assert.equal(report.oldPassphraseCleanupAuthorized, false)
    assert.equal(s.counts().walReads, before.walReads)
  }
})

test("D139 missing old or new Secret during cutover never counts as committed", async () => {
  for (const selected of ["source", "destination"] as const) {
    for (const key of ["secret-old", "secret-new"] as const) {
      const s = fixture()
      await s.seed()
      if (selected === "destination") {
        s.selectDestinationSettings()
        await s.selectDestinationIndex()
      }
      s.secrets.delete(key)
      const report = await inspectV4ReencryptionLocalTransactionAfterCrash(s.input())
      assert.equal(report.observation, "manual-recovery-required")
      assert.equal(report.oldPassphraseCleanupAuthorized, false)
    }
  }
})

test("D139 torn or absent Intent, missing WAL ref receipt and incomplete Shadow never certify Source", async () => {
  const cases: Array<(s: ReturnType<typeof fixture>) => void> = [
    s => { s.files.delete(intentPath) },
    s => { s.files.set(intentPath, "{torn") },
    s => {
      const wal = s.getWal()
      s.setWal({ ...wal, verifiedRefObservations: wal.verifiedRefObservations.slice(0, 1) })
    },
    s => { s.files.delete(shadowRoot + "/index.json") },
  ]
  for (const breakIt of cases) {
    const s = fixture()
    await s.seed()
    breakIt(s)
    const report = await inspectV4ReencryptionLocalTransactionAfterCrash(s.input())
    assert.equal(report.observation, "manual-recovery-required")
    assert.equal(report.localCutoverAuthorized, false)
  }
  const missing = fixture()
  await missing.seed(false)
  assert.equal((await inspectV4ReencryptionLocalTransactionAfterCrash(missing.input())).observation,
    "manual-recovery-required")
})

test("D139 Settings or Source Index change across awaited WAL read is refused", async () => {
  const settingsChanged = fixture()
  await settingsChanged.seed()
  const input = settingsChanged.input()
  const reader = input.journal.assertHealthySnapshot
  let changed = false
  input.journal.assertHealthySnapshot = async generation => {
    if (!changed) {
      changed = true
      settingsChanged.settings.githubBranch = "rekey/2026"
    }
    return reader(generation)
  }
  const first = await inspectV4ReencryptionLocalTransactionAfterCrash(input)
  assert.equal(changed, true)
  assert.equal(first.observation, "manual-recovery-required")

  const indexChanged = fixture()
  await indexChanged.seed()
  const another = indexChanged.input()
  const readWal = another.journal.assertHealthySnapshot
  let modified = false
  another.journal.assertHealthySnapshot = async generation => {
    if (!modified) {
      modified = true
      const index = await loadV4LocalIndex(indexChanged.adapter, indexRoot)
      index.generation++
      await saveV4LocalIndex(indexChanged.adapter, indexRoot, index)
    }
    return readWal(generation)
  }
  const report = await inspectV4ReencryptionLocalTransactionAfterCrash(another)
  assert.equal(modified, true)
  assert.equal(report.observation, "manual-recovery-required")
})

test("D139 missing external lease, durability and WAL failures cannot report success", async () => {
  const s = fixture()
  await s.seed()
  const good = s.input()
  await assert.rejects(() => inspectV4ReencryptionLocalTransactionAfterCrash({
    ...good, assertExclusiveInitiatorLease: async () => { throw new Error("lease lost") },
  }), /lease lost/)
  await assert.rejects(() => inspectV4ReencryptionLocalTransactionAfterCrash({
    ...good, assertCrashDurable: async () => { throw new Error("fsync EPERM") },
  }), /EPERM/)
  await assert.rejects(() => inspectV4ReencryptionLocalTransactionAfterCrash({
    ...good, journal: { ...good.journal, async assertHealthySnapshot() { throw new Error("WAL unreadable") } },
  }), /WAL unreadable/)
  assert.equal(s.counts().held, false)
})

test("D139 detects adapter reader replacement inside the held lease before trusting local state", async () => {
  const s = fixture()
  await s.seed()
  const input = s.input()
  const originalRead = input.indexAdapter.read
  const originalHolder = input.withExclusiveInitiatorLease
  let replaced = false
  input.withExclusiveInitiatorLease = async body => originalHolder(async () => {
    replaced = true
    input.indexAdapter.read = async path => originalRead(path)
    try { return await body() } finally { input.indexAdapter.read = originalRead }
  })
  const report = await inspectV4ReencryptionLocalTransactionAfterCrash(input)
  assert.equal(replaced, true)
  assert.equal(report.observation, "manual-recovery-required")
})

test("D139 holder skipping the body cannot forge a verified result", async () => {
  const s = fixture()
  await s.seed()
  const report = await inspectV4ReencryptionLocalTransactionAfterCrash({
    ...s.input(),
    withExclusiveInitiatorLease: async () => ({
      integrityScope: "read-only-local-transaction-crash-window" as const,
      observation: "source-prepared-uncommitted" as const,
      localCutoverAuthorized: false as const, resumeSyncAuthorized: false as const,
      rollbackAuthorized: false as const, remoteWritesAuthorized: false as const,
      oldPassphraseCleanupAuthorized: false as const,
    }) as never,
  })
  assert.equal(report.observation, "manual-recovery-required")
  assert.equal(s.counts().held, false)
})
