import assert from "node:assert/strict";
import test from "node:test";

import { encryptV4Payload, deriveV4Keyring } from "../../src/lib/v4/crypto";
import { V4HistoryService } from "../../src/lib/v4/history-service";
import { decodeV4RemoteConfig, decodeV4RemoteHead, decodeV4RemoteShard, encodeV4RemoteConfig } from "../../src/lib/v4/remote-index";
import type { V4RemoteConfig } from "../../src/lib/v4/protocol-types";

const encoder = new TextEncoder();
const repoId = "owner/repo#non-default";
const plaintext: V4RemoteConfig = { formatVersion: 4, mode: "plaintext", repoId, pathLayout: "plaintext-v1" };

function paddedJson(value: unknown, length: number): Uint8Array {
  const json = encoder.encode(JSON.stringify(value));
  assert.ok(json.byteLength < length);
  const bytes = new Uint8Array(length);
  bytes.fill(0x20);
  bytes.set(json);
  return bytes;
}

test("oversized but otherwise valid remote config is rejected before JSON parsing", () => {
  const config = { ...plaintext };
  assert.deepEqual(decodeV4RemoteConfig(encoder.encode(JSON.stringify(config))), config);
  assert.throws(
    () => encodeV4RemoteConfig({ ...config, repoId: "a".repeat(64 * 1024) }),
    /V4 config metadata exceeds.*byte limit/u,
  );
  assert.throws(
    () => decodeV4RemoteConfig(paddedJson(config, 64 * 1024 + 1)),
    /V4 config metadata exceeds.*byte limit/u,
  );
});

test("oversized but otherwise valid remote head is rejected before JSON parsing", async () => {
  const head = { formatVersion: 4, mode: "plaintext", repoId, epoch: 1, generation: 1, journalId: "j1", shardHashes: {}, updatedAt: 1, deviceId: "d1" };
  const normal = await decodeV4RemoteHead(encoder.encode(JSON.stringify(head)), plaintext);
  assert.equal(normal.journalId, "j1");
  await assert.rejects(
    () => decodeV4RemoteHead(paddedJson(head, 256 * 1024 + 1), plaintext),
    /V4 head metadata exceeds.*byte limit/u,
  );
});

test("oversized otherwise valid remote shard fails closed without processing records", async () => {
  const shard = { bucket: "aa", records: {} };
  assert.deepEqual((await decodeV4RemoteShard(encoder.encode(JSON.stringify(shard)), "aa", plaintext)).records, {});
  await assert.rejects(
    () => decodeV4RemoteShard(paddedJson(shard, 16 * 1024 * 1024 + 1), "aa", plaintext),
    /V4 shard metadata exceeds.*byte limit/u,
  );
});

for (const mode of ["plaintext", "encrypted"] as const) {
  test(`oversized ${mode} history journal is rejected before parsing`, async () => {
    const keyring = mode === "encrypted"
      ? await deriveV4Keyring({ passphrase: "test-pass", repoId, salt: encoder.encode("test-salt"), iterations: 10 })
      : undefined;
    const config: V4RemoteConfig = mode === "plaintext"
      ? plaintext
      : { formatVersion: 4, mode, repoId, pathLayout: "opaque-stable-v1" };
    const page = { journalId: "j1", page: 0, pageCount: 1, changes: [] };
    const normal = encoder.encode(JSON.stringify(page));
    const oversized = paddedJson(page, 32 * 1024 * 1024 + 1);
    const serialize = (bytes: Uint8Array) => mode === "encrypted"
      ? encryptV4Payload(keyring!.journalKey, bytes, { kind: "journal", aad: `${repoId}:j1:0` })
      : Promise.resolve(bytes);
    let stored = await serialize(normal);
    const github = {
      async listCommits() { return []; },
      async getFileBytes() { return { bytes: stored, sha: "fake-blob" }; },
      async getGitCommit(sha: string) { return { sha, treeSha: "tree", parentShas: [] }; },
      async getTreeAt(): Promise<never> { throw new Error("Unexpected tree read"); },
      async getBlob(): Promise<never> { throw new Error("Unexpected blob read"); },
    };
    const service = new V4HistoryService({ github, config, keyring });
    const commit = { sha: "commit", message: "obsidian-sync-v4:j1", authorName: "test", authoredAt: "2026-10-17T00:00:00Z", parentShas: [], source: "plugin" as const, journalId: "j1" };
    assert.deepEqual(await service.getCommitChanges(commit), []);
    stored = await serialize(oversized);
    await assert.rejects(
      () => service.getCommitChanges(commit),
      /V4 journal metadata exceeds.*byte limit/u,
    );
  });
}
