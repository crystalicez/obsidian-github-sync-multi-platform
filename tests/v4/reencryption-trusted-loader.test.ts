import assert from "node:assert/strict";
import test from "node:test";

import { sha256Hex, toBase64Url, utf8ToBytes } from "../../src/lib/bytes";
import { deriveV4Keyring } from "../../src/lib/v4/crypto";
import { buildV4RemoteMetadata } from "../../src/lib/v4/remote-index";
import type { V4RemoteConfig, V4RemoteHead } from "../../src/lib/v4/protocol-types";
import { V4StorageCodec } from "../../src/lib/v4/storage-codec";
import { verifyGitHubReencryptionSource } from "../../src/lib/v4/reencryption-trusted-loader";

const enc = utf8ToBytes;
const commitSha = "a".repeat(40);
const rootTreeSha = "b".repeat(40);
const managedTreeSha = "c".repeat(40);
const validBranch = "main";
const repoId = "owner/repo#main";

async function createFixture() {
  const config: V4RemoteConfig = {
    formatVersion: 4, mode: "encrypted", repoId, pathLayout: "opaque-stable-v1",
    algorithm: "AES-GCM", kdf: "PBKDF2-SHA-256",
    kdfParams: { iterations: 10, salt: toBase64Url(enc("salt")) },
  };
  const keyring = await deriveV4Keyring({ passphrase: "correct", repoId, salt: enc("salt"), iterations: 10 });
  const codec = new V4StorageCodec({ mode: "encrypted", pathLayout: "opaque-stable-v1", keyring });
  const file = await codec.prepare("Unicode/秘密 🪄.md", enc("File content secret"), "v1", 123, "file-1");
  const record = { ...file.record, path: "Unicode/秘密 🪄.md" };
  const hash = await sha256Hex(enc(JSON.stringify([record])));
  const head: V4RemoteHead = {
    formatVersion: 4, mode: "encrypted", epoch: 1, generation: 1,
    journalId: "j", shardHashes: { [record.pathId.slice(0, 2)]: hash },
    updatedAt: 1, deviceId: "device",
  };
  const prepared = await buildV4RemoteMetadata({ config, head, records: [record], keyring });
  const files = new Map(prepared.map((f, i) => [f.path, { bytes: f.bytes, sha: String(i + 1).repeat(40).slice(0, 40) }]));
  for (const object of file.files) files.set(object.path, { bytes: object.bytes, sha: "f".repeat(40) });
  const trees = new Map<string, { sha: string; truncated: false; tree: Array<{ path: string; type: "tree" | "blob"; mode: "040000" | "100644"; sha: string }> }>();
  const treeIds = new Map<string, string>([["", rootTreeSha]]);
  let nextTree = 0;
  for (const [path, file] of files) {
    const segments = path.split("/");
    let parentPath = "";
    for (const segment of segments.slice(0, -1)) {
      const childPath = parentPath ? parentPath + "/" + segment : segment;
      if (!treeIds.has(childPath)) treeIds.set(childPath, nextTree++ === 0 ? managedTreeSha : (nextTree + 10).toString(16).padStart(40, "0"));
      parentPath = childPath;
    }
    const leaf = segments[segments.length - 1]!;
    const parentSha = treeIds.get(parentPath)!;
    const tree = trees.get(parentSha) ?? { sha: parentSha, truncated: false as const, tree: [] };
    tree.tree.push({ path: leaf, type: "blob", mode: "100644", sha: file.sha });
    trees.set(parentSha, tree);
  }
  for (const [folder, sha] of treeIds) {
    if (!folder) continue;
    const segments = folder.split("/");
    const parent = segments.slice(0, -1).join("/");
    const name = segments[segments.length - 1]!;
    const parentSha = treeIds.get(parent)!;
    const tree = trees.get(parentSha) ?? { sha: parentSha, truncated: false as const, tree: [] };
    tree.tree.push({ path: name, type: "tree", mode: "040000", sha });
    trees.set(parentSha, tree);
  }
  const blobs = new Map([...files.values()].map(f => [f.sha, f.bytes]));
  let currentSha = commitSha;
  let blobReads = 0;
  let refReads = 0;
  let commitReads = 0;
  let treeReads = 0;
  let mutateWhenBlobRead: ((path: string) => void) | undefined;
  const github = {
    async getGitRef() {
      refReads++;
      return { ref: "refs/heads/" + validBranch, type: "commit", sha: currentSha };
    },
    async getGitCommit(sha: string) {
      commitReads++;
      assert.equal(sha, commitSha);
      return { sha, treeSha: rootTreeSha, parentShas: [] };
    },
    async getTreeAt(sha: string, recursive = true) {
      treeReads++;
      assert.equal(recursive, false, "immutable traversal must not rely on truncated recursive tree");
      const tree = trees.get(sha);
      if (!tree) throw new Error("tree unavailable");
      return { ...tree, url: "", tree: tree.tree.map(entry => ({ ...entry, url: "" })) };
    },
    async getBlob(sha: string) {
      blobReads++;
      mutateWhenBlobRead?.(sha);
      const bytes = blobs.get(sha);
      if (!bytes) throw new Error("blob unavailable");
      return bytes;
    },
    // Deliberately no Contents API available; immutable tree walk only.
  };
  return {
    github, blobs, files, trees, get blobReads() { return blobReads; }, get refReads() { return refReads; },
    get commitReads() { return commitReads; }, get treeReads() { return treeReads; },
    setCurrentSha(sha: string) { currentSha = sha; },
    onBlobRead(fn: (sha: string) => void) { mutateWhenBlobRead = fn; },
    config, keyring,
  };
}

