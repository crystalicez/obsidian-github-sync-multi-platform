import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { sha256Hex, toBase64Url, utf8ToBytes } from "../../src/lib/bytes";
import { deriveV4Keyring } from "../../src/lib/v4/crypto";
import { buildV4RemoteMetadata } from "../../src/lib/v4/remote-index";
import type { V4RemoteConfig, V4RemoteHead } from "../../src/lib/v4/protocol-types";
import { V4StorageCodec } from "../../src/lib/v4/storage-codec";
import { verifyGitHubReencryptionSource, verifyGitHubReencryptionForkSource, verifyGitHubReencryptionForkSourceWithParityInventory, verifyGitHubReencryptionForkSourceWithTranscodeInventory, verifyGitHubFrozenReencryptionBackup } from "../../src/lib/v4/reencryption-trusted-loader";
import { verifyV4ReencryptionInitiatorLocalParity } from "../../src/lib/v4/reencryption-initiator-parity"
import { inspectV4MobileReencryptionFileSizePreflight } from "../../src/lib/v4/reencryption-mobile-initiator-reader";
import { planV4OrphanReencryptionDestination } from "../../src/lib/v4/reencryption-orphan-branch";
import { createV4ReencryptedObjectStream } from "../../src/lib/v4/reencryption-stream-transcode";
import { stageV4ReencryptionVaultObjects } from "../../src/lib/v4/reencryption-staging-receipts";
import { readImmutableGitFile } from "../../src/lib/v4/immutable-git-read";
import { proposeV4SameRepositoryReencryptionBackupBranch } from "../../src/lib/v4/reencryption-owner-decisions";
import { inspectV4FencedFrozenBackupContentAfterRestart } from "../../src/lib/v4/reencryption-fenced-backup-content";
import { V4_REENCRYPTION_SYNC_FENCE_ROOT } from "../../src/lib/v4/reencryption-sync-fence";
import type { V4ReencryptionProposedCommitIdentity } from "../../src/lib/v4/reencryption-proposed-commit-receipt";
import { inspectV4FrozenBackupAfterAmbiguousCreate } from "../../src/lib/v4/reencryption-backup-reconcile";
import { createAndVerifyV4FrozenBackupRef } from "../../src/lib/v4/reencryption-backup-create-verified";
import { createV4JournaledFrozenBackup, createV4BestEffortJournaledFrozenBackup, reconcileV4PendingFrozenBackupWithJournal, reconcileV4PendingFrozenBackupWithJournalBestEffort, stageV4BestEffortJournaledThreeBranchVault } from "../../src/lib/v4/reencryption-ref-journal-coordinator";
import { acquireV4DesktopRekeyWalStorage } from "../../src/lib/v4/reencryption-desktop-wal";
import { createV4ReencryptionRecoveryJournal } from "../../src/lib/v4/reencryption-recovery-journal";
import type { V4LocalIndexAdapter } from "../../src/lib/v4/local-index";

const enc = utf8ToBytes;
const gitBlobSha = (bytes: Uint8Array) =>
  createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
const commitSha = "a".repeat(40);
const rootTreeSha = "b".repeat(40);
const managedTreeSha = "c".repeat(40);
const validBranch = "main";
const repoId = "owner/repo#main";

async function createFixture(includeChunkedFile = false) {
  const config: V4RemoteConfig = {
    formatVersion: 4, mode: "encrypted", repoId, pathLayout: "opaque-stable-v1",
    algorithm: "AES-GCM", kdf: "PBKDF2-SHA-256",
    kdfParams: { iterations: 10, salt: toBase64Url(enc("salt")) },
  };
  const keyring = await deriveV4Keyring({ passphrase: "correct", repoId, salt: enc("salt"), iterations: 10 });
  const codec = new V4StorageCodec({ mode: "encrypted", pathLayout: "opaque-stable-v1", keyring });
  const file = await codec.prepare("Unicode/秘密 🪄.md", enc("File content secret"), "v1", 123, "file-1");
  const writes = [{ path: "Unicode/秘密 🪄.md", write: file }];
  if (includeChunkedFile) {
    writes.push({
      path: "attachments/chunked.bin",
      write: await codec.prepare("attachments/chunked.bin",
        new Uint8Array(8 * 1024 * 1024 + 31).fill(0x31), "v2", 456, "file-2"),
    });
  }
  const records = writes.map(item => ({ ...item.write.record, path: item.path }));
  const buckets = new Map<string, typeof records>();
  for (const record of records) {
    const bucket = record.pathId.slice(0, 2);
    const items = buckets.get(bucket) ?? [];
    items.push(record);
    buckets.set(bucket, items);
  }
  const shardHashes: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [bucket, items] of buckets) {
    shardHashes[bucket] = await sha256Hex(enc(JSON.stringify(
      [...items].sort((a, b) => a.pathId.localeCompare(b.pathId)),
    )));
  }
  const head: V4RemoteHead = {
    formatVersion: 4, mode: "encrypted", epoch: 1, generation: 1,
    journalId: "j", shardHashes, updatedAt: 1, deviceId: "device",
  };
  const prepared = await buildV4RemoteMetadata({ config, head, records, keyring });
  const files = new Map(prepared.map(f => [f.path, { bytes: f.bytes, sha: gitBlobSha(f.bytes) }]));
  for (const item of writes) {
    for (const object of item.write.files) {
      files.set(object.path, { bytes: object.bytes, sha: gitBlobSha(object.bytes) });
    }
  }
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
  let repoReads = 0;
  let repositoryId = 1284153873;
  let repositoryFullName = "Owner/Repo";
  let commitReads = 0;
  let treeReads = 0;
  let mutateWhenBlobRead: ((path: string) => void) | undefined;
  const github = {
    async getRepositoryIdentity() {
      repoReads++;
      return { id: repositoryId, fullName: repositoryFullName };
    },
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
    get repoReads() { return repoReads; },
    setRepositoryId(id: number) { repositoryId = id; },
    setRepositoryName(name: string) { repositoryFullName = name; },
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
  assert.equal(f.repoReads, 2, "physical repository identity must be checked before and after verification");
  assert.equal(f.commitReads, 1, "an immutable commit should be resolved once, not once per shard/object");
  assert.ok(f.treeReads <= 8, "shared immutable Git tree traversal should reuse a bounded cache");
  assert.ok(!JSON.stringify(value).includes("秘密"));
});

test("D72 blocks wrong or malformed GitHub repository identity before any Git tree request", async () => {
  for (const [id, name] of [
    [12, "other/repo"],
    [12, "owner/other"],
    [0, "owner/repo"],
    [Number.MAX_SAFE_INTEGER + 1, "owner/repo"],
    [12, "../repo"],
  ] as const) {
    const f = await createFixture();
    f.setRepositoryId(id);
    f.setRepositoryName(name);
    await assert.rejects(() => verifyGitHubReencryptionSource({
      github: f.github, expectedRepoId: repoId, expectedBranch: "main", passphrase: "correct",
    }), /GitHub repository identity|repository source identity/i, String(name));
    assert.equal(f.refReads, 0, "wrong physical repo must fail before any branch read");
    assert.equal(f.blobReads, 0, "wrong physical repo must fail before any object read");
  }
});

