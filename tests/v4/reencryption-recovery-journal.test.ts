import assert from "node:assert/strict";
import test from "node:test";

import { utf8ToBytes } from "../../src/lib/bytes";
import { createV4ReencryptionRecoveryJournal, V4ReencryptionJournalRecoveryRequiredError } from "../../src/lib/v4/reencryption-recovery-journal";
import type { V4LocalIndexAdapter } from "../../src/lib/v4/local-index";

const sourceCommitSha = "a".repeat(40);
const repoId = "owner/repo#rekey/new";
const runId = "rekey-d80-test-run";
const key = new Uint8Array(32).fill(0x9f);

class MemoryAdapter implements V4LocalIndexAdapter {
  files = new Map<string, string>();
  async read(path: string) { const v = this.files.get(path); if (v === undefined) throw new Error("missing"); return v; }
  async write(path: string, value: string) { this.files.set(path, value); }
  async exists(path: string) { return this.files.has(path); }
  async mkdir(_path: string) {}
}

function create(adapter = new MemoryAdapter(), overrides: Record<string, unknown> = {}) {
  return createV4ReencryptionRecoveryJournal({
    adapter, root: ".obsidian/plugins/test-v4/rekey-journal",
    destinationRepoId: repoId, sourceCommitSha, runId, journalKey: key, ...overrides,
  });
}
const receipt = (n: number) => ({
  path: `.obsidian-github-sync-v4/data/aa/aa${n.toString(16).padStart(62, "0")}.enc`,
  sha: n.toString(16).padStart(40, "0"),
  byteLength: 343,
});

test("D80 two-slot encrypted WAL is readable after restart but never authorizes reusing staged receipts", async () => {
  const adapter = new MemoryAdapter();
  const store = create(adapter);
  assert.equal(await store.load(), null);
  const begun = await store.begin();
  assert.equal(begun.generation, 1);
  assert.equal(begun.requiresRemoteRevalidation, true);
  const intent1 = await store.recordUploadIntent(receipt(1), begun.generation);
  assert.equal(intent1.pendingIntents.length, 1);
  const first = await store.appendReceipt(receipt(1), intent1.generation);
  const intent2 = await store.recordUploadIntent(receipt(2), first.generation);
  const second = await store.appendReceipt(receipt(2), intent2.generation);
  assert.equal(second.generation, 5);
  assert.equal(second.receipts.length, 2);
  assert.equal(second.permissionToPublish, false);
  assert.equal(second.cutoverAuthorized, false);
  const restarted = await create(adapter).load();
  assert.ok(restarted);
  assert.equal(restarted.generation, 5);
  assert.equal(restarted.receipts.length, 2);
  assert.equal(restarted.requiresRemoteRevalidation, true);
  assert.equal(restarted.permissionToPublish, false);
  assert.equal(restarted.cutoverAuthorized, false);
  const raw = [...adapter.files.values()].join("");
  assert.ok(!raw.includes(receipt(1).path), "WAL must not expose object paths in plaintext");
  assert.ok(!raw.includes(receipt(1).sha), "WAL must not expose Git receipt SHA in plaintext");
});

test("D80 refuses corrupt newest slot but loads older authenticated generation ONLY as unverified", async () => {
  const adapter = new MemoryAdapter();
  const store = create(adapter);
  const started = await store.begin();
  const intent1 = await store.recordUploadIntent(receipt(1), started.generation);
  const final1 = await store.appendReceipt(receipt(1), intent1.generation);
  const intent2 = await store.recordUploadIntent(receipt(2), final1.generation);
  const third = await store.appendReceipt(receipt(2), intent2.generation);
  assert.equal(third.generation, 5);
  const recent = [...adapter.files.keys()].find(path => path.endsWith("slot-1.json"))!;
  adapter.files.set(recent, "{broken");
  const recovered = await create(adapter).load();
  assert.ok(recovered);
  assert.equal(recovered.generation, 4);
  assert.equal(recovered.receipts.length, 1);
  assert.equal(recovered.pendingIntents.length, 1);
  assert.equal(recovered.requiresRemoteRevalidation, true);
  await assert.rejects(() => create(adapter).appendReceipt(receipt(2), 4),
    /damaged|interrupted|recovery/i, "do not overwrite a higher potentially torn generation without manual reconciliation");
});

test("D80 corrupted BOTH WAL slots requires manual recovery, never starts an empty successful run", async () => {
  const adapter = new MemoryAdapter();
  const store = create(adapter);
  const beginning = await store.begin();
  await store.recordUploadIntent(receipt(1), beginning.generation);
  for (const path of adapter.files.keys()) adapter.files.set(path, "{");
  await assert.rejects(() => create(adapter).load(), V4ReencryptionJournalRecoveryRequiredError);
  await assert.rejects(() => create(adapter).begin(), V4ReencryptionJournalRecoveryRequiredError);
});

