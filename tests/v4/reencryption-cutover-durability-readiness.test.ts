import assert from "node:assert/strict"
import test from "node:test"
import {
  assessV4ReencryptionCutoverDurability,
  V4_REENCRYPTION_CUTOVER_REQUIREMENTS,
  type V4ReencryptionCutoverEvidenceLevel,
  type V4ReencryptionCutoverPlatform,
  type V4ReencryptionCutoverEvidenceClaim,
} from "../../src/lib/v4/reencryption-cutover-durability-readiness"
import { V4RekeyWalDirectorySyncProof } from "../../src/lib/v4/reencryption-desktop-wal"

const platforms: V4ReencryptionCutoverPlatform[] = [
  "windows-desktop", "macos-desktop", "linux-desktop", "android-mobile", "ios-mobile",
]
const levels: readonly V4ReencryptionCutoverEvidenceLevel[] = [
  "unverified", "process-restart-only", "claimed-power-loss-qualification",
]
const claim = (
  platform: V4ReencryptionCutoverPlatform, index: number, level: V4ReencryptionCutoverEvidenceLevel,
): V4ReencryptionCutoverEvidenceClaim => ({
  requirement: V4_REENCRYPTION_CUTOVER_REQUIREMENTS[index]!,
  platform, level, mechanism: "isolated dry-run only",
})
const prohibited = {
  localCutoverAuthorized: false, resumeSyncAuthorized: false,
  rollbackAuthorized: false, remoteWritesAuthorized: false,
  oldPassphraseCleanupAuthorized: false,
}

test("D140 no evidence gives an ordered eight-surface inventory and cannot commit", () => {
  const result = assessV4ReencryptionCutoverDurability({
    platform: "windows-desktop", evidence: [],
  })
  assert.equal(result.integrityScope, "read-only-platform-cutover-capability-inventory")
  assert.equal(result.platform, "windows-desktop")
  assert.equal(result.state, "proofs-missing")
  assert.deepEqual(result.requirements, V4_REENCRYPTION_CUTOVER_REQUIREMENTS.map(requirement => ({
    requirement, diagnostic: "missing",
  })))
  for (const [name, value] of Object.entries(prohibited)) {
    assert.equal(result[name as keyof typeof prohibited], value)
  }
  assert.equal(Object.isFrozen(result), true)
  assert.equal(Object.isFrozen(result.requirements), true)
})

test("D140 every platform and all 3^8 evidence combinations deny write/resume/secret cleanup", () => {
  let samples = 0
  for (const platform of platforms) {
    for (let permutation = 0; permutation < 3 ** V4_REENCRYPTION_CUTOVER_REQUIREMENTS.length; permutation++) {
      let mask = permutation
      const claims = V4_REENCRYPTION_CUTOVER_REQUIREMENTS.map((_, index) => {
        const level = levels[mask % levels.length]!
        mask = Math.floor(mask / levels.length)
        return claim(platform, index, level)
      })
      const result = assessV4ReencryptionCutoverDurability({ platform, evidence: claims })
      assert.equal(result.requirements.length, 8)
      for (let index = 0; index < claims.length; index++) {
        assert.equal(result.requirements[index]?.requirement, claims[index]?.requirement)
        assert.equal(result.requirements[index]?.diagnostic,
          claims[index]?.level === "claimed-power-loss-qualification"
            ? "unqualified-claim"
            : claims[index]?.level === "process-restart-only"
              ? "process-only" : "missing")
      }
      assert.equal(result.state, permutation === 3 ** 8 - 1
        ? "all-proofs-claimed-but-not-authenticated" : "proofs-missing")
      for (const [name, value] of Object.entries(prohibited)) {
        assert.equal(result[name as keyof typeof prohibited], value)
      }
      samples++
    }
  }
  assert.equal(samples, 5 * 3 ** 8)
})

test("D140 a claimed power-loss proof for only WAL does not mask missing Obsidian persistence and commit evidence", () => {
  const report = assessV4ReencryptionCutoverDurability({
    platform: "windows-desktop",
    evidence: [
      claim("windows-desktop", 0, "claimed-power-loss-qualification"),
      claim("windows-desktop", 3, "process-restart-only"),
      claim("windows-desktop", 4, "unverified"),
    ],
  })
  assert.equal(report.state, "proofs-missing")
  assert.deepEqual(report.requirements.map(x => x.diagnostic), [
    "unqualified-claim", "missing", "missing", "process-only",
    "missing", "missing", "missing", "missing",
  ])
  assert.deepEqual(report.requirements[6], {
    requirement: "idempotent-committed-receipt-and-recovery", diagnostic: "missing",
  })
})

test("D140 rejects duplicate, foreign-platform, malformed and mutated claims instead of picking the strongest one", () => {
  const good = claim("windows-desktop", 0, "process-restart-only")
  const invalid = [
    [good, good],
    [good, claim("linux-desktop", 1, "claimed-power-loss-qualification")],
    [{ ...good, requirement: "arbitrary" }],
    [{ ...good, level: "automatic-commit" }],
    [{ ...good, mechanism: "\u0000" }],
    [{ ...good, mechanism: "a".repeat(257) }],
    Array.from({ length: 9 }, () => good),
  ]
  for (const evidence of invalid) {
    assert.throws(() => assessV4ReencryptionCutoverDurability({
      platform: "windows-desktop", evidence: evidence as V4ReencryptionCutoverEvidenceClaim[],
    }), /Invalid|Unrecognized|conflicting|duplicate/i)
  }
  assert.throws(() => assessV4ReencryptionCutoverDurability({
    platform: "unknown-os" as V4ReencryptionCutoverPlatform, evidence: [],
  }), /Invalid/)
  const input = { platform: "ios-mobile" as const, evidence: [claim("ios-mobile", 0, "process-restart-only")] }
  const report = assessV4ReencryptionCutoverDurability(input)
  input.evidence[0] = claim("ios-mobile", 0, "claimed-power-loss-qualification")
  assert.equal(report.requirements[0]?.diagnostic, "process-only")
  assert.equal(report.localCutoverAuthorized, false)
})

test("D140 failed directory synchronization and a later rename revoke WAL durability proof", async () => {
  const proof = new V4RekeyWalDirectorySyncProof()
  await proof.refresh(true, async () => false)
  assert.throws(() => proof.assertConfirmed(), /fsync.*unproven/i)
  await proof.refresh(true, async () => true)
  assert.doesNotThrow(() => proof.assertConfirmed())
  proof.invalidate()
  assert.throws(() => proof.assertConfirmed(), /fsync.*unproven/i)
  await assert.rejects(() => proof.refresh(true, async () => { throw new Error("EPERM") }), /EPERM/)
  assert.throws(() => proof.assertConfirmed(), /fsync.*unproven/i)
  const report = assessV4ReencryptionCutoverDurability({
    platform: "windows-desktop",
    evidence: [claim("windows-desktop", 0, "process-restart-only")],
  })
  assert.equal(report.requirements[0]?.diagnostic, "process-only")
  assert.equal(report.localCutoverAuthorized, false)
})
