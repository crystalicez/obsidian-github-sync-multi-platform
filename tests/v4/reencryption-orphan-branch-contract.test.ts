import assert from "node:assert/strict";
import test from "node:test";

import {
  planV4OrphanReencryptionDestination,
  assertV4OrphanReencryptionRoot,
  assertV4OrphanDestinationRefObservations,
} from "../../src/lib/v4/reencryption-orphan-branch";

const SOURCE_SHA = "a".repeat(40);
const SOURCE_TREE = "b".repeat(40);
const DEST_SHA = "c".repeat(40);
const DEST_TREE = "d".repeat(40);
const SOURCE_REPO_ID = "owner/repo#main";
const DEST_REPO_ID = "owner/repo#rekey/new-key-2026";
const oldConfig = {
  formatVersion: 4, mode: "encrypted", repoId: SOURCE_REPO_ID,
  pathLayout: "opaque-stable-v1", algorithm: "AES-GCM",
  kdf: "PBKDF2-SHA-256", kdfParams: { iterations: 600_000, salt: "c2FsdA" },
};
const newConfig = {
  ...oldConfig, repoId: DEST_REPO_ID,
  kdfParams: { iterations: 900_000, salt: "bmV3LXNhbHQ" },
};
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const topology = {
  sourceRepoId: SOURCE_REPO_ID,
  destinationRepoId: DEST_REPO_ID,
  sourceCommitSha: SOURCE_SHA,
  sourcePhysicalRepositoryId: 1234,
  destinationPhysicalRepositoryId: 1234,
  expectedPhysicalRepositoryId: 1234,
  defaultBranch: "main",
};
const candidate = {
  candidateCommit: { sha: DEST_SHA, treeSha: DEST_TREE, parentShas: [] as string[] },
  sourceTreeSha: SOURCE_TREE,
  sourceConfigBytes: bytes(oldConfig),
  destinationConfigBytes: bytes(newConfig),
};

test("D74 approved topology chooses a new root commit on a distinct same-repository branch", () => {
  const plan = planV4OrphanReencryptionDestination(topology);
  assert.deepEqual(plan, {
    kind: "same-repository-new-orphan-branch",
    status: "blocked-pending-migration-implementation",
    sourceRepoId: SOURCE_REPO_ID,
    destinationRepoId: DEST_REPO_ID,
    pinnedSourceCommitSha: SOURCE_SHA,
    physicalRepositoryId: 1234,
    destinationBranch: "rekey/new-key-2026",
  });
  assert.ok(Object.isFrozen(plan));
  assert.ok(!("safeToPublish" in plan));
});

test("D74 rejects source branch, default branch, a different repository, and invalid refs", () => {
  const invalid = [
    { ...topology, destinationRepoId: SOURCE_REPO_ID },
    { ...topology, destinationRepoId: "owner/other#rekey/new-key-2026" },
    { ...topology, destinationRepoId: "other/repo#rekey/new-key-2026" },
     { ...topology, destinationRepoId: "owner/repo#rekey/../unsafe" },
    { ...topology, destinationRepoId: "owner/repo#rekey/name.lock" },
    { ...topology, destinationRepoId: "owner/repo#feature name" },
    { ...topology, destinationRepoId: "owner/repo#rekey/new-key-2026#bad" },
    { ...topology, destinationRepoId: "owner/repo#rekey//double" },
   ];
  for (const input of invalid) {
    assert.throws(() => planV4OrphanReencryptionDestination(input), /branch|repository|destination|identity|Invalid/u);
  }
  assert.equal(planV4OrphanReencryptionDestination({
    ...topology, destinationRepoId: "owner/repo#main/sub",
  }).destinationBranch, "main/sub");
  assert.throws(
    () => planV4OrphanReencryptionDestination({ ...topology, defaultBranch: "rekey/new-key-2026" }),
    /default branch/i,
  );
});

test("D74 rejects physical GitHub ID mismatch and malformed commit identity", () => {
  for (const input of [
    { ...topology, destinationPhysicalRepositoryId: 1235 },
    { ...topology, sourcePhysicalRepositoryId: 1235 },
    { ...topology, expectedPhysicalRepositoryId: 0 },
    { ...topology, sourceCommitSha: "HEAD" },
    { ...topology, sourceCommitSha: "e".repeat(64) },
  ]) {
    assert.throws(() => planV4OrphanReencryptionDestination(input), /repository|identity|SHA/i);
  }
});

test("D74 candidate root proof requires zero parents and fresh destination encrypted config", () => {
  const plan = planV4OrphanReencryptionDestination(topology);
  const proof = assertV4OrphanReencryptionRoot({ ...candidate, plan });
  assert.deepEqual(proof, {
    proof: "orphan-commit-topology-only",
    destinationRepoId: DEST_REPO_ID,
    destinationCommitSha: DEST_SHA,
    destinationTreeSha: DEST_TREE,
    parentCount: 0,
  });
  assert.ok(Object.isFrozen(proof));
  assert.equal(JSON.stringify(proof).includes("c2FsdA"), false);
});

