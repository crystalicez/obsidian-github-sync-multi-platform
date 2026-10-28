import assert from "node:assert/strict"
import test from "node:test"
import { createEmptyV4LocalIndex, loadV4LocalIndex, saveV4LocalIndex, type V4LocalIndexAdapter } from "../../src/lib/v4/local-index"
import type { V4ReencryptionJournalSnapshot } from "../../src/lib/v4/reencryption-recovery-journal"
import type { V4ReencryptionProposedCommitIdentity, V4ReencryptionProposedCommitInspectionInput } from "../../src/lib/v4/reencryption-proposed-commit-receipt"
import { planV4ReencryptionSeparatedRoots } from "../../src/lib/v4/reencryption-separated-selector"
import {
  inspectV4ReencryptionSeparatedSelectorAfterRestart,
  sealV4ReencryptionSeparatedSelectorTestVector,
} from "../../src/lib/v4/reencryption-separated-selector-prototype"

const identity: V4ReencryptionProposedCommitIdentity = {
  runId: "d146_run_123", walGeneration: 7, indexRoot: "private/index-v4", deviceId: "device146",
  sourceRepoId: "owner/vault#main", backupRepoId: "owner/vault#backup/rekey",
  destinationRepoId: "owner/vault#rekey/2026",
  sourceCommitSha: "a".repeat(40), sourceTreeSha: "c".repeat(40),
  destinationCommitSha: "b".repeat(40), destinationTreeSha: "d".repeat(40),
  manifestSha256: "e".repeat(64),
  sourcePassphraseSecretId: "secret-old", destinationPassphraseSecretId: "secret-new",
}
const roots = planV4ReencryptionSeparatedRoots(identity.indexRoot, identity.runId)
const expectedBase = {
  integrityScope: "authenticated-option-a-selector-prototype-uncommitted",
  localCutoverAuthorized: false, resumeSyncAuthorized: false,
  rollbackAuthorized: false, remoteWritesAuthorized: false,
  oldPassphraseCleanupAuthorized: false,
} as const
const manual = { ...expectedBase, observation: "manual-recovery-required" }
const observed = { ...expectedBase, observation: "authenticated-selector-with-both-indices-uncommitted" }

