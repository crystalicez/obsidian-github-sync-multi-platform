import assert from "node:assert/strict"
import test from "node:test"
import { createEmptyV4LocalIndex, loadV4LocalIndex, saveV4LocalIndex, type V4LocalIndexAdapter } from "../../src/lib/v4/local-index"
import type { V4ReencryptionJournalSnapshot } from "../../src/lib/v4/reencryption-recovery-journal"
import {
  assertV4ReencryptionProposedCommitIdentity,
  sealV4ReencryptionProposedCommitTestVector,
  inspectV4ReencryptionProposedCommitAfterRestart,
  type V4ReencryptionProposedCommitIdentity,
  type V4ReencryptionProposedCommitInspectionInput,
  type V4ReencryptionProposedCommitReport,
} from "../../src/lib/v4/reencryption-proposed-commit-receipt"
import { encryptV4Payload } from "../../src/lib/v4/crypto"
import { V4_RUNTIME_INDEX_ROOT } from "../../src/lib/v4/reencryption-index-root"
import { toBase64, utf8ToBytes } from "../../src/lib/bytes"

const identity: V4ReencryptionProposedCommitIdentity = {
  runId: "run_d142_123", walGeneration: 14, indexRoot: "private/v4-index",
  deviceId: "device142",
  sourceRepoId: "owner/vault#main", backupRepoId: "owner/vault#backup/rekey",
  destinationRepoId: "owner/vault#rekey/2026",
  sourceCommitSha: "a".repeat(40), sourceTreeSha: "c".repeat(40),
  destinationCommitSha: "b".repeat(40), destinationTreeSha: "d".repeat(40),
  manifestSha256: "e".repeat(64),
  sourcePassphraseSecretId: "old-secret", destinationPassphraseSecretId: "new-secret",
}
const markerPath = identity.indexRoot + "-rekey-proposed-" + identity.runId + "/marker.json"
const shadowRoot = identity.indexRoot + "-rekey-" + identity.runId
const newKey = () => new Uint8Array(32).fill(13)
const gates = {
  integrityScope: "authenticated-hypothetical-local-marker-read-only",
  localCutoverAuthorized: false,
  resumeSyncAuthorized: false,
  rollbackAuthorized: false,
  remoteWritesAuthorized: false,
  oldPassphraseCleanupAuthorized: false,
} as const
const manual = { ...gates, observation: "manual-recovery-required" }
const observed = { ...gates, observation: "authenticated-marker-with-destination-observed-uncommitted" }

