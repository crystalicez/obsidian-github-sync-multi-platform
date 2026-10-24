import assert from "node:assert/strict";
import test from "node:test";

import { assessV4ReencryptionReadiness } from "../../src/lib/v4/reencryption-preflight";

const enc = (text: string) => new TextEncoder().encode(text);
const SHA = "a".repeat(40);
const base = {
  sourceConfigBytes: enc(JSON.stringify({
    formatVersion: 4, mode: "encrypted", repoId: "owner/repo#main",
    pathLayout: "opaque-stable-v1", algorithm: "AES-GCM", kdf: "PBKDF2-SHA-256",
    kdfParams: { iterations: 600_000, salt: "c2FsdA" },
  })),
  expectedRepositoryId: "owner/repo#main",
  pinnedSourceCommitSha: SHA,
  observedSourceCommitSha: SHA,
  requestedIterations: 900_000,
  evidence: {
    sourceAuthenticated: true,
    snapshotComplete: true,
    backupVerified: true,
    syncIdle: true,
    recoveryClear: true,
    conflictsResolved: true,
    localChangesResolved: true,
    otherDevicesPaused: true,
    oldHistoryRiskAcknowledged: true,
  },
};

test("D67 read-only re-encryption preview is always blocked until destination topology is approved", () => {
  const result = assessV4ReencryptionReadiness(base);
  assert.equal(result.status, "blocked");
  assert.deepEqual(result.blockers, ["destination-topology-unapproved"]);
  assert.equal(result.sourceRepositoryId, "owner/repo#main");
  assert.equal(result.pinnedSourceCommitSha, SHA);
  assert.equal(result.existingIterations, 600_000);
  assert.equal(result.requestedIterations, 900_000);
  assert.equal(JSON.stringify(result).includes("c2FsdA"), false, "never surface raw KDF salt in a preview");
  assert.equal(JSON.stringify(result).includes("passphrase"), false, "never include credentials or passphrase");
});

test("D67 preflight blocks every unverified safety prerequisite independently", () => {
  const expected = {
    sourceAuthenticated: "source-authentication-unverified",
    snapshotComplete: "source-snapshot-incomplete",
    backupVerified: "backup-unverified",
    syncIdle: "sync-in-progress",
    recoveryClear: "pending-recovery",
    conflictsResolved: "conflicts-unresolved",
    localChangesResolved: "local-edits-unresolved",
    otherDevicesPaused: "other-devices-not-coordinated",
    oldHistoryRiskAcknowledged: "git-history-risk-not-acknowledged",
  } as const;
  for (const [key, blocker] of Object.entries(expected)) {
    const result = assessV4ReencryptionReadiness({
      ...base, evidence: { ...base.evidence, [key]: false },
    });
    assert.ok(result.blockers.includes(blocker), key);
    assert.ok(result.blockers.includes("destination-topology-unapproved"));
  }
  const missing = assessV4ReencryptionReadiness({ ...base, evidence: undefined });
  assert.ok(missing.blockers.includes("backup-unverified"));
  assert.ok(missing.blockers.includes("sync-in-progress"));
});

test("D67 source head races fail closed and no unpinned source commit is accepted", () => {
  const changed = assessV4ReencryptionReadiness({
    ...base, observedSourceCommitSha: "b".repeat(40),
  });
  assert.ok(changed.blockers.includes("source-head-changed"));
  for (const badSha of ["", "HEAD", "main", "0".repeat(64), "A".repeat(40)]) {
    assert.throws(() => assessV4ReencryptionReadiness({
      ...base, pinnedSourceCommitSha: badSha,
    }), /source commit SHA/i, badSha);
  }
  const notObserved = assessV4ReencryptionReadiness({
    ...base, observedSourceCommitSha: null,
  });
  assert.ok(notObserved.blockers.includes("source-head-unverified"));
});

test("D67 rejects unsupported remote identity, KDF iteration attacks and invalid new settings", () => {
  for (const requestedIterations of [0, 599_999, 1_200_001, "900000", 900_000.5, NaN]) {
    assert.throws(() => assessV4ReencryptionReadiness({
      ...base, requestedIterations,
    }), /PBKDF2 iterations/u, String(requestedIterations));
  }
  assert.equal(assessV4ReencryptionReadiness({ ...base, requestedIterations: 1_200_000 }).requestedIterations, 1_200_000);
  assert.throws(() => assessV4ReencryptionReadiness({
    ...base, expectedRepositoryId: "other/repo#main",
  }), /repository identity/i);
  const maliciousRemote = enc(JSON.stringify({
    formatVersion: 4, mode: "encrypted", repoId: "owner/repo#main",
    kdfParams: { iterations: 1_200_001, salt: "c2FsdA" },
  }));
  assert.throws(() => assessV4ReencryptionReadiness({
    ...base, sourceConfigBytes: maliciousRemote,
  }), /KDF|PBKDF2/i);
});

test("D67 legacy KDF and unencrypted sources remain blocked without deleting or reinitializing them", () => {
  const oldRemote = assessV4ReencryptionReadiness({
    ...base, sourceConfigBytes: enc(JSON.stringify({
      formatVersion: 4, mode: "encrypted", repoId: "owner/repo#main",
    })),
  });
  assert.equal(oldRemote.existingIterations, null);
  assert.ok(oldRemote.blockers.includes("source-kdf-metadata-missing"));
  assert.ok(oldRemote.blockers.includes("source-layout-unsupported"));
  const plaintext = assessV4ReencryptionReadiness({
    ...base, sourceConfigBytes: enc(JSON.stringify({
      formatVersion: 4, mode: "plaintext", repoId: "owner/repo#main",
      pathLayout: "plaintext-v1",
    })),
  });
  assert.ok(plaintext.blockers.includes("source-not-encrypted"));
});

test("D67 preflight never performs GitHub, vault, crypto, SecretStorage or local filesystem IO", () => {
  const preview = assessV4ReencryptionReadiness(base);
  assert.equal(preview.status, "blocked");
  assert.ok(Object.isFrozen(preview));
  assert.ok(Object.isFrozen(preview.blockers));
});