function fixture() {
  const files = new Map<string, string>()
  const secrets = new Map([[identity.sourcePassphraseSecretId, "old passphrase"],
    [identity.destinationPassphraseSecretId, "new passphrase"]])
  const key = new Uint8Array(32).fill(46)
  let writes = 0
  let reads = 0
  let held = false
  let wal: V4ReencryptionJournalSnapshot = {
    generation: identity.walGeneration, receipts: [], pendingIntents: [], pendingRefIntents: [],
    verifiedRefObservations: [
      { role: "backup", repoId: identity.backupRepoId,
        commitSha: identity.sourceCommitSha, treeSha: identity.sourceTreeSha },
      { role: "destination", repoId: identity.destinationRepoId,
        commitSha: identity.destinationCommitSha, treeSha: identity.destinationTreeSha,
        manifestSha256: identity.manifestSha256 },
    ],
    preparedCandidateReceipt: { commitSha: identity.destinationCommitSha,
      treeSha: identity.destinationTreeSha, manifestSha256: identity.manifestSha256 },
    candidatePreparationSha256: "f".repeat(64), stageHandoffStarted: true,
    requiresRemoteRevalidation: true, permissionToPublish: false, cutoverAuthorized: false,
  }
  const adapter: V4LocalIndexAdapter = {
    async exists(path) { return files.has(path) },
    async read(path) {
      reads++
      const value = files.get(path)
      if (value === undefined) throw new Error("missing " + path)
      return value
    },
    async stat(path) {
      const value = files.get(path)
      return value === undefined ? null : { size: Buffer.byteLength(value) }
    },
    async mkdir() {},
    async write(path, value) { writes++; files.set(path, value) },
  }
  const journal = {
    sourceCommitSha: identity.sourceCommitSha, destinationRepoId: identity.destinationRepoId,
    async assertHealthySnapshot(generation: number) {
      assert.equal(held, true)
      assert.equal(generation, identity.walGeneration)
      return structuredClone(wal)
    },
  }
  const settings = {
    githubOwner: "owner", githubRepo: "vault", githubBranch: "rekey/2026",
    encryptionMode: "encrypted", encryptionPassphraseSecretId: identity.destinationPassphraseSecretId,
    vault: identity.deviceId,
  }
  const withExclusiveInitiatorLease = async <T>(body: () => Promise<T>): Promise<T> => {
    assert.equal(held, false)
    held = true
    try { return await body() } finally { held = false }
  }
  const assertExclusiveInitiatorLease = async () => { assert.equal(held, true) }
  const assertCrashDurable = async () => { assert.equal(held, true) }
  const input = (): V4ReencryptionProposedCommitInspectionInput => ({
    identity: { ...identity }, journalKey: key, adapter, settings, journal,
    getSecret: id => secrets.get(id) ?? null,
    withExclusiveInitiatorLease, assertExclusiveInitiatorLease, assertCrashDurable,
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
    await saveV4LocalIndex(adapter, roots.sourceIndexRoot, source)
    await saveV4LocalIndex(adapter, roots.shadowIndexRoot, shadow)
    files.set(roots.selectorPath, await sealV4ReencryptionSeparatedSelectorTestVector(identity, key))
  }
  return { input, seed, files, secrets, key, adapter, settings, journal,
    setWal: (x: V4ReencryptionJournalSnapshot) => { wal = x },
    wal: () => wal, count: () => ({ writes, reads, held }) }
}

test("D146 AES-GCM independent selector readback preserves Source and Shadow without cutover", async () => {
  const s = fixture()
  await s.seed()
  const source = await loadV4LocalIndex(s.adapter, roots.sourceIndexRoot)
  const shadow = await loadV4LocalIndex(s.adapter, roots.shadowIndexRoot)
  assert.equal(source.repoId, identity.sourceRepoId)
  assert.equal(shadow.repoId, identity.destinationRepoId)
  assert.notEqual(source.repoId, shadow.repoId)
  const before = new Map(s.files)
  const count = s.count().writes
  assert.deepEqual(await inspectV4ReencryptionSeparatedSelectorAfterRestart(s.input()), observed)
  assert.equal(s.count().writes, count)
  assert.equal(s.count().held, false)
  assert.deepEqual(s.files, before)
  assert.equal(Object.isFrozen(await inspectV4ReencryptionSeparatedSelectorAfterRestart(s.input())), true)
  assert.doesNotMatch(JSON.stringify(observed), /old passphrase|new passphrase|secret-old|secret-new/)
})

test("D146 altered, absent and torn Selector cannot pass authentication", async () => {
  for (const alter of [(x: string) => x.slice(0, -4),
    (x: string) => x.replace(/^[A-Za-z]/u, "Z"),
    (x: string) => x + "\n", () => "A".repeat(8200), () => "", () => "{}"]) {
    const s = fixture()
    await s.seed()
    s.files.set(roots.selectorPath, alter(s.files.get(roots.selectorPath)!))
    assert.deepEqual(await inspectV4ReencryptionSeparatedSelectorAfterRestart(s.input()), manual)
  }
  const missing = fixture()
  await missing.seed()
  missing.files.delete(roots.selectorPath)
  assert.deepEqual(await inspectV4ReencryptionSeparatedSelectorAfterRestart(missing.input()), manual)
})

test("D146 wrong key or replayed run, WAL, Secret IDs, branches and tree cannot pass", async () => {
  for (const patch of [
    { runId: "other_run_12" }, { walGeneration: 8 },
    { backupRepoId: "owner/vault#another" }, { destinationRepoId: "owner/vault#rekey/other" },
    { sourceTreeSha: "1".repeat(40) }, { manifestSha256: "3".repeat(64) },
    { destinationPassphraseSecretId: "different-new" },
  ]) {
    const s = fixture()
    await s.seed()
    const changed = s.input()
    changed.identity = { ...changed.identity, ...patch }
    if (patch.destinationRepoId !== undefined) {
      await assert.rejects(() => inspectV4ReencryptionSeparatedSelectorAfterRestart(changed),
        /Incomplete separated selector readback contract/)
    } else {
      assert.deepEqual(await inspectV4ReencryptionSeparatedSelectorAfterRestart(changed), manual)
    }
  }
  const wrong = fixture()
  await wrong.seed()
  wrong.key[0] ^= 1
  assert.deepEqual(await inspectV4ReencryptionSeparatedSelectorAfterRestart(wrong.input()), manual)
})

test("D146 keeps manual recovery for mismatched Source, Shadow, Settings, WAL or missing secret", async () => {
  for (const failure of ["source", "shadow", "settings", "old", "new", "wal"] as const) {
    const s = fixture()
    await s.seed()
    if (failure === "source") {
      const index = await loadV4LocalIndex(s.adapter, roots.sourceIndexRoot)
      index.remoteCommitSha = "8".repeat(40)
      await saveV4LocalIndex(s.adapter, roots.sourceIndexRoot, index)
    } else if (failure === "shadow") {
      const index = await loadV4LocalIndex(s.adapter, roots.shadowIndexRoot)
      index.repoId = identity.sourceRepoId
      await saveV4LocalIndex(s.adapter, roots.shadowIndexRoot, index)
    } else if (failure === "settings") s.settings.githubBranch = "main"
    else if (failure === "old") s.secrets.delete(identity.sourcePassphraseSecretId)
    else if (failure === "new") s.secrets.delete(identity.destinationPassphraseSecretId)
    else s.setWal({ ...s.wal(), pendingIntents: [{ kind: "invalid" }] as V4ReencryptionJournalSnapshot["pendingIntents"] })
    assert.deepEqual(await inspectV4ReencryptionSeparatedSelectorAfterRestart(s.input()), manual)
  }
})

test("D146 mid-read replacement of selector, WAL, Settings and reader cannot pass", async () => {
  for (const failure of ["selector", "wal", "settings", "reader", "key"] as const) {
    const s = fixture()
    await s.seed()
    const input = s.input()
    const original = input.journal.assertHealthySnapshot
    let changed = false
    input.journal.assertHealthySnapshot = async generation => {
      const current = await original(generation)
      if (!changed) {
        changed = true
        if (failure === "selector") s.files.set(roots.selectorPath, "torn")
        if (failure === "wal") s.setWal({ ...s.wal(), generation: 99 })
        if (failure === "settings") s.settings.githubBranch = "main"
        if (failure === "reader") input.adapter.read = async () => "forged"
        if (failure === "key") input.journalKey[0] ^= 1
      }
      return current
    }
    assert.deepEqual(await inspectV4ReencryptionSeparatedSelectorAfterRestart(input), manual)
  }
})

test("D146 unsupported lease holder and invalid inputs refuse positive authority", async () => {
  const s = fixture()
  await s.seed()
  const skipped = s.input()
  skipped.withExclusiveInitiatorLease = async () => observed as never
  assert.deepEqual(await inspectV4ReencryptionSeparatedSelectorAfterRestart(skipped), manual)
  const duplicate = s.input()
  const originalHolder = duplicate.withExclusiveInitiatorLease
  duplicate.withExclusiveInitiatorLease = async body => {
    await originalHolder(body)
    return originalHolder(body)
  }
  await assert.rejects(() => inspectV4ReencryptionSeparatedSelectorAfterRestart(duplicate), /invoked repeatedly/)
  await assert.rejects(() => sealV4ReencryptionSeparatedSelectorTestVector(
    { ...identity, sourceRepoId: identity.destinationRepoId }, s.key), /three distinct refs/)
  await assert.rejects(() => sealV4ReencryptionSeparatedSelectorTestVector(
    identity, new Uint8Array(16)), /requires the V4 journal key/)
})
