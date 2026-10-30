import assert from "node:assert/strict"
import test from "node:test"
import { sha256Hex, toBase64, utf8ToBytes } from "../../src/lib/bytes"
import { encryptV4Payload } from "../../src/lib/v4/crypto"
import {
  inspectV4ReencryptionCommitPairTestVectors,
  sealV4ReencryptionCommitPairTestVectors,
  type V4ReencryptionCommitPairTestContract,
  type V4ReencryptionCommitPairTestVectors,
} from "../../src/lib/v4/reencryption-commit-pair-test-vectors"
import { sealV4ReencryptionProposedCommitTestVector } from "../../src/lib/v4/reencryption-proposed-commit-receipt"
import { sealV4ReencryptionSeparatedSelectorTestVector,
  sealV4ReencryptionPreparedSelectorEvidence } from "../../src/lib/v4/reencryption-separated-selector-prototype"

const contract: V4ReencryptionCommitPairTestContract = {
  transactionId: "a1".repeat(16),
  identity: {
    runId: "d182_pair_run", walGeneration: 8, indexRoot: "github-sync-v4-index",
    deviceId: "device_d182", sourceRepoId: "owner/vault#main",
    backupRepoId: "owner/vault#backup/d182", destinationRepoId: "owner/vault#rekey/d182",
    sourceCommitSha: "a".repeat(40), sourceTreeSha: "c".repeat(40),
    destinationCommitSha: "b".repeat(40), destinationTreeSha: "d".repeat(40),
    manifestSha256: "e".repeat(64),
    sourcePassphraseSecretId: "old-passphrase-id", destinationPassphraseSecretId: "new-passphrase-id",
  },
  sourceIndexSha256: "1".repeat(64),
  destinationShadowSha256: "2".repeat(64),
  preparedEvidenceSha256: "3".repeat(64),
  walSnapshotSha256: "4".repeat(64),
  sourceSettingsSha256: "5".repeat(64),
  destinationSettingsSha256: "6".repeat(64),
}
const key = () => new Uint8Array(32).fill(0x72)
const expected = {
  integrityScope: "in-memory-cryptographically-bound-commit-pair-test-vectors",
  observation: "both-test-vectors-authenticate-uncommitted",
  reason: "linked-but-not-authoritative",
  localCutoverAuthorized: false, resumeSyncAuthorized: false, rollbackAuthorized: false,
  remoteWritesAuthorized: false, oldPassphraseCleanupAuthorized: false,
}
const fail = (reason: string) => ({
  ...expected, observation: "manual-recovery-required", reason,
})
const inspect = (
  pair: { receiptTestVector: string | null; selectorTestVector: string | null },
  identity: V4ReencryptionCommitPairTestContract = contract,
  journalKey: Uint8Array = key(),
) => inspectV4ReencryptionCommitPairTestVectors(identity, journalKey, pair)

test("D182 two domain-separated AES-GCM test records authenticate only as uncommitted", async () => {
  const pair = await sealV4ReencryptionCommitPairTestVectors(contract, key())
  const seen = await inspect(pair)
  assert.deepEqual(seen, expected)
  assert.equal(Object.isFrozen(seen), true)
  assert.equal(Object.isFrozen(pair), true)
  assert.notEqual(pair.selectorTestVector, pair.receiptTestVector)
  assert.doesNotMatch(pair.receiptTestVector + pair.selectorTestVector,
    /old-passphrase-id|new-passphrase-id|sourceRepoId|destinationRepoId/)
  assert.ok(pair.selectorTestVector.length < 8192)
  assert.ok(pair.receiptTestVector.length < 8192)
})

