import assert from "node:assert/strict"
import test from "node:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { createEmptyV4LocalIndex, loadV4LocalIndex, saveV4LocalIndex, type V4LocalIndexAdapter } from "../../src/lib/v4/local-index"
import { prepareV4ReencryptionLocalCutoverIntent } from "../../src/lib/v4/reencryption-local-cutover-intent"
import { stageV4BestEffortPreparedSelectorEvidence, inspectV4BestEffortPreparedSelectorAfterRestart } from "../../src/lib/v4/reencryption-prepared-selector-stage"
import {
  authenticateV4ReencryptionPreparedSelectorEvidence,
  authenticateV4ReencryptionSeparatedSelectorTestVector,
} from "../../src/lib/v4/reencryption-separated-selector-prototype"
import { planV4ReencryptionSeparatedRoots } from "../../src/lib/v4/reencryption-separated-selector"
import { V4_RUNTIME_INDEX_ROOT } from "../../src/lib/v4/reencryption-index-root"
import { armV4ReencryptionSyncFence, assertV4ReencryptionSyncFenceClear, V4_REENCRYPTION_SYNC_FENCE_ROOT } from "../../src/lib/v4/reencryption-sync-fence"
import { stageV4FencedBestEffortPreparedSelector, inspectV4FencedBestEffortPreparedSelectorAfterRestart } from "../../src/lib/v4/reencryption-fenced-prepared-selector"
import { inspectV4FencedLocalCrashTriageAfterRestart } from "../../src/lib/v4/reencryption-fenced-local-crash-triage"
import { sealV4ReencryptionSeparatedSelectorTestVector } from "../../src/lib/v4/reencryption-separated-selector-prototype"
import { acquireV4DesktopRekeyWalStorage } from "../../src/lib/v4/reencryption-desktop-wal"
import { createV4ReencryptionRecoveryJournal, type V4ReencryptionJournalSnapshot } from "../../src/lib/v4/reencryption-recovery-journal"
import type { V4ReencryptionProposedCommitIdentity } from "../../src/lib/v4/reencryption-proposed-commit-receipt"

const identity: V4ReencryptionProposedCommitIdentity = {
  runId: "d172_prepared_run", walGeneration: 8,
  indexRoot: "private/v4-index", deviceId: "device172",
  sourceRepoId: "owner/vault#main", backupRepoId: "owner/vault#backup/rekey",
  destinationRepoId: "owner/vault#rekey/2026",
  sourceCommitSha: "a".repeat(40), sourceTreeSha: "c".repeat(40),
  destinationCommitSha: "b".repeat(40), destinationTreeSha: "d".repeat(40),
  manifestSha256: "e".repeat(64),
  sourcePassphraseSecretId: "old-secret", destinationPassphraseSecretId: "new-secret",
}
const roots = planV4ReencryptionSeparatedRoots(identity.indexRoot, identity.runId)
const preparedPath = roots.selectorPath.replace(/selector\.json$/u, "prepared.json")
const intentPath = identity.indexRoot + "-rekey-intent-" + identity.runId + "/intent.json"
const consent = "accept-best-effort-power-loss-recovery-risk" as const