test("D80 wrong destination, source pin, run identity or journal key cannot decrypt old journal", async () => {
  const adapter = new MemoryAdapter();
  const store = create(adapter);
  await store.begin();
  for (const overrides of [
    { destinationRepoId: "owner/repo#rekey/other" },
    { sourceCommitSha: "b".repeat(40) },
    { runId: "another-rekey-run" },
    { journalKey: new Uint8Array(32).fill(0x38) },
  ]) {
    await assert.rejects(() => create(adapter, overrides).load(), V4ReencryptionJournalRecoveryRequiredError);
  }
});

test("D80 duplicate receipts, invalid Git SHA, unexpected version and stale generation fail without writes", async () => {
  const adapter = new MemoryAdapter();
  const store = create(adapter);
  const begun = await store.begin();
  const intent = await store.recordUploadIntent(receipt(1), begun.generation);
  const staged = await store.appendReceipt(receipt(1), intent.generation);
  const before = new Map(adapter.files);
  for (const value of [
    receipt(1),
    { ...receipt(2), sha: "HEAD" },
    { ...receipt(2), byteLength: 8 * 1024 * 1024 + 1 },
    { ...receipt(2), path: "../secret" },
  ]) {
    await assert.rejects(() => store.recordUploadIntent(value, staged.generation), /duplicate|SHA|size|path|invalid|recovery journal/i);
    assert.deepEqual(adapter.files, before);
  }
  await assert.rejects(() => store.recordUploadIntent(receipt(3), 1), /generation|stale/i);
  assert.deepEqual(adapter.files, before);
});

test("D80 crash mid-new-slot write leaves older snapshot, requires revalidation and prohibits untrusted retry", async () => {
  class TornAdapter extends MemoryAdapter {
    tear = false;
    override async write(path: string, value: string) {
      if (this.tear) { this.files.set(path, value.slice(0, 14)); throw new Error("simulated power loss"); }
      await super.write(path, value);
    }
  }
  const adapter = new TornAdapter();
  const store = create(adapter);
  const started = await store.begin();
  adapter.tear = true;
  await assert.rejects(() => store.recordUploadIntent(receipt(1), started.generation), /simulated power loss/);
  adapter.tear = false;
  const restored = await create(adapter).load();
  assert.ok(restored);
  assert.equal(restored.generation, 1);
  assert.equal(restored.receipts.length, 0);
  assert.equal(restored.pendingIntents.length, 0);
  assert.equal(restored.requiresRemoteRevalidation, true);
});

test("D80 pending upload intent survives restart and mismatched receipt cannot clear it", async () => {
  const adapter = new MemoryAdapter();
  const journal = create(adapter);
  const begun = await journal.begin();
  const intent = await journal.recordUploadIntent(receipt(7), begun.generation);
  const restarted = create(adapter);
  const loaded = await restarted.load();
  assert.ok(loaded);
  assert.equal(loaded.pendingIntents.length, 1);
  assert.equal(loaded.receipts.length, 0);
  assert.equal(loaded.requiresRemoteRevalidation, true);
  const before = new Map(adapter.files);
  await assert.rejects(() => restarted.appendReceipt({ ...receipt(7), sha: "b".repeat(40) }, intent.generation),
    /intent|receipt/i);
  assert.deepEqual(adapter.files, before);
  const completed = await restarted.appendReceipt(receipt(7), intent.generation);
  assert.equal(completed.pendingIntents.length, 0);
  assert.equal(completed.receipts.length, 1);
  assert.equal(completed.permissionToPublish, false);
});


const backupIntent = {
  role: "backup" as const,
  repoId: "owner/repo#backup/frozen-old-key",
  commitSha: sourceCommitSha,
  treeSha: "c".repeat(40),
};
const destinationIntent = {
  role: "destination" as const,
  repoId,
  commitSha: "d".repeat(40),
  treeSha: "e".repeat(40),
  manifestSha256: "f".repeat(64),
};
const candidateReceipt = {
  commitSha: destinationIntent.commitSha,
  treeSha: destinationIntent.treeSha,
  manifestSha256: destinationIntent.manifestSha256,
};