test("D182 all absent, one-sided and truncated crash windows never form a committed pair", async () => {
  const pair = await sealV4ReencryptionCommitPairTestVectors(contract, key())
  assert.deepEqual(await inspect({ receiptTestVector: null, selectorTestVector: null }), fail("both-absent"))
  assert.deepEqual(await inspect({ receiptTestVector: pair.receiptTestVector, selectorTestVector: null }),
    fail("one-artifact-missing"))
  assert.deepEqual(await inspect({ receiptTestVector: null, selectorTestVector: pair.selectorTestVector }),
    fail("one-artifact-missing"))
  for (const value of [pair.receiptTestVector.slice(0, -3), "{",
    pair.receiptTestVector + "\n", "A".repeat(8196), ""]) {
    assert.deepEqual(await inspect({ ...pair, receiptTestVector: value }), fail("invalid-or-mismatched-pair"))
  }
  for (const value of [pair.selectorTestVector.slice(0, -6), "[",
    pair.selectorTestVector + "\n", "A".repeat(8196), ""]) {
    assert.deepEqual(await inspect({ ...pair, selectorTestVector: value }), fail("invalid-or-mismatched-pair"))
  }
})

test("D182 a selector cannot be paired with a different ciphertext receipt even for the identical run", async () => {
  const a = await sealV4ReencryptionCommitPairTestVectors(contract, key())
  const b = await sealV4ReencryptionCommitPairTestVectors(contract, key())
  assert.notEqual(a.receiptTestVector, b.receiptTestVector)
  assert.deepEqual(await inspect({
    selectorTestVector: a.selectorTestVector, receiptTestVector: b.receiptTestVector,
  }), fail("invalid-or-mismatched-pair"))
  assert.deepEqual(await inspect({
    selectorTestVector: b.selectorTestVector, receiptTestVector: a.receiptTestVector,
  }), fail("invalid-or-mismatched-pair"))
})

test("D182 every independently pinned Source/Shadow/Settings/Intent/WAL dimension rejects replay", async () => {
  const pair = await sealV4ReencryptionCommitPairTestVectors(contract, key())
  const changes: V4ReencryptionCommitPairTestContract[] = [
    { ...contract, transactionId: "a2".repeat(16) },
    { ...contract, sourceIndexSha256: "7".repeat(64) },
    { ...contract, destinationShadowSha256: "7".repeat(64) },
    { ...contract, preparedEvidenceSha256: "7".repeat(64) },
    { ...contract, walSnapshotSha256: "7".repeat(64) },
    { ...contract, sourceSettingsSha256: "7".repeat(64) },
    { ...contract, destinationSettingsSha256: "7".repeat(64) },
    { ...contract, identity: { ...contract.identity, walGeneration: 9 } },
    { ...contract, identity: { ...contract.identity, runId: "d182_other_run" } },
    { ...contract, identity: { ...contract.identity, sourceCommitSha: "7".repeat(40) } },
    { ...contract, identity: { ...contract.identity, backupRepoId: "owner/vault#backup/other" } },
    { ...contract, identity: { ...contract.identity, destinationRepoId: "owner/vault#rekey/other" } },
    { ...contract, identity: { ...contract.identity, destinationTreeSha: "7".repeat(40) } },
    { ...contract, identity: { ...contract.identity, manifestSha256: "7".repeat(64) } },
    { ...contract, identity: { ...contract.identity, destinationPassphraseSecretId: "another-new-key" } },
    { ...contract, identity: { ...contract.identity, deviceId: "other_device" } },
  ]
  for (const changed of changes) {
    assert.deepEqual(await inspect(pair, changed), fail("invalid-or-mismatched-pair"))
  }
  assert.deepEqual(await inspect(pair, contract, new Uint8Array(32).fill(9)),
    fail("invalid-or-mismatched-pair"))
})

test("D182 D142 marker and D147 Selector and D172 Prepared are not interchangeable with D182 pair", async () => {
  const pair = await sealV4ReencryptionCommitPairTestVectors(contract, key())
  const legacyReceipt = await sealV4ReencryptionProposedCommitTestVector(contract.identity, key())
  const legacySelector = await sealV4ReencryptionSeparatedSelectorTestVector(contract.identity, key())
  const prepared = await sealV4ReencryptionPreparedSelectorEvidence(contract.identity, key())
  for (const receipt of [legacyReceipt, legacySelector, prepared]) {
    assert.deepEqual(await inspect({ ...pair, receiptTestVector: receipt }),
      fail("invalid-or-mismatched-pair"))
  }
  for (const selector of [legacyReceipt, legacySelector, prepared]) {
    assert.deepEqual(await inspect({ ...pair, selectorTestVector: selector }),
      fail("invalid-or-mismatched-pair"))
  }
})