test("D70 loads and verifies config, head, index and ciphertext solely from exact commit tree", async () => {
  const f = await createFixture();
  const value = await verifyGitHubReencryptionSource({
    github: f.github, expectedRepoId: repoId, expectedBranch: "main", passphrase: "correct",
  });
  assert.equal(value.integrityScope, "all-live-objects");
  assert.equal(value.verifiedFileCount, 1);
  assert.equal(value.verifiedRemoteObjectCount, 1);
  assert.equal(value.totalVerifiedPlaintextBytes, String(enc("File content secret").byteLength));
  assert.equal(f.refReads >= 3, true, "source HEAD must be observed before and after verification");
  assert.equal(f.commitReads, 1, "an immutable commit should be resolved once, not once per shard/object");
  assert.ok(f.treeReads <= 8, "shared immutable Git tree traversal should reuse a bounded cache");
  assert.ok(!JSON.stringify(value).includes("秘密"));
});

test("D70 rejects wrong source branch/ref/type before any Git object read", async () => {
  const f = await createFixture();
  const wrongRef = { ...f.github, async getGitRef() { return { ref: "refs/heads/other", type: "commit", sha: commitSha }; } };
  await assert.rejects(
    () => verifyGitHubReencryptionSource({ github: wrongRef, expectedRepoId: repoId, expectedBranch: "main", passphrase: "correct" }),
    /source ref|branch|identity/i,
  );
  const wrongType = { ...f.github, async getGitRef() { return { ref: "refs/heads/main", type: "tag", sha: commitSha }; } };
  await assert.rejects(
    () => verifyGitHubReencryptionSource({ github: wrongType, expectedRepoId: repoId, expectedBranch: "main", passphrase: "correct" }),
    /source ref|type|commit/i,
  );
  assert.equal(f.blobReads, 0);
});

test("D70 rejects wrong repo identity, passphrase, and malformed remote KDF before object verification", async () => {
  const f = await createFixture();
  await assert.rejects(
    () => verifyGitHubReencryptionSource({ github: f.github, expectedRepoId: "owner/other#main", expectedBranch: "main", passphrase: "correct" }),
    /repository identity|source/i,
  );
  await assert.rejects(
    () => verifyGitHubReencryptionSource({ github: f.github, expectedRepoId: repoId, expectedBranch: "main", passphrase: "incorrect" }),
    /decrypt|passphrase|auth/i,
  );
});