test("D101 encrypted two-slot WAL persists BOTH Git ref create-intents through restart with exact SHA/tree identity", async () => {
  const adapter = new MemoryAdapter();
  let journal = create(adapter);
  const begun = await journal.begin();
  let snap = await journal.recordRefIntent(backupIntent, begun.generation);
  assert.deepEqual(snap.pendingRefIntents, [backupIntent]);
  assert.equal(snap.verifiedRefObservations.length, 0);
  assert.equal(snap.permissionToPublish, false);
  assert.equal(snap.cutoverAuthorized, false);
  const raw = [...adapter.files.values()].join("");
  assert.ok(!raw.includes(backupIntent.repoId));
  // Source SHA is intentionally in the existing WAL authenticated header as the run identity.
  assert.ok(raw.includes(sourceCommitSha));
  assert.ok(!raw.includes(backupIntent.treeSha));
  journal = create(adapter); // simulated process restart after GitHub POST outcome was lost
  const afterRestart = await journal.load();
  assert.ok(afterRestart);
  assert.deepEqual(afterRestart.pendingRefIntents, [backupIntent]);
  assert.equal(afterRestart.requiresRemoteRevalidation, true);
  assert.equal(afterRestart.permissionToPublish, false);
  await assert.rejects(() => journal.recordRefIntent(backupIntent, afterRestart.generation), /duplicate/i);
  await assert.rejects(() => journal.recordRefIntent(destinationIntent, afterRestart.generation), /requires completed staging|verified Backup/i);
  await assert.rejects(() => journal.recordUploadIntent(receipt(1), afterRestart.generation), /unresolved ref/i);

  snap = await journal.markRefReadbackObserved(backupIntent, afterRestart.generation);
  assert.equal(snap.pendingRefIntents.length, 0);
  assert.deepEqual(snap.verifiedRefObservations, [backupIntent]);
  snap = await journal.recordStagingHandoff(backupIntent, snap.generation);
  const upload = await journal.recordUploadIntent(receipt(1), snap.generation);
  snap = await journal.appendReceipt(receipt(1), upload.generation);
  snap = await journal.recordCandidatePreparationIntent("1".repeat(64), snap.generation);
  snap = await journal.recordPreparedCandidateReceipt(candidateReceipt, snap.generation);
  snap = await journal.recordRefIntent(destinationIntent, snap.generation);
  assert.deepEqual(snap.pendingRefIntents, [destinationIntent]);
  assert.equal(snap.permissionToPublish, false);
  journal = create(adapter);
  const refLost = await journal.load();
  assert.ok(refLost);
  assert.deepEqual(refLost.pendingRefIntents, [destinationIntent]);
  assert.deepEqual(refLost.verifiedRefObservations, [backupIntent]);
  assert.equal(refLost.requiresRemoteRevalidation, true);
  await assert.rejects(() => journal.recordRefIntent(destinationIntent, refLost.generation), /duplicate/i);
  await assert.rejects(() => journal.recordUploadIntent(receipt(2), refLost.generation), /unresolved ref|candidate preparation/i);
  snap = await journal.markRefReadbackObserved(destinationIntent, refLost.generation);
  assert.deepEqual(snap.verifiedRefObservations, [backupIntent, destinationIntent]);
  assert.equal(snap.permissionToPublish, false);
  assert.equal(snap.cutoverAuthorized, false);
  assert.ok(Object.isFrozen(snap.pendingRefIntents));
  assert.ok(Object.isFrozen(snap.verifiedRefObservations[0]));
});

test("D110 encrypted destination WAL refuses an unbound or malformed candidate manifest fingerprint", async () => {
  const adapter = new MemoryAdapter()
  const journal = create(adapter)
  let state = await journal.begin()
  state = await journal.recordRefIntent(backupIntent, state.generation)
  state = await journal.markRefReadbackObserved(backupIntent, state.generation)
  state = await journal.recordStagingHandoff(backupIntent, state.generation)
  state = await journal.recordCandidatePreparationIntent("1".repeat(64), state.generation)
  state = await journal.recordPreparedCandidateReceipt(candidateReceipt, state.generation)
  const original = new Map(adapter.files)
  for (const value of [undefined, "HEAD", "a".repeat(63), "G".repeat(64)]) {
    await assert.rejects(() => journal.recordRefIntent({
      ...destinationIntent, manifestSha256: value,
    }, state.generation), V4ReencryptionJournalRecoveryRequiredError)
    assert.deepEqual(adapter.files, original)
  }
  state = await journal.recordRefIntent(destinationIntent, state.generation)
  assert.equal(state.pendingRefIntents[0]?.manifestSha256, destinationIntent.manifestSha256)
  const serialized = [...adapter.files.values()].join("")
  assert.ok(!serialized.includes(destinationIntent.manifestSha256))
  await assert.rejects(() => journal.markRefReadbackObserved({
    ...destinationIntent, manifestSha256: "a".repeat(64),
  }, state.generation), /does not match/i)
  assert.deepEqual((await create(adapter).load())?.pendingRefIntents, [destinationIntent])
})

