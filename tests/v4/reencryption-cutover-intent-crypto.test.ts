import assert from "node:assert/strict"
import test from "node:test"
import { toBase64, utf8ToBytes } from "../../src/lib/bytes"
import { encryptV4Payload } from "../../src/lib/v4/crypto"
import {
  sealV4ReencryptionCutoverCandidatePair,
  type V4ReencryptionCutoverCandidateContract,
} from "../../src/lib/v4/reencryption-cutover-candidate-crypto"
import {
  sealV4ReencryptionPendingCutoverIntent,
  inspectV4ReencryptionPendingCutoverIntent,
} from "../../src/lib/v4/reencryption-cutover-intent-crypto"

const contract: V4ReencryptionCutoverCandidateContract = {
  transactionId: "b3".repeat(16),
  identity: {
    runId: "d227_intent_run", walGeneration: 8, indexRoot: "github-sync-v4-index",
    deviceId: "device_d227", sourceRepoId: "owner/vault#main",
    backupRepoId: "owner/vault#backup/d227", destinationRepoId: "owner/vault#rekey/d227",
    sourceCommitSha: "a".repeat(40), sourceTreeSha: "c".repeat(40),
    destinationCommitSha: "b".repeat(40), destinationTreeSha: "d".repeat(40),
    manifestSha256: "e".repeat(64),
    sourcePassphraseSecretId: "old-d227-secret-id", destinationPassphraseSecretId: "new-d227-secret-id",
  },
  sourceIndexSha256: "1".repeat(64), destinationShadowSha256: "2".repeat(64),
  preparedEvidenceSha256: "3".repeat(64), walSnapshotSha256: "4".repeat(64),
  sourceSettingsSha256: "5".repeat(64), destinationSettingsSha256: "6".repeat(64),
}
const key = () => new Uint8Array(32).fill(0x48)
const success = {
  integrityScope: "production-namespace-cutover-intent-crypto-only",
  observation: "authenticated-intent-uncommitted",
  localCutoverAuthorized: false, resumeSyncAuthorized: false,
  rollbackAuthorized: false, remoteWritesAuthorized: false,
  oldPassphraseCleanupAuthorized: false,
}
const failed = { ...success, observation: "manual-recovery-required" }

test("D227 authenticated Intent binds exact independently sealed Candidate ciphertext and has zero live authority", async () => {
  const candidate = await sealV4ReencryptionCutoverCandidatePair(contract, key())
  const intent = await sealV4ReencryptionPendingCutoverIntent(contract, key(), candidate)
  assert.deepEqual(await inspectV4ReencryptionPendingCutoverIntent(contract, key(), candidate, intent), success)
  assert.ok(intent.length <= 8192)
  assert.doesNotMatch(intent, /sourceRepoId|passphrase|old-d227|destinationCommitSha/u)
  assert.notEqual(intent, candidate.receiptCiphertext)
  assert.notEqual(intent, candidate.selectorCiphertext)
  assert.deepEqual(await inspectV4ReencryptionPendingCutoverIntent(
    contract, key(), candidate, candidate.receiptCiphertext), failed)
  assert.deepEqual(await inspectV4ReencryptionPendingCutoverIntent(
    contract, key(), candidate, candidate.selectorCiphertext), failed)
})

test("D227 foreign, incomplete, exchanged or re-encrypted Candidate never authenticates a historical Intent", async () => {
  const candidate = await sealV4ReencryptionCutoverCandidatePair(contract, key())
  const other = await sealV4ReencryptionCutoverCandidatePair(contract, key())
  const intent = await sealV4ReencryptionPendingCutoverIntent(contract, key(), candidate)
  for (const altered of [
    { ...candidate, receiptCiphertext: other.receiptCiphertext },
    { ...candidate, selectorCiphertext: other.selectorCiphertext },
    { receiptCiphertext: other.receiptCiphertext, selectorCiphertext: other.selectorCiphertext },
  ]) {
    assert.deepEqual(await inspectV4ReencryptionPendingCutoverIntent(contract, key(), altered, intent), failed)
    if (altered.receiptCiphertext === candidate.receiptCiphertext
      || altered.selectorCiphertext === candidate.selectorCiphertext) {
      await assert.rejects(() => sealV4ReencryptionPendingCutoverIntent(contract, key(), altered))
    } else {
      const reissued = await sealV4ReencryptionPendingCutoverIntent(contract, key(), altered)
      assert.deepEqual(await inspectV4ReencryptionPendingCutoverIntent(
        contract, key(), altered, reissued,
      ), success)
    }
  }
  for (const malformed of [null, "", "invalid", intent.slice(0, -4), intent + "\n", "A".repeat(8196)]) {
    assert.deepEqual(await inspectV4ReencryptionPendingCutoverIntent(
      contract, key(), candidate, malformed,
    ), failed)
  }
  assert.deepEqual(await inspectV4ReencryptionPendingCutoverIntent(contract, key(), null, intent), failed)
  assert.deepEqual(await inspectV4ReencryptionPendingCutoverIntent(
    { ...contract, sourceSettingsSha256: "7".repeat(64) }, key(), candidate, intent,
  ), failed)
  assert.deepEqual(await inspectV4ReencryptionPendingCutoverIntent(
    contract, new Uint8Array(32).fill(0x49), candidate, intent,
  ), failed)
})

test("D227 even an authenticated same-key forged committed phase fails closed", async () => {
  const candidate = await sealV4ReencryptionCutoverCandidatePair(contract, key())
  const intent = await sealV4ReencryptionPendingCutoverIntent(contract, key(), candidate)
  const context = "v4-rekey-cutover-intent-pending-v1"
  const hmac = await crypto.subtle.importKey("raw", key() as any,
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  const derived = new Uint8Array(await crypto.subtle.sign(
    "HMAC", hmac, utf8ToBytes(context + ":key") as any,
  ))
  const id = contract.identity
  const aad = context + ":" + contract.transactionId + ":" + id.runId + ":"
    + id.sourceCommitSha + ":" + id.destinationRepoId + ":" + id.destinationCommitSha
  const forged = await encryptV4Payload(
    derived, utf8ToBytes(JSON.stringify({
      schemaVersion: 1, phase: "committed", contract, receiptCiphertextSha256: "0".repeat(64),
      selectorCiphertextSha256: "1".repeat(64),
    })), { kind: "journal", aad },
  )
  assert.deepEqual(await inspectV4ReencryptionPendingCutoverIntent(
    contract, key(), candidate, toBase64(forged),
  ), failed)
  assert.deepEqual(await inspectV4ReencryptionPendingCutoverIntent(contract, key(), candidate, intent), success)
  forged.fill(0)
  derived.fill(0)
})

test("D227 mutated key, contract or Candidate getter while encryption is awaited cannot yield trusted intent", async () => {
  const candidate = await sealV4ReencryptionCutoverCandidatePair(contract, key())
  const alternate = await sealV4ReencryptionCutoverCandidatePair(contract, key())
  const changedKey = key()
  let calls = 0
  const unstable = {
    get receiptCiphertext() {
      return ++calls > 1 ? alternate.receiptCiphertext : candidate.receiptCiphertext
    },
    selectorCiphertext: candidate.selectorCiphertext,
  }
  await assert.rejects(() => sealV4ReencryptionPendingCutoverIntent(contract, changedKey, unstable))
  const intent = await sealV4ReencryptionPendingCutoverIntent(contract, key(), candidate)
  calls = 0
  assert.deepEqual(await inspectV4ReencryptionPendingCutoverIntent(
    contract, key(), unstable, intent,
  ), failed)
})