function fixture() {
  const files = new Map<string, string>()
  const secrets = new Map([["old-secret", "old-passphrase"], ["new-secret", "new-passphrase"]])
  const key = newKey()
  let writes = 0
  let walReads = 0
  let held = false
  const adapter: V4LocalIndexAdapter = {
    async read(path) {
      const content = files.get(path)
      if (content === undefined) throw new Error("missing " + path)
      return content
    },
    async exists(path) { return files.has(path) },
    async mkdir() {},
    async write(path, value) { writes++; files.set(path, value) },
    async stat(path) {
      const value = files.get(path)
      return value ? { size: utf8ToBytes(value).byteLength } : null
    },
  }
  let wal: V4ReencryptionJournalSnapshot = {
    generation: identity.walGeneration, receipts: [], pendingIntents: [], pendingRefIntents: [],
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
  const journal = {
    sourceCommitSha: identity.sourceCommitSha, destinationRepoId: identity.destinationRepoId,
    async assertHealthySnapshot(generation: number) {
      assert.equal(held, true)
      assert.equal(generation, identity.walGeneration)
      walReads++
      return wal
    },
  }
  const settings = {
    githubOwner: "owner", githubRepo: "vault", githubBranch: "rekey/2026",
    encryptionMode: "encrypted", encryptionPassphraseSecretId: "new-secret", vault: "device142",
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
    const index = createEmptyV4LocalIndex({
      repoId: identity.destinationRepoId, deviceId: identity.deviceId, mode: "encrypted",
    })
    index.remoteCommitSha = identity.destinationCommitSha
    await saveV4LocalIndex(adapter, identity.indexRoot, index)
    await saveV4LocalIndex(adapter, shadowRoot, index)
    files.set(markerPath, await sealV4ReencryptionProposedCommitTestVector(identity, key))
  }
  return {
    seed, input, adapter, settings, files, secrets, journal, key,
    setWal(next: V4ReencryptionJournalSnapshot) { wal = next },
    getWal() { return wal },
    count() { return { writes, walReads, held } },
  }
}

async function inspect(s: ReturnType<typeof fixture>): Promise<V4ReencryptionProposedCommitReport> {
  return inspectV4ReencryptionProposedCommitAfterRestart(s.input())
}

test("D175 proposed Cutover identity accepts only the existing single-segment runtime Index root", () => {
  assert.doesNotThrow(() => assertV4ReencryptionProposedCommitIdentity({
    ...identity, indexRoot: V4_RUNTIME_INDEX_ROOT,
  }))
  for (const indexRoot of ["index", "github-sync-v4-stage", "../github-sync-v4-index",
    "github-sync-v4-index/..", "github-sync-v4-index\\wrong"]) {
    assert.throws(() => assertV4ReencryptionProposedCommitIdentity({
      ...identity, indexRoot,
    }), /Invalid proposed cutover receipt identity/)
  }
})

test("D142 genuine AES-GCM proposed marker + stable destination index/WAL is still NEVER durable authorization", async () => {
  const s = fixture()
  await s.seed()
  const before = new Map(s.files)
  const writes = s.count().writes
  const result = await inspect(s)
  assert.deepEqual(result, observed)
  assert.deepEqual(s.files, before)
  assert.equal(s.count().writes, writes)
  assert.equal(s.count().walReads, 2)
  assert.equal(s.count().held, false)
  assert.doesNotMatch(JSON.stringify(result), /old-passphrase|new-passphrase|old-secret|new-secret/)
  assert.equal(Object.isFrozen(result), true)
})

test("D142 a marker is not authority if real active Index or Settings remain at Source", async () => {
  for (const kind of ["active-index", "settings-branch", "settings-key", "settings-vault"] as const) {
    const s = fixture()
    await s.seed()
    if (kind === "active-index") {
      const source = await loadV4LocalIndex(s.adapter, identity.indexRoot)
      source.repoId = identity.sourceRepoId
      source.remoteCommitSha = identity.sourceCommitSha
      await saveV4LocalIndex(s.adapter, identity.indexRoot, source)
    } else if (kind === "settings-branch") s.settings.githubBranch = "main"
    else if (kind === "settings-key") s.settings.encryptionPassphraseSecretId = "old-secret"
    else s.settings.vault = "other"
    assert.deepEqual(await inspect(s), manual)
  }
})

test("D142 malformed, truncated, overlimit and modified encrypted marker never passes authentication", async () => {
  for (const mutate of [
    (value: string) => "{" + value,
    (value: string) => value.slice(0, -3),
    (value: string) => value.replace(/[A-Za-z0-9]/u, "Z"),
    (value: string) => value + "\n",
    () => "A".repeat(8200),
    () => "",
  ]) {
    const s = fixture()
    await s.seed()
    s.files.set(markerPath, mutate(s.files.get(markerPath)!))
    assert.deepEqual(await inspect(s), manual)
  }
  const s = fixture()
  await s.seed()
  s.files.delete(markerPath)
  assert.deepEqual(await inspect(s), manual)
})

test("D142 replayed, wrong-key, and wrong Git/manifest/WAL identity fail closed", async () => {
  for (const mutation of ["wrong-key", "run", "source", "destination", "manifest", "wrong-WAL"] as const) {
    const s = fixture()
    await s.seed()
    const input = s.input()
    if (mutation === "wrong-key") input.journalKey.fill(90)
    if (mutation === "run") input.identity.runId = "run_different"
    if (mutation === "source") input.identity.sourceCommitSha = "9".repeat(40)
    if (mutation === "destination") input.identity.destinationCommitSha = "8".repeat(40)
    if (mutation === "manifest") input.identity.manifestSha256 = "7".repeat(64)
    if (mutation === "wrong-WAL") {
      s.setWal({ ...s.getWal(), verifiedRefObservations: [
        ...s.getWal().verifiedRefObservations.slice(0, 1),
        { ...s.getWal().verifiedRefObservations[1]!, manifestSha256: "7".repeat(64) },
      ] })
    }
    if (mutation === "source") {
      await assert.rejects(() => inspectV4ReencryptionProposedCommitAfterRestart(input),
        /Incomplete proposed cutover restart reader contract/)
    } else {
      assert.deepEqual(await inspectV4ReencryptionProposedCommitAfterRestart(input), manual)
    }
  }
})

test("D142 same-key authenticated extra fields and unknown phase remain invalid", async () => {
  const s = fixture()
  await s.seed()
  const key = s.key
  const hmacKey = await crypto.subtle.importKey("raw", key as any,
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  const derived = new Uint8Array(await crypto.subtle.sign("HMAC", hmacKey,
    utf8ToBytes("v4-rekey-proposed-local-commit-v1:key") as any))
  const aad = "v4-rekey-proposed-local-commit-v1:" + identity.runId + ":"
    + identity.sourceCommitSha + ":" + identity.destinationRepoId + ":" + identity.destinationCommitSha
  for (const record of [
    { schemaVersion: 1, phase: "hypothetical-commit-marker-uncommitted", identity, cutoverAuthorized: true },
    { schemaVersion: 1, phase: "committed", identity },
    { schemaVersion: 1, phase: "hypothetical-commit-marker-uncommitted",
      identity: { ...identity, backupRepoId: "owner/vault#another" } },
  ]) {
    const ciphertext = await encryptV4Payload(derived, utf8ToBytes(JSON.stringify(record)), {
      kind: "journal", aad,
    })
    s.files.set(markerPath, toBase64(ciphertext))
    assert.deepEqual(await inspect(s), manual)
  }
  derived.fill(0)
})

test("D142 torn WAL, missing old or new SecretStorage and incomplete Shadow never certify marker", async () => {
  for (const fault of ["wal", "old", "new", "shadow"] as const) {
    const s = fixture()
    await s.seed()
    if (fault === "wal") {
      s.setWal({ ...s.getWal(), pendingRefIntents: [
        { role: "destination", repoId: identity.destinationRepoId,
          commitSha: identity.destinationCommitSha, treeSha: identity.destinationTreeSha,
          manifestSha256: identity.manifestSha256 },
      ] })
    } else if (fault === "old") s.secrets.delete("old-secret")
    else if (fault === "new") s.secrets.delete("new-secret")
    else s.files.delete(shadowRoot + "/index.json")
    assert.deepEqual(await inspect(s), manual)
  }
})

test("D142 changing Settings, active Index, marker, WAL or key during awaits returns manual", async () => {
  for (const fault of ["settings", "index", "marker", "wal", "key"] as const) {
    const s = fixture()
    await s.seed()
    const input = s.input()
    const original = input.journal.assertHealthySnapshot
    let changed = false
    input.journal.assertHealthySnapshot = async generation => {
      if (!changed) {
        changed = true
        if (fault === "settings") s.settings.githubBranch = "main"
        if (fault === "index") {
          const index = await loadV4LocalIndex(s.adapter, identity.indexRoot)
          index.generation++
          await saveV4LocalIndex(s.adapter, identity.indexRoot, index)
        }
        if (fault === "marker") s.files.set(markerPath, "broken")
        if (fault === "wal") s.setWal({ ...s.getWal(), generation: 22 })
        if (fault === "key") input.journalKey.fill(21)
      }
      return original(generation)
    }
    assert.deepEqual(await inspectV4ReencryptionProposedCommitAfterRestart(input), manual)
    assert.equal(changed, true)
  }
})

test("D142 method substitution, holder omission and twice-invoked body fail closed", async () => {
  const changed = fixture()
  await changed.seed()
  const input = changed.input()
  const oldHolder = input.withExclusiveInitiatorLease
  const oldRead = input.adapter.read
  input.withExclusiveInitiatorLease = async body => oldHolder(async () => {
    input.adapter.read = async path => oldRead(path)
    return body()
  })
  assert.deepEqual(await inspectV4ReencryptionProposedCommitAfterRestart(input), manual)
  input.adapter.read = oldRead
  const skipped = fixture()
  await skipped.seed()
  assert.deepEqual(await inspectV4ReencryptionProposedCommitAfterRestart({
    ...skipped.input(),
    withExclusiveInitiatorLease: async () => observed as never,
  }), manual)
  const repeated = fixture()
  await repeated.seed()
  const body = repeated.input()
  await assert.rejects(() => inspectV4ReencryptionProposedCommitAfterRestart({
    ...body,
    withExclusiveInitiatorLease: async execute => body.withExclusiveInitiatorLease(async () => {
      await execute()
      return execute()
    }),
  }), /invoked repeatedly/)
})

test("D142 lease, durability and authenticated WAL errors propagate without a positive result", async () => {
  const s = fixture()
  await s.seed()
  await assert.rejects(() => inspectV4ReencryptionProposedCommitAfterRestart({
    ...s.input(), assertExclusiveInitiatorLease: async () => { throw new Error("lease gone") },
  }), /lease gone/)
  await assert.rejects(() => inspectV4ReencryptionProposedCommitAfterRestart({
    ...s.input(), assertCrashDurable: async () => { throw new Error("EPERM fsync") },
  }), /EPERM/)
  await assert.rejects(() => inspectV4ReencryptionProposedCommitAfterRestart({
    ...s.input(), journal: { ...s.journal,
      async assertHealthySnapshot() { throw new Error("torn journal") } },
  }), /torn journal/)
  assert.equal(s.count().held, false)
})

test("D142 invalid repo scopes and secret aliasing reject vectors before any serialization", async () => {
  const key = newKey()
  for (const invalid of [
    { ...identity, destinationRepoId: identity.sourceRepoId },
    { ...identity, backupRepoId: "other/repo#backup" },
    { ...identity, sourcePassphraseSecretId: identity.destinationPassphraseSecretId },
    { ...identity, runId: "../../foo" },
    { ...identity, walGeneration: -1 },
    { ...identity, sourceCommitSha: "G".repeat(40) },
    { ...identity, hiddenUnexpectedField: "must-not-be-serialized" },
  ]) {
    await assert.rejects(() => sealV4ReencryptionProposedCommitTestVector(invalid, key))
  }
  await assert.rejects(() => sealV4ReencryptionProposedCommitTestVector(identity, new Uint8Array(16)),
    /journal key/)
})
