import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sha256Hex, toBase64Url, utf8ToBytes } from "../../src/lib/bytes";
import { deriveV4Keyring } from "../../src/lib/v4/crypto";
import { computeV4GitBlobSha1 } from "../../src/lib/v4/git-blob-identity";
import { planV4OrphanReencryptionDestination } from "../../src/lib/v4/reencryption-orphan-branch";
import { stageV4ReencryptionVaultObjects } from "../../src/lib/v4/reencryption-staging-receipts";
import { createV4ReencryptionRecoveryJournal } from "../../src/lib/v4/reencryption-recovery-journal";
import { acquireV4DesktopRekeyWalStorage } from "../../src/lib/v4/reencryption-desktop-wal";
import { stageV4ReencryptionVaultObjectsWithJournal } from "../../src/lib/v4/reencryption-journaled-staging";
import { stageV4JournaledThreeBranchVault } from "../../src/lib/v4/reencryption-ref-journal-coordinator";
import type { V4LocalIndexAdapter } from "../../src/lib/v4/local-index";
import type { V4IndexFileRecord } from "../../src/lib/v4/local-index";
import type { V4RemoteShard } from "../../src/lib/v4/remote-index";
import type { V4RemoteConfig, V4RemoteHead } from "../../src/lib/v4/protocol-types";
import { V4StorageCodec } from "../../src/lib/v4/storage-codec";

const bytes = utf8ToBytes;
const sha = "a".repeat(40);
const oldId = "owner/repo#main";
const newId = "owner/repo#rekey/d79";
const config = (repoId: string, salt: string): V4RemoteConfig => ({
  formatVersion: 4, mode: "encrypted", repoId, pathLayout: "opaque-stable-v1",
  kdf: "PBKDF2-SHA-256", algorithm: "AES-GCM",
  kdfParams: { iterations: 600_000, salt: toBase64Url(bytes(salt)) },
});
const plan = planV4OrphanReencryptionDestination({
  sourceRepoId: oldId, destinationRepoId: newId,
  sourceCommitSha: sha, sourcePhysicalRepositoryId: 45, destinationPhysicalRepositoryId: 45,
  expectedPhysicalRepositoryId: 45, defaultBranch: "main",
});
async function fixture(extraSize = 0) {
  const sourceKeyring = await deriveV4Keyring({
    repoId: oldId, passphrase: "old-secret", salt: bytes("old-salt"), iterations: 10,
  });
  const destinationKeyring = await deriveV4Keyring({
    repoId: newId, passphrase: "new-secret", salt: bytes("new-salt"), iterations: 10,
  });
  const sourceCodec = new V4StorageCodec({ mode: "encrypted", pathLayout: "opaque-stable-v1", keyring: sourceKeyring });
  const destinationCodec = new V4StorageCodec({ mode: "encrypted", pathLayout: "opaque-stable-v1", keyring: destinationKeyring });
  const sourceBytes = new Map<string, Uint8Array>();
  const targets = new Map<string, Uint8Array>([
    ["Unicode/秘密 🌼.md", bytes("some encrypted data")],
    ["Archive/empty.bin", new Uint8Array()],
  ]);
  if (extraSize) targets.set("Files/big.bin", new Uint8Array(extraSize).fill(0x47));
  const records: V4IndexFileRecord[] = [];
  for (const [path, value] of targets) {
    const prepared = await sourceCodec.prepare(path, value, "v1", 22, "old-" + records.length);
    records.push({ ...prepared.record, path });
    for (const part of prepared.files) sourceBytes.set(part.path, part.bytes);
  }
  const shards: Record<string, V4RemoteShard> = {};
  for (const record of records) {
    const bucket = record.pathId.slice(0, 2);
    (shards[bucket] ??= { bucket, records: {} }).records[record.pathId] = record;
  }
  const shardHashes: Record<string, string> = {};
  for (const [bucket, shard] of Object.entries(shards)) {
    shardHashes[bucket] = await sha256Hex(bytes(JSON.stringify(
      Object.values(shard.records).sort((a, b) => a.pathId.localeCompare(b.pathId)),
    )));
  }
  const head: V4RemoteHead = {
    formatVersion: 4, mode: "encrypted", epoch: 1, generation: 1, journalId: "j",
    deviceId: "device", updatedAt: 1, shardHashes,
  };
  const staged = new Map<string, Uint8Array>();
  const receipts: Array<{ path: string; sha: string }> = [];
  let sourceChecks = 0;
  let stages = 0;
  const input = {
    plan, sourceConfig: config(oldId, "old-salt"), sourceHead: head, sourceShards: shards,
    sourceKeyring, destinationConfig: config(newId, "new-salt"), destinationKeyring,
    async readSourceObject(path: string, commitSha: string) {
      assert.equal(commitSha, sha);
      return sourceBytes.get(path) ?? null;
    },
    async verifySourceStillPinned() { sourceChecks++; },
    async stageImmutableObject(path: string, ciphertext: Uint8Array) {
      stages++;
      const value = ciphertext.slice();
      staged.set(path, value);
      const id = computeV4GitBlobSha1(value);
      receipts.push({ path, sha: id });
      return id;
    },
  };
  return {
    input, staged, receipts, targets, destinationCodec, sourceBytes,
    get stages() { return stages; }, get sourceChecks() { return sourceChecks; },
  };
}