test("D72 detects physical GitHub repository switching even if old commit and config still match", async () => {
  const f = await createFixture();
  f.onBlobRead(() => f.setRepositoryId(987654321));
  await assert.rejects(() => verifyGitHubReencryptionSource({
    github: f.github, expectedRepoId: repoId, expectedBranch: "main", passphrase: "correct",
  }), /GitHub repository identity|repository switched/i);
  assert.ok(f.repoReads >= 2, "recheck physical identity at end");
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

test("D190 Re-encryption source proof rejects a truncated tree even when every requested entry is present", async () => {
  for (const truncatedTreeSha of [rootTreeSha, managedTreeSha]) {
    const fixture = await createFixture();
    const partial = {
      ...fixture.github,
      async getTreeAt(sha: string, recursive = true) {
        const complete = await fixture.github.getTreeAt(sha, recursive);
        return sha === truncatedTreeSha ? { ...complete, truncated: true } : complete;
      },
    };
    await assert.rejects(
      () => verifyGitHubReencryptionSource({
        github: partial, expectedRepoId: repoId,
        expectedBranch: validBranch, passphrase: "correct",
      }),
      /incomplete|truncated/i,
      "Never certify full Source integrity using a truncated Git tree",
    );
    assert.equal(fixture.blobReads, 0, "No ciphertext can be trusted after a truncated ancestor tree");
  }
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

test("D71 trusted reader rejects blob bytes not matching immutable tree SHA before decrypt", async () => {
  const f = await createFixture();
  const wrongBlob = {
    ...f.github,
    async getBlob(sha: string) {
      const original = await f.github.getBlob(sha);
      const substituted = original.slice();
      substituted[0] = substituted[0]! ^ 1;
      return substituted;
    },
  };
  await assert.rejects(
    () => verifyGitHubReencryptionSource({
      github: wrongBlob, expectedRepoId: repoId, expectedBranch: "main", passphrase: "correct",
    }),
    /Git blob identity mismatch/i,
  );
});

test("D70 rejects over-cap remote KDF metadata before deriving any key", async () => {
  const f = await createFixture();
  const configEntry = f.trees.get(managedTreeSha)!.tree.find(item => item.path === "config.json");
  assert.ok(configEntry);
  const maliciousConfig = enc(JSON.stringify({
    ...f.config, kdfParams: { ...f.config.kdfParams, iterations: 1_200_001 },
  }));
  configEntry.sha = gitBlobSha(maliciousConfig);
  f.blobs.set(configEntry.sha, maliciousConfig);
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

test("D95 authenticated fork source pins initial immutable commit while other devices advance old branch", async () => {
  const fork = await createFixture()
  fork.onBlobRead(() => fork.setCurrentSha("d".repeat(40)))
  const verified = await verifyGitHubReencryptionForkSource({
    github: fork.github, expectedRepoId: repoId, expectedBranch: "main",
    passphrase: "correct",
  })
  assert.equal(verified.integrityScope, "all-live-objects")
  assert.equal(verified.pinnedSourceCommitSha, commitSha)
  assert.equal(verified.verifiedFileCount, 1)
  // Only the initial old-branch HEAD pin is required. Every following object
  // is looked up by its immutable SHA, not by the mutable ref.
  assert.equal(fork.refReads, 1)
  assert.equal(fork.repoReads, 2)
  assert.ok(fork.blobReads > 0)

  const malicious = await createFixture()
  malicious.setCurrentSha("not-a-commit")
  await assert.rejects(() => verifyGitHubReencryptionForkSource({
    github: malicious.github, expectedRepoId: repoId, expectedBranch: "main",
    passphrase: "correct",
  }), /source ref|commit SHA|immutable/i)
  assert.equal(malicious.blobReads, 0)
})

test("D340 authenticated fork source supplies minimal immutable records for local parity without publication authority", async () => {
  const f = await createFixture()
  f.onBlobRead(() => f.setCurrentSha("d".repeat(40)))
  const result = await verifyGitHubReencryptionForkSourceWithParityInventory({
    github: f.github, expectedRepoId: repoId, expectedBranch: "main",
    passphrase: "correct",
  })
  assert.equal(result.pinnedSourceCommitSha, commitSha)
  assert.equal(result.verifiedSource.integrityScope, "all-live-objects")
  assert.equal(result.verifiedSource.verifiedFileCount, 1)
  assert.equal(result.sourceRecords.length, 1)
  assert.deepEqual(Object.keys(result.sourceRecords[0]!).sort(), [
    "deleted", "path", "plaintextSha256", "size",
  ])
  assert.equal(result.sourceRecords[0]!.deleted, false)
  assert.equal(result.sourceRecords[0]!.path, "Unicode/秘密 🪄.md")
  assert.equal(result.sourceRecords[0]!.size, enc("File content secret").byteLength)
  assert.match(result.sourceRecords[0]!.plaintextSha256, /^[0-9a-f]{64}$/u)
  assert.equal(Object.isFrozen(result.sourceRecords), true)
  assert.equal(Object.isFrozen(result.sourceRecords[0]), true)
  assert.equal(result.initiatorLocalParityVerified, false)
  assert.equal(result.permissionToPublish, false)
  assert.equal(result.cutoverAuthorized, false)
  assert.equal(f.refReads, 1, "fork verification reads one pinned HEAD, not mutable re-fetches")
  assert.equal(f.repoReads, 2)
  assert.ok(f.blobReads > 0, "every authenticated ciphertext blob must be verified")
  assert.equal(JSON.stringify(result).includes("File content secret"), false,
    "the record handoff must not contain decrypted plaintext")
  assert.equal(JSON.stringify(result).includes("correct"), false,
    "the handoff must not expose the old passphrase")

  let leaseChecks = 0
  let physicalOpens = 0
  const localBytes = enc("File content secret")
  const localParity = await verifyV4ReencryptionInitiatorLocalParity({
    pinnedSourceCommitSha: result.pinnedSourceCommitSha,
    verifiedSource: result.verifiedSource,
    sourceRecords: result.sourceRecords,
    reader: {
      async listFiles() {
        return [{ path: "Unicode/秘密 🪄.md", size: localBytes.byteLength, mtime: 123 }]
      },
      async openFile(path) {
        assert.equal(path, "Unicode/秘密 🪄.md")
        physicalOpens++
        return { size: localBytes.byteLength, async *chunks() { yield localBytes.slice() } }
      },
      async listOpenEditorPaths() { return [] },
      async assertIdleAndNoPendingEdits() {},
      async assertSourceConfigurationUnchanged() {},
      async assertExclusiveInitiatorLease() { leaseChecks++ },
    },
  })
  assert.equal(localParity.allFilesContentVerified, true)
  assert.equal(localParity.checkedFileCount, 1)
  assert.equal(localParity.checkedPlaintextBytes, String(localBytes.byteLength))
  assert.equal(localParity.initiatorLocalCutoverAuthorized, false)
  assert.equal(physicalOpens, 2, "local parity must hash each file twice")
  assert.ok(leaseChecks > 2, "local parity must repeatedly check a live lease")

  const wrong = await createFixture()
  await assert.rejects(() => verifyGitHubReencryptionForkSourceWithParityInventory({
    github: wrong.github, expectedRepoId: repoId, expectedBranch: "main",
    passphrase: "incorrect",
  }), /decrypt|passphrase|auth/i)
})

test("D364 cryptographically authenticated pinned GitHub Source inventory feeds Mobile metadata-only eligibility", async () => {
  const fixture = await createFixture()
  const source = await verifyGitHubReencryptionForkSourceWithParityInventory({
    github: fixture.github, expectedRepoId: repoId, expectedBranch: "main", passphrase: "correct",
  })
  let contentReads = 0
  let localExists = true
  const scopedPath = "Unicode/秘密 🪄.md"
  const adapter = {
    async list(path: string) {
      if (path === "/") return { files: [], folders: ["Unicode"] }
      if (path === "Unicode") return { files: localExists ? [scopedPath] : [], folders: [] }
      throw Error("unexpected physical directory probe")
    },
    async stat(path: string) {
      if (path === "Unicode") return { type: "folder" as const, size: 0, mtime: 10 }
      if (path === scopedPath && localExists) {
        return { type: "file" as const, size: enc("File content secret").byteLength, mtime: 11 }
      }
      return null
    },
    async readBinary() { contentReads++; throw Error("eligibility must never read local plaintext") },
  }
  const input = {
    adapter,
    scope: {
      configDir: ".obsidian", pluginId: "D364",
      ignorePathRegex: "", syncObsidianConfig: false,
      syncBookmarks: false, syncPlugins: false,
    },
    expectedSourceFiles: source.sourceRecords,
    assertPreviewStable: async () => {},
  }
  assert.equal((await inspectV4MobileReencryptionFileSizePreflight(input)).checkedFileCount, 1)
  assert.equal(contentReads, 0)
  localExists = false
  await assert.rejects(() => inspectV4MobileReencryptionFileSizePreflight(input),
    /physical Vault inventory differs from authenticated GitHub Source/i)
  assert.equal(contentReads, 0)
  assert.equal(source.permissionToPublish, false)
  assert.equal(source.cutoverAuthorized, false)
})

test("D346 authenticated Source metadata feeds real streaming re-encryption without granting publication", async () => {
  const f = await createFixture()
  f.onBlobRead(() => f.setCurrentSha("d".repeat(40)))
  const snapshot = await verifyGitHubReencryptionForkSourceWithTranscodeInventory({
    github: f.github, expectedRepoId: repoId, expectedBranch: "main", passphrase: "correct",
  })
  assert.equal(snapshot.pinnedSourceCommitSha, commitSha)
  assert.equal(snapshot.verifiedSource.verifiedFileCount, 1)
  assert.equal(snapshot.sourceRecords.length, 1)
  const sourceRecord = snapshot.sourceRecords[0]!
  for (const key of ["fileId", "pathId", "storage", "remotePath", "remoteVersion", "plaintextSha256"]) {
    assert.ok(Object.hasOwn(sourceRecord, key), "transcoding needs authenticated " + key)
  }
  assert.equal(Object.isFrozen(snapshot), true)
  assert.equal(Object.isFrozen(snapshot.sourceRecords), true)
  assert.equal(Object.isFrozen(sourceRecord), true)
  assert.equal(snapshot.initiatorLocalParityVerified, false)
  assert.equal(snapshot.permissionToPublish, false)
  assert.equal(snapshot.cutoverAuthorized, false)
  assert.equal(JSON.stringify(snapshot).includes("File content secret"), false)
  assert.equal(JSON.stringify(snapshot).includes("correct"), false)

  const destinationRepoId = "owner/repo#rekey/d346"
  const destinationSalt = enc("D346-independent-destination-salt")
  const destinationConfig: V4RemoteConfig = {
    ...f.config, repoId: destinationRepoId,
    kdfParams: { salt: toBase64Url(destinationSalt), iterations: 600_000 },
  }
  const destinationKey = await deriveV4Keyring({
    passphrase: "different-new-secret", repoId: destinationRepoId,
    salt: destinationSalt, iterations: 600_000,
  })
  const newCodec = new V4StorageCodec({
    mode: "encrypted", pathLayout: "opaque-stable-v1", keyring: destinationKey,
  })
  const plan = planV4OrphanReencryptionDestination({
    sourceRepoId: repoId, destinationRepoId, sourceCommitSha: commitSha,
    sourcePhysicalRepositoryId: 1284153873, destinationPhysicalRepositoryId: 1284153873,
    expectedPhysicalRepositoryId: 1284153873, defaultBranch: "main",
  })
  let immutableReads = 0
  const prepared = await createV4ReencryptedObjectStream({
    plan, sourceConfig: f.config, destinationConfig,
    sourceKeyring: f.keyring, destinationKeyring: destinationKey, sourceRecord,
    async readSourceObject(path, sha) {
      assert.equal(sha, snapshot.pinnedSourceCommitSha)
      immutableReads++
      const found = await readImmutableGitFile(path, sha, {
        getCommit: commit => f.github.getGitCommit(commit),
        getTree: tree => f.github.getTreeAt(tree, false),
        getBlob: blob => f.github.getBlob(blob),
      })
      return found?.bytes ?? null
    },
    async verifySourceStillPinned() {
      assert.equal(snapshot.pinnedSourceCommitSha, commitSha)
    },
  })
  const encoded = new Map<string, Uint8Array>()
  for await (const object of prepared.objects()) {
    assert.equal(encoded.has(object.path), false)
    encoded.set(object.path, object.bytes)
    object.release?.()
  }
  const next = await prepared.finalize()
  assert.equal(immutableReads > 0, true)
  assert.equal(next.plaintextSha256, sourceRecord.plaintextSha256)
  assert.equal(next.fileId === sourceRecord.fileId, false)
  assert.equal(next.pathId === sourceRecord.pathId, false)
  assert.equal(next.remotePath === sourceRecord.remotePath, false)
  assert.deepEqual(await newCodec.read(next, async path => {
    const ciphertext = encoded.get(path)
    assert.ok(ciphertext)
    return ciphertext
  }), enc("File content secret"))
  assert.equal(snapshot.permissionToPublish, false,
    "successful object-level transcode does not authorize a Git commit/ref or local cutover")
})

test("D346 authenticated transcode inventory refuses wrong old passphrase before producing records", async () => {
  const f = await createFixture()
  await assert.rejects(() => verifyGitHubReencryptionForkSourceWithTranscodeInventory({
    github: f.github, expectedRepoId: repoId, expectedBranch: "main",
    passphrase: "incorrect",
  }), /decrypt|passphrase|auth|integrity/i)
})

test("D347 fully authenticated fork snapshot stages the entire destination via existing pipeline without refs", async () => {
  const f = await createFixture(true)
  // Other old-branch devices may advance HEAD; the new destination stays bound
  // to exactly the first authenticated commit, including its HEAD/shards.
  f.onBlobRead(() => f.setCurrentSha("d".repeat(40)))
  const source = await verifyGitHubReencryptionForkSourceWithTranscodeInventory({
    github: f.github, expectedRepoId: repoId, expectedBranch: "main", passphrase: "correct",
  })
  assert.equal(source.pinnedSourceCommitSha, commitSha)
  assert.equal(source.sourceRecords.length, 2, "full Source includes single and chunked files")
  const chunked = source.sourceRecords.find(record => record.path === "attachments/chunked.bin")
  assert.equal(chunked?.storage, "chunked")
  assert.equal(Object.isFrozen(chunked?.partPaths), true)
  assert.throws(() => chunked!.partPaths!.push("forged-part"),
    TypeError, "authenticated multipart paths must remain immutable")
  assert.equal(source.sourceConfig.repoId, repoId)
  assert.equal(source.sourceHead.formatVersion, 4)
  assert.ok(Object.keys(source.sourceShards).length > 0)
  assert.equal(Object.isFrozen(source.sourceConfig), true)
  assert.equal(Object.isFrozen(source.sourceConfig.kdfParams), true)
  assert.equal(Object.isFrozen(source.sourceHead), true)
  assert.equal(Object.isFrozen(source.sourceHead.shardHashes), true)
  assert.equal(Object.isFrozen(source.sourceShards), true)
  const shard = Object.values(source.sourceShards)[0]!
  assert.equal(Object.isFrozen(shard), true)
  assert.equal(Object.isFrozen(shard.records), true)
  assert.strictEqual(Object.values(shard.records)[0], source.sourceRecords[0],
    "full-Vault staging must share the frozen authenticated records, not make a mutable second copy")
  assert.equal(f.refReads, 1, "source proof must pin exactly one immutable commit")

  const destRepoId = "owner/repo#rekey/d347"
  const salt = enc("D347-fresh-destination-salt")
  const destinationConfig: V4RemoteConfig = {
    ...f.config,
    repoId: destRepoId,
    kdfParams: { salt: toBase64Url(salt), iterations: 600_000 },
  }
  const destinationKey = await deriveV4Keyring({
    passphrase: "another-synthetic-new-key", repoId: destRepoId, salt, iterations: 600_000,
  })
  const plan = planV4OrphanReencryptionDestination({
    sourceRepoId: repoId, destinationRepoId: destRepoId, sourceCommitSha: commitSha,
    sourcePhysicalRepositoryId: 1284153873, destinationPhysicalRepositoryId: 1284153873,
    expectedPhysicalRepositoryId: 1284153873, defaultBranch: "main",
  })
  const stagedBytes = new Map<string, Uint8Array>()
  let reads = 0
  const staged = await stageV4ReencryptionVaultObjects({
    plan,
    sourceConfig: source.sourceConfig,
    sourceHead: source.sourceHead,
    sourceShards: source.sourceShards,
    sourceKeyring: f.keyring,
    destinationConfig,
    destinationKeyring: destinationKey,
    async readSourceObject(path, pinnedSha) {
      assert.equal(pinnedSha, commitSha)
      reads++
      const found = await readImmutableGitFile(path, pinnedSha, {
        getCommit: sha => f.github.getGitCommit(sha),
        getTree: sha => f.github.getTreeAt(sha, false),
        getBlob: sha => f.github.getBlob(sha),
      })
      return found?.bytes ?? null
    },
    async verifySourceStillPinned() {
      assert.equal(source.pinnedSourceCommitSha, commitSha)
    },
    async stageImmutableObject(path, bytes) {
      assert.equal(stagedBytes.has(path), false)
      stagedBytes.set(path, Uint8Array.from(bytes))
      return gitBlobSha(bytes)
    },
  })
  assert.ok(reads > 0)
  assert.equal(staged.preview.integrityScope, "staged-immutable-blobs-only")
  assert.equal(staged.preview.finalizedFileCount, source.verifiedSource.verifiedFileCount)
  assert.equal(staged.preview.totalPlaintextBytes, source.verifiedSource.totalVerifiedPlaintextBytes)
  assert.equal(staged.preview.validatedReceiptCount, stagedBytes.size)
  assert.equal(staged.preview.permissionToPublish, false)
  assert.equal(staged.preview.cutoverAuthorized, false)
  assert.equal(staged.records.length, source.sourceRecords.length)
  const newCodec = new V4StorageCodec({
    mode: "encrypted", pathLayout: "opaque-stable-v1", keyring: destinationKey,
  })
  for (const record of staged.records) {
    const old = source.sourceRecords.find(item => item.path === record.path)!
    assert.notEqual(record.fileId, old.fileId)
    assert.notEqual(record.pathId, old.pathId)
    assert.equal(record.plaintextSha256, old.plaintextSha256)
    const plaintext = await newCodec.read(record, async path => {
      const bytes = stagedBytes.get(path)
      assert.ok(bytes)
      return bytes
    })
    const expected = record.path === "attachments/chunked.bin"
      ? new Uint8Array(8 * 1024 * 1024 + 31).fill(0x31)
      : enc("File content secret")
    assert.deepEqual(plaintext, expected)
  }
  assert.equal(staged.records.filter(record => record.storage === "chunked").length, 1)
  assert.equal(stagedBytes.size, 3, "one encrypted single object and two bounded encrypted parts")
  assert.equal(f.refReads, 1, "no mutable HEAD reads, commits or refs are written by this staging test")
})

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

const frozenPlan = proposeV4SameRepositoryReencryptionBackupBranch({
  sourceRepoId: repoId,
  backupRepoId: "owner/repo#backup/2026-10-26",
  destinationRepoId: "owner/repo#rekey/2026-10-26",
  pinnedSourceCommitSha: commitSha,
  sourcePhysicalRepositoryId: 1284153873,
  backupPhysicalRepositoryId: 1284153873,
  destinationPhysicalRepositoryId: 1284153873,
  expectedPhysicalRepositoryId: 1284153873,
  defaultBranch: "main",
})

type GitFixture = Awaited<ReturnType<typeof createFixture>>
function frozenBackupClient(f: GitFixture) {
  return {
    ...f.github,
    branchName: "backup/2026-10-26",
    async getGitRef() {
      await f.github.getGitRef()
      return { ref: "refs/heads/backup/2026-10-26", type: "commit", sha: commitSha }
    },
  }
}

test("D350 real best-effort WAL creates verified Backup before full-Vault staging, exactly once", async () => {
  const f = await D99BackupFixture(true)
  const source = await verifyGitHubReencryptionForkSourceWithTranscodeInventory({
    github: f.f.github, expectedRepoId: repoId, expectedBranch: "main", passphrase: "correct",
  })
  assert.equal(source.verifiedSource.verifiedFileCount, 2)
  const parent = join(process.cwd(), ".tmp")
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, "d350-backup-then-stage-"))
  const wal = await acquireV4DesktopRekeyWalStorage({
    rootAbsolute: root, journalRoot: "rekey/wal",
  })
  try {
    const journal = createV4ReencryptionRecoveryJournal({
      adapter: wal.adapter, root: "rekey/wal",
      sourceCommitSha: source.pinnedSourceCommitSha,
      destinationRepoId: frozenPlan.destinationRepoId,
      runId: "d350-backup-and-staging", journalKey: new Uint8Array(32).fill(0x53),
    })
    await journal.begin()
    let backupIntentObservedBeforeCreate = false
    const originalCreate = f.input.backup.createGitRef
    f.input.backup.createGitRef = async sha => {
      const pending = await journal.load()
      backupIntentObservedBeforeCreate = pending?.pendingRefIntents.length === 1
        && pending.pendingRefIntents[0]?.role === "backup"
        && pending.pendingRefIntents[0]?.repoId === frozenPlan.backupRepoId
        && pending.pendingRefIntents[0]?.commitSha === source.pinnedSourceCommitSha
        && pending.pendingRefIntents[0]?.treeSha === rootTreeSha
        && pending?.cutoverAuthorized === false
      assert.equal(backupIntentObservedBeforeCreate, true,
        "the Backup create-only request must see its own exact authenticated WAL intent")
      return originalCreate(sha)
    }
    const acknowledgement = "accept-best-effort-power-loss-recovery-risk" as const
    const backup = await createV4BestEffortJournaledFrozenBackup({
      ...f.input, journal, wal, acknowledgement,
    })
    assert.equal(backupIntentObservedBeforeCreate, true)
    assert.equal(backup.backupContentsReadbackVerified, true)
    assert.equal(backup.verifiedFileCount, 2)
    assert.equal(backup.verifiedPlaintextBytes, source.verifiedSource.totalVerifiedPlaintextBytes)
    assert.equal(backup.initiatingDeviceCutoverAuthorized, false)
    assert.equal(f.createAttempts, 1, "create the real mock Backup ref exactly once")
    const afterBackup = await journal.load()
    assert.ok(afterBackup)
    assert.equal(afterBackup.pendingRefIntents.length, 0)
    assert.equal(afterBackup.verifiedRefObservations.length, 1)
    const backupRef = afterBackup.verifiedRefObservations[0]!
    assert.equal(backupRef.role, "backup")
    assert.equal(backupRef.commitSha, source.pinnedSourceCommitSha)
    assert.equal(backupRef.treeSha, rootTreeSha)
    assert.equal(afterBackup.permissionToPublish, false)
    assert.equal(afterBackup.cutoverAuthorized, false)

    // A second device can advance the old source independently. The staging
    // reader must keep using the authenticated pinned commit, not live HEAD.
    f.f.setCurrentSha("d".repeat(40))
    const salt = enc("d350-synthetic-destination-salt")
    const destRepoId = frozenPlan.destinationRepoId
    const destinationConfig: V4RemoteConfig = {
      ...source.sourceConfig, repoId: destRepoId,
      kdfParams: { salt: toBase64Url(salt), iterations: 600_000 },
    }
    const destinationKeyring = await deriveV4Keyring({
      passphrase: "d350-new-test-only-secret",
      repoId: destRepoId, salt, iterations: 600_000,
    })
    const codec = new V4StorageCodec({
      mode: "encrypted", pathLayout: "opaque-stable-v1", keyring: destinationKeyring,
    })
    const plan = planV4OrphanReencryptionDestination({
      sourceRepoId: repoId, destinationRepoId: destRepoId,
      sourceCommitSha: source.pinnedSourceCommitSha,
      sourcePhysicalRepositoryId: 1284153873,
      destinationPhysicalRepositoryId: 1284153873,
      expectedPhysicalRepositoryId: 1284153873, defaultBranch: "main",
    })
    const stagedBytes = new Map<string, Uint8Array>()
    let stageWrites = 0
    const stagingInput = {
      plan, journal, wal, acknowledgement,
      beginAfterVerifiedBackup: {
        expectedJournalGeneration: afterBackup.generation, backupRef,
      },
      sourceConfig: source.sourceConfig,
      sourceHead: source.sourceHead,
      sourceShards: source.sourceShards,
      sourceKeyring: f.f.keyring,
      destinationConfig, destinationKeyring,
      async readSourceObject(path: string, sha: string) {
        assert.equal(sha, source.pinnedSourceCommitSha)
        const found = await readImmutableGitFile(path, sha, {
          getCommit: commit => f.f.github.getGitCommit(commit),
          getTree: tree => f.f.github.getTreeAt(tree, false),
          getBlob: blob => f.f.github.getBlob(blob),
        })
        return found?.bytes ?? null
      },
      async verifySourceStillPinned() {
        assert.equal(source.pinnedSourceCommitSha, plan.pinnedSourceCommitSha)
      },
      async stageImmutableObject(path: string, bytes: Uint8Array) {
        stageWrites++
        const pending = await journal.load()
        assert.equal(pending?.pendingIntents.length, 1)
        assert.equal(pending.pendingIntents[0]?.path, path)
        assert.equal(pending.pendingIntents[0]?.sha, gitBlobSha(bytes))
        assert.equal(pending.cutoverAuthorized, false)
        stagedBytes.set(path, Uint8Array.from(bytes))
        return gitBlobSha(bytes)
      },
    }
    const staged = await stageV4BestEffortJournaledThreeBranchVault(stagingInput)
    assert.equal(staged.preview.finalizedFileCount, 2)
    assert.equal(staged.receipts.length, 3)
    assert.equal(stageWrites, 3)
    assert.equal(staged.journalSnapshot.pendingIntents.length, 0)
    assert.equal(staged.journalSnapshot.verifiedRefObservations.length, 1)
    assert.equal(staged.journalSnapshot.permissionToPublish, false)
    assert.equal(staged.journalSnapshot.cutoverAuthorized, false)
    for (const record of staged.records) {
      const actual = await codec.read(record, async path => {
        const bytes = stagedBytes.get(path)
        assert.ok(bytes)
        return bytes
      })
      const expected = record.path === "attachments/chunked.bin"
        ? new Uint8Array(8 * 1024 * 1024 + 31).fill(0x31)
        : enc("File content secret")
      assert.deepEqual(actual, expected)
    }
    await assert.rejects(
      () => stageV4BestEffortJournaledThreeBranchVault(stagingInput),
      /Manual Recovery|previous run/i,
    )
    assert.equal(stageWrites, 3, "the completed WAL must never replay staged uploads")
    await assert.rejects(
      () => createV4BestEffortJournaledFrozenBackup({
        ...f.input, journal, wal, acknowledgement,
      }),
      /previous ref intent|manual recovery/i,
    )
    assert.equal(f.createAttempts, 1, "the previously verified Backup must not be recreated")
  } finally {
    await wal.release()
    await rm(root, { recursive: true, force: true })
  }
})

test("D350 ambiguous Backup creation cannot forge a WAL handoff into destination staging", async () => {
  const f = await D99BackupFixture()
  const source = await verifyGitHubReencryptionForkSourceWithTranscodeInventory({
    github: f.f.github, expectedRepoId: repoId, expectedBranch: "main", passphrase: "correct",
  })
  const parent = join(process.cwd(), ".tmp")
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, "d350-unverified-backup-"))
  const wal = await acquireV4DesktopRekeyWalStorage({
    rootAbsolute: root, journalRoot: "rekey/wal",
  })
  try {
    const journal = createV4ReencryptionRecoveryJournal({
      adapter: wal.adapter, root: "rekey/wal",
      sourceCommitSha: source.pinnedSourceCommitSha,
      destinationRepoId: frozenPlan.destinationRepoId,
      runId: "d350-ambiguous-backup", journalKey: new Uint8Array(32).fill(0x54),
    })
    await journal.begin()
    // Simulate a create-only Git ref that may exist remotely, but whose
    // response and subsequent independent readback are both unavailable.
    f.loseCreateResponse()
    let attempted = false
    const originalCreate = f.input.backup.createGitRef
    f.input.backup.createGitRef = async sha => {
      attempted = true
      return originalCreate(sha)
    }
    const originalRead = f.input.backup.getGitRefOrNull
    f.input.backup.getGitRefOrNull = async () => {
      if (attempted) throw new Error("D350 synthetic remote readback unavailable")
      return originalRead()
    }
    const acknowledgement = "accept-best-effort-power-loss-recovery-risk" as const
    await assert.rejects(
      () => createV4BestEffortJournaledFrozenBackup({
        ...f.input, journal, wal, acknowledgement,
      }), /ambiguous|Manual Recovery|readback unavailable|recovery/i,
    )
    assert.equal(f.createAttempts, 1, "uncertain GitHub create must happen at most once")
    const previous = await journal.load()
    assert.ok(previous)
    assert.equal(previous.pendingRefIntents.length, 1)
    assert.equal(previous.verifiedRefObservations.length, 0)
    assert.equal(previous.pendingRefIntents[0]?.role, "backup")
    assert.equal(previous.cutoverAuthorized, false)

    const plan = planV4OrphanReencryptionDestination({
      sourceRepoId: repoId, destinationRepoId: frozenPlan.destinationRepoId,
      sourceCommitSha: source.pinnedSourceCommitSha,
      sourcePhysicalRepositoryId: 1284153873,
      destinationPhysicalRepositoryId: 1284153873,
      expectedPhysicalRepositoryId: 1284153873,
      defaultBranch: "main",
    })
    const salt = enc("d350-unverified-backup-destination-salt")
    const destinationConfig: V4RemoteConfig = {
      ...source.sourceConfig,
      repoId: frozenPlan.destinationRepoId,
      kdfParams: { salt: toBase64Url(salt), iterations: 600_000 },
    }
    const destinationKeyring = await deriveV4Keyring({
      passphrase: "synthetic-d350-recovery-passphrase",
      repoId: frozenPlan.destinationRepoId, salt, iterations: 600_000,
    })
    let uploadAttempts = 0
    await assert.rejects(
      () => stageV4BestEffortJournaledThreeBranchVault({
        plan, journal, wal, acknowledgement,
        beginAfterVerifiedBackup: {
          expectedJournalGeneration: previous.generation,
          backupRef: {
            role: "backup", repoId: frozenPlan.backupRepoId,
            commitSha: source.pinnedSourceCommitSha, treeSha: rootTreeSha,
          },
        },
        sourceConfig: source.sourceConfig, sourceHead: source.sourceHead,
        sourceShards: source.sourceShards, sourceKeyring: f.f.keyring,
        destinationConfig, destinationKeyring,
        async readSourceObject() {
          throw new Error("An unverified Backup must not read Source objects for staging")
        },
        async verifySourceStillPinned() {
          throw new Error("An unverified Backup must not start staging")
        },
        async stageImmutableObject() {
          uploadAttempts++
          throw new Error("No staging after ambiguous Backup")
        },
      }), /verified|Backup|handoff|Manual Recovery|generation|readback/i,
    )
    assert.equal(uploadAttempts, 0)
    await assert.rejects(
      () => createV4BestEffortJournaledFrozenBackup({
        ...f.input, journal, wal, acknowledgement,
      }), /previous ref intent|Manual Recovery|reconcile/i,
    )
    assert.equal(f.createAttempts, 1, "never replay an ambiguous Backup ref POST")
  } finally {
    await wal.release()
    await rm(root, { recursive: true, force: true })
  }
})

test("D348 verified pinned Source and frozen Backup feed one-shot real desktop WAL staging", async () => {
  const f = await createFixture(true)
  f.onBlobRead(() => f.setCurrentSha("d".repeat(40)))
  const source = await verifyGitHubReencryptionForkSourceWithTranscodeInventory({
    github: f.github, expectedRepoId: repoId, expectedBranch: "main", passphrase: "correct",
  })
  const backup = await verifyGitHubFrozenReencryptionBackup({
    github: frozenBackupClient(f), plan: frozenPlan,
    expectedSourceTreeSha: rootTreeSha, passphrase: "correct",
  })
  assert.equal(backup.backupContentsReadbackVerified, true)
  assert.equal(backup.pinnedSourceCommitSha, source.pinnedSourceCommitSha)
  assert.equal(backup.verifiedFileCount, source.verifiedSource.verifiedFileCount)
  assert.equal(backup.verifiedPlaintextBytes, source.verifiedSource.totalVerifiedPlaintextBytes)
  assert.equal(backup.destinationPublicationAuthorized, false)
  const sourceRefReads = f.refReads

  const destRepoId = frozenPlan.destinationRepoId
  const salt = enc("d348-test-only-independent-salt")
  const destinationConfig: V4RemoteConfig = {
    ...source.sourceConfig, repoId: destRepoId,
    kdfParams: { iterations: 600_000, salt: toBase64Url(salt) },
  }
  const destinationKeyring = await deriveV4Keyring({
    passphrase: "d348-test-only-new-passphrase",
    repoId: destRepoId, salt, iterations: 600_000,
  })
  const destinationCodec = new V4StorageCodec({
    mode: "encrypted", pathLayout: "opaque-stable-v1", keyring: destinationKeyring,
  })
  const plan = planV4OrphanReencryptionDestination({
    sourceRepoId: repoId, destinationRepoId: destRepoId,
    sourceCommitSha: source.pinnedSourceCommitSha,
    sourcePhysicalRepositoryId: 1284153873, destinationPhysicalRepositoryId: 1284153873,
    expectedPhysicalRepositoryId: 1284153873, defaultBranch: "main",
  })
  const backupRef = {
    role: "backup" as const, repoId: frozenPlan.backupRepoId,
    commitSha: backup.pinnedSourceCommitSha, treeSha: backup.pinnedSourceTreeSha,
  }
  const parent = join(process.cwd(), ".tmp")
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, "d348-pinned-source-best-effort-wal-"))
  try {
    // These two runs use independent disposable OS-bound WALs. The backup
    // creation POST remains simulated; only readback is authenticated above.
    for (const loseSecondReply of [false, true]) {
      const walRoot = join(root, loseSecondReply ? "interrupted" : "complete")
      await mkdir(walRoot)
      const wal = await acquireV4DesktopRekeyWalStorage({
        rootAbsolute: walRoot, journalRoot: "rekey/wal",
      })
      try {
        const journal = createV4ReencryptionRecoveryJournal({
          adapter: wal.adapter, root: "rekey/wal",
          sourceCommitSha: source.pinnedSourceCommitSha, destinationRepoId: destRepoId,
          runId: loseSecondReply ? "d348-interrupted" : "d348-complete",
          journalKey: new Uint8Array(32).fill(0x55),
        })
        let previous = await journal.begin()
        previous = await journal.recordRefIntent(backupRef, previous.generation)
        previous = await journal.markRefReadbackObserved(backupRef, previous.generation)
        const beginAfterVerifiedBackup = {
          expectedJournalGeneration: previous.generation, backupRef,
        }
        let uploadAttempts = 0
        const stagedBlobs = new Map<string, Uint8Array>()
        const input = {
          plan, journal, wal, beginAfterVerifiedBackup,
          acknowledgement: "accept-best-effort-power-loss-recovery-risk" as const,
          sourceConfig: source.sourceConfig,
          sourceHead: source.sourceHead,
          sourceShards: source.sourceShards,
          sourceKeyring: f.keyring,
          destinationConfig, destinationKeyring,
          async readSourceObject(path: string, sha: string) {
            assert.equal(sha, source.pinnedSourceCommitSha)
            const found = await readImmutableGitFile(path, sha, {
              getCommit: commit => f.github.getGitCommit(commit),
              getTree: tree => f.github.getTreeAt(tree, false),
              getBlob: blob => f.github.getBlob(blob),
            })
            return found?.bytes ?? null
          },
          async verifySourceStillPinned() {
            assert.equal(source.pinnedSourceCommitSha, plan.pinnedSourceCommitSha)
          },
          async stageImmutableObject(path: string, bytes: Uint8Array) {
            uploadAttempts++
            const onDisk = await journal.load()
            assert.equal(onDisk?.stageHandoffStarted, true)
            assert.equal(onDisk?.pendingIntents.length, 1,
              "an authenticated intent must be on disk before each blob upload")
            assert.equal(onDisk.pendingIntents[0]!.path, path)
            assert.equal(onDisk.pendingIntents[0]!.sha, gitBlobSha(bytes))
            if (loseSecondReply && uploadAttempts === 2) {
              throw new Error("D348 synthetic lost Git blob response")
            }
            stagedBlobs.set(path, Uint8Array.from(bytes))
            return gitBlobSha(bytes)
          },
        }
        if (loseSecondReply) {
          await assert.rejects(
            () => stageV4BestEffortJournaledThreeBranchVault(input),
            /D348 synthetic lost Git blob response/,
          )
          const interrupted = await journal.load()
          assert.equal(interrupted?.receipts.length, 1)
          assert.equal(interrupted.pendingIntents.length, 1)
          assert.equal(interrupted.requiresRemoteRevalidation, true)
          assert.equal(interrupted.cutoverAuthorized, false)
          await assert.rejects(
            () => stageV4BestEffortJournaledThreeBranchVault(input),
            /Manual Recovery|previous run/i,
          )
          assert.equal(uploadAttempts, 2, "ambiguous second POST must not be retried")
        } else {
          const staged = await stageV4BestEffortJournaledThreeBranchVault(input)
          assert.equal(staged.preview.finalizedFileCount, 2)
          assert.equal(staged.receipts.length, 3)
          assert.equal(staged.journalSnapshot.receipts.length, 3)
          assert.equal(staged.journalSnapshot.pendingIntents.length, 0)
          assert.equal(staged.journalSnapshot.requiresRemoteRevalidation, true)
          assert.equal(staged.journalSnapshot.permissionToPublish, false)
          assert.equal(staged.journalSnapshot.cutoverAuthorized, false)
          for (const record of staged.records) {
            const plaintext = await destinationCodec.read(record, async path => {
              const bytes = stagedBlobs.get(path)
              assert.ok(bytes)
              return bytes
            })
            const expected = record.path === "attachments/chunked.bin"
              ? new Uint8Array(8 * 1024 * 1024 + 31).fill(0x31)
              : enc("File content secret")
            assert.deepEqual(plaintext, expected)
          }
          await assert.rejects(
            () => stageV4BestEffortJournaledThreeBranchVault(input),
            /Manual Recovery|previous run/i,
          )
          assert.equal(uploadAttempts, 3, "completed journal cannot silently replay uploads")
        }
      } finally {
        await wal.release()
      }
    }
    assert.equal(f.refReads, sourceRefReads,
      "no new mutable source HEAD lookup or Git ref mutation is needed for WAL staging")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("D94 authenticates all frozen backup contents even when old source HEAD advances independently", async () => {
  const f = await createFixture()
  // Simulate a device B committing to the old branch after A froze the backup.
  f.setCurrentSha("d".repeat(40))
  const report = await verifyGitHubFrozenReencryptionBackup({
    github: frozenBackupClient(f),
    plan: frozenPlan, expectedSourceTreeSha: rootTreeSha, passphrase: "correct",
  })
  assert.deepEqual(report, {
    integrityScope: "authenticated-frozen-backup-all-live-objects",
    backupRepoId: frozenPlan.backupRepoId,
    pinnedSourceCommitSha: commitSha,
    pinnedSourceTreeSha: rootTreeSha,
    verifiedFileCount: 1,
    verifiedRemoteObjectCount: 1,
    verifiedPlaintextBytes: String(enc("File content secret").byteLength),
    backupContentsReadbackVerified: true,
    backupCreationProven: false,
    installedObsidianRestoreVerified: false,
    independentStorageVerified: false,
    destinationPublicationAuthorized: false,
    cutoverAuthorized: false,
  })
  assert.equal(f.refReads >= 3, true)
  assert.equal(f.repoReads, 2)
  assert.ok(f.blobReads > 1)
  assert.ok(Object.isFrozen(report))
})

test("D94 refuses forged backup plans, branch scope and wrong physical repository BEFORE Git IO", async () => {
  const invalids = [
    { plan: { ...frozenPlan, pinnedSourceCommitSha: "d".repeat(40) } },
    { plan: { ...frozenPlan, physicalRepositoryId: 4 } },
    { plan: { ...frozenPlan, backupRepoId: "owner/other#backup/2026-10-26" } },
    { plan: { ...frozenPlan, backupReadbackVerified: true } },
    { plan: { ...frozenPlan, destinationRepoId: frozenPlan.backupRepoId } },
    { plan: { ...frozenPlan, status: "ready" } },
    { expectedSourceTreeSha: "HEAD" },
  ]
  for (const modified of invalids) {
    const f = await createFixture()
    await assert.rejects(() => verifyGitHubFrozenReencryptionBackup({
      github: frozenBackupClient(f), plan: frozenPlan,
      expectedSourceTreeSha: rootTreeSha, passphrase: "correct",
      ...modified,
    } as Parameters<typeof verifyGitHubFrozenReencryptionBackup>[0]), /backup|branch|repository|identity|snapshot|commit/i)
    assert.equal(f.blobReads, 0)
  }
  const f = await createFixture()
  const wrongBranch = { ...frozenBackupClient(f), branchName: "other" }
  await assert.rejects(() => verifyGitHubFrozenReencryptionBackup({
    github: wrongBranch, plan: frozenPlan, expectedSourceTreeSha: rootTreeSha, passphrase: "correct",
  }), /branch/i)
  assert.equal(f.repoReads, 0)
})

test("D94 fails closed for moved backup ref, wrong tree or corrupted ciphertext", async () => {
  const f = await createFixture()
  const wrongRef = {
    ...frozenBackupClient(f),
    async getGitRef() { return { ref: "refs/heads/backup/2026-10-26", type: "commit", sha: "d".repeat(40) } },
  }
  await assert.rejects(() => verifyGitHubFrozenReencryptionBackup({
    github: wrongRef, plan: frozenPlan, expectedSourceTreeSha: rootTreeSha, passphrase: "correct",
  }), /pinned|commit/i)
  assert.equal(f.blobReads, 0)

  const wrongTree = await createFixture()
  await assert.rejects(() => verifyGitHubFrozenReencryptionBackup({
    github: frozenBackupClient(wrongTree), plan: frozenPlan,
    expectedSourceTreeSha: "f".repeat(40), passphrase: "correct",
  }), /root Git tree/i)
  assert.equal(wrongTree.blobReads, 0)

  const corrupt = await createFixture()
  const altered = {
    ...frozenBackupClient(corrupt),
    async getBlob(sha: string) {
      const bytes = await corrupt.github.getBlob(sha)
      const copy = bytes.slice()
      copy[0] = copy[0]! ^ 1
      return copy
    },
  }
  await assert.rejects(() => verifyGitHubFrozenReencryptionBackup({
    github: altered, plan: frozenPlan, expectedSourceTreeSha: rootTreeSha, passphrase: "correct",
  }), /blob identity|integrity/i)
})

test("D94 detects backup HEAD drift while verifying, abort and wrong passphrase", async () => {
  const f = await createFixture()
  let reads = 0
  const moving = {
    ...frozenBackupClient(f),
    async getGitRef() {
      reads++
      return {
        ref: "refs/heads/backup/2026-10-26", type: "commit",
        sha: reads === 1 ? commitSha : "d".repeat(40),
      }
    },
  }
  await assert.rejects(() => verifyGitHubFrozenReencryptionBackup({
    github: moving, plan: frozenPlan, expectedSourceTreeSha: rootTreeSha, passphrase: "correct",
  }), /source HEAD|changed|pinned/i)

  const badPassword = await createFixture()
  await assert.rejects(() => verifyGitHubFrozenReencryptionBackup({
    github: frozenBackupClient(badPassword), plan: frozenPlan,
    expectedSourceTreeSha: rootTreeSha, passphrase: "wrong",
  }), /auth|decrypt|passphrase/i)

  const aborted = await createFixture()
  const ctrl = new AbortController()
  ctrl.abort(new Error("cancelled frozen read"))
  await assert.rejects(() => verifyGitHubFrozenReencryptionBackup({
    github: frozenBackupClient(aborted), plan: frozenPlan,
    expectedSourceTreeSha: rootTreeSha, passphrase: "correct", signal: ctrl.signal,
  }), /cancelled frozen read/i)
  assert.equal(aborted.repoReads, 0)
})

function backupRecoveryClient(
  f: GitFixture,
  initial: null | string = commitSha,
) {
  const client = frozenBackupClient(f)
  let refSha: null | string = initial
  let readCount = 0
  let defaultName = "main"
  let failRead = false
  return {
    github: {
      ...client,
      async getRepositoryDefaultBranch() { return defaultName },
      async getGitRefOrNull() {
        readCount++
        if (failRead) throw new Error("GitHub 503: unresolved backup ref")
        return refSha === null ? null : {
          ref: "refs/heads/backup/2026-10-26", type: "commit", sha: refSha,
        }
      },
    },
    get readCount() { return readCount },
    changeRef(next: string | null) { refSha = next },
    changeDefault(next: string) { defaultName = next },
    failReads() { failRead = true },
  }
}

test("D95 distinguishes absent and conflicting backup refs WITHOUT retry authorization or content reads", async () => {
  for (const [sha, status] of [
    [null, "ref-unobserved-at-two-checks"],
    ["d".repeat(40), "ref-occupied-by-other-commit"],
  ] as const) {
    const f = await createFixture()
    const recovery = backupRecoveryClient(f, sha)
    const result = await inspectV4FrozenBackupAfterAmbiguousCreate({
      backup: recovery.github, plan: frozenPlan,
      expectedSourceTreeSha: rootTreeSha, originalPassphrase: "correct",
    })
    assert.equal(result.outcome, status)
    assert.equal(result.backupContentsReadbackVerified, false)
    assert.equal(result.automaticallyRetryCreateAuthorized, false)
    assert.equal(result.overwriteAuthorized, false)
    assert.equal(result.destinationPublicationAuthorized, false)
    assert.equal(result.cutoverAuthorized, false)
    assert.equal(f.blobReads, 0)
    assert.equal(recovery.readCount, 3)
    assert.ok(Object.isFrozen(result))
  }
})

test("D95 uncertain create recovery verifies all real frozen encrypted objects and never authorizes cutover", async () => {
  const f = await createFixture()
  f.setCurrentSha("d".repeat(40)) // independent old branch has advanced
  const recovery = backupRecoveryClient(f)
  const report = await inspectV4FrozenBackupAfterAmbiguousCreate({
    backup: recovery.github, plan: frozenPlan,
    expectedSourceTreeSha: rootTreeSha, originalPassphrase: "correct",
  })
  assert.deepEqual(report, {
    integrityScope: "ambiguous-backup-create-read-only-reconciliation",
    backupRepoId: frozenPlan.backupRepoId,
    pinnedSourceCommitSha: commitSha,
    outcome: "matching-backup-full-readback",
    backupContentsReadbackVerified: true,
    verifiedFileCount: 1,
    verifiedPlaintextBytes: String(enc("File content secret").byteLength),
    creationProven: false,
    automaticallyRetryCreateAuthorized: false,
    overwriteAuthorized: false,
    installedObsidianRestoreVerified: false,
    independentStorageVerified: false,
    destinationPublicationAuthorized: false,
    cutoverAuthorized: false,
  })
  assert.equal(recovery.readCount, 4)
  assert.ok(f.blobReads > 1)
})

test("D191 backup recovery refuses a ref changed during final repository and default-branch proof", async () => {
  for (const [initial, changed] of [
    [commitSha, "d".repeat(40)],
    [null, commitSha],
    ["d".repeat(40), "e".repeat(40)],
  ] as const) {
    const fixture = await createFixture()
    const recovery = backupRecoveryClient(fixture, initial)
    const getDefault = recovery.github.getRepositoryDefaultBranch
    let defaultReads = 0
    recovery.github.getRepositoryDefaultBranch = async () => {
      const observed = await getDefault()
      if (++defaultReads === 2) recovery.changeRef(changed)
      return observed
    }
    await assert.rejects(
      () => inspectV4FrozenBackupAfterAmbiguousCreate({
        backup: recovery.github, plan: frozenPlan,
        expectedSourceTreeSha: rootTreeSha, originalPassphrase: "correct",
      }),
      /ref changed/i,
      "A late remote ref change must not become a trusted backup recovery report",
    )
    assert.equal(defaultReads, 2)
  }
})

test("D95 refuses unknown API outcome or changes in backup ref during reconciliation", async () => {
  const missing = await createFixture()
  const recovery = backupRecoveryClient(missing)
  recovery.failReads()
  await assert.rejects(() => inspectV4FrozenBackupAfterAmbiguousCreate({
    backup: recovery.github, plan: frozenPlan,
    expectedSourceTreeSha: rootTreeSha, originalPassphrase: "correct",
  }), /503/)
  assert.equal(missing.blobReads, 0)

  const drifting = await createFixture()
  const move = backupRecoveryClient(drifting)
  const reads = move.github.getGitRefOrNull
  let index = 0
  move.github.getGitRefOrNull = async () => {
    const ref = await reads()
    index++
    if (index === 2) return { ...ref!, sha: "d".repeat(40) }
    return ref
  }
  await assert.rejects(() => inspectV4FrozenBackupAfterAmbiguousCreate({
    backup: move.github, plan: frozenPlan,
    expectedSourceTreeSha: rootTreeSha, originalPassphrase: "correct",
  }), /changed/)
  assert.equal(drifting.blobReads, 0)

  const after = await createFixture()
  const changedAfter = backupRecoveryClient(after)
  const read = changedAfter.github.getGitRefOrNull
  let checks = 0
  changedAfter.github.getGitRefOrNull = async () => {
    checks++
    return checks === 3 ? null : read()
  }
  await assert.rejects(() => inspectV4FrozenBackupAfterAmbiguousCreate({
    backup: changedAfter.github, plan: frozenPlan,
    expectedSourceTreeSha: rootTreeSha, originalPassphrase: "correct",
  }), /changed/)
})

test("D95 refuses wrong physical identity, wrong client scope, invalid plan and changed default branch", async () => {
  const f = await createFixture()
  f.setRepositoryId(5)
  const client = backupRecoveryClient(f)
  await assert.rejects(() => inspectV4FrozenBackupAfterAmbiguousCreate({
    backup: client.github, plan: frozenPlan,
    expectedSourceTreeSha: rootTreeSha, originalPassphrase: "correct",
  }), /repository/)
  assert.equal(f.blobReads, 0)

  const wrongScope = await createFixture()
  const other = backupRecoveryClient(wrongScope)
  await assert.rejects(() => inspectV4FrozenBackupAfterAmbiguousCreate({
    backup: { ...other.github, branchName: "backup/wrong" }, plan: frozenPlan,
    expectedSourceTreeSha: rootTreeSha, originalPassphrase: "correct",
  }), /scope|branch/)
  assert.equal(wrongScope.repoReads, 0)

  const invalid = await createFixture()
  const original = backupRecoveryClient(invalid)
  await assert.rejects(() => inspectV4FrozenBackupAfterAmbiguousCreate({
    backup: original.github,
    plan: { ...frozenPlan, status: "unsafe" } as unknown as typeof frozenPlan,
    expectedSourceTreeSha: rootTreeSha, originalPassphrase: "correct",
  }), /blocked/)
  assert.equal(invalid.repoReads, 0)

  const wrongDefault = await createFixture()
  const defaultReader = backupRecoveryClient(wrongDefault)
  const def = defaultReader.github.getRepositoryDefaultBranch
  let count = 0
  defaultReader.github.getRepositoryDefaultBranch = async () =>
    ++count === 1 ? def() : "unexpected"
  await assert.rejects(() => inspectV4FrozenBackupAfterAmbiguousCreate({
    backup: defaultReader.github, plan: frozenPlan,
    expectedSourceTreeSha: rootTreeSha, originalPassphrase: "correct",
  }), /default branch changed/)
})

async function D99BackupFixture(includeChunkedFile = false) {
  const f = await createFixture(includeChunkedFile)
  const verifiedSource = await verifyGitHubReencryptionForkSource({
    github: f.github, expectedRepoId: repoId, expectedBranch: "main", passphrase: "correct",
  })
  let target: string | null = null
  let createAttempts = 0
  let outcomeLost = false
  let failAfterCreateRefRead = false
  let failReadOnce = false
  const backup = {
    ...frozenBackupClient(f),
    async getRepositoryDefaultBranch() { return "main" },
    async getGitRef() {
      if (!target) throw new Error("Backup branch does not exist.")
      return { ref: "refs/heads/backup/2026-10-26", type: "commit", sha: target }
    },
    async getGitRefOrNull() {
      if (failReadOnce) {
        failReadOnce = false
        throw new Error("GitHub 503 after create")
      }
      return target ? { ref: "refs/heads/backup/2026-10-26", type: "commit", sha: target } : null
    },
    async createGitRef(sha: string) {
      createAttempts++
      if (target) throw new Error("Ref collision")
      target = sha
      if (failAfterCreateRefRead) failReadOnce = true
      if (outcomeLost) throw new Error("GitHub POST lost response")
    },
  }
  const source = {
    branchName: "main",
    getRepositoryIdentity: () => f.github.getRepositoryIdentity(),
    async getRepositoryDefaultBranch() { return "main" },
    getGitCommit: (sha: string) => f.github.getGitCommit(sha),
  }
  const input = {
    plan: frozenPlan, verifiedSource, source, backup, expectedSourceTreeSha: rootTreeSha,
    originalPassphrase: "correct",
    assertDurableBackupIntent: async () => {},
    assertExclusiveMigrationLease: async () => {},
  }
  return {
    f, input, get createAttempts() { return createAttempts },
    occupy(sha = commitSha) { target = sha },
    loseCreateResponse() { outcomeLost = true },
    failPostCreateReadback() { failAfterCreateRefRead = true },
  }
}

test("D99 creates a single frozen backup ref then decrypts and verifies the COMPLETE old-key content", async () => {
  const f = await D99BackupFixture()
  f.f.setCurrentSha("d".repeat(40)) // D90 old source keeps syncing independently
  let intent = false
  const report = await createAndVerifyV4FrozenBackupRef({
    ...f.input,
    assertDurableBackupIntent: async () => { intent = true },
  })
  assert.equal(intent, true)
  assert.equal(report.publicationOutcome, "response-confirmed")
  assert.equal(report.backupContentsReadbackVerified, true)
  assert.equal(report.verifiedFileCount, 1)
  assert.equal(report.verifiedPlaintextBytes, String(enc("File content secret").byteLength))
  assert.equal(report.independentlyAuditedDurableIntent, false)
  assert.equal(report.installedObsidianRestoreVerified, false)
  assert.equal(report.initiatingDeviceCutoverAuthorized, false)
  assert.equal(f.createAttempts, 1)
  assert.ok(Object.isFrozen(report))
})

test("D396 frozen Backup rejects a changed Git ref writer after remote preflight but before POST", async () => {
  const f = await D99BackupFixture()
  let leaseChecks = 0
  let substitutedWriterCalls = 0
  await assert.rejects(
    () => createAndVerifyV4FrozenBackupRef({
      ...f.input,
      assertExclusiveMigrationLease: async () => {
        if (++leaseChecks === 2) {
          f.input.backup.createGitRef = async () => {
            substitutedWriterCalls++
            f.occupy(commitSha)
          }
        }
      },
    }),
    /frozen backup.*(writer|client|authority).*changed|manual recovery/i,
    "replacing a scoped create-only GitHub ref writer cannot authorize Backup",
  )
  assert.equal(leaseChecks, 2, "mutation must occur at the second lease check after GitHub preflight")
  assert.equal(substitutedWriterCalls, 0, "substituted GitHub method must not run")
  assert.equal(f.createAttempts, 0, "original GitHub ref writer must not run")
})

test("D396 frozen Backup does not certify success after its Git ref writer is replaced post-POST", async () => {
  const f = await D99BackupFixture()
  const originalWriter = f.input.backup.createGitRef
  let substitutedWriterCalls = 0
  let postCompleted = false
  f.input.backup.createGitRef = async sha => {
    await originalWriter.call(f.input.backup, sha)
    postCompleted = true
    f.input.backup.createGitRef = async () => {
      substitutedWriterCalls++
    }
  }
  await assert.rejects(
    () => createAndVerifyV4FrozenBackupRef(f.input),
    /frozen backup.*(writer|client|authority).*changed|manual recovery/i,
    "a completed ref POST cannot be certified from a changed GitHub client",
  )
  assert.equal(postCompleted, true, "the test must pass the actual create-only POST boundary")
  assert.equal(f.createAttempts, 1, "one real writer invocation, no retry")
  assert.equal(substitutedWriterCalls, 0, "the replacement writer cannot be used")
})

test("D99 ambiguous backup create response is fully reconciled without retry or old branch freeze", async () => {
  const f = await D99BackupFixture()
  f.loseCreateResponse()
  f.f.setCurrentSha("d".repeat(40))
  const report = await createAndVerifyV4FrozenBackupRef(f.input)
  assert.equal(report.publicationOutcome, "lost-create-response-reconciled")
  assert.equal(report.backupContentsReadbackVerified, true)
  assert.equal(report.destinationPublicationAuthorized, false)
  assert.equal(f.createAttempts, 1)
})

test("D100 deterministic GitHub 422 backup-ref rejection can never be reconciled as our success", async () => {
  const f = await D99BackupFixture()
  f.input.backup.createGitRef = async () => {
    f.occupy(commitSha)
    throw Object.assign(new Error("GitHub 422 rejected backup ref"), { status: 422 })
  }
  await assert.rejects(() => createAndVerifyV4FrozenBackupRef(f.input), /422 rejected/)
})

test("D99 post-create ref read error is distinct from lost create response", async () => {
  const f = await D99BackupFixture()
  f.failPostCreateReadback()
  const report = await createAndVerifyV4FrozenBackupRef(f.input)
  assert.equal(report.publicationOutcome, "post-create-readback-reconciled")
  assert.equal(f.createAttempts, 1)
})

test("D99 pre-existing IDENTICAL ref is not falsely adopted as our successful backup create", async () => {
  const f = await D99BackupFixture()
  await assert.rejects(() => createAndVerifyV4FrozenBackupRef({
    ...f.input,
    assertDurableBackupIntent: async () => { f.occupy(commitSha) },
  }), /already exists|branch/i)
  assert.equal(f.createAttempts, 0)
})

test("D99 refuses missing durable backup-intent persistence and wrong original password", async () => {
  const f = await D99BackupFixture()
  await assert.rejects(() => createAndVerifyV4FrozenBackupRef({
    ...f.input,
    assertDurableBackupIntent: async () => { throw new Error("WAL directory fsync EPERM") },
  }), /fsync EPERM/)
  assert.equal(f.createAttempts, 0)

  const mismatch = await D99BackupFixture()
  await assert.rejects(() => createAndVerifyV4FrozenBackupRef({
    ...mismatch.input, originalPassphrase: "incorrect",
  }), /auth|decrypt|recovery|backup/i)
  assert.equal(mismatch.createAttempts, 1)
})

test("D99 lease loss AFTER remote preflight but BEFORE backup create must not send GitHub POST", async () => {
  const f = await D99BackupFixture()
  let checks = 0
  await assert.rejects(() => createAndVerifyV4FrozenBackupRef({
    ...f.input,
    assertExclusiveMigrationLease: async () => {
      if (++checks === 2) throw new Error("initiating-device exclusive lease lost")
    },
  }), /lease lost/)
  assert.equal(checks, 2)
  assert.equal(f.createAttempts, 0)
})

async function D102Journal() {
  const files = new Map<string, string>()
  const adapter: V4LocalIndexAdapter = {
    async exists(path) { return files.has(path) },
    async read(path) {
      const value = files.get(path)
      if (value === undefined) throw new Error("missing")
      return value
    },
    async write(path, data) { files.set(path, data) },
    async mkdir(_path) {},
  }
  const open = () => createV4ReencryptionRecoveryJournal({
    adapter, root: "v4/rekey-journal",
    destinationRepoId: frozenPlan.destinationRepoId,
    sourceCommitSha: commitSha, runId: "d102-backup-run",
    journalKey: new Uint8Array(32).fill(0x62),
  })
  const journal = open()
  await journal.begin()
  const wal = {
    assertExclusiveStageLease: async () => {},
    assertCrashDurable: async () => {},
  }
  // This mock WAL is NOT evidence of OS durability.
  return { journal, open, wal, files }
}

test("D102 Backup can only be created with exact encrypted WAL ref intent, then confirms separate authenticated readback", async () => {
  const f = await D99BackupFixture()
  const j = await D102Journal()
  const result = await createV4JournaledFrozenBackup({
    ...f.input, journal: j.journal, wal: j.wal,
  })
  assert.equal(result.backupContentsReadbackVerified, true)
  assert.equal(result.independentlyAuditedDurableIntent, false)
  assert.equal(f.createAttempts, 1)
  const restarted = await j.open().load()
  assert.ok(restarted)
  assert.equal(restarted.pendingRefIntents.length, 0)
  assert.deepEqual(restarted.verifiedRefObservations, [{
    role: "backup", repoId: frozenPlan.backupRepoId,
    commitSha, treeSha: rootTreeSha,
  }])
  assert.equal(restarted.cutoverAuthorized, false)
  assert.ok(![...j.files.values()].join("").includes(frozenPlan.backupRepoId))
  await assert.rejects(() => createV4JournaledFrozenBackup({
    ...f.input, journal: j.open(), wal: j.wal,
  }), /previous ref intent/i)
  assert.equal(f.createAttempts, 1)
})

test("D102 Windows unproven WAL durability blocks Backup mutation and leaves no ref intent", async () => {
  const f = await D99BackupFixture()
  const j = await D102Journal()
  await assert.rejects(() => createV4JournaledFrozenBackup({
    ...f.input, journal: j.journal,
    wal: {
      ...j.wal,
      assertCrashDurable: async () => { throw new Error("Windows fsync EPERM") },
    },
  }), /fsync EPERM/i)
  assert.equal(f.createAttempts, 0)
  assert.deepEqual((await j.journal.load())?.pendingRefIntents, [])
})

test("D166 best-effort Backup explicitly accepts risk, authenticates WAL around one create-only ref, and never cuts over", async () => {
  const f = await D99BackupFixture()
  const j = await D102Journal()
  let checkpoints = 0
  const input = {
    ...f.input, journal: j.journal,
    wal: {
      assertExclusiveStageLease: async () => {},
      assertBestEffortCheckpoint: async () => {
        checkpoints++
        return "best-effort-readback-only" as const
      },
    },
    acknowledgement: "accept-best-effort-power-loss-recovery-risk" as const,
  }
  const result = await createV4BestEffortJournaledFrozenBackup(input)
  assert.equal(result.backupContentsReadbackVerified, true)
  assert.equal(result.destinationPublicationAuthorized, false)
  assert.equal(result.initiatingDeviceCutoverAuthorized, false)
  assert.equal(result.independentlyAuditedDurableIntent, false)
  assert.equal(f.createAttempts, 1)
  assert.ok(checkpoints >= 6)
  const snapshot = await j.open().assertHealthySnapshot(3)
  assert.equal(snapshot.pendingRefIntents.length, 0)
  assert.equal(snapshot.verifiedRefObservations[0]?.repoId, frozenPlan.backupRepoId)
  assert.equal(snapshot.cutoverAuthorized, false)
  await assert.rejects(() => createV4BestEffortJournaledFrozenBackup({
    ...input, journal: j.open(),
  }), /previous ref intent/i)
  assert.equal(f.createAttempts, 1)
})

test("D395 best-effort Backup refuses replaced WAL lease or checkpoint before first ref intent", async () => {
  for (const replacement of ["lease", "checkpoint"] as const) {
    const f = await D99BackupFixture()
    const j = await D102Journal()
    let originalChecks = 0
    let replacementCalls = 0
    const wal = {
      async assertExclusiveStageLease() {
        originalChecks++
        if (originalChecks === 1) {
          if (replacement === "lease") wal.assertExclusiveStageLease = async () => {
            replacementCalls++
          }
          else wal.assertBestEffortCheckpoint = async () => {
            replacementCalls++
            return "best-effort-readback-only" as const
          }
        }
      },
      async assertBestEffortCheckpoint() {
        return "best-effort-readback-only" as const
      },
    }
    await assert.rejects(
      () => createV4BestEffortJournaledFrozenBackup({
        ...f.input, journal: j.journal, wal,
        acknowledgement: "accept-best-effort-power-loss-recovery-risk",
      }),
      /best-effort.*(WAL|lease|checkpoint).*changed|Manual Recovery/i,
      "D395 may not trust " + replacement + " substituted during an awaited WAL lease",
    )
    assert.equal(originalChecks, 1)
    assert.equal(replacementCalls, 0, "new callback must not be invoked")
    assert.equal(f.createAttempts, 0, "no GitHub ref may be created")
    const persisted = await j.journal.load()
    assert.equal(persisted?.generation, 1)
    assert.equal(persisted?.pendingRefIntents.length, 0)
    assert.equal(persisted?.cutoverAuthorized, false)
  }
})

test("D395 Backup retains pending intent when remote preflight swaps the WAL lease owner", async () => {
  const f = await D99BackupFixture()
  const j = await D102Journal()
  let substitutedCalls = 0
  let swapped = false
  const wal = {
    async assertExclusiveStageLease() {},
    async assertBestEffortCheckpoint() {
      return "best-effort-readback-only" as const
    },
  }
  const readBackupRef = f.input.backup.getGitRefOrNull
  f.input.backup.getGitRefOrNull = async () => {
    const pending = await j.journal.load()
    if (!swapped && pending?.pendingRefIntents.length === 1) {
      swapped = true
      wal.assertExclusiveStageLease = async () => { substitutedCalls++ }
    }
    return readBackupRef.call(f.input.backup)
  }
  await assert.rejects(
    () => createV4BestEffortJournaledFrozenBackup({
      ...f.input, journal: j.journal, wal,
      acknowledgement: "accept-best-effort-power-loss-recovery-risk",
    }),
    /best-effort.*WAL.*changed|Manual Recovery/i,
  )
  assert.equal(swapped, true, "test must change lease during a real Backup Git preflight")
  assert.equal(substitutedCalls, 0, "substituted callback must not authorize ref creation")
  assert.equal(f.createAttempts, 0)
  const pending = await j.journal.load()
  assert.equal(pending?.generation, 2)
  assert.equal(pending?.pendingRefIntents.length, 1)
  assert.equal(pending?.verifiedRefObservations.length, 0)
  assert.equal(pending?.cutoverAuthorized, false)
})

test("D166 missing best-effort risk acknowledgement fails before WAL or network writes", async () => {
  const f = await D99BackupFixture()
  const j = await D102Journal()
  let checks = 0
  await assert.rejects(() => createV4BestEffortJournaledFrozenBackup({
    ...f.input, journal: j.journal,
    wal: {
      assertExclusiveStageLease: async () => { checks++ },
      assertBestEffortCheckpoint: async () => {
        checks++
        return "best-effort-readback-only" as const
      },
    },
    acknowledgement: "not-accepted" as "accept-best-effort-power-loss-recovery-risk",
  }), /acknowledgement/i)
  assert.equal(checks, 0)
  assert.equal(f.createAttempts, 0)
  assert.deepEqual((await j.journal.load())?.pendingRefIntents, [])
})

test("D166 failed WAL checkpoint after intent keeps pending ref and prevents GitHub create", async () => {
  const f = await D99BackupFixture()
  const j = await D102Journal()
  let checks = 0
  const wal = {
    assertExclusiveStageLease: async () => {},
    assertBestEffortCheckpoint: async () => {
      if (++checks === 4) throw new Error("WAL disk read failed")
      return "best-effort-readback-only" as const
    },
  }
  await assert.rejects(() => createV4BestEffortJournaledFrozenBackup({
    ...f.input, journal: j.journal, wal,
    acknowledgement: "accept-best-effort-power-loss-recovery-risk",
  }), /Manual Recovery/i)
  assert.equal(checks, 4)
  assert.equal(f.createAttempts, 0)
  const pending = await j.open().assertHealthySnapshot(2)
  assert.equal(pending.pendingRefIntents.length, 1)
  assert.equal(pending.permissionToPublish, false)
  assert.equal(pending.cutoverAuthorized, false)
})

test("D166 best-effort unresolved GitHub create never retries the same frozen Backup", async () => {
  const f = await D99BackupFixture()
  const j = await D102Journal()
  const original = f.input.backup.createGitRef
  f.input.backup.createGitRef = async sha => {
    try { await original(sha) }
    finally {
      f.input.backup.getGitRefOrNull = async () => {
        throw new Error("GitHub 503 during Backup reconciliation")
      }
    }
  }
  f.loseCreateResponse()
  const input = {
    ...f.input, journal: j.journal,
    wal: {
      assertExclusiveStageLease: async () => {},
      assertBestEffortCheckpoint: async () => "best-effort-readback-only" as const,
    },
    acknowledgement: "accept-best-effort-power-loss-recovery-risk" as const,
  }
  await assert.rejects(() => createV4BestEffortJournaledFrozenBackup(input), /ambiguous|recovery/i)
  assert.equal(f.createAttempts, 1)
  assert.equal((await j.open().load())?.pendingRefIntents.length, 1)
  await assert.rejects(() => createV4BestEffortJournaledFrozenBackup({
    ...input, journal: j.open(),
  }), /previous ref intent/i)
  assert.equal(f.createAttempts, 1)
})

test("D166 real Windows WAL permits approved best-effort frozen Backup readback without claiming fsync durability", async () => {
  const parent = join(process.cwd(), ".tmp")
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, "d166-best-effort-backup-"))
  try {
    const f = await D99BackupFixture()
    const wal = await acquireV4DesktopRekeyWalStorage({
      rootAbsolute: root, journalRoot: "v4/rekey-journal",
    })
    try {
      const journal = createV4ReencryptionRecoveryJournal({
        adapter: wal.adapter, root: "v4/rekey-journal",
        destinationRepoId: frozenPlan.destinationRepoId, sourceCommitSha: commitSha,
        runId: "d166-backup-run", journalKey: new Uint8Array(32).fill(0x65),
      })
      await journal.begin()
      const result = await createV4BestEffortJournaledFrozenBackup({
        ...f.input, journal, wal,
        acknowledgement: "accept-best-effort-power-loss-recovery-risk",
      })
      assert.equal(result.backupContentsReadbackVerified, true)
      assert.equal(f.createAttempts, 1)
      const state = await journal.assertHealthySnapshot(3)
      assert.equal(state.verifiedRefObservations.length, 1)
      assert.equal(state.cutoverAuthorized, false)
      assert.equal(state.requiresRemoteRevalidation, true)
    } finally {
      await wal.release()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("D166 best-effort Backup after ambiguous GitHub response recovers by read-only ref verification, never replay", async () => {
  const f = await D99BackupFixture()
  const j = await D102Journal()
  const originalRead = f.input.backup.getGitRefOrNull
  const originalWrite = f.input.backup.createGitRef
  f.input.backup.createGitRef = async sha => {
    try { await originalWrite(sha) }
    finally {
      f.input.backup.getGitRefOrNull = async () => {
        throw new Error("GitHub 503 readback unavailable")
      }
    }
  }
  f.loseCreateResponse()
  const wal = {
    assertExclusiveStageLease: async () => {},
    assertBestEffortCheckpoint: async () => "best-effort-readback-only" as const,
  }
  const acknowledgement = "accept-best-effort-power-loss-recovery-risk" as const
  await assert.rejects(() => createV4BestEffortJournaledFrozenBackup({
    ...f.input, journal: j.journal, wal, acknowledgement,
  }), /ambiguous|recovery/i)
  assert.equal((await j.open().load())?.pendingRefIntents.length, 1)
  f.input.backup.getGitRefOrNull = originalRead
  const result = await reconcileV4PendingFrozenBackupWithJournalBestEffort({
    plan: frozenPlan, backup: f.input.backup, journal: j.open(), wal,
    expectedSourceTreeSha: rootTreeSha, originalPassphrase: "correct",
    verifiedOriginalSource: f.input.verifiedSource, acknowledgement,
  })
  assert.equal(result.backedUpContentsVerified, true)
  assert.equal(result.automaticallyRetryCreateAuthorized, false)
  assert.equal(result.initiatingDeviceCutoverAuthorized, false)
  assert.equal(f.createAttempts, 1)
  assert.deepEqual((await j.open().assertHealthySnapshot(3)).pendingRefIntents, [])
  await assert.rejects(() => reconcileV4PendingFrozenBackupWithJournalBestEffort({
    plan: frozenPlan, backup: f.input.backup, journal: j.open(), wal,
    expectedSourceTreeSha: rootTreeSha, originalPassphrase: "correct",
    verifiedOriginalSource: f.input.verifiedSource, acknowledgement,
  }), /one exact unresolved/i)
  assert.equal(f.createAttempts, 1)
})

test("D166 uncertain best-effort Recovery cannot clear pending WAL after wrong Git ref", async () => {
  const f = await D99BackupFixture()
  const j = await D102Journal()
  const starting = (await j.journal.load())!
  await j.journal.recordRefIntent({
    role: "backup", repoId: frozenPlan.backupRepoId,
    commitSha, treeSha: rootTreeSha,
  }, starting.generation)
  const wal = {
    assertExclusiveStageLease: async () => {},
    assertBestEffortCheckpoint: async () => "best-effort-readback-only" as const,
  }
  const input = {
    plan: frozenPlan, backup: f.input.backup, journal: j.journal, wal,
    expectedSourceTreeSha: rootTreeSha, originalPassphrase: "correct",
    verifiedOriginalSource: f.input.verifiedSource,
    acknowledgement: "accept-best-effort-power-loss-recovery-risk" as const,
  }
  f.input.backup.getGitRefOrNull = async () => ({
    ref: "refs/heads/backup/2026-10-26", sha: "f".repeat(40), type: "commit",
  })
  await assert.rejects(() => reconcileV4PendingFrozenBackupWithJournalBestEffort(input), /missing|conflicting|authenticated/i)
  assert.equal(f.createAttempts, 0)
  assert.equal((await j.open().assertHealthySnapshot(2)).pendingRefIntents.length, 1)
  await assert.rejects(() => reconcileV4PendingFrozenBackupWithJournalBestEffort({
    ...input, acknowledgement: "declined" as "accept-best-effort-power-loss-recovery-risk",
  }), /acknowledgement/i)
  assert.equal((await j.open().assertHealthySnapshot(2)).pendingRefIntents.length, 1)
})

test("D103 a corrupt sibling WAL slot after durable intent but before POST stops Backup ref creation", async () => {
  const f = await D99BackupFixture()
  const j = await D102Journal()
  let checks = 0
  await assert.rejects(() => createV4JournaledFrozenBackup({
    ...f.input, journal: j.journal,
    wal: {
      ...j.wal,
      assertCrashDurable: async () => {
        if (++checks === 2) {
          const older = [...j.files.keys()].find(path => path.endsWith("slot-1.json"))
          assert.ok(older)
          j.files.set(older, "{broken sibling")
        }
      },
    },
  }), /manual recovery|required|journal/i)
  assert.equal(f.createAttempts, 0)
  const recovered = await j.open().load()
  assert.ok(recovered)
  assert.equal(recovered.pendingRefIntents.length, 1)
  assert.equal(recovered.requiresRemoteRevalidation, true)
})

test("D102 lost GitHub Backup create outcome with unavailable readback retains WAL intent and forbids blind retry", async () => {
  const f = await D99BackupFixture()
  const j = await D102Journal()
  const originalWrite = f.input.backup.createGitRef
  f.input.backup.createGitRef = async sha => {
    try { await originalWrite(sha) }
    finally {
      f.input.backup.getGitRefOrNull = async () => {
        throw new Error("GitHub 503 during Backup recovery")
      }
    }
  }
  f.loseCreateResponse()
  await assert.rejects(() => createV4JournaledFrozenBackup({
    ...f.input, journal: j.journal, wal: j.wal,
  }), /ambiguous|recovery/i)
  const state = await j.open().load()
  assert.ok(state)
  assert.deepEqual(state.pendingRefIntents, [{
    role: "backup", repoId: frozenPlan.backupRepoId,
    commitSha, treeSha: rootTreeSha,
  }])
  assert.equal(state.requiresRemoteRevalidation, true)
  assert.equal(state.permissionToPublish, false)
  await assert.rejects(() => createV4JournaledFrozenBackup({
    ...f.input, journal: j.open(), wal: j.wal,
  }), /previous ref intent/i)
  assert.equal(f.createAttempts, 1)
})

test("D103 real lost Backup create response can be independently read/decrypted after restart and reconciled into WAL", async () => {
  const f = await D99BackupFixture()
  const j = await D102Journal()
  const existingRead = f.input.backup.getGitRefOrNull
  const originalWrite = f.input.backup.createGitRef
  f.input.backup.createGitRef = async sha => {
    try { await originalWrite(sha) }
    finally {
      f.input.backup.getGitRefOrNull = async () => {
        throw new Error("GitHub 503 lost during first Backup recovery")
      }
    }
  }
  f.loseCreateResponse()
  await assert.rejects(() => createV4JournaledFrozenBackup({
    ...f.input, journal: j.journal, wal: j.wal,
  }), /ambiguous|recovery/i)
  assert.equal(f.createAttempts, 1)
  assert.equal((await j.open().load())?.pendingRefIntents.length, 1)
  // Operator obtained new storage lease after investigating the old process.
  // The new session ONLY READS GitHub and marks verified observation.
  f.input.backup.getGitRefOrNull = existingRead
  const report = await reconcileV4PendingFrozenBackupWithJournal({
    plan: frozenPlan, backup: f.input.backup,
    expectedSourceTreeSha: rootTreeSha, originalPassphrase: "correct",
    verifiedOriginalSource: f.input.verifiedSource,
    journal: j.open(), wal: j.wal,
  })
  assert.equal(report.backedUpContentsVerified, true)
  assert.equal(report.automaticallyRetryCreateAuthorized, false)
  assert.equal(report.initiatingDeviceCutoverAuthorized, false)
  assert.equal(f.createAttempts, 1)
  const state = await j.open().load()
  assert.ok(state)
  assert.deepEqual(state.pendingRefIntents, [])
  assert.equal(state.verifiedRefObservations.length, 1)
  assert.equal(state.permissionToPublish, false)
  await assert.rejects(() => reconcileV4PendingFrozenBackupWithJournal({
    plan: frozenPlan, backup: f.input.backup,
    expectedSourceTreeSha: rootTreeSha, originalPassphrase: "correct",
    verifiedOriginalSource: f.input.verifiedSource,
    journal: j.open(), wal: j.wal,
  }), /one exact unresolved/i)
})

test("D103 Backup recovery cannot clear unresolved WAL after a mismatched remote ref", async () => {
  const f = await D99BackupFixture()
  const j = await D102Journal()
  const started = (await j.journal.load())!
  await j.journal.recordRefIntent({
    role: "backup", repoId: frozenPlan.backupRepoId,
    commitSha, treeSha: rootTreeSha,
  }, started.generation)
  f.input.backup.getGitRefOrNull = async () => ({
    ref: "refs/heads/backup/2026-10-26", sha: "f".repeat(40), type: "commit",
  })
  await assert.rejects(() => reconcileV4PendingFrozenBackupWithJournal({
    plan: frozenPlan, backup: f.input.backup,
    expectedSourceTreeSha: rootTreeSha, originalPassphrase: "correct",
    verifiedOriginalSource: f.input.verifiedSource,
    journal: j.journal, wal: j.wal,
  }), /missing|conflicting|authenticated/i)
  assert.equal(f.createAttempts, 0)
  assert.equal((await j.journal.load())?.pendingRefIntents.length, 1)
})

const d216Identity: V4ReencryptionProposedCommitIdentity = {
  runId: "d216_backup_readback", walGeneration: 8, indexRoot: "private/v4-index",
  deviceId: "device216", sourceRepoId: repoId,
  backupRepoId: frozenPlan.backupRepoId, destinationRepoId: frozenPlan.destinationRepoId,
  sourceCommitSha: commitSha, sourceTreeSha: rootTreeSha,
  destinationCommitSha: "d".repeat(40), destinationTreeSha: "e".repeat(40),
  manifestSha256: "f".repeat(64),
  sourcePassphraseSecretId: "old-key", destinationPassphraseSecretId: "new-key",
}
const d216FencePath = V4_REENCRYPTION_SYNC_FENCE_ROOT + "/active.json"
async function d216Fixture() {
  const f = await createFixture()
  const backup = frozenBackupClient(f)
  const files = new Map<string, string>([
    [V4_REENCRYPTION_SYNC_FENCE_ROOT, ""],
    [d216FencePath, JSON.stringify({
      schemaVersion: 1, phase: "migration-fenced-uncommitted",
      runId: d216Identity.runId, sourceRepoId: d216Identity.sourceRepoId,
      destinationRepoId: d216Identity.destinationRepoId,
    })],
  ])
  let held = false
  let owners = 0
  let fenceReads = 0
  let walChanged = false
  const adapter = {
    async exists(path: string) { return files.has(path) },
    async read(path: string) {
      fenceReads++
      const value = files.get(path)
      if (value === undefined) throw Error("missing fence")
      return value
    },
  }
  const wal = {
    async assertExclusiveStageLease() { assert.equal(held, true) },
    async assertBestEffortCheckpoint() {
      assert.equal(held, true)
      return "best-effort-readback-only" as const
    },
  }
  const journal = {
    sourceCommitSha: d216Identity.sourceCommitSha,
    destinationRepoId: d216Identity.destinationRepoId,
    async assertHealthySnapshot(generation: number) {
      assert.equal(held, true)
      assert.equal(generation, d216Identity.walGeneration)
      return {
        generation: walChanged ? 9 : 8,
        receipts: [], pendingIntents: [], pendingRefIntents: [],
        verifiedRefObservations: [
          { role: "backup" as const, repoId: d216Identity.backupRepoId,
            commitSha: d216Identity.sourceCommitSha, treeSha: d216Identity.sourceTreeSha },
          { role: "destination" as const, repoId: d216Identity.destinationRepoId,
            commitSha: d216Identity.destinationCommitSha, treeSha: d216Identity.destinationTreeSha,
            manifestSha256: d216Identity.manifestSha256 },
        ],
        preparedCandidateReceipt: {
          commitSha: d216Identity.destinationCommitSha, treeSha: d216Identity.destinationTreeSha,
          manifestSha256: d216Identity.manifestSha256,
        },
        candidatePreparationSha256: "a".repeat(64),
        stageHandoffStarted: true, requiresRemoteRevalidation: true,
        permissionToPublish: false, cutoverAuthorized: false,
      }
    },
  }
  const lease = async () => { assert.equal(held, true) }
  const holder = async <T>(body: () => Promise<T>): Promise<T> => {
    owners++
    assert.equal(held, false)
    held = true
    try { return await body() } finally { held = false }
  }
  const input = {
    identity: d216Identity,
    backup: { github: backup, plan: frozenPlan,
      expectedSourceTreeSha: rootTreeSha, passphrase: "correct" },
    adapter, wal, journal,
    assertExclusiveInitiatorLease: lease, withExclusiveInitiatorLease: holder,
  }
  return {
    f, files, input, get ownerCalls() { return owners }, get fenceReads() { return fenceReads },
    corruptWal() { walChanged = true },
    replaceHolder(next: typeof holder) { input.withExclusiveInitiatorLease = next },
  }
}

test("D216 held-fence Backup recovery re-decrypts all frozen Git blobs twice with no write authority", async () => {
  const x = await d216Fixture()
  x.f.setCurrentSha("9".repeat(40)) // Old Source branch remains independently writable.
  const result = await inspectV4FencedFrozenBackupContentAfterRestart(x.input)
  assert.equal(result.observation, "complete-frozen-backup-reverified-uncommitted")
  assert.equal(result.completeBackupContentReverified, true)
  assert.equal(result.verifiedFileCount, 1)
  assert.equal(result.verifiedPlaintextBytes, String(enc("File content secret").length))
  assert.equal(x.f.repoReads, 4, "each complete pass must re-observe physical repository identity")
  assert.ok(x.f.blobReads >= 8, "both passes must re-fetch all encrypted metadata and content")
  assert.ok(x.fenceReads >= 6)
  assert.equal(x.ownerCalls, 1)
  assert.equal(result.localCutoverAuthorized, false)
  assert.equal(result.resumeSyncAuthorized, false)
  assert.equal(result.oldPassphraseCleanupAuthorized, false)
})

test("D216 Backup ref moving between complete reads fails closed with the old branch unchanged", async () => {
  const x = await d216Fixture()
  let reads = 0
  x.input.backup.github.getGitRef = async () => ({
    ref: "refs/heads/backup/2026-10-26", type: "commit",
    sha: ++reads <= 2 ? commitSha : "9".repeat(40),
  })
  const result = await inspectV4FencedFrozenBackupContentAfterRestart(x.input)
  assert.equal(result.observation, "manual-recovery-required")
  assert.equal(result.completeBackupContentReverified, false)
  assert.ok(x.f.blobReads >= 4)
  assert.equal(result.remoteWritesAuthorized, false)
})

test("D216 changed Backup ciphertext on second read denies any positive recovery proof", async () => {
  const x = await d216Fixture()
  x.f.onBlobRead(sha => {
    if (x.f.blobReads < 5) return
    const content = x.f.blobs.get(sha)
    if (!content) return
    const changed = content.slice()
    changed[0] = changed[0]! ^ 1
    x.f.blobs.set(sha, changed)
  })
  const result = await inspectV4FencedFrozenBackupContentAfterRestart(x.input)
  assert.equal(result.observation, "manual-recovery-required")
  assert.ok(x.f.blobReads >= 5)
  assert.equal(result.localCutoverAuthorized, false)
})

test("D216 missing or forged Fence, WAL, repo ID or source passphrase requires Manual Recovery", async () => {
  const variants = [
    (x: Awaited<ReturnType<typeof d216Fixture>>) => { x.files.delete(d216FencePath) },
    (x: Awaited<ReturnType<typeof d216Fixture>>) => { x.files.set(d216FencePath, "{broken") },
    (x: Awaited<ReturnType<typeof d216Fixture>>) => { x.corruptWal() },
    (x: Awaited<ReturnType<typeof d216Fixture>>) => { x.f.setRepositoryId(123) },
    (x: Awaited<ReturnType<typeof d216Fixture>>) => { x.input.backup.passphrase = "incorrect" },
  ]
  for (const change of variants) {
    const x = await d216Fixture()
    change(x)
    const result = await inspectV4FencedFrozenBackupContentAfterRestart(x.input)
    assert.equal(result.observation, "manual-recovery-required")
    assert.equal(result.localCutoverAuthorized, false)
    assert.equal(result.oldPassphraseCleanupAuthorized, false)
  }
})

test("D216 skipped or repeated lease callback cannot fabricate full Backup success", async () => {
  const skipped = await d216Fixture()
  skipped.replaceHolder(async () =>
    ({ observation: "complete-frozen-backup-reverified-uncommitted" }) as never)
  const result = await inspectV4FencedFrozenBackupContentAfterRestart(skipped.input)
  assert.equal(result.observation, "manual-recovery-required")
  assert.equal(skipped.f.blobReads, 0)

  const repeated = await d216Fixture()
  repeated.replaceHolder(async body => {
    const result = await body()
    await body()
    return result
  })
  const second = await inspectV4FencedFrozenBackupContentAfterRestart(repeated.input)
  assert.equal(second.observation, "manual-recovery-required")
  assert.equal(second.resumeSyncAuthorized, false)
})

test("D95 aborted recovery does no remote I/O", async () => {
  const f = await createFixture()
  const ctrl = new AbortController()
  ctrl.abort(new Error("stop recovery"))
  await assert.rejects(() => inspectV4FrozenBackupAfterAmbiguousCreate({
    backup: backupRecoveryClient(f).github, plan: frozenPlan,
    expectedSourceTreeSha: rootTreeSha, originalPassphrase: "correct", signal: ctrl.signal,
  }), /stop recovery/)
  assert.equal(f.repoReads, 0)
})