test("D101 journal ref-intent and receipt fail closed on wrong commit/tree/repo/role/stale generation", async () => {
  const adapter = new MemoryAdapter();
  const journal = create(adapter);
  const begun = await journal.begin();
  const invalid = [
    { ...backupIntent, role: "destination" },
    { ...backupIntent, repoId: repoId },
    { ...backupIntent, repoId: "other/repo#backup/frozen-old-key" },
    { ...backupIntent, commitSha: "a".repeat(39) },
    { ...backupIntent, treeSha: "HEAD" },
    { ...backupIntent, role: "unknown" },
  ];
  const original = new Map(adapter.files);
  for (const item of invalid) {
    await assert.rejects(() => journal.recordRefIntent(item as typeof backupIntent, begun.generation));
    assert.deepEqual(adapter.files, original);
  }
  const pending = await journal.recordRefIntent(backupIntent, begun.generation);
  await assert.rejects(() => journal.markRefReadbackObserved({ ...backupIntent, treeSha: "f".repeat(40) }, pending.generation), /does not match/i);
  await assert.rejects(() => journal.markRefReadbackObserved(backupIntent, begun.generation), /stale/i);
  assert.deepEqual((await journal.load())?.pendingRefIntents, [backupIntent]);
  await assert.rejects(() => journal.recordRefIntent(backupIntent, pending.generation), /duplicate/i);
});

test("D101 WAL torn destination ref intent never grants retry, reuse, publication or cutover", async () => {
  class TornAdapter extends MemoryAdapter {
    tear = false;
    override async write(path: string, value: string) {
      if (this.tear) { this.files.set(path, value.slice(0, 14)); throw new Error("torn destination WAL write"); }
      await super.write(path, value);
    }
  }
  const adapter = new TornAdapter();
  let journal = create(adapter);
  let snap = await journal.begin();
  snap = await journal.recordRefIntent(backupIntent, snap.generation);
  snap = await journal.markRefReadbackObserved(backupIntent, snap.generation);
  snap = await journal.recordStagingHandoff(backupIntent, snap.generation);
  snap = await journal.recordCandidatePreparationIntent("1".repeat(64), snap.generation);
  snap = await journal.recordPreparedCandidateReceipt(candidateReceipt, snap.generation);
  adapter.tear = true;
  await assert.rejects(() => journal.recordRefIntent(destinationIntent, snap.generation), /torn destination WAL write/i);
  adapter.tear = false;
  journal = create(adapter);
  const restored = await journal.load();
  assert.ok(restored);
  assert.deepEqual(restored.verifiedRefObservations, [backupIntent]);
  assert.deepEqual(restored.pendingRefIntents, []);
  assert.equal(restored.requiresRemoteRevalidation, true);
  assert.equal(restored.permissionToPublish, false);
  await assert.rejects(() => journal.recordRefIntent(destinationIntent, restored.generation),
    /recovery|journal/i);
});

test("D103 a corrupted older WAL slot is readable for manual recovery but cannot certify safe Git mutation", async () => {
  const adapter = new MemoryAdapter();
  const journal = create(adapter);
  let state = await journal.begin();
  state = await journal.recordRefIntent(backupIntent, state.generation);
  const olderSlot = [...adapter.files.keys()].find(path => path.endsWith("slot-1.json"));
  assert.ok(olderSlot);
  adapter.files.set(olderSlot, "{broken");
  const loaded = await create(adapter).load();
  assert.ok(loaded);
  assert.equal(loaded.generation, state.generation);
  assert.deepEqual(loaded.pendingRefIntents, [backupIntent]);
  assert.equal(loaded.requiresRemoteRevalidation, true);
  await assert.rejects(() => create(adapter).assertHealthySnapshot(state.generation),
    V4ReencryptionJournalRecoveryRequiredError);
  await assert.rejects(() => journal.markRefReadbackObserved(backupIntent, state.generation),
    V4ReencryptionJournalRecoveryRequiredError);
});

test("D103 missing older WAL slot after generation two prevents further mutations despite a valid newest slot", async () => {
  const adapter = new MemoryAdapter();
  const journal = create(adapter);
  const begin = await journal.begin();
  const pending = await journal.recordRefIntent(backupIntent, begin.generation);
  const oldSlot = [...adapter.files.keys()].find(path => path.endsWith("slot-1.json"));
  assert.ok(oldSlot);
  adapter.files.delete(oldSlot);
  const view = await journal.load();
  assert.ok(view);
  assert.deepEqual(view.pendingRefIntents, [backupIntent]);
  assert.equal(view.requiresRemoteRevalidation, true);
  await assert.rejects(() => journal.assertHealthySnapshot(pending.generation),
    V4ReencryptionJournalRecoveryRequiredError);
  await assert.rejects(() => journal.markRefReadbackObserved(backupIntent, pending.generation),
    V4ReencryptionJournalRecoveryRequiredError);
});

