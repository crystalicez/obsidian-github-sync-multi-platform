import assert from "node:assert/strict";
import test from "node:test";
import { V4PluginRuntime } from "../../src/lib/v4/runtime";
import { createEmptyV4LocalIndex } from "../../src/lib/v4/local-index";
import { V4_CONFIG_PATH, V4_HEAD_PATH } from "../../src/lib/v4/protocol-types";

const enc = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const repoId = "owner/repo#main";
const config = { formatVersion: 4, mode: "plaintext", repoId, pathLayout: "plaintext-v1" };
const head = { formatVersion: 4, mode: "plaintext", repoId, epoch: 1, generation: 1,
  journalId: "j1", shardHashes: {}, updatedAt: 1, deviceId: "peer" };

function fixture(changed?: () => void) {
  const readRefs: string[] = [];
  const remote = {
    async getGitRefOrNull() { return { sha: "a".repeat(40), ref: "refs/heads/main", type: "commit" }; },
    async getFileBytes(path: string, ref?: string) {
      readRefs.push(ref ?? "<unscoped>");
      if (path === V4_HEAD_PATH) changed?.();
      if (path === V4_CONFIG_PATH) return { bytes: enc(config), sha: "config" };
      if (path === V4_HEAD_PATH) return { bytes: enc(head), sha: "head" };
      return null;
    },
  };
  const runtime = Object.create(V4PluginRuntime.prototype) as any;
  runtime.credentialGeneration = 1;
  runtime.plugin = {
    githubClient: remote,
    settings: { githubOwner: "owner", githubRepo: "repo", githubBranch: "main", encryptionMode: "plaintext" },
    app: { vault: { getFiles() { return [{ path: "local.md", stat: { size: 1, mtime: 10 } }]; } } },
  };
  runtime.assertSettingsTransitionInactive = () => {};
  runtime.assertSettingsGeneration = (generation: number) => {
    if (runtime.credentialGeneration !== generation) throw new Error("Changed settings generation");
  };
  runtime.repoId = () => repoId;
  runtime.loadIndex = async () => createEmptyV4LocalIndex({ repoId, deviceId: "local", mode: "plaintext" });
  runtime.scopePredicate = () => (_path: string) => true;
  return { runtime, readRefs };
}

test("Files overview uses one exact immutable Git ref, not unversioned/stale cache as remote", async () => {
  const { runtime, readRefs } = fixture();
  const inventory = await runtime.fileOverview();
  assert.equal(inventory.remoteCommitSha, "a".repeat(40));
  assert.deepEqual(inventory.entries.map((e: {path:string; status:string}) => [e.path, e.status]), [["local.md", "local-only"]]);
  assert.deepEqual(readRefs, ["a".repeat(40), "a".repeat(40)]);
});

test("Files overview does not publish stale data when settings generation changes during fetch", async () => {
  let runtime: any;
  const pair = fixture(() => { runtime.credentialGeneration++; });
  runtime = pair.runtime;
  await assert.rejects(() => runtime.fileOverview(), /Changed settings generation/u);
});
