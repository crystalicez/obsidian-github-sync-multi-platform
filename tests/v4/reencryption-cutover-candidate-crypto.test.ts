import assert from "node:assert/strict"
import test from "node:test"
import { toBase64, utf8ToBytes } from "../../src/lib/bytes"
import { encryptV4Payload } from "../../src/lib/v4/crypto"
import {
  inspectV4ReencryptionCutoverCandidatePair,
  sealV4ReencryptionCutoverCandidatePair,
  type V4ReencryptionCutoverCandidateContract,
  type V4ReencryptionCutoverCandidatePair,
} from "../../src/lib/v4/reencryption-cutover-candidate-crypto"
import { sealV4ReencryptionCommitPairTestVectors } from "../../src/lib/v4/reencryption-commit-pair-test-vectors"

const contract: V4ReencryptionCutoverCandidateContract = {
  transactionId: "b3".repeat(16),
  identity: {
    runId: "d223_candidate_run", walGeneration: 8, indexRoot: "github-sync-v4-index",
    deviceId: "device_d223", sourceRepoId: "owner/vault#main",
    backupRepoId: "owner/vault#backup/d223", destinationRepoId: "owner/vault#rekey/d223",
    sourceCommitSha: "a".repeat(40), sourceTreeSha: "c".repeat(40),
    destinationCommitSha: "b".repeat(40), destinationTreeSha: "d".repeat(40),
    manifestSha256: "e".repeat(64),
    sourcePassphraseSecretId: "old-d223-secret-id", destinationPassphraseSecretId: "new-d223-secret-id",
  },
  sourceIndexSha256: "1".repeat(64),
  destinationShadowSha256: "2".repeat(64),
  preparedEvidenceSha256: "3".repeat(64),
  walSnapshotSha256: "4".repeat(64),
  sourceSettingsSha256: "5".repeat(64),
  destinationSettingsSha256: "6".repeat(64),
}
const key = () => new Uint8Array(32).fill(0x48)
const linked = {
  integrityScope: "production-namespace-cutover-candidate-crypto-only",
  observation: "cryptographically-linked-candidate-uncommitted",
  reason: "candidate-pair-linked-no-commit-proof",
  localCutoverAuthorized: false,
  resumeSyncAuthorized: false,
  rollbackAuthorized: false,
  remoteWritesAuthorized: false,
  oldPassphraseCleanupAuthorized: false,
}
const failure = (reason: string) => ({
  ...linked, observation: "manual-recovery-required", reason,
})
const inspect = (
  pair: { receiptCiphertext: string | null; selectorCiphertext: string | null } | null,
  expected: V4ReencryptionCutoverCandidateContract = contract,
  secret: Uint8Array = key(),
) => inspectV4ReencryptionCutoverCandidatePair(expected, secret, pair)

test("D223 candidate uses production namespace, independent encrypted Receipt and linked Selector; never authorizes Cutover", async () => {
  const pair = await sealV4ReencryptionCutoverCandidatePair(contract, key())
  assert.deepEqual(await inspect(pair), linked)
  assert.equal(Object.isFrozen(pair), true)
  assert.notEqual(pair.receiptCiphertext, pair.selectorCiphertext)
  assert.ok(pair.receiptCiphertext.length <= 8192)
  assert.ok(pair.selectorCiphertext.length <= 8192)
  assert.doesNotMatch(pair.receiptCiphertext + pair.selectorCiphertext,
    /old-d223-secret-id|new-d223-secret-id|sourceRepoId|destinationRepoId/)
  assert.equal(linked.localCutoverAuthorized, false)
  assert.equal(linked.resumeSyncAuthorized, false)
  assert.equal(linked.oldPassphraseCleanupAuthorized, false)
})

test("D223 candidate-only missing, one-sided, torn and noncanonical crash windows fail closed", async () => {
  const pair = await sealV4ReencryptionCutoverCandidatePair(contract, key())
  assert.deepEqual(await inspect({ receiptCiphertext: null, selectorCiphertext: null }), failure("both-absent"))
  assert.deepEqual(await inspect({ receiptCiphertext: pair.receiptCiphertext, selectorCiphertext: null }),
    failure("one-sided-or-torn"))
  assert.deepEqual(await inspect({ receiptCiphertext: null, selectorCiphertext: pair.selectorCiphertext }),
    failure("one-sided-or-torn"))
  assert.deepEqual(await inspect(null), failure("invalid-or-foreign-ciphertext"))
  for (const broken of [pair.receiptCiphertext.slice(0,-2), pair.receiptCiphertext+"\n",
    "not-base64", "A".repeat(8196), ""]) {
    assert.deepEqual(await inspect({ ...pair, receiptCiphertext: broken }),
      failure("invalid-or-foreign-ciphertext"))
  }
  for (const broken of [pair.selectorCiphertext.slice(0,-4), pair.selectorCiphertext+"\n",
    "[", "A".repeat(8196), ""]) {
    assert.deepEqual(await inspect({ ...pair, selectorCiphertext: broken }),
      failure("invalid-or-foreign-ciphertext"))
  }
})

test("D223 Selector SHA-256 binds exact encrypted Receipt, even for identical transaction and plaintext", async () => {
  const first = await sealV4ReencryptionCutoverCandidatePair(contract, key())
  const second = await sealV4ReencryptionCutoverCandidatePair(contract, key())
  assert.notEqual(first.receiptCiphertext, second.receiptCiphertext)
  for (const mismatched of [
    { ...first, receiptCiphertext: second.receiptCiphertext },
    { ...second, receiptCiphertext: first.receiptCiphertext },
    { ...first, selectorCiphertext: second.selectorCiphertext },
  ]) {
    assert.deepEqual(await inspect(mismatched), failure("invalid-or-foreign-ciphertext"))
  }
})