test("D104 one-time Backup-to-Staging WAL handoff survives restart even with ZERO ciphertext receipts", async () => {
  const adapter = new MemoryAdapter();
  let journal = create(adapter);
  let state = await journal.begin();
  state = await journal.recordRefIntent(backupIntent, state.generation);
  state = await journal.markRefReadbackObserved(backupIntent, state.generation);
  assert.equal(state.stageHandoffStarted, false);
  const beforeGeneration = state.generation;
  state = await journal.recordStagingHandoff(backupIntent, state.generation);
  assert.equal(state.generation, beforeGeneration + 1);
  assert.equal(state.stageHandoffStarted, true);
  assert.equal(state.receipts.length, 0);
  assert.equal(state.permissionToPublish, false);
  assert.equal(state.cutoverAuthorized, false);
  journal = create(adapter);
  const restarted = await journal.load();
  assert.ok(restarted);
  assert.equal(restarted.stageHandoffStarted, true);
  assert.equal(restarted.requiresRemoteRevalidation, true);
  await assert.rejects(() => journal.recordStagingHandoff(backupIntent, restarted.generation),
    /already started|stale/i);
  await assert.rejects(() => journal.recordStagingHandoff(
    { ...backupIntent, treeSha: "f".repeat(40) }, restarted.generation),
  /already started|stale/i);
  assert.equal((await journal.load())?.generation, restarted.generation);
});

test("D112 prepared candidate receipt is one-shot and binds Commit/Tree/manifest before Destination ref", async () => {
  const adapter = new MemoryAdapter()
  let journal = create(adapter)
  let state = await journal.begin()
  state = await journal.recordRefIntent(backupIntent, state.generation)
  state = await journal.markRefReadbackObserved(backupIntent, state.generation)
  state = await journal.recordStagingHandoff(backupIntent, state.generation)
  state = await journal.recordCandidatePreparationIntent("1".repeat(64), state.generation)
  const original = new Map(adapter.files)
  await assert.rejects(() => journal.recordRefIntent(destinationIntent, state.generation), /candidate receipt/i)
  await assert.rejects(() => journal.recordPreparedCandidateReceipt({
    ...candidateReceipt, treeSha: "not-a-git-sha",
  }, state.generation), V4ReencryptionJournalRecoveryRequiredError)
  assert.deepEqual(adapter.files, original)
  state = await journal.recordPreparedCandidateReceipt(candidateReceipt, state.generation)
  assert.deepEqual(state.preparedCandidateReceipt, candidateReceipt)
  assert.equal(state.cutoverAuthorized, false)
  const raw = [...adapter.files.values()].join("")
  assert.ok(!raw.includes(candidateReceipt.manifestSha256))
  journal = create(adapter)
  const restarted = await journal.load()
  assert.ok(restarted)
  assert.deepEqual(restarted.preparedCandidateReceipt, candidateReceipt)
  await assert.rejects(() => journal.recordPreparedCandidateReceipt(candidateReceipt, restarted.generation), /prepared receipt/i)
  await assert.rejects(() => journal.recordRefIntent({
    ...destinationIntent, treeSha: "c".repeat(40),
  }, restarted.generation), /exact independently observed candidate receipt/i)
  await assert.rejects(() => journal.recordRefIntent({
    ...destinationIntent, manifestSha256: "a".repeat(64),
  }, restarted.generation), /exact independently observed candidate receipt/i)
  state = await journal.recordRefIntent(destinationIntent, restarted.generation)
  assert.deepEqual(state.preparedCandidateReceipt, candidateReceipt)
  assert.deepEqual(state.pendingRefIntents, [destinationIntent])
  assert.equal(state.permissionToPublish, false)
})

test("D111 one-shot candidate preparation WAL marker survives restart and blocks any further ciphertext staging", async () => {
  const adapter = new MemoryAdapter()
  let journal = create(adapter)
  let state = await journal.begin()
  state = await journal.recordRefIntent(backupIntent, state.generation)
  state = await journal.markRefReadbackObserved(backupIntent, state.generation)
  state = await journal.recordStagingHandoff(backupIntent, state.generation)
  const digest = "a".repeat(64)
  state = await journal.recordCandidatePreparationIntent(digest, state.generation)
  assert.equal(state.candidatePreparationSha256, digest)
  assert.equal(state.receipts.length, 0)
  const raw = [...adapter.files.values()].join("")
  assert.ok(!raw.includes(digest))
  journal = create(adapter)
  const recovered = await journal.load()
  assert.ok(recovered)
  assert.equal(recovered.candidatePreparationSha256, digest)
  const original = new Map(adapter.files)
  await assert.rejects(() => journal.recordCandidatePreparationIntent(digest, recovered.generation), /one-shot/i)
  await assert.rejects(() => journal.recordCandidatePreparationIntent("b".repeat(64), recovered.generation), /one-shot/i)
  await assert.rejects(() => journal.recordUploadIntent(receipt(3), recovered.generation), /after candidate preparation/i)
  assert.deepEqual(adapter.files, original)
  assert.equal(recovered.permissionToPublish, false)
  assert.equal(recovered.cutoverAuthorized, false)
})

