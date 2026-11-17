import assert from "node:assert/strict"
import test from "node:test"

import {
  digestD392InstalledEvidence,
  assertD392InstalledEvidenceDigest,
} from "../../scripts/installed-source-evidence-digest.mjs"

const original = Buffer.from(JSON.stringify({
  sourceCommitSha: "a".repeat(40),
  sourceTreeSha: "b".repeat(40),
  note: "สวัสดี",
}), "utf8")

test("D392 installed evidence accepts only the exact parent-authenticated manifest bytes", () => {
  const digest = digestD392InstalledEvidence(original)
  assert.match(digest, /^[a-f0-9]{64}$/u)
  assert.doesNotThrow(() => assertD392InstalledEvidenceDigest(original, digest))

  const tampered = Buffer.from(original)
  const offset = tampered.indexOf(Buffer.from("b".repeat(40)))
  assert.ok(offset >= 0)
  tampered[offset] = "c".charCodeAt(0)
  assert.equal(tampered.length, original.length)
  assert.notEqual(tampered.toString("utf8"), original.toString("utf8"))
  assert.throws(() => assertD392InstalledEvidenceDigest(tampered, digest),
    /D392.*mismatch/i)
})

test("D392 missing, malformed and substituted parent digest fail before parsing Source evidence", () => {
  for (const digest of [undefined, "", "a".repeat(63), "z".repeat(64), "A".repeat(64)]) {
    assert.throws(() => assertD392InstalledEvidenceDigest(original, digest),
      /D392.*digest/i)
  }
  assert.throws(
    () => assertD392InstalledEvidenceDigest(original, "0".repeat(64)),
    /D392.*mismatch/i,
  )
})