test("D223 cannot replay any pinned Source, Shadow, WAL, Settings or identity field, even with valid AES tags", async () => {
  const pair = await sealV4ReencryptionCutoverCandidatePair(contract, key())
  const changed: V4ReencryptionCutoverCandidateContract[] = [
    { ...contract, transactionId: "c1".repeat(16) },
    { ...contract, sourceIndexSha256: "7".repeat(64) },
    { ...contract, destinationShadowSha256: "7".repeat(64) },
    { ...contract, preparedEvidenceSha256: "7".repeat(64) },
    { ...contract, walSnapshotSha256: "7".repeat(64) },
    { ...contract, sourceSettingsSha256: "7".repeat(64) },
    { ...contract, destinationSettingsSha256: "7".repeat(64) },
    { ...contract, identity: { ...contract.identity, runId: "d223_other_run" } },
    { ...contract, identity: { ...contract.identity, sourceCommitSha: "7".repeat(40) } },
    { ...contract, identity: { ...contract.identity, destinationCommitSha: "7".repeat(40) } },
    { ...contract, identity: { ...contract.identity, backupRepoId: "owner/vault#backup/other" } },
    { ...contract, identity: { ...contract.identity, sourcePassphraseSecretId: "other-old-secret" } },
    { ...contract, identity: { ...contract.identity, destinationPassphraseSecretId: "other-new-secret" } },
    { ...contract, identity: { ...contract.identity, walGeneration: 10 } },
    { ...contract, identity: { ...contract.identity, manifestSha256: "7".repeat(64) } },
    { ...contract, identity: { ...contract.identity, deviceId: "other_device" } },
  ]
  for (const candidate of changed) {
    assert.deepEqual(await inspect(pair, candidate), failure("invalid-or-foreign-ciphertext"))
  }
  assert.deepEqual(await inspect(pair, contract, new Uint8Array(32).fill(3)),
    failure("invalid-or-foreign-ciphertext"))
})

test("D223 D182 test vectors cannot be substituted into production-namespace candidate fields", async () => {
  const candidate = await sealV4ReencryptionCutoverCandidatePair(contract, key())
  const testVector = await sealV4ReencryptionCommitPairTestVectors(contract, key())
  for (const swapped of [
    { ...candidate, receiptCiphertext: testVector.receiptTestVector },
    { ...candidate, selectorCiphertext: testVector.selectorTestVector },
    { receiptCiphertext: testVector.receiptTestVector, selectorCiphertext: testVector.selectorTestVector },
  ]) {
    assert.deepEqual(await inspect(swapped), failure("invalid-or-foreign-ciphertext"))
  }
})

test("D223 even correctly AES-encrypted forged committed phases, extra fields or changed contract fail closed", async () => {
  const pair = await sealV4ReencryptionCutoverCandidatePair(contract, key())
  const base = "v4-rekey-cutover-receipt-candidate-v1"
  const hmac = await crypto.subtle.importKey("raw", key() as any,
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  const derived = new Uint8Array(await crypto.subtle.sign(
    "HMAC", hmac, utf8ToBytes(base + ":key") as any,
  ))
  const id = contract.identity
  const aad = base + ":" + contract.transactionId + ":" + id.runId + ":"
    + id.sourceCommitSha + ":" + id.destinationRepoId + ":" + id.destinationCommitSha
  for (const forged of [
    { schemaVersion: 1, phase: "committed", contract },
    { schemaVersion: 1, phase: "cutover-receipt-candidate-uncommitted", contract, cutoverAuthorized: true },
    { schemaVersion: 1, phase: "cutover-receipt-candidate-uncommitted",
      contract: { ...contract, transactionId: "c5".repeat(16) } },
  ]) {
    const bytes = await encryptV4Payload(derived, utf8ToBytes(JSON.stringify(forged)),
      { kind: "journal", aad })
    const tampered = toBase64(bytes)
    assert.deepEqual(await inspect({ ...pair, receiptCiphertext: tampered }),
      failure("invalid-or-foreign-ciphertext"))
    bytes.fill(0)
  }
  derived.fill(0)
})

test("D223 invalid structured contracts and keys reject signing and do not create authority", async () => {
  const invalid = [
    { ...contract, transactionId: "0".repeat(32) },
    { ...contract, transactionId: "short" },
    { ...contract, walSnapshotSha256: "g".repeat(64) },
    { ...contract, identity: { ...contract.identity, destinationRepoId: contract.identity.sourceRepoId } },
    { ...contract, identity: { ...contract.identity, newField: true } },
    { ...contract, extraFlag: "committed" },
  ]
  for (const wrong of invalid) {
    await assert.rejects(() => sealV4ReencryptionCutoverCandidatePair(
      wrong as V4ReencryptionCutoverCandidateContract, key()))
    assert.deepEqual(await inspect(null, wrong as V4ReencryptionCutoverCandidateContract),
      failure("invalid-or-foreign-ciphertext"))
  }
  await assert.rejects(() => sealV4ReencryptionCutoverCandidatePair(contract, new Uint8Array(16)))
})

test("D223 candidate verifier must reject a getter changing ciphertext during async authentication", async () => {
  const a = await sealV4ReencryptionCutoverCandidatePair(contract, key())
  const b = await sealV4ReencryptionCutoverCandidatePair(contract, key())
  let observed = 0
  const pair: V4ReencryptionCutoverCandidatePair = {
    get receiptCiphertext() {
      if (++observed > 1) return b.receiptCiphertext
      return a.receiptCiphertext
    },
    selectorCiphertext: a.selectorCiphertext,
  }
  assert.deepEqual(await inspect(pair), failure("invalid-or-foreign-ciphertext"))
  assert.ok(observed >= 2)
})