test("D111 torn encrypted candidate-preparation WAL slot never authorizes a Destination ref or replay", async () => {
  class TornAdapter extends MemoryAdapter {
    fail = false
    override async write(path: string, value: string) {
      if (this.fail) {
        this.files.set(path, value.slice(0, 11))
        throw new Error("torn candidate-intent WAL slot")
      }
      await super.write(path, value)
    }
  }
  const adapter = new TornAdapter()
  const journal = create(adapter)
  let state = await journal.begin()
  state = await journal.recordRefIntent(backupIntent, state.generation)
  state = await journal.markRefReadbackObserved(backupIntent, state.generation)
  state = await journal.recordStagingHandoff(backupIntent, state.generation)
  adapter.fail = true
  await assert.rejects(() => journal.recordCandidatePreparationIntent("c".repeat(64), state.generation),
    /torn candidate-intent WAL slot/)
  adapter.fail = false
  const recovered = await create(adapter).load()
  assert.ok(recovered)
  assert.equal(recovered.candidatePreparationSha256, null)
  assert.equal(recovered.permissionToPublish, false)
  assert.equal(recovered.cutoverAuthorized, false)
  await assert.rejects(() => create(adapter).recordCandidatePreparationIntent("c".repeat(64), recovered.generation),
    V4ReencryptionJournalRecoveryRequiredError)
  await assert.rejects(() => create(adapter).recordRefIntent(destinationIntent, recovered.generation),
    V4ReencryptionJournalRecoveryRequiredError)
})

test("D111 refuses candidate preparation during unresolved staged ciphertext or without verified Backup", async () => {
  const adapter = new MemoryAdapter()
  const journal = create(adapter)
  let state = await journal.begin()
  await assert.rejects(() => journal.recordCandidatePreparationIntent("a".repeat(64), state.generation), /one-shot/i)
  state = await journal.recordRefIntent(backupIntent, state.generation)
  state = await journal.markRefReadbackObserved(backupIntent, state.generation)
  state = await journal.recordStagingHandoff(backupIntent, state.generation)
  state = await journal.recordUploadIntent(receipt(4), state.generation)
  await assert.rejects(() => journal.recordCandidatePreparationIntent("a".repeat(64), state.generation), /one-shot/i)
  assert.equal((await journal.load())?.candidatePreparationSha256, null)
})

test("D108 low-level WAL rejects blob uploads and destination intent before one-shot Backup-to-Staging handoff", async () => {
  const adapter = new MemoryAdapter();
  const journal = create(adapter);
  let snapshot = await journal.begin();
  snapshot = await journal.recordRefIntent(backupIntent, snapshot.generation);
  snapshot = await journal.markRefReadbackObserved(backupIntent, snapshot.generation);
  const before = new Map(adapter.files);

  await assert.rejects(() => journal.recordUploadIntent(receipt(1), snapshot.generation),
    /Staging handoff/i);
  await assert.rejects(() => journal.recordRefIntent(destinationIntent, snapshot.generation),
    /one-shot Staging handoff/i);
  assert.deepEqual(adapter.files, before, "No alternate lower-level caller may skip the journal phase boundary");
  assert.deepEqual((await journal.load())?.verifiedRefObservations, [backupIntent]);

  snapshot = await journal.recordStagingHandoff(backupIntent, snapshot.generation);
  assert.equal(snapshot.stageHandoffStarted, true);
  snapshot = await journal.recordCandidatePreparationIntent("1".repeat(64), snapshot.generation);
  snapshot = await journal.recordPreparedCandidateReceipt(candidateReceipt, snapshot.generation);
  snapshot = await journal.recordRefIntent(destinationIntent, snapshot.generation);
  assert.deepEqual(snapshot.pendingRefIntents, [destinationIntent]);
  assert.equal(snapshot.permissionToPublish, false);
  assert.equal(snapshot.cutoverAuthorized, false);
});

