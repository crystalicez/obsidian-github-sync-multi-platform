import assert from "node:assert/strict";
import test from "node:test";

import { sha256Hex } from "../../src/lib/bytes";
import { createEmptyV4LocalIndex } from "../../src/lib/v4/local-index";
import { buildV4RemoteMetadata } from "../../src/lib/v4/remote-index";
import {
  assertV4PathLayoutCompatible,
  loadV4RemoteConfig,
  loadV4RemoteState,
  remoteV4StateFromLocalIndex,
} from "../../src/lib/v4/remote-loader";
import { expectedV4PathLayout, V4_FORMAT_VERSION, type V4RemoteConfig, type V4RemoteHead } from "../../src/lib/v4/protocol-types";

const enc = (value: string) => new TextEncoder().encode(value);

class MemoryRemoteGithub {
  readonly reads: Array<{ path: string; ref?: string }> = [];
  constructor(private readonly files: Map<string, Uint8Array>) {}
  async getFileBytes(path: string, ref?: string) {
    this.reads.push({ path, ref });
    const bytes = this.files.get(path);
    return bytes ? { bytes, sha: `sha:${path}` } : null;
  }
}

test("remote loader reads config head and shard at the requested immutable commit", async () => {
  const path = "Notes/a.md";
  const pathId = await sha256Hex(enc(`path:${path}`));
  const bucket = pathId.slice(0, 2);
  const config: V4RemoteConfig = {
    formatVersion: V4_FORMAT_VERSION,
    mode: "plaintext",
    repoId: "o/r#main",
    pathLayout: expectedV4PathLayout("plaintext"),
  };
  const head: V4RemoteHead = {
    formatVersion: V4_FORMAT_VERSION,
    mode: "plaintext",
    epoch: 1,
    generation: 2,
    journalId: "journal-2",
    shardHashes: { [bucket]: "remote-shard-hash" },
    updatedAt: 3,
    deviceId: "device-a",
  };
  const record = {
    path,
    pathId,
    fileId: "file-a",
    plaintextSha256: "a".repeat(64),
    size: 1,
    mtime: 2,
    remoteVersion: "journal-2",
    remotePath: path,
    storage: "single" as const,
  };
  const metadata = await buildV4RemoteMetadata({ config, head, records: [record] });
  const github = new MemoryRemoteGithub(new Map(metadata.map(file => [file.path, file.bytes])));
  const index = createEmptyV4LocalIndex({ repoId: config.repoId, deviceId: "local", mode: config.mode, pathLayout: config.pathLayout });

  const loadedConfig = await loadV4RemoteConfig({ github, desiredConfig: config }, "commit-2", "normal");
  const state = await loadV4RemoteState({ github, index }, "commit-2", loadedConfig);

  assert.deepEqual(loadedConfig, config);
  assert.equal(state?.commitSha, "commit-2");
  assert.deepEqual(state?.head, head);
  assert.deepEqual(state?.records, [record]);
  assert.equal(github.reads.every(read => read.ref === "commit-2"), true);
});

test("remote loader keeps layout migration restricted to Force Push", () => {
  const legacy: V4RemoteConfig = { formatVersion: 4, mode: "encrypted", repoId: "o/r#main" };
  const desired: V4RemoteConfig = { formatVersion: 4, mode: "encrypted", repoId: "o/r#main", pathLayout: "opaque-stable-v1" };
  assert.throws(() => assertV4PathLayoutCompatible(legacy, desired, "normal"), /Force Push/iu);
  assert.throws(() => assertV4PathLayoutCompatible(legacy, desired, "forcePull"), /Force Push/iu);
  assert.doesNotThrow(() => assertV4PathLayoutCompatible(legacy, desired, "forcePush"));
});

test("remote loader can reconstruct a plaintext unchanged-head state from the local index", () => {
  const config: V4RemoteConfig = { formatVersion: 4, mode: "plaintext", repoId: "o/r#main", pathLayout: "plaintext-v1" };
  const index = createEmptyV4LocalIndex({ repoId: config.repoId, deviceId: "local", mode: config.mode, pathLayout: config.pathLayout });
  index.epoch = 4;
  index.generation = 5;
  index.remoteCommitSha = "commit-5";
  const state = remoteV4StateFromLocalIndex(index, "commit-5", config);

  assert.equal(state.commitSha, "commit-5");
  assert.equal(state.head.epoch, 4);
  assert.equal(state.head.generation, 5);
  assert.deepEqual(state.records, []);
});