function fixture(indexRoot = identity.indexRoot) {
  const activeRoots = planV4ReencryptionSeparatedRoots(indexRoot, identity.runId)
  const files = new Map<string, string>()
  const dirs = new Set<string>()
  const writes: string[] = []
  const key = new Uint8Array(32).fill(0x72)
  let held = false
  let checks = 0
  let snapshot: V4ReencryptionJournalSnapshot = {
    generation: 8, receipts: [], pendingIntents: [], pendingRefIntents: [],
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
  const adapter: V4LocalIndexAdapter = {
    async read(path) {
      const value = files.get(path)
      if (value === undefined) throw Error("missing " + path)
      return value
    },
    async write(path, value) { writes.push(path); files.set(path, value) },
    async mkdir(path) { dirs.add(path) },
    async exists(path) { return files.has(path) || dirs.has(path) },
    async stat(path) {
      const value = files.get(path)
      return value === undefined ? null : { size: Buffer.byteLength(value) }
    },
  }
  const journal = {
    sourceCommitSha: identity.sourceCommitSha,
    destinationRepoId: identity.destinationRepoId,
    async assertHealthySnapshot(generation: number) {
      assert.equal(held, true)
      assert.equal(generation, 8)
      return structuredClone(snapshot)
    },
  }
  const wal = {
    async assertExclusiveStageLease() { assert.equal(held, true) },
    async assertBestEffortCheckpoint() {
      checks++
      assert.equal(held, true)
      return "best-effort-readback-only" as const
    },
  }
  const settings = {
    githubOwner: "owner", githubRepo: "vault", githubBranch: "main",
    encryptionMode: "encrypted", encryptionPassphraseSecretId: "old-secret", vault: identity.deviceId,
  }
  const secrets = new Map([["old-secret", "old-value"], ["new-secret", "new-value"]])
  const lease = async () => { assert.equal(held, true) }
  const owner = async <T>(body: () => Promise<T>): Promise<T> => {
    assert.equal(held, false)
    held = true
    try { return await body() } finally { held = false }
  }
  const input = () => ({
    restart: {
      runId: identity.runId, indexRoot,
      sourceCommitSha: identity.sourceCommitSha, backupRepoId: identity.backupRepoId,
      expectedWalGeneration: identity.walGeneration,
      expected: {
        sourceRepoId: identity.sourceRepoId, destinationRepoId: identity.destinationRepoId,
        destinationCommitSha: identity.destinationCommitSha,
        sourcePassphraseSecretId: identity.sourcePassphraseSecretId,
        destinationPassphraseSecretId: identity.destinationPassphraseSecretId,
        deviceId: identity.deviceId,
      },
      settings, indexAdapter: adapter, journal, wal,
      acknowledgement: consent,
      getSecret: (id: string) => secrets.get(id) ?? null,
      assertExclusiveInitiatorLease: lease,
    },
    identity: { ...identity, indexRoot }, journalKey: key, withExclusiveInitiatorLease: owner,
  })
  const seed = async () => {
    const source = createEmptyV4LocalIndex({
      repoId: identity.sourceRepoId, deviceId: identity.deviceId, mode: "encrypted",
    })
    source.remoteCommitSha = identity.sourceCommitSha
    const shadow = createEmptyV4LocalIndex({
      repoId: identity.destinationRepoId, deviceId: identity.deviceId, mode: "encrypted",
    })
    shadow.remoteCommitSha = identity.destinationCommitSha
    await saveV4LocalIndex(adapter, activeRoots.sourceIndexRoot, source)
    await saveV4LocalIndex(adapter, activeRoots.shadowIndexRoot, shadow)
    await owner(async () => prepareV4ReencryptionLocalCutoverIntent({
      adapter, activeIndexRoot: indexRoot, runId: identity.runId,
      sourceRepoId: identity.sourceRepoId, backupRepoId: identity.backupRepoId,
      destinationRepoId: identity.destinationRepoId,
      sourceCommitSha: identity.sourceCommitSha, destinationCommitSha: identity.destinationCommitSha,
      sourcePassphraseSecretId: identity.sourcePassphraseSecretId,
      destinationPassphraseSecretId: identity.destinationPassphraseSecretId,
      deviceId: identity.deviceId, walGeneration: identity.walGeneration,
      assertExclusiveInitiatorLease: lease, assertCrashDurable: lease,
    }))
  }
  return {
    files, dirs, writes, key, adapter, settings, secrets, wal, journal, seed, input, owner,
    setWal(next: V4ReencryptionJournalSnapshot) { snapshot = next },
    walSnapshot: () => snapshot,
    get checks() { return checks },
  }
}

const fenceMarker = V4_REENCRYPTION_SYNC_FENCE_ROOT + "/active.json"

async function armFixtureFence(s: ReturnType<typeof fixture>): Promise<void> {
  const input = s.input()
  await s.owner(async () => {
    await armV4ReencryptionSyncFence({
      adapter: s.adapter, runId: input.identity.runId,
      sourceRepoId: input.identity.sourceRepoId,
      destinationRepoId: input.identity.destinationRepoId,
      assertExclusiveInitiatorLease: input.restart.assertExclusiveInitiatorLease,
    })
  })
}

async function d180Fixture() {
  const s = fixture(V4_RUNTIME_INDEX_ROOT)
  await s.seed()
  await armFixtureFence(s)
  await stageV4FencedBestEffortPreparedSelector(s.input())
  return s
}

const d180Prepared = V4_RUNTIME_INDEX_ROOT + "-rekey-selector-" + identity.runId + "/prepared.json"
const d180Selector = V4_RUNTIME_INDEX_ROOT + "-rekey-selector-" + identity.runId + "/selector.json"
const d180Intent = V4_RUNTIME_INDEX_ROOT + "-rekey-intent-" + identity.runId + "/intent.json"
const d180Proposed = V4_RUNTIME_INDEX_ROOT + "-rekey-proposed-" + identity.runId

test("D180 read-only crash triage authenticates Source/Fence/Intent/Prepared/WAL with no repair or Sync", async () => {
  const s = await d180Fixture()
  const beforeFiles = new Map(s.files)
  const beforeDirs = new Set(s.dirs)
  const beforeWrites = s.writes.length
  const result = await inspectV4FencedLocalCrashTriageAfterRestart(s.input())
  assert.deepEqual(result, {
    integrityScope: "read-only-fenced-local-crash-triage-uncommitted",
    evidence: "best-effort-wal-readback-not-power-loss-durable",
    observation: "source-prepared-uncommitted",
    reason: "source-still-selected",
    localCutoverAuthorized: false, resumeSyncAuthorized: false,
    rollbackAuthorized: false, remoteWritesAuthorized: false,
    oldPassphraseCleanupAuthorized: false,
  })
  assert.equal(Object.isFrozen(result), true)
  assert.deepEqual(s.files, beforeFiles)
  assert.deepEqual(s.dirs, beforeDirs)
  assert.equal(s.writes.length, beforeWrites)
  await assert.rejects(() => assertV4ReencryptionSyncFenceClear(s.adapter))
})

test("D180 destination-looking state still has no commit authority or old-key cleanup", async () => {
  const s = await d180Fixture()
  const shadow = await loadV4LocalIndex(s.adapter, V4_RUNTIME_INDEX_ROOT + "-rekey-" + identity.runId)
  await saveV4LocalIndex(s.adapter, V4_RUNTIME_INDEX_ROOT, shadow)
  s.settings.githubBranch = "rekey/2026"
  s.settings.encryptionPassphraseSecretId = "new-secret"
  const before = new Map(s.files)
  const writes = s.writes.length
  const report = await inspectV4FencedLocalCrashTriageAfterRestart(s.input())
  assert.equal(report.observation, "destination-observed-without-commit-proof")
  assert.equal(report.reason, "destination-looking-without-authoritative-commit")
  assert.equal(report.resumeSyncAuthorized, false)
  assert.equal(report.rollbackAuthorized, false)
  assert.equal(report.oldPassphraseCleanupAuthorized, false)
  assert.deepEqual(s.files, before)
  assert.equal(s.writes.length, writes)
  assert.equal(s.secrets.get("old-secret"), "old-value")
  await assert.rejects(() => assertV4ReencryptionSyncFenceClear(s.adapter))
})

test("D180 both interrupted Settings-first and Index-first windows need Manual Recovery", async () => {
  for (const phase of ["settings-first", "index-first"] as const) {
    const s = await d180Fixture()
    if (phase === "settings-first") {
      s.settings.githubBranch = "rekey/2026"
      s.settings.encryptionPassphraseSecretId = "new-secret"
    } else {
      const shadow = await loadV4LocalIndex(s.adapter, V4_RUNTIME_INDEX_ROOT + "-rekey-" + identity.runId)
      await saveV4LocalIndex(s.adapter, V4_RUNTIME_INDEX_ROOT, shadow)
    }
    const before = new Map(s.files)
    const writes = s.writes.length
    const report = await inspectV4FencedLocalCrashTriageAfterRestart(s.input())
    assert.equal(report.observation, "manual-recovery-required", phase)
    assert.equal(report.reason, "mixed-or-changed-local-state", phase)
    assert.equal(report.localCutoverAuthorized, false)
    assert.deepEqual(s.files, before)
    assert.equal(s.writes.length, writes)
  }
})

test("D180 even a valid-looking future Selector or proposed Commit marker is unexpected residue, never authority", async () => {
  for (const kind of ["authenticated-selector", "proposed-root", "marker-only"] as const) {
    const s = await d180Fixture()
    if (kind === "authenticated-selector") {
      s.files.set(d180Selector,
        await sealV4ReencryptionSeparatedSelectorTestVector(s.input().identity, s.key))
    } else if (kind === "proposed-root") {
      s.dirs.add(d180Proposed)
    } else {
      s.files.set(d180Proposed + "/marker.json", "garbage")
    }
    const before = new Map(s.files)
    const writes = s.writes.length
    const report = await inspectV4FencedLocalCrashTriageAfterRestart(s.input())
    assert.equal(report.observation, "manual-recovery-required", kind)
    assert.equal(report.reason, "unrecognized-selector-or-commit-artifact", kind)
    assert.equal(report.resumeSyncAuthorized, false)
    assert.equal(report.rollbackAuthorized, false)
    assert.deepEqual(s.files, before)
    assert.equal(s.writes.length, writes)
  }
})

test("D180 missing or altered Prepared Selector/Intent or corrupt WAL/Fence always fails closed", async () => {
  for (const kind of ["missing-prepared", "forged-prepared", "torn-intent",
    "wrong-intent-sha", "stale-wal", "lost-fence", "foreign-fence", "missing-secret"] as const) {
    const s = await d180Fixture()
    if (kind === "missing-prepared") s.files.delete(d180Prepared)
    if (kind === "forged-prepared") s.files.set(d180Prepared, "valid-base64-but-wrong")
    if (kind === "torn-intent") s.files.set(d180Intent, "{")
    if (kind === "wrong-intent-sha") {
      const intent = s.files.get(d180Intent)!
      s.files.set(d180Intent, intent.replace(/"recordSha256":"[a-f0-9]{64}"/u,
        '"recordSha256":"' + "0".repeat(64) + '"'))
    }
    if (kind === "stale-wal") s.setWal({ ...s.walSnapshot(), generation: 999 })
    if (kind === "lost-fence") s.files.delete(fenceMarker)
    if (kind === "foreign-fence") s.files.set(fenceMarker,
      s.files.get(fenceMarker)!.replace(identity.runId, "run_d180_foreign"))
    if (kind === "missing-secret") s.secrets.delete("old-secret")
    const before = new Map(s.files)
    const writes = s.writes.length
    const report = await inspectV4FencedLocalCrashTriageAfterRestart(s.input())
    assert.equal(report.observation, "manual-recovery-required", kind)
    assert.equal(report.localCutoverAuthorized, false)
    assert.equal(report.resumeSyncAuthorized, false)
    assert.equal(report.oldPassphraseCleanupAuthorized, false)
    assert.deepEqual(s.files, before)
    assert.equal(s.writes.length, writes)
  }
})

test("D180 asynchronous SecretStorage or Settings mutation while reading Prepared evidence is detected", async () => {
  for (const cause of ["settings", "secret"] as const) {
    const s = await d180Fixture()
    const originalRead = s.adapter.read
    let changed = false
    s.adapter.read = async path => {
      const value = await originalRead(path)
      if (path === d180Prepared && !changed) {
        changed = true
        if (cause === "settings") s.settings.githubBranch = "rekey/2026"
        else s.secrets.set("new-secret", "new-key-changed-mid-read")
      }
      return value
    }
    const writes = s.writes.length
    const report = await inspectV4FencedLocalCrashTriageAfterRestart(s.input())
    assert.equal(changed, true)
    assert.equal(report.observation, "manual-recovery-required")
    assert.equal(report.resumeSyncAuthorized, false)
    assert.equal(s.writes.length, writes)
  }
})

test("D181 holder skipping callback or forging a positive result cannot certify crash recovery", async () => {
  const s = await d180Fixture()
  const authentic = await inspectV4FencedLocalCrashTriageAfterRestart(s.input())
  assert.equal(authentic.observation, "source-prepared-uncommitted")
  const initialWrites = s.writes.length
  const skipped = s.input()
  skipped.withExclusiveInitiatorLease = async () => authentic as never
  const skippedResult = await inspectV4FencedLocalCrashTriageAfterRestart(skipped)
  assert.equal(skippedResult.observation, "manual-recovery-required")
  assert.equal(skippedResult.reason, "fence-wal-or-storage-uncertain")

  const forged = s.input()
  forged.withExclusiveInitiatorLease = async action => s.owner(async () => {
    await action()
    return { ...authentic, observation: "destination-observed-without-commit-proof" } as never
  })
  const forgedResult = await inspectV4FencedLocalCrashTriageAfterRestart(forged)
  assert.equal(forgedResult.observation, "manual-recovery-required")
  assert.equal(forgedResult.resumeSyncAuthorized, false)
  assert.equal(s.writes.length, initialWrites)
  await assert.rejects(() => assertV4ReencryptionSyncFenceClear(s.adapter))
})

test("D181 holder double invocation returning the first success and post-callback drift fail closed", async () => {
  for (const cause of ["double", "after-settings", "after-secret"] as const) {
    const s = await d180Fixture()
    const input = s.input()
    input.withExclusiveInitiatorLease = async action => s.owner(async () => {
      const first = await action()
      if (cause === "double") await action()
      else if (cause === "after-settings") s.settings.githubBranch = "another-branch"
      else s.secrets.set("new-secret", "post-holder-secret-changed")
      return first
    })
    const writes = s.writes.length
    const result = await inspectV4FencedLocalCrashTriageAfterRestart(input)
    assert.equal(result.observation, "manual-recovery-required", cause)
    assert.equal(result.reason, "fence-wal-or-storage-uncertain", cause)
    assert.equal(result.resumeSyncAuthorized, false)
    assert.equal(s.writes.length, writes)
  }
})

test("D181 exhaustive local crash boundary matrix never treats Settings/Index and mock receipt residue as authority", async () => {
  for (const settings of ["source", "destination"] as const) {
    for (const activeIndex of ["source", "destination"] as const) {
      for (const residue of ["absent", "selector", "receipt"] as const) {
        for (const prepared of ["healthy", "torn"] as const) {
          const s = await d180Fixture()
          if (settings === "destination") {
            s.settings.githubBranch = "rekey/2026"
            s.settings.encryptionPassphraseSecretId = "new-secret"
          }
          if (activeIndex === "destination") {
            const shadow = await loadV4LocalIndex(s.adapter,
              V4_RUNTIME_INDEX_ROOT + "-rekey-" + identity.runId)
            await saveV4LocalIndex(s.adapter, V4_RUNTIME_INDEX_ROOT, shadow)
          }
          if (residue === "selector") s.files.set(d180Selector,
            await sealV4ReencryptionSeparatedSelectorTestVector(s.input().identity, s.key))
          if (residue === "receipt") s.files.set(d180Proposed + "/marker.json", "future-looking")
          if (prepared === "torn") s.files.set(d180Prepared, "{torn")

          const before = new Map(s.files)
          const writes = s.writes.length
          const result = await inspectV4FencedLocalCrashTriageAfterRestart(s.input())
          const label = [settings, activeIndex, residue, prepared].join("/")
          const expected = residue !== "absent"
            ? "unrecognized-selector-or-commit-artifact"
            : prepared === "torn"
              ? "missing-or-invalid-prepared-evidence"
              : settings === "source" && activeIndex === "source"
                ? "source-still-selected"
                : settings === "destination" && activeIndex === "destination"
                  ? "destination-looking-without-authoritative-commit"
                  : "mixed-or-changed-local-state"
          assert.equal(result.reason, expected, label)
          assert.equal(result.localCutoverAuthorized, false, label)
          assert.equal(result.resumeSyncAuthorized, false, label)
          assert.equal(result.rollbackAuthorized, false, label)
          assert.equal(result.oldPassphraseCleanupAuthorized, false, label)
          assert.deepEqual(s.files, before, label)
          assert.equal(s.writes.length, writes, label)
        }
      }
    }
  }
})

test("D176 exact fence binding permits only prepared evidence, never committed Cutover", async () => {
  const s = fixture(V4_RUNTIME_INDEX_ROOT)
  await s.seed()
  await armFixtureFence(s)
  const originals = new Map(s.files)
  const writes = s.writes.length
  const input = s.input()
  const stage = await stageV4FencedBestEffortPreparedSelector(input)
  assert.equal(stage.status, "authenticated-prepared-selector-uncommitted")
  assert.equal(stage.localCutoverAuthorized, false)
  assert.equal(stage.resumeSyncAuthorized, false)
  assert.deepEqual(s.writes.slice(writes), [
    V4_RUNTIME_INDEX_ROOT + "-rekey-selector-" + identity.runId + "/prepared.json",
  ])
  for (const [path, value] of originals) assert.equal(s.files.get(path), value, path)
  assert.equal(s.settings.githubBranch, "main")
  await assert.rejects(() => assertV4ReencryptionSyncFenceClear(s.adapter))
  const reopened = await inspectV4FencedBestEffortPreparedSelectorAfterRestart(s.input())
  assert.equal(reopened.observation, "authenticated-prepared-selector-uncommitted")
  assert.equal(reopened.localCutoverAuthorized, false)
  assert.equal(reopened.resumeSyncAuthorized, false)
  assert.equal(reopened.oldPassphraseCleanupAuthorized, false)
  assert.equal(s.writes.length, writes + 1)
  await assert.rejects(() => stageV4FencedBestEffortPreparedSelector(s.input()), /Existing.*Manual Recovery/)
})

test("D176 missing, foreign, torn, extra-field and noncanonical fence refuse any prepared Selector writes", async () => {
  const s = fixture(V4_RUNTIME_INDEX_ROOT)
  await s.seed()
  const before = s.writes.length
  await assert.rejects(() => stageV4FencedBestEffortPreparedSelector(s.input()), /fence/i)
  assert.equal(s.writes.length, before)
  await armFixtureFence(s)
  const good = s.files.get(fenceMarker)!
  const cases = [
    good.replace(identity.runId, "different_run_176"),
    good.replace(identity.sourceRepoId, "owner/vault#other"),
    good.replace(identity.destinationRepoId, "owner/vault#rekey/foreign"),
    good.slice(0, -7),
    good + "\n",
    good.replace('"schemaVersion":1', '"schemaVersion":1,"authorized":true'),
    "z".repeat(513),
  ]
  for (const tampered of cases) {
    s.files.set(fenceMarker, tampered)
    const count = s.writes.length
    await assert.rejects(() => stageV4FencedBestEffortPreparedSelector(s.input()), /fence/i)
    assert.equal(s.writes.length, count)
    assert.equal((await inspectV4FencedBestEffortPreparedSelectorAfterRestart(s.input())).observation,
      "manual-recovery-required")
    await assert.rejects(() => assertV4ReencryptionSyncFenceClear(s.adapter))
  }
  s.files.set(fenceMarker, good)
  s.dirs.delete(V4_REENCRYPTION_SYNC_FENCE_ROOT)
  const count = s.writes.length
  await assert.rejects(() => stageV4FencedBestEffortPreparedSelector(s.input()), /fence/i)
  assert.equal(s.writes.length, count)
})

test("D176 fence mutation during prepared evidence write retains ambiguous record and never retries", async () => {
  const s = fixture(V4_RUNTIME_INDEX_ROOT)
  await s.seed()
  await armFixtureFence(s)
  const originalWrite = s.adapter.write
  const marker = s.files.get(fenceMarker)!
  s.adapter.write = async (path, content) => {
    await originalWrite(path, content)
    if (path.endsWith("/prepared.json")) s.files.set(fenceMarker, marker.replace(identity.runId, "swapped_run_176"))
  }
  const before = s.writes.length
  await assert.rejects(() => stageV4FencedBestEffortPreparedSelector(s.input()), /fence/i)
  assert.equal(s.writes.length, before + 1)
  const stageRoot = V4_RUNTIME_INDEX_ROOT + "-rekey-selector-" + identity.runId
  assert.equal(s.files.has(stageRoot + "/prepared.json"), true)
  assert.equal(s.files.has(stageRoot + "/selector.json"), false)
  await assert.rejects(() => assertV4ReencryptionSyncFenceClear(s.adapter))
  assert.equal((await inspectV4FencedBestEffortPreparedSelectorAfterRestart(s.input())).observation,
    "manual-recovery-required")
  await assert.rejects(() => stageV4FencedBestEffortPreparedSelector(s.input()))
  assert.equal(s.writes.length, before + 1)
})

test("D176 missing fence during restart never certifies a previously staged record", async () => {
  const s = fixture(V4_RUNTIME_INDEX_ROOT)
  await s.seed()
  await armFixtureFence(s)
  await stageV4FencedBestEffortPreparedSelector(s.input())
  const writes = s.writes.length
  s.files.delete(fenceMarker)
  const report = await inspectV4FencedBestEffortPreparedSelectorAfterRestart(s.input())
  assert.equal(report.observation, "manual-recovery-required")
  assert.equal(report.localCutoverAuthorized, false)
  assert.equal(report.resumeSyncAuthorized, false)
  assert.equal(s.writes.length, writes)
  assert.equal(s.dirs.has(V4_REENCRYPTION_SYNC_FENCE_ROOT), true)
  await assert.rejects(() => assertV4ReencryptionSyncFenceClear(s.adapter))
})

test("D175 stages and reopens authenticated prepared Selector next to the actual Runtime Index root", async () => {
  const s = fixture(V4_RUNTIME_INDEX_ROOT)
  await s.seed()
  const prior = new Map(s.files)
  const writes = s.writes.length
  const runRoots = planV4ReencryptionSeparatedRoots(V4_RUNTIME_INDEX_ROOT, identity.runId)
  const expectedEvidence = runRoots.selectorPath.replace(/selector\.json$/u, "prepared.json")
  const stage = await stageV4BestEffortPreparedSelectorEvidence(s.input())
  assert.equal(stage.evidencePath, expectedEvidence)
  assert.equal(stage.localCutoverAuthorized, false)
  assert.equal(stage.resumeSyncAuthorized, false)
  assert.deepEqual(s.writes.slice(writes), [expectedEvidence])
  for (const [path, value] of prior) assert.equal(s.files.get(path), value, path)
  assert.equal(s.files.has(runRoots.selectorPath), false)
  assert.equal(s.files.has(roots.selectorPath), false)
  const read = await inspectV4BestEffortPreparedSelectorAfterRestart(s.input())
  assert.equal(read.observation, "authenticated-prepared-selector-uncommitted")
  assert.equal(read.localCutoverAuthorized, false)
  assert.equal(read.resumeSyncAuthorized, false)
  assert.equal(s.writes.length, writes + 1)
  assert.equal(s.settings.githubBranch, "main")
  assert.equal(s.settings.encryptionPassphraseSecretId, "old-secret")
})

test("D172 reopened prepared evidence remains uncommitted and read-only", async () => {
  const s = fixture()
  await s.seed()
  await stageV4BestEffortPreparedSelectorEvidence(s.input())
  const files = new Map(s.files)
  const before = s.writes.length
  const report = await inspectV4BestEffortPreparedSelectorAfterRestart(s.input())
  assert.deepEqual(report, {
    integrityScope: "read-only-prepared-selector-and-authenticated-wal",
    evidence: "best-effort-wal-readback-not-power-loss-durable",
    observation: "authenticated-prepared-selector-uncommitted",
    localCutoverAuthorized: false, resumeSyncAuthorized: false,
    rollbackAuthorized: false, oldPassphraseCleanupAuthorized: false,
  })
  assert.equal(Object.isFrozen(report), true)
  assert.deepEqual(s.files, files)
  assert.equal(s.writes.length, before)
  assert.equal(await s.adapter.exists(roots.selectorPath), false)
})

test("D172 restored encrypted evidence rejects tampering, replayed identity and stale WAL without writing", async () => {
  const s = fixture()
  await s.seed()
  await stageV4BestEffortPreparedSelectorEvidence(s.input())
  const bytes = s.files.get(preparedPath)!
  const before = s.writes.length
  for (const broken of [bytes.slice(0, -5), bytes + "\n", "A".repeat(8195)]) {
    s.files.set(preparedPath, broken)
    assert.equal((await inspectV4BestEffortPreparedSelectorAfterRestart(s.input())).observation,
      "manual-recovery-required")
  }
  s.files.set(preparedPath, bytes)
  const wrongKey = s.input()
  wrongKey.journalKey[0] ^= 1
  assert.equal((await inspectV4BestEffortPreparedSelectorAfterRestart(wrongKey)).observation,
    "manual-recovery-required")
  const original = s.walSnapshot()
  s.setWal({ ...original, pendingRefIntents: [original.verifiedRefObservations[1]!] })
  assert.equal((await inspectV4BestEffortPreparedSelectorAfterRestart(s.input())).observation,
    "manual-recovery-required")
  s.setWal(original)
  s.files.set(roots.selectorPath, "incomplete active selector")
  assert.equal((await inspectV4BestEffortPreparedSelectorAfterRestart(s.input())).observation,
    "manual-recovery-required")
  assert.equal(s.writes.length, before)
})

test("D172 cooperative overlapping preparation allows no second encrypted write", async () => {
  const s = fixture()
  await s.seed()
  const input = s.input()
  const holder = input.withExclusiveInitiatorLease
  let entered!: () => void
  let release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  let first = true
  input.withExclusiveInitiatorLease = async body => {
    if (first) { first = false; entered(); await held }
    return holder(body)
  }
  const running = stageV4BestEffortPreparedSelectorEvidence(input)
  await started
  try {
    const before = s.writes.length
    await assert.rejects(() => stageV4BestEffortPreparedSelectorEvidence(s.input()),
      /Concurrent.*Manual Recovery/)
    assert.equal(s.writes.length, before)
  } finally { release() }
  assert.equal((await running).status, "authenticated-prepared-selector-uncommitted")
  assert.equal(s.files.has(preparedPath), true)
})

test("D172 writes a distinct encrypted prepared selector once and preserves source/settings/indices", async () => {
  const s = fixture()
  await s.seed()
  const before = new Map(s.files)
  const writes = s.writes.length
  const report = await stageV4BestEffortPreparedSelectorEvidence(s.input())
  assert.deepEqual(report, {
    status: "authenticated-prepared-selector-uncommitted",
    evidencePath: preparedPath,
    evidence: "best-effort-wal-readback-not-power-loss-durable",
    localCutoverAuthorized: false, resumeSyncAuthorized: false,
    rollbackAuthorized: false, oldPassphraseCleanupAuthorized: false,
  })
  assert.deepEqual(s.writes.slice(writes), [preparedPath])
  for (const [path, value] of before) assert.equal(s.files.get(path), value, path)
  assert.equal(await s.adapter.exists(roots.selectorPath), false)
  assert.equal(s.settings.githubBranch, "main")
  assert.equal(s.settings.encryptionPassphraseSecretId, "old-secret")
  const sealed = s.files.get(preparedPath)!
  assert.equal(await authenticateV4ReencryptionPreparedSelectorEvidence(sealed, identity, s.key), true)
  assert.equal(await authenticateV4ReencryptionSeparatedSelectorTestVector(sealed, identity, s.key), false)
  assert.equal(s.checks >= 18, true)
  await assert.rejects(() => stageV4BestEffortPreparedSelectorEvidence(s.input()), /Existing.*Manual Recovery/)
  assert.equal(s.writes.length, writes + 1)
  assert.doesNotMatch(sealed, /old-secret|new-secret|old-value|new-value/)
})

test("D172 wrong acknowledgement, identity, missing D170 intent and incomplete WAL all deny writes", async () => {
  for (const cause of ["consent", "identity", "intent", "wal", "selector"] as const) {
    const s = fixture()
    await s.seed()
    const input = s.input()
    if (cause === "consent") input.restart.acknowledgement = "no" as typeof consent
    if (cause === "identity") input.identity.destinationTreeSha = "f".repeat(40)
    if (cause === "intent") s.files.delete(intentPath)
    if (cause === "wal") s.setWal({
      ...s.walSnapshot(), pendingRefIntents: [s.walSnapshot().verifiedRefObservations[1]!],
    })
    if (cause === "selector") s.files.set(roots.selectorPath, "occupied")
    const writes = s.writes.length
    await assert.rejects(() => stageV4BestEffortPreparedSelectorEvidence(input))
    assert.equal(s.writes.length, writes, cause)
    assert.equal(s.files.has(preparedPath), false, cause)
  }
})

test("D172 lost prepared evidence write response preserves partial record and forbids restart/retry", async () => {
  const s = fixture()
  await s.seed()
  const input = s.input()
  const original = input.restart.indexAdapter.write
  input.restart.indexAdapter.write = async (path, value) => {
    await original(path, value)
    if (path === preparedPath) throw Error("lost write response")
  }
  await assert.rejects(() => stageV4BestEffortPreparedSelectorEvidence(input), /lost write response/)
  assert.equal(s.files.has(preparedPath), true)
  assert.equal(await s.adapter.exists(roots.selectorPath), false)
  await assert.rejects(() => stageV4BestEffortPreparedSelectorEvidence(s.input()), /Existing.*Manual Recovery/)
})

test("D172 changed Source Settings or encrypted evidence during awaited checkpoint never reports success", async () => {
  const s = fixture()
  await s.seed()
  const input = s.input()
  const normal = input.restart.wal.assertBestEffortCheckpoint
  let changed = false
  input.restart.wal.assertBestEffortCheckpoint = async () => {
    const result = await normal()
    if (!changed && s.files.has(preparedPath)) {
      changed = true
      s.settings.githubBranch = "other"
    }
    return result
  }
  await assert.rejects(() => stageV4BestEffortPreparedSelectorEvidence(input), /Manual Recovery/)
  assert.equal(changed, true)
  assert.equal(await s.adapter.exists(roots.selectorPath), false)
})

test("D172/D180 real Windows WAL reopened under a fresh lease permits read-only fenced crash triage", async () => {
  const parent = join(process.cwd(), ".tmp")
  await mkdir(parent, { recursive: true })
  const directory = await mkdtemp(join(parent, "d172-prepared-"))
  try {
    let staged: ReturnType<typeof fixture> | null = null
    const storage = await acquireV4DesktopRekeyWalStorage({ rootAbsolute: directory, journalRoot: "rekey/wal" })
    try {
      const journal = createV4ReencryptionRecoveryJournal({
        adapter: storage.adapter, root: "rekey/wal",
        runId: identity.runId, journalKey: new Uint8Array(32).fill(0x72),
        sourceCommitSha: identity.sourceCommitSha, destinationRepoId: identity.destinationRepoId,
      })
      let w = await journal.begin()
      const backup = { role: "backup" as const, repoId: identity.backupRepoId,
        commitSha: identity.sourceCommitSha, treeSha: identity.sourceTreeSha }
      w = await journal.recordRefIntent(backup, w.generation)
      w = await journal.markRefReadbackObserved(backup, w.generation)
      w = await journal.recordStagingHandoff(backup, w.generation)
      w = await journal.recordCandidatePreparationIntent("f".repeat(64), w.generation)
      w = await journal.recordPreparedCandidateReceipt({
        commitSha: identity.destinationCommitSha,
        treeSha: identity.destinationTreeSha, manifestSha256: identity.manifestSha256,
      }, w.generation)
      const dest = { role: "destination" as const, repoId: identity.destinationRepoId,
        commitSha: identity.destinationCommitSha,
        treeSha: identity.destinationTreeSha, manifestSha256: identity.manifestSha256 }
      w = await journal.recordRefIntent(dest, w.generation)
      w = await journal.markRefReadbackObserved(dest, w.generation)
      assert.equal(w.generation, 8)
      const s = fixture()
      staged = s
      await s.seed()
      await armFixtureFence(s)
      const before = new Map(s.files)
      const input = s.input()
      input.restart.journal = journal
      input.restart.wal = {
        async assertExclusiveStageLease() { await storage.assertExclusiveStageLease() },
        async assertBestEffortCheckpoint() { return storage.assertBestEffortCheckpoint() },
      }
      const report = await stageV4BestEffortPreparedSelectorEvidence(input)
      assert.equal(report.localCutoverAuthorized, false)
      for (const [path, value] of before) assert.equal(s.files.get(path), value)
      assert.equal(await journal.assertHealthySnapshot(8).then(x => x.verifiedRefObservations.length), 2)
      assert.equal(s.files.has(preparedPath), true)
    } finally { await storage.release() }
    const reopened = await acquireV4DesktopRekeyWalStorage({
      rootAbsolute: directory, journalRoot: "rekey/wal",
    })
    try {
      assert.ok(staged)
      const journal = createV4ReencryptionRecoveryJournal({
        adapter: reopened.adapter, root: "rekey/wal",
        runId: identity.runId, journalKey: new Uint8Array(32).fill(0x72),
        sourceCommitSha: identity.sourceCommitSha, destinationRepoId: identity.destinationRepoId,
      })
      const input = staged.input()
      input.restart.journal = journal
      input.restart.wal = {
        async assertExclusiveStageLease() { await reopened.assertExclusiveStageLease() },
        async assertBestEffortCheckpoint() { return reopened.assertBestEffortCheckpoint() },
      }
      const before = new Map(staged.files)
      const report = await inspectV4BestEffortPreparedSelectorAfterRestart(input)
      assert.equal(report.observation, "authenticated-prepared-selector-uncommitted")
      assert.equal(report.resumeSyncAuthorized, false)
      assert.equal(report.localCutoverAuthorized, false)
      assert.deepEqual(staged.files, before)
      const triage = await inspectV4FencedLocalCrashTriageAfterRestart(input)
      assert.equal(triage.observation, "source-prepared-uncommitted")
      assert.equal(triage.reason, "source-still-selected")
      assert.equal(triage.localCutoverAuthorized, false)
      assert.equal(triage.resumeSyncAuthorized, false)
      assert.deepEqual(staged.files, before)
      staged.files.set(roots.selectorPath, "unexpected commit-looking residue")
      const ambiguous = await inspectV4FencedLocalCrashTriageAfterRestart(input)
      assert.equal(ambiguous.observation, "manual-recovery-required")
      assert.equal(ambiguous.reason, "unrecognized-selector-or-commit-artifact")
      await assert.rejects(() => assertV4ReencryptionSyncFenceClear(staged!.adapter))
    } finally { await reopened.release() }
  } finally { await rm(directory, { recursive: true, force: true }) }
})