test("D113 rejects two individually authenticated adjacent WAL slots from divergent same-run histories", async () => {
  const firstHistory = new MemoryAdapter()
  const independentHistory = new MemoryAdapter()
  const first = create(firstHistory)
  const second = create(independentHistory)

  const a = await first.begin()
  await first.recordUploadIntent(receipt(1), a.generation) // g2 pending receipt(1)

  const b = await second.begin()
  const alternate = await second.recordUploadIntent(receipt(2), b.generation)
  const newer = await second.appendReceipt(receipt(2), alternate.generation) // g3 receipt(2)
  assert.equal(newer.generation, 3)
  const slot2 = [...firstHistory.files.entries()].find(([path]) => path.endsWith("slot-0.json"))
  assert.ok(slot2)
  const targetSlot = [...independentHistory.files.keys()].find(path => path.endsWith("slot-0.json"))
  assert.ok(targetSlot)
  // Both slots carry VALID AES-GCM authentication and the exact same
  // journal key/run/source/destination identity. Generation adjacency alone
  // wrongly accepted the two incompatible histories as a single WAL.
  independentHistory.files.set(targetSlot, slot2[1])
  await assert.rejects(() => create(independentHistory).load(),
    V4ReencryptionJournalRecoveryRequiredError)
  await assert.rejects(() => create(independentHistory).assertHealthySnapshot(3),
    V4ReencryptionJournalRecoveryRequiredError)
  await assert.rejects(() => create(independentHistory).recordUploadIntent(receipt(3), 3),
    V4ReencryptionJournalRecoveryRequiredError)
})

test("D113 an ordinary valid two-slot upload/receipt transition still opens after restart", async () => {
  const adapter = new MemoryAdapter()
  const journal = create(adapter)
  const started = await journal.begin()
  const pending = await journal.recordUploadIntent(receipt(1), started.generation)
  const received = await journal.appendReceipt(receipt(1), pending.generation)
  const recovered = await create(adapter).assertHealthySnapshot(received.generation)
  assert.equal(recovered.generation, 3)
  assert.deepEqual(recovered.receipts, [receipt(1)])
  assert.deepEqual(recovered.pendingIntents, [])
  assert.equal(recovered.requiresRemoteRevalidation, true)
  assert.equal(recovered.permissionToPublish, false)
  assert.equal(recovered.cutoverAuthorized, false)
})

test("D114 valid complete three-branch WAL lifecycle survives restart at every generation", async () => {
  const adapter = new MemoryAdapter()
  const journal = create(adapter)
  let state = await journal.begin()
  const verify = async () => {
    const restarted = create(adapter)
    assert.deepEqual(await restarted.load(), state)
    const healthy = await restarted.assertHealthySnapshot(state.generation)
    assert.deepEqual(healthy, state)
    assert.equal(healthy.requiresRemoteRevalidation, true)
    assert.equal(healthy.permissionToPublish, false)
    assert.equal(healthy.cutoverAuthorized, false)
  }
  await verify()
  state = await journal.recordRefIntent(backupIntent, state.generation)
  await verify()
  state = await journal.markRefReadbackObserved(backupIntent, state.generation)
  await verify()
  state = await journal.recordStagingHandoff(backupIntent, state.generation)
  await verify()
  state = await journal.recordUploadIntent(receipt(1), state.generation)
  await verify()
  state = await journal.appendReceipt(receipt(1), state.generation)
  await verify()
  state = await journal.recordCandidatePreparationIntent("1".repeat(64), state.generation)
  await verify()
  state = await journal.recordPreparedCandidateReceipt(candidateReceipt, state.generation)
  await verify()
  state = await journal.recordRefIntent(destinationIntent, state.generation)
  await verify()
  state = await journal.markRefReadbackObserved(destinationIntent, state.generation)
  await verify()
})

test("D114 divergent authenticated Backup ref observations cannot complete a pending intent", async () => {
  const first = new MemoryAdapter()
  const second = new MemoryAdapter()
  const original = create(first)
  const a = await original.begin()
  await original.recordRefIntent(backupIntent, a.generation) // first gen-2
  const alternate = { ...backupIntent, treeSha: "b".repeat(40) }
  const other = create(second)
  const b = await other.begin()
  const pending = await other.recordRefIntent(alternate, b.generation)
  await other.markRefReadbackObserved(alternate, pending.generation) // second gen-3
  const fromFirst = [...first.files.entries()].find(([path]) => path.endsWith("slot-0.json"))
  const inSecond = [...second.files.keys()].find(path => path.endsWith("slot-0.json"))
  assert.ok(fromFirst && inSecond)
  second.files.set(inSecond, fromFirst[1])
  const bytesBefore = new Map(second.files)
  await assert.rejects(() => create(second).load(), V4ReencryptionJournalRecoveryRequiredError)
  await assert.rejects(() => create(second).assertHealthySnapshot(3), V4ReencryptionJournalRecoveryRequiredError)
  await assert.rejects(() => create(second).recordStagingHandoff(alternate, 3), V4ReencryptionJournalRecoveryRequiredError)
  assert.deepEqual(second.files, bytesBefore)
})