class JournalTestAdapter implements V4LocalIndexAdapter {
  files = new Map<string, string>();
  async read(path: string) {
    const value = this.files.get(path);
    if (!value) throw new Error("journal slot absent");
    return value;
  }
  async write(path: string, value: string) { this.files.set(path, value); }
  async exists(path: string) { return this.files.has(path); }
  async mkdir(_path: string) {}
}

function journal(adapter = new JournalTestAdapter(), sourcePin = sha, destination = newId) {
  return createV4ReencryptionRecoveryJournal({
    adapter,
    root: ".obsidian/plugins/rekey-d81/journal",
    destinationRepoId: destination, sourceCommitSha: sourcePin,
    runId: "rekey-d81-exact-run", journalKey: new Uint8Array(32).fill(0x55),
  });
}

test("D79 stages only finalized V4 output and matches full-vault parity without permitting publish", async () => {
  const f = await fixture();
  const result = await stageV4ReencryptionVaultObjects(f.input);
  assert.equal(result.preview.integrityScope, "staged-immutable-blobs-only");
  assert.equal(result.preview.permissionToPublish, false);
  assert.equal(result.preview.cutoverAuthorized, false);
  assert.equal(result.preview.backupVerified, false);
  assert.equal(result.preview.destinationReadbackVerified, false);
  assert.equal(result.preview.finalizedFileCount, 2);
  assert.equal(result.preview.validatedReceiptCount, 2);
  assert.equal(result.records.length, 2);
  assert.equal(result.receipts.length, 2);
  assert.equal(f.stages, 2);
  assert.ok(f.sourceChecks >= 3);
  assert.ok(Object.isFrozen(result.preview));
  assert.ok(!JSON.stringify(result.preview).includes("秘密"));
  for (const record of result.records) {
    assert.deepEqual(await f.destinationCodec.read(record, async path => f.staged.get(path)!), f.targets.get(record.path));
  }
});

test("D79 rejects a wrong or malformed GitHub object SHA receipt without returning a completed manifest", async () => {
  const f = await fixture();
  await assert.rejects(() => stageV4ReencryptionVaultObjects({
    ...f.input, async stageImmutableObject(_path, _content) { return "f".repeat(40); },
  }), /receipt|blob|SHA|identity/i);
  const next = await fixture();
  await assert.rejects(() => stageV4ReencryptionVaultObjects({
    ...next.input, async stageImmutableObject() { return "HEAD"; },
  }), /receipt|blob|SHA|identity/i);
});