test("D182 authenticated extra fields or forged committed phase with the correct domain key are rejected", async () => {
  const pair = await sealV4ReencryptionCommitPairTestVectors(contract, key())
  const base = "v4-rekey-d182-receipt-contract-test-vector-v1"
  const hmac = await crypto.subtle.importKey("raw", key() as any,
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  const derived = new Uint8Array(await crypto.subtle.sign("HMAC", hmac,
    utf8ToBytes(base + ":key") as any))
  const identity = contract.identity
  const aad = base + ":" + contract.transactionId + ":" + identity.runId
    + ":" + identity.sourceCommitSha + ":" + identity.destinationRepoId
    + ":" + identity.destinationCommitSha
  for (const record of [
    { schemaVersion: 1, phase: "receipt-candidate-test-vector-uncommitted",
      contract, cutoverAuthorized: true },
    { schemaVersion: 1, phase: "committed", contract },
    { schemaVersion: 1, phase: "receipt-candidate-test-vector-uncommitted",
      contract: { ...contract, transactionId: "a2".repeat(16) } },
  ]) {
    const bytes = await encryptV4Payload(derived,
      utf8ToBytes(JSON.stringify(record)), { kind: "journal", aad })
    const forged = toBase64(bytes)
    assert.deepEqual(await inspect({ ...pair, receiptTestVector: forged }),
      fail("invalid-or-mismatched-pair"))
    bytes.fill(0)
  }
  derived.fill(0)
})

test("D182 invalid contracts and journal key sizes cannot produce test vectors", async () => {
  for (const invalid of [
    { ...contract, transactionId: "0".repeat(32) },
    { ...contract, transactionId: "short" },
    { ...contract, sourceIndexSha256: "not-hex" },
    { ...contract, walSnapshotSha256: "A".repeat(64) },
    { ...contract, identity: { ...contract.identity, destinationRepoId: contract.identity.sourceRepoId } },
    { ...contract, identity: { ...contract.identity, extras: true } },
    { ...contract, extras: true },
  ]) {
    await assert.rejects(() => sealV4ReencryptionCommitPairTestVectors(
      invalid as V4ReencryptionCommitPairTestContract, key(),
    ))
    assert.deepEqual(await inspect({ receiptTestVector: null, selectorTestVector: null },
      invalid as V4ReencryptionCommitPairTestContract), fail("invalid-or-mismatched-pair"))
  }
  await assert.rejects(() => sealV4ReencryptionCommitPairTestVectors(contract, new Uint8Array(16)))
})

test("D182 unverified digest placeholders never authorize Cutover even if both tags authenticate", async () => {
  const pair = await sealV4ReencryptionCommitPairTestVectors(contract, key())
  const seen = await inspect(pair)
  assert.deepEqual(seen, expected)
  assert.equal(seen.localCutoverAuthorized, false)
  assert.equal(seen.resumeSyncAuthorized, false)
  assert.equal(seen.rollbackAuthorized, false)
  assert.equal(seen.oldPassphraseCleanupAuthorized, false)
  // This in-memory API cannot establish that the caller-derived digest values
  // are genuine disk snapshots, full remote ciphertext or a durable commit.
  assert.notEqual(await sha256Hex(utf8ToBytes(pair.receiptTestVector)),
    contract.preparedEvidenceSha256)
})

test("D182 a caller swapping a sealed pair after an awaited authentication fails closed", async () => {
  const initial = await sealV4ReencryptionCommitPairTestVectors(contract, key())
  const replacement = await sealV4ReencryptionCommitPairTestVectors(contract, key())
  let reads = 0
  const pair = {
    get receiptTestVector() {
      if (++reads > 1) return replacement.receiptTestVector
      return initial.receiptTestVector
    },
    selectorTestVector: initial.selectorTestVector,
  }
  assert.deepEqual(await inspect(pair), fail("invalid-or-mismatched-pair"))
  assert.equal(reads >= 2, true)
})
