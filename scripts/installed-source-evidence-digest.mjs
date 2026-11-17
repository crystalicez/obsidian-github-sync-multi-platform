import { createHash, timingSafeEqual } from "node:crypto"

/** D392 test-only handoff: immutable bytes authenticated by the GitHub E2E parent. */
export function digestD392InstalledEvidence(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError("D392 installed Source evidence must be raw bytes.")
  }
  return createHash("sha256").update(bytes).digest("hex")
}

export function assertD392InstalledEvidenceDigest(bytes, pinnedDigest) {
  if (typeof pinnedDigest !== "string" || !/^[a-f0-9]{64}$/u.test(pinnedDigest)) {
    throw new Error("D392 installed Source evidence digest is missing or malformed.")
  }
  const actual = Buffer.from(digestD392InstalledEvidence(bytes), "hex")
  const expected = Buffer.from(pinnedDigest, "hex")
  if (!timingSafeEqual(actual, expected)) {
    throw new Error("D392 installed Source evidence SHA-256 mismatch.")
  }
}