test("D79 stages no extra blobs on incomplete/missing or changed source", async () => {
  const f = await fixture();
  const unknown = { ...f.input.sourceShards };
  delete unknown[Object.keys(unknown)[0]!];
  await assert.rejects(() => stageV4ReencryptionVaultObjects({
    ...f.input, sourceShards: unknown,
  }), /bucket|shard|missing/i);
  assert.equal(f.stages, 0);
  const g = await fixture();
  let calls = 0;
  await assert.rejects(() => stageV4ReencryptionVaultObjects({
    ...g.input, async verifySourceStillPinned() {
      if (++calls > 2) throw new Error("source HEAD changed");
    },
  }), /source HEAD changed/i);
});

test("D79 refuses a completed manifest if a later immutable blob staging attempt fails", async () => {
  const f = await fixture();
  let callbacks = 0;
  await assert.rejects(() => stageV4ReencryptionVaultObjects({
    ...f.input, async stageImmutableObject(path, value) {
      if (++callbacks === 2) throw new Error("temporary GitHub upload failed");
      return computeV4GitBlobSha1(value);
    },
  }), /temporary GitHub upload failed/i);
  assert.equal(callbacks, 2);
});

test("D79 rejects a staging callback that mutates the ciphertext buffer after its SHA was computed", async () => {
  const f = await fixture();
  await assert.rejects(() => stageV4ReencryptionVaultObjects({
    ...f.input,
    async stageImmutableObject(_path, ciphertext) {
      const before = computeV4GitBlobSha1(ciphertext);
      ciphertext[0] = ciphertext[0]! ^ 1;
      return before;
    },
  }), /receipt SHA identity mismatch/i);
});

test("D79 never returns a completed manifest when a later source multipart part is corrupted", async () => {
  const f = await fixture(8 * 1024 * 1024 + 17);
  const all = Object.values(f.input.sourceShards).flatMap(shard => Object.values(shard.records));
  const chunked = all.find(record => record.storage === "chunked");
  assert.ok(chunked);
  const lastPath = chunked.partPaths?.[chunked.partPaths.length - 1];
  assert.ok(lastPath);
  const raw = f.sourceBytes.get(lastPath);
  assert.ok(raw);
  const tampered = raw.slice();
  tampered[tampered.length - 1] ^= 1;
  f.sourceBytes.set(lastPath, tampered);
  await assert.rejects(() => stageV4ReencryptionVaultObjects(f.input), /integrity|authentication|source|decrypt/i);
  assert.ok(f.stages > 0, "an earlier staged immutable object must never imply a complete vault");
});

test("D79 authenticates and stages multipart ciphertext one part at a time", async () => {
  const f = await fixture(8 * 1024 * 1024 + 17);
  const result = await stageV4ReencryptionVaultObjects(f.input);
  assert.equal(result.preview.finalizedFileCount, 3);
  assert.equal(result.preview.validatedReceiptCount, 4);
  for (const receipt of result.receipts) {
    assert.ok(receipt.byteLength <= 8 * 1024 * 1024);
    assert.equal(receipt.sha, computeV4GitBlobSha1(f.staged.get(receipt.path)!));
  }
  const big = result.records.find(record => record.path === "Files/big.bin")!;
  assert.equal(big.storage, "chunked");
  assert.ok(Object.isFrozen(big));
  assert.ok(Object.isFrozen(big.partPaths));
  assert.throws(() => big.partPaths!.push("forged-part"), TypeError,
    "completed multipart object paths must remain immutable after receipt validation");
  assert.deepEqual(await f.destinationCodec.read(big, async path => f.staged.get(path)!), f.targets.get(big.path));
});