test("D74 rejects parent ancestry, source commit/tree reuse, key/KDF/salt reuse and wrong new repo ID", () => {
  const plan = planV4OrphanReencryptionDestination(topology);
  for (const variant of [
    { ...candidate, candidateCommit: { ...candidate.candidateCommit, parentShas: [SOURCE_SHA] } },
    { ...candidate, candidateCommit: { ...candidate.candidateCommit, parentShas: ["e".repeat(40)] } },
    { ...candidate, candidateCommit: { ...candidate.candidateCommit, sha: SOURCE_SHA } },
    { ...candidate, candidateCommit: { ...candidate.candidateCommit, treeSha: SOURCE_TREE } },
    { ...candidate, destinationConfigBytes: bytes({ ...newConfig, repoId: SOURCE_REPO_ID }) },
    { ...candidate, destinationConfigBytes: bytes({ ...newConfig, kdfParams: oldConfig.kdfParams }) },
    { ...candidate, destinationConfigBytes: bytes({ ...newConfig, mode: "plaintext", pathLayout: "plaintext-v1" }) },
    { ...candidate, destinationConfigBytes: bytes({ ...newConfig, kdfParams: { iterations: 1_200_001, salt: "bmV3LXNhbHQ" } }) },
  ]) {
    assert.throws(() => assertV4OrphanReencryptionRoot({ ...variant, plan }), /root|parent|source|tree|salt|KDF|encrypted|destination|PBKDF2/i);
  }
});

test("D96 requires pinned initial source snapshot and two absent destination refs without fencing later old-branch commits", () => {
  const plan = planV4OrphanReencryptionDestination(topology);
  const proof = assertV4OrphanDestinationRefObservations({
    plan,
    observedSourceCommitShaBefore: SOURCE_SHA,
    observedSourceCommitShaAfter: SOURCE_SHA,
    destinationFirstObservation: null,
    destinationSecondObservation: null,
    observedPhysicalRepositoryIdBefore: 1234,
    observedPhysicalRepositoryIdAfter: 1234,
  });
  assert.deepEqual(proof, {
    proof: "prepublication-ref-observations-only",
    destinationRepoId: DEST_REPO_ID,
    pinnedSourceCommitSha: SOURCE_SHA,
    independentlyObservedAbsentCount: 2,
  });
  assert.ok(Object.isFrozen(proof));
  assert.ok(!("safeToPublish" in proof));
  const laterOldBranchCommit = assertV4OrphanDestinationRefObservations({
    plan,
    observedSourceCommitShaBefore: SOURCE_SHA,
    observedSourceCommitShaAfter: "e".repeat(40),
    destinationFirstObservation: null,
    destinationSecondObservation: null,
    observedPhysicalRepositoryIdBefore: 1234,
    observedPhysicalRepositoryIdAfter: 1234,
  })
  assert.deepEqual(laterOldBranchCommit, proof);
  // Observation proof is NOT permission to publish: create-ref collision
  // checks and actual durable migration prerequisites remain mandatory.
});

test("D96 refuses destination occupancy, unpinned initial source, malformed later source and physical repo switch", () => {
  const plan = planV4OrphanReencryptionDestination(topology);
  const stable = {
    plan,
    observedSourceCommitShaBefore: SOURCE_SHA,
    observedSourceCommitShaAfter: SOURCE_SHA,
    destinationFirstObservation: null,
    destinationSecondObservation: null,
    observedPhysicalRepositoryIdBefore: 1234,
    observedPhysicalRepositoryIdAfter: 1234,
  };
  for (const patch of [
    { destinationFirstObservation: DEST_SHA },
    { destinationSecondObservation: DEST_SHA },
    { destinationSecondObservation: undefined },
    { observedSourceCommitShaBefore: "e".repeat(40) },
    { observedSourceCommitShaAfter: null },
    { observedPhysicalRepositoryIdAfter: 4321 },
    { observedPhysicalRepositoryIdBefore: 0 },
  ]) {
    assert.throws(() => assertV4OrphanDestinationRefObservations({ ...stable, ...patch }),
      /source|destination|ref|branch|repository|identity|observation/i);
  }
});

test("D74 pure contract does not perform reads, writes, ref changes, migrations or device cutover", () => {
  const plan = planV4OrphanReencryptionDestination(topology);
  assert.equal(plan.status, "blocked-pending-migration-implementation");
  assert.ok(!("sourceToken" in plan));
  assert.ok(!("passphrase" in plan));
  assert.ok(!("oldSalt" in plan));
});