test("D114 divergent authenticated candidate-preparation fingerprints cannot complete a prepared commit", async () => {
  const first = new MemoryAdapter()
  const second = new MemoryAdapter()
  const make = async (adapter: MemoryAdapter, digest: string) => {
    const journal = create(adapter)
    let state = await journal.begin()
    state = await journal.recordRefIntent(backupIntent, state.generation)
    state = await journal.markRefReadbackObserved(backupIntent, state.generation)
    state = await journal.recordStagingHandoff(backupIntent, state.generation)
    return { journal, state: await journal.recordCandidatePreparationIntent(digest, state.generation) }
  }
  await make(first, "1".repeat(64)) // first gen-5
  const { journal, state } = await make(second, "2".repeat(64))
  await journal.recordPreparedCandidateReceipt(candidateReceipt, state.generation) // second gen-6
  const firstSlot = [...first.files.entries()].find(([path]) => path.endsWith("slot-1.json"))
  const secondSlot = [...second.files.keys()].find(path => path.endsWith("slot-1.json"))
  assert.ok(firstSlot && secondSlot)
  second.files.set(secondSlot, firstSlot[1])
  await assert.rejects(() => create(second).load(), V4ReencryptionJournalRecoveryRequiredError)
  await assert.rejects(() => create(second).recordRefIntent(destinationIntent, 6), V4ReencryptionJournalRecoveryRequiredError)
})

test("D114 divergent authenticated prepared Git commits cannot authorize Destination ref intent", async () => {
  const first = new MemoryAdapter()
  const second = new MemoryAdapter()
  const make = async (adapter: MemoryAdapter, commitSha: string) => {
    const journal = create(adapter)
    let state = await journal.begin()
    state = await journal.recordRefIntent(backupIntent, state.generation)
    state = await journal.markRefReadbackObserved(backupIntent, state.generation)
    state = await journal.recordStagingHandoff(backupIntent, state.generation)
    state = await journal.recordCandidatePreparationIntent("1".repeat(64), state.generation)
    return { journal, state: await journal.recordPreparedCandidateReceipt({ ...candidateReceipt, commitSha }, state.generation) }
  }
  await make(first, candidateReceipt.commitSha) // first gen-6
  const differentCommitSha = "b".repeat(40)
  const { journal, state } = await make(second, differentCommitSha)
  await journal.recordRefIntent({ ...destinationIntent, commitSha: differentCommitSha }, state.generation) // second gen-7
  const firstSlot = [...first.files.entries()].find(([path]) => path.endsWith("slot-0.json"))
  const secondSlot = [...second.files.keys()].find(path => path.endsWith("slot-0.json"))
  assert.ok(firstSlot && secondSlot)
  second.files.set(secondSlot, firstSlot[1])
  await assert.rejects(() => create(second).load(), V4ReencryptionJournalRecoveryRequiredError)
  await assert.rejects(() => create(second).assertHealthySnapshot(7), V4ReencryptionJournalRecoveryRequiredError)
})

test("D108 rejects authenticated nonadjacent WAL generations instead of accepting replayed old slot", async () => {
  const adapter = new MemoryAdapter();
  const journal = create(adapter);
  let current = await journal.begin();
  const firstSlot = [...adapter.files.entries()].find(([path]) => path.endsWith("slot-1.json"));
  assert.ok(firstSlot);
  current = await journal.recordRefIntent(backupIntent, current.generation);
  current = await journal.markRefReadbackObserved(backupIntent, current.generation);
  current = await journal.recordStagingHandoff(backupIntent, current.generation);
  current = await journal.recordUploadIntent(receipt(1), current.generation);
  current = await journal.appendReceipt(receipt(1), current.generation);
  assert.equal(current.generation, 6);
  adapter.files.set(firstSlot[0], firstSlot[1]); // Valid *old* gen-1 MAC/AES-GCM in place of gen-5.
  await assert.rejects(() => create(adapter).load(), V4ReencryptionJournalRecoveryRequiredError);
  await assert.rejects(() => create(adapter).assertHealthySnapshot(6), V4ReencryptionJournalRecoveryRequiredError);
  await assert.rejects(() => create(adapter).recordRefIntent(destinationIntent, 6),
    V4ReencryptionJournalRecoveryRequiredError);
});

test("D101 legacy encrypted staging-only WAL payload still opens as ref-free recovery evidence", async () => {
  const adapter = new MemoryAdapter();
  const journal = create(adapter);
  const started = await journal.begin();
  const loaded = await create(adapter).load();
  assert.ok(loaded);
  assert.equal(started.generation, 1);
  assert.deepEqual(loaded.pendingRefIntents, []);
  assert.deepEqual(loaded.verifiedRefObservations, []);
  assert.equal(loaded.requiresRemoteRevalidation, true);
});

test("D80 reset or auto-publish controls are not exposed by the journal interface", async () => {
  const j = create();
  assert.equal("clear" in j, false);
  assert.equal("publish" in j, false);
  assert.equal("resumeUploads" in j, false);
  assert.equal(Object.isFrozen(j), true, "journal context binding must resist runtime mutation");
  assert.equal(j.sourceCommitSha, sourceCommitSha);
  assert.equal(j.destinationRepoId, repoId);
});