test("D81 binds D79 staging to WAL intent BEFORE upload and confirms exact Git SHA afterwards", async () => {
  const f = await fixture();
  const adapter = new JournalTestAdapter();
  const wal = journal(adapter);
  let uploads = 0;
  let leaseChecks = 0;
  const result = await stageV4ReencryptionVaultObjectsWithJournal({
    ...f.input, journal: wal,
    async assertExclusiveStageLease() { leaseChecks++; },
    async stageImmutableObject(path, ciphertext) {
      uploads++;
      const current = await journal(adapter).load();
      assert.ok(current);
      assert.equal(current.pendingIntents.length, 1, "intent must exist before Git Blob API is called");
      assert.equal(current.pendingIntents[0]!.path, path);
      assert.equal(current.pendingIntents[0]!.sha, computeV4GitBlobSha1(ciphertext));
      assert.equal(current.receipts.length, uploads - 1);
      return f.input.stageImmutableObject(path, ciphertext);
    },
  });
  assert.equal(uploads, 2);
  assert.ok(leaseChecks >= 6);
  assert.deepEqual(result.journalSnapshot.receipts, result.receipts);
  assert.equal(result.journalSnapshot.pendingIntents.length, 0);
  assert.equal(result.journalSnapshot.requiresRemoteRevalidation, true);
  assert.equal(result.journalSnapshot.permissionToPublish, false);
  assert.equal(result.preview.destinationReadbackVerified, false);
  assert.equal((await journal(adapter).load())!.receipts.length, 2);
  const serialized = [...adapter.files.values()].join("");
  assert.ok(!serialized.includes("秘密"));
  assert.ok(!serialized.includes(result.receipts[0]!.path));
});

test("D102 D90 three-branch flow stages fresh ciphertext AFTER explicitly verified Backup WAL ref, not a new journal", async () => {
  const f = await fixture();
  const wal = journal();
  let state = await wal.begin();
  const backupRef = {
    role: "backup" as const, repoId: "owner/repo#backup/frozen",
    commitSha: sha, treeSha: "b".repeat(40),
  };
  state = await wal.recordRefIntent(backupRef, state.generation);
  state = await wal.markRefReadbackObserved(backupRef, state.generation);
  const result = await stageV4ReencryptionVaultObjectsWithJournal({
    ...f.input, journal: wal,
    beginAfterVerifiedBackup: { expectedJournalGeneration: state.generation, backupRef },
    async assertExclusiveStageLease() {},
    async assertCrashDurable() {},
  });
  assert.equal(result.receipts.length, 2);
  assert.equal(result.journalSnapshot.stageHandoffStarted, true);
  assert.equal(result.journalSnapshot.verifiedRefObservations.length, 1);
  assert.deepEqual(result.journalSnapshot.verifiedRefObservations[0], backupRef);
  assert.equal(result.journalSnapshot.pendingRefIntents.length, 0);
  assert.deepEqual(result.journalSnapshot.receipts, result.receipts);
  assert.equal(result.journalSnapshot.permissionToPublish, false);
  assert.equal(result.journalSnapshot.cutoverAuthorized, false);
  await assert.rejects(() => stageV4ReencryptionVaultObjectsWithJournal({
    ...f.input, journal: wal,
    beginAfterVerifiedBackup: { expectedJournalGeneration: state.generation, backupRef },
    async assertExclusiveStageLease() {},
    async assertCrashDurable() {},
  }), /previous run requires manual recovery/i);
});

test("D102 refuses accidental reuse of an older Backup journal, wrong exact backup SHA or unresolved backup intent", async () => {
  const f = await fixture();
  const wal = journal();
  let state = await wal.begin();
  const backupRef = {
    role: "backup" as const, repoId: "owner/repo#backup/frozen",
    commitSha: sha, treeSha: "b".repeat(40),
  };
  state = await wal.recordRefIntent(backupRef, state.generation);
  let uploads = 0;
  const stage = (beginAfterVerifiedBackup?: { expectedJournalGeneration: number; backupRef: typeof backupRef }) =>
    stageV4ReencryptionVaultObjectsWithJournal({
      ...f.input, journal: wal, beginAfterVerifiedBackup,
      async assertExclusiveStageLease() {},
      async assertCrashDurable() {},
      async stageImmutableObject(path, value) {
        uploads++;
        return f.input.stageImmutableObject(path, value);
      },
    });
  await assert.rejects(() => stage({ expectedJournalGeneration: state.generation, backupRef }),
    /previous run requires manual recovery/i);
  state = await wal.markRefReadbackObserved(backupRef, state.generation);
  await assert.rejects(() => stage({ expectedJournalGeneration: state.generation - 1, backupRef }),
    /previous run requires manual recovery/i);
  await assert.rejects(() => stage({ expectedJournalGeneration: state.generation,
    backupRef: { ...backupRef, treeSha: "f".repeat(40) },
  }), /previous run requires manual recovery/i);
  await assert.rejects(() => stage(), /previous run requires manual recovery/i);
  assert.equal(uploads, 0);
});

