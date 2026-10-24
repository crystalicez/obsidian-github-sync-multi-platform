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

test("D80 reset or auto-publish controls are not exposed by the journal interface", async () => {
  const j = create();
  assert.equal("clear" in j, false);
  assert.equal("publish" in j, false);
  assert.equal("resumeUploads" in j, false);
});