test("D70 rejects missing or substituted metadata/content and never infers absence from partial trees", async () => {
  const f = await createFixture();
  const tree = f.trees.get(managedTreeSha)!;
  const missing = tree.tree.find(entry => entry.path === "config.json");
  assert.ok(missing);
  tree.tree.splice(tree.tree.indexOf(missing), 1);
  await assert.rejects(
    () => verifyGitHubReencryptionSource({ github: f.github, expectedRepoId: repoId, expectedBranch: "main", passphrase: "correct" }),
    /missing config|source config|config.*missing/i,
  );
  tree.tree.push(missing);
  const incomplete = { ...f.github,
    async getTreeAt(sha: string, recursive = true) {
      const result = await f.github.getTreeAt(sha, recursive);
      return sha === managedTreeSha ? { ...result, truncated: true } : result;
    },
  };
  tree.tree.splice(tree.tree.indexOf(missing), 1);
  await assert.rejects(
    () => verifyGitHubReencryptionSource({ github: incomplete, expectedRepoId: repoId, expectedBranch: "main", passphrase: "correct" }),
    /incomplete|tree/i,
  );
});

test("D70 refuses a mismatched immutable Git commit or substituted tree identity", async () => {
  const f = await createFixture();
  const wrongCommit = { ...f.github, async getGitCommit(_sha: string) {
    return { sha: "e".repeat(40), treeSha: rootTreeSha, parentShas: [] };
  } };
  await assert.rejects(
    () => verifyGitHubReencryptionSource({ github: wrongCommit, expectedRepoId: repoId, expectedBranch: "main", passphrase: "correct" }),
    /commit identity mismatch/i,
  );
  const wrongTree = { ...f.github, async getTreeAt(sha: string, recursive = true) {
    const tree = await f.github.getTreeAt(sha, recursive);
    return { ...tree, sha: "e".repeat(40) };
  } };
  await assert.rejects(
    () => verifyGitHubReencryptionSource({ github: wrongTree, expectedRepoId: repoId, expectedBranch: "main", passphrase: "correct" }),
    /tree identity mismatch/i,
  );
});

test("D70 rejects over-cap remote KDF metadata before deriving any key", async () => {
  const f = await createFixture();
  const configEntry = f.trees.get(managedTreeSha)!.tree.find(item => item.path === "config.json");
  assert.ok(configEntry);
  f.blobs.set(configEntry.sha, enc(JSON.stringify({
    ...f.config, kdfParams: { ...f.config.kdfParams, iterations: 1_200_001 },
  })));
  await assert.rejects(
    () => verifyGitHubReencryptionSource({ github: f.github, expectedRepoId: repoId, expectedBranch: "main", passphrase: "correct" }),
    /KDF|PBKDF2|iterations/i,
  );
});

test("D70 refuses source ref change during Git object traversal and after verification", async () => {
  const f = await createFixture();
  f.onBlobRead(() => f.setCurrentSha("d".repeat(40)));
  await assert.rejects(
    () => verifyGitHubReencryptionSource({ github: f.github, expectedRepoId: repoId, expectedBranch: "main", passphrase: "correct" }),
    /source HEAD|changed/i,
  );
});

test("D70 source proof aborts before any Git read on cancellation", async () => {
  const f = await createFixture();
  const controller = new AbortController();
  controller.abort(new Error("synthetic cancelled"));
  await assert.rejects(() => verifyGitHubReencryptionSource({
    github: f.github, expectedRepoId: repoId, expectedBranch: "main",
    passphrase: "correct", signal: controller.signal,
  }), /synthetic cancelled/i);
  assert.equal(f.refReads, 0);
});

test("D70 never writes to GitHub and refuses a ref that is a short SHA or branch alias", async () => {
  const f = await createFixture();
  f.setCurrentSha("HEAD");
  await assert.rejects(() => verifyGitHubReencryptionSource({
    github: f.github, expectedRepoId: repoId, expectedBranch: "main", passphrase: "correct",
  }), /source ref|source HEAD|commit/i);
  assert.equal(f.blobReads, 0);
});