test("D109 approved three-branch staging refuses missing real WAL crash-durability barrier before any upload", async () => {
  const f = await fixture();
  const wal = journal();
  let state = await wal.begin();
  const backupRef = {
    role: "backup" as const, repoId: "owner/repo#backup/frozen",
    commitSha: sha, treeSha: "b".repeat(40),
  };
  state = await wal.recordRefIntent(backupRef, state.generation);
  state = await wal.markRefReadbackObserved(backupRef, state.generation);
  const before = state.generation;
  await assert.rejects(() => stageV4ReencryptionVaultObjectsWithJournal({
    ...f.input, journal: wal,
    beginAfterVerifiedBackup: { expectedJournalGeneration: before, backupRef },
    async assertExclusiveStageLease() {},
  }), /crash-durable WAL barrier/i);
  assert.equal(f.stages, 0);
  assert.equal((await wal.load())?.generation, before);
  assert.equal((await wal.load())?.stageHandoffStarted, false);
});

test("D109 Windows fsync EPERM stops three-branch staging even before the one-shot handoff", async () => {
  const f = await fixture();
  const wal = journal();
  let state = await wal.begin();
  const backupRef = {
    role: "backup" as const, repoId: "owner/repo#backup/frozen",
    commitSha: sha, treeSha: "b".repeat(40),
  };
  state = await wal.recordRefIntent(backupRef, state.generation);
  state = await wal.markRefReadbackObserved(backupRef, state.generation);
  await assert.rejects(() => stageV4ReencryptionVaultObjectsWithJournal({
    ...f.input, journal: wal,
    beginAfterVerifiedBackup: { expectedJournalGeneration: state.generation, backupRef },
    async assertExclusiveStageLease() {},
    async assertCrashDurable() { throw new Error("Windows Node directory fsync EPERM"); },
  }), /fsync EPERM/i);
  assert.equal(f.stages, 0);
  assert.equal((await wal.load())?.stageHandoffStarted, false);
});

test("D109 fsync failure AFTER encrypted blob intent but BEFORE GitHub POST leaves pending WAL and zero uploaded blobs", async () => {
  const f = await fixture();
  const wal = journal();
  let state = await wal.begin();
  const backupRef = {
    role: "backup" as const, repoId: "owner/repo#backup/frozen",
    commitSha: sha, treeSha: "b".repeat(40),
  };
  state = await wal.recordRefIntent(backupRef, state.generation);
  state = await wal.markRefReadbackObserved(backupRef, state.generation);
  let durabilityChecks = 0;
  await assert.rejects(() => stageV4ReencryptionVaultObjectsWithJournal({
    ...f.input, journal: wal,
    beginAfterVerifiedBackup: { expectedJournalGeneration: state.generation, backupRef },
    async assertExclusiveStageLease() {},
    async assertCrashDurable() {
      if (++durabilityChecks === 3) throw new Error("fsync interrupted after staged blob intent");
    },
  }), /fsync interrupted/i);
  assert.equal(durabilityChecks, 3);
  assert.equal(f.stages, 0, "no remote blob upload after non-durable Git blob intent");
  const pending = await wal.load();
  assert.ok(pending);
  assert.equal(pending.stageHandoffStarted, true);
  assert.equal(pending.pendingIntents.length, 1);
  assert.equal(pending.receipts.length, 0);
  assert.equal(pending.requiresRemoteRevalidation, true);
  assert.equal(pending.permissionToPublish, false);
  await assert.rejects(() => stageV4ReencryptionVaultObjectsWithJournal({
    ...f.input, journal: wal,
    beginAfterVerifiedBackup: { expectedJournalGeneration: state.generation, backupRef },
    async assertExclusiveStageLease() {},
    async assertCrashDurable() {},
  }), /previous run requires manual recovery/i);
  assert.equal(f.stages, 0);
});

test("D109 same-run Backup→Staging coordinator binds WAL durable guard without caller-supplied staging callback", async () => {
  const f = await fixture();
  const journalInstance = journal();
  let state = await journalInstance.begin();
  const backupRef = {
    role: "backup" as const, repoId: "owner/repo#backup/frozen",
    commitSha: sha, treeSha: "b".repeat(40),
  };
  state = await journalInstance.recordRefIntent(backupRef, state.generation);
  state = await journalInstance.markRefReadbackObserved(backupRef, state.generation);
  let durableChecks = 0;
  let leaseChecks = 0;
  const result = await stageV4JournaledThreeBranchVault({
    ...f.input, journal: journalInstance,
    beginAfterVerifiedBackup: { expectedJournalGeneration: state.generation, backupRef },
    wal: {
      async assertExclusiveStageLease() { leaseChecks++ },
      async assertCrashDurable() { durableChecks++ },
    },
  });
  assert.equal(f.stages, 2);
  assert.ok(durableChecks >= 6);
  assert.ok(leaseChecks >= durableChecks);
  assert.equal(result.journalSnapshot.stageHandoffStarted, true);
  assert.equal(result.journalSnapshot.receipts.length, 2);
  assert.equal(result.journalSnapshot.permissionToPublish, false);
  assert.equal(result.journalSnapshot.cutoverAuthorized, false);
});

test("D109 same-run coordinator propagates Windows WAL fsync EPERM without entering staging", async () => {
  const f = await fixture();
  const journalInstance = journal();
  let state = await journalInstance.begin();
  const backupRef = {
    role: "backup" as const, repoId: "owner/repo#backup/frozen",
    commitSha: sha, treeSha: "b".repeat(40),
  };
  state = await journalInstance.recordRefIntent(backupRef, state.generation);
  state = await journalInstance.markRefReadbackObserved(backupRef, state.generation);
  await assert.rejects(() => stageV4JournaledThreeBranchVault({
    ...f.input, journal: journalInstance,
    beginAfterVerifiedBackup: { expectedJournalGeneration: state.generation, backupRef },
    wal: {
      async assertExclusiveStageLease() {},
      async assertCrashDurable() { throw new Error("D86 Windows directory fsync EPERM"); },
    },
  }), /fsync EPERM/i);
  assert.equal(f.stages, 0);
  assert.equal((await journalInstance.load())?.stageHandoffStarted, false);
});

test("D109 REAL Windows WAL filesystem capability blocks Git staging POST when directory sync is unsupported", async () => {
  const tempParent = join(process.cwd(), ".tmp");
  await mkdir(tempParent, { recursive: true });
  const root = await mkdtemp(join(tempParent, "d109-actual-rekey-stage-"));
  const journalRoot = "rekey/wal";
  try {
    const wal = await acquireV4DesktopRekeyWalStorage({ rootAbsolute: root, journalRoot });
    try {
      const j = createV4ReencryptionRecoveryJournal({
        adapter: wal.adapter, root: journalRoot, destinationRepoId: newId,
        sourceCommitSha: sha, runId: "rekey-d109-real-wal",
        journalKey: new Uint8Array(32).fill(0x55),
      });
      let state = await j.begin();
      const backupRef = {
        role: "backup" as const, repoId: "owner/repo#backup/frozen",
        commitSha: sha, treeSha: "b".repeat(40),
      };
      state = await j.recordRefIntent(backupRef, state.generation);
      state = await j.markRefReadbackObserved(backupRef, state.generation);
      const f = await fixture();
      let physicalDurabilityError: unknown;
      try { await wal.assertCrashDurable() }
      catch (error) { physicalDurabilityError = error }
      if (physicalDurabilityError) {
        await assert.rejects(() => stageV4JournaledThreeBranchVault({
          ...f.input, journal: j, wal,
          beginAfterVerifiedBackup: { expectedJournalGeneration: state.generation, backupRef },
        }), /fsync|durability/i);
        assert.equal(f.stages, 0);
        assert.equal((await j.load())?.stageHandoffStarted, false);
      } else {
        // On a platform where the real barrier succeeds, this fixture has
        // only in-memory immutable Git blob callbacks, NOT live GitHub.
        const result = await stageV4JournaledThreeBranchVault({
          ...f.input, journal: j, wal,
          beginAfterVerifiedBackup: { expectedJournalGeneration: state.generation, backupRef },
        });
        assert.equal(result.journalSnapshot.receipts.length, 2);
        assert.equal(result.journalSnapshot.cutoverAuthorized, false);
      }
    } finally { await wal.release() }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("D81 timeout after upload intent leaves unresolved WAL; a retry cannot silently reuse it", async () => {
  const f = await fixture();
  const wal = journal();
  let attempts = 0;
  const run = () => stageV4ReencryptionVaultObjectsWithJournal({
    ...f.input, journal: wal, async assertExclusiveStageLease() {},
    async stageImmutableObject() { attempts++; throw new Error("ambiguous GitHub timeout"); },
  });
  await assert.rejects(run, /ambiguous GitHub timeout/);
  assert.equal((await wal.load())!.pendingIntents.length, 1);
  assert.equal((await wal.load())!.receipts.length, 0);
  await assert.rejects(run, /previous run requires manual recovery/);
  assert.equal(attempts, 1);
});

test("D81 wrong blob SHA stays pending and never becomes a completed journal receipt", async () => {
  const f = await fixture();
  const wal = journal();
  await assert.rejects(() => stageV4ReencryptionVaultObjectsWithJournal({
    ...f.input, journal: wal, async assertExclusiveStageLease() {},
    async stageImmutableObject() { return "f".repeat(40); },
  }), /blob SHA mismatch/);
  assert.equal((await wal.load())!.pendingIntents.length, 1);
  assert.equal((await wal.load())!.receipts.length, 0);
});

test("D81 bad source, wrong WAL binding or missing exclusive lease stops before any Git write", async () => {
  const f = await fixture();
  let uploads = 0;
  const upload = async () => { uploads++; return "f".repeat(40); };
  const corrupt = { ...f.input.sourceShards };
  delete corrupt[Object.keys(corrupt)[0]!];
  const wal = journal();
  await assert.rejects(() => stageV4ReencryptionVaultObjectsWithJournal({
    ...f.input, sourceShards: corrupt, journal: wal,
    assertExclusiveStageLease: async () => {}, stageImmutableObject: upload,
  }), /bucket|missing|shard/);
  assert.equal(await wal.load(), null);
  await assert.rejects(() => stageV4ReencryptionVaultObjectsWithJournal({
    ...f.input, journal: journal(new JournalTestAdapter(), "b".repeat(40)),
    assertExclusiveStageLease: async () => {}, stageImmutableObject: upload,
  }), /binding mismatch/);
  await assert.rejects(() => stageV4ReencryptionVaultObjectsWithJournal({
    ...f.input, journal: wal,
    async assertExclusiveStageLease() { throw new Error("exclusive lease not held"); },
    stageImmutableObject: upload,
  }), /exclusive lease not held/);
  assert.equal(uploads, 0);
});

test("D81 cancellation after journaling intent, before sending bytes, leaves pending no receipt", async () => {
  const f = await fixture();
  const wal = journal();
  const controller = new AbortController();
  let uploads = 0;
  await assert.rejects(() => stageV4ReencryptionVaultObjectsWithJournal({
    ...f.input, journal: wal, signal: controller.signal,
    async assertExclusiveStageLease() {
      if ((await wal.load())?.pendingIntents.length) controller.abort(new Error("cancel after intent"));
    },
    async stageImmutableObject() { uploads++; return "f".repeat(40); },
  }), /cancel after intent|abort/i);
  assert.equal((await wal.load())!.pendingIntents.length, 1);
  assert.equal(uploads, 0);
});

test("D79 refuses cancellation before producing an output report", async () => {
  const f = await fixture();
  const controller = new AbortController();
  controller.abort(new Error("user cancelled"));
  await assert.rejects(() => stageV4ReencryptionVaultObjects({
    ...f.input, signal: controller.signal,
  }), /cancelled/i);
  assert.equal(f.stages, 0);
});
