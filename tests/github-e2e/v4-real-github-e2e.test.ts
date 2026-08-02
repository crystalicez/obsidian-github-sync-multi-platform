import assert from "node:assert/strict";
import test, { after } from "node:test";
import { setRequestUrlHandler } from "obsidian";

import { GitHubClient, type GitHubConfig } from "../../src/lib/github-api";
import { randomBytes, toBase64Url } from "../../src/lib/bytes";
import { deriveV4Keyring } from "../../src/lib/v4/crypto";
import { V4HistoryService } from "../../src/lib/v4/history-service";
import { createEmptyV4LocalIndex } from "../../src/lib/v4/local-index";
import { expectedV4PathLayout, V4_FORMAT_VERSION, type V4RemoteConfig, type V4StorageMode } from "../../src/lib/v4/protocol-types";
import { V4StorageCodec } from "../../src/lib/v4/storage-codec";
import { V4SyncSession, type V4SessionVault } from "../../src/lib/v4/sync-session";

const forbiddenBranches = new Set(["main", "master", "production", "prod", "release", "stable"]);

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function githubConfig(): GitHubConfig {
  const branch = requiredEnv("GITHUB_E2E_BRANCH");
  if (forbiddenBranches.has(branch.toLowerCase())) throw new Error(`Refusing destructive GitHub E2E branch: ${branch}`);
  return {
    owner: requiredEnv("GITHUB_E2E_OWNER"),
    repo: requiredEnv("GITHUB_E2E_REPO"),
    branch,
    token: requiredEnv("GITHUB_E2E_TOKEN"),
  };
}

async function fetchWithRetry(url: string, init: RequestInit, attempts = 3): Promise<Response> {
  let response: Response | undefined;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    response = await fetch(url, init);
    if (![401, 403, 429].includes(response.status) && response.status < 500) return response;
    if (attempt < attempts) {
      await response.arrayBuffer().catch(() => undefined);
      await new Promise(resolve => setTimeout(resolve, attempt * 500));
    }
  }
  return response!;
}

function installRequestUrlBridge(): void {
  setRequestUrlHandler(async raw => {
    const request = raw as { url: string; method?: string; headers?: Record<string, string>; body?: string };
    const response = await fetchWithRetry(request.url, {
      method: request.method ?? "GET",
      headers: request.headers,
      body: request.body,
    });
    const arrayBuffer = await response.arrayBuffer();
    const text = new TextDecoder().decode(arrayBuffer);
    let json: unknown;
    try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      text,
      json,
      arrayBuffer,
    };
  });
}

async function githubRequest(config: GitHubConfig, apiPath: string, init: RequestInit = {}): Promise<Response> {
  return fetchWithRetry(`https://api.github.com/repos/${config.owner}/${config.repo}${apiPath}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2026-03-10",
      ...(init.headers ?? {}),
    },
  });
}

async function waitForBranchAbsent(config: GitHubConfig, branchPath: string, timeoutMs = 15_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    const response = await githubRequest(config, `/git/ref/heads/${branchPath}?_=${Date.now()}`);
    if (response.status === 404) return;
    const responseText = await response.text();
    if (response.status === 422) {
      try {
        if ((JSON.parse(responseText) as { message?: string }).message === "Reference does not exist") return;
      } catch {
        // Continue to the explicit unexpected-response error below.
      }
    }
    if (response.status !== 200) throw new Error(`Cannot verify GitHub E2E branch deletion: HTTP ${response.status} ${responseText}`);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for GitHub E2E branch deletion after ${timeoutMs}ms.`);
}

async function waitForBranchHead(config: GitHubConfig, expectedSha: string, timeoutMs = 15_000): Promise<void> {
  const branchPath = config.branch.split("/").map(encodeURIComponent).join("/");
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    const response = await githubRequest(config, `/git/ref/heads/${branchPath}?_=${Date.now()}`);
    if (response.status === 200) {
      const ref = await response.json() as { object?: { sha?: string } };
      if (ref.object?.sha === expectedSha) return;
    } else {
      await response.arrayBuffer().catch(() => undefined);
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for GitHub E2E branch head ${expectedSha} after ${timeoutMs}ms.`);
}

async function deleteTestBranch(config: GitHubConfig): Promise<void> {
  const repository = await githubRequest(config, "");
  if (!repository.ok) throw new Error(`Cannot inspect GitHub E2E repository: HTTP ${repository.status}`);
  const metadata = await repository.json() as { default_branch: string };
  if (metadata.default_branch === config.branch) throw new Error("GITHUB_E2E_BRANCH must not be the repository default branch.");

  const branchPath = config.branch.split("/").map(encodeURIComponent).join("/");
  const response = await githubRequest(config, `/git/refs/heads/${branchPath}`, { method: "DELETE" });
  if (response.status === 204 || response.status === 404) {
    await waitForBranchAbsent(config, branchPath);
    return;
  }
  const responseText = await response.text();
  if (response.status === 422) {
    try {
      if ((JSON.parse(responseText) as { message?: string }).message === "Reference does not exist") {
        await waitForBranchAbsent(config, branchPath);
        return;
      }
    } catch {
      // Fall through so malformed validation responses remain visible.
    }
  }
  throw new Error(`Cannot reset GitHub E2E branch: HTTP ${response.status} ${responseText}`);
}

class MemoryVault implements V4SessionVault {
  readonly files = new Map<string, { bytes: Uint8Array; mtime: number }>();

  set(path: string, bytes: Uint8Array, mtime = Date.now()): void {
    this.files.set(path, { bytes: new Uint8Array(bytes), mtime });
  }

  async listFiles() {
    return [...this.files].map(([path, file]) => ({ path, size: file.bytes.byteLength, mtime: file.mtime }));
  }

  async stat(path: string) {
    const file = this.files.get(path);
    return file ? { path, size: file.bytes.byteLength, mtime: file.mtime } : null;
  }

  async read(path: string) {
    const file = this.files.get(path);
    if (!file) throw new Error(`Missing local E2E file: ${path}`);
    return new Uint8Array(file.bytes);
  }

  async write(path: string, bytes: Uint8Array, mtime?: number) {
    this.set(path, bytes, mtime);
  }

  async trash(path: string) {
    this.files.delete(path);
  }
}

function repoId(config: GitHubConfig): string {
  return `${config.owner}/${config.repo}#${config.branch}`;
}

async function runRoundTrip(mode: V4StorageMode, config: GitHubConfig): Promise<void> {
  await deleteTestBranch(config);
  const client = new GitHubClient(config);
  const started = performance.now();
  try {
    const salt = randomBytes(16);
    const remoteConfig: V4RemoteConfig = mode === "encrypted"
      ? {
        formatVersion: V4_FORMAT_VERSION,
        mode,
        repoId: repoId(config),
        pathLayout: expectedV4PathLayout(mode),
        algorithm: "AES-GCM",
        kdf: "PBKDF2-SHA-256",
        kdfParams: { iterations: 10_000, salt: toBase64Url(salt) },
      }
      : { formatVersion: V4_FORMAT_VERSION, mode, repoId: repoId(config), pathLayout: expectedV4PathLayout(mode) };
    assert.equal(remoteConfig.pathLayout, mode === "encrypted" ? "opaque-stable-v1" : "plaintext-v1");
    const keyring = mode === "encrypted"
      ? await deriveV4Keyring({ passphrase: "v4-real-github-e2e", repoId: remoteConfig.repoId, salt, iterations: 10_000 })
      : undefined;

    const source = new MemoryVault();
    source.set("Notes/hello.md", new TextEncoder().encode(`hello from ${mode}`), 1);
    source.set("Assets/pixel.bin", new Uint8Array([0, 1, 2, 255]), 2);
    const sourceIndex = createEmptyV4LocalIndex({
      repoId: remoteConfig.repoId,
      deviceId: `source-${mode}`,
      mode,
      pathLayout: expectedV4PathLayout(mode),
    });
    const sourceSession = new V4SyncSession({
      github: client,
      vault: source,
      index: sourceIndex,
      config: remoteConfig,
      keyring,
      conflictPolicy: "copy",
      abortChangePercent: 0,
    });

    const pushed = await sourceSession.sync({ operation: "forcePush", allowThresholdOverride: false });
    assert.equal(pushed.mode, "force-push");
    await waitForBranchHead(config, sourceIndex.remoteCommitSha!);

    if (mode === "encrypted") {
      const beforeRename = Object.values(sourceIndex.shards)
        .flatMap(shard => Object.values(shard.records))
        .find(record => record.path === "Notes/hello.md")!;
      const renamedFile = source.files.get("Notes/hello.md")!;
      source.files.delete("Notes/hello.md");
      source.set("Notes/hello-renamed.md", renamedFile.bytes, 3);
      await sourceSession.sync({
        operation: "normal",
        allowThresholdOverride: false,
        changes: [{ type: "rename", oldPath: "Notes/hello.md", path: "Notes/hello-renamed.md", mtime: 3 }],
      });
      await waitForBranchHead(config, sourceIndex.remoteCommitSha!);
      const afterRename = Object.values(sourceIndex.shards)
        .flatMap(shard => Object.values(shard.records))
        .find(record => record.path === "Notes/hello-renamed.md")!;
      assert.equal(afterRename.fileId, beforeRename.fileId);
      assert.equal(afterRename.remotePath, beforeRename.remotePath);
    }

    assert.equal((await sourceSession.sync({ operation: "normal", allowThresholdOverride: false })).mode, "noop");
    const publishedCommitSha = sourceIndex.remoteCommitSha!;
    const history = new V4HistoryService({ github: client, config: remoteConfig, keyring });
    const historyPage = await history.listCommits();
    const publishedHistoryCommit = historyPage.items.find(item => item.sha === publishedCommitSha && item.source === "plugin");
    assert.ok(publishedHistoryCommit?.journalId);
    const historyChanges = await history.getCommitChanges(publishedHistoryCommit);
    assert.equal(historyChanges.some(change => change.path === (mode === "encrypted" ? "Notes/hello-renamed.md" : "Notes/hello.md")), true);

    const publishedCommit = await client.getGitCommit(publishedCommitSha);
    const tree = await client.getTreeAt(publishedCommit.treeSha, true);
    if (mode === "encrypted") {
      const headPath = ".obsidian-github-sync-v4/head";
      const headNode = tree.tree.find(node => node.path === headPath);
      assert.ok(headNode, "Encrypted V4 head is missing from the published commit tree.");
      const [headByPath, headByBlob] = await Promise.all([
        client.getFileBytes(headPath, publishedCommitSha),
        client.getBlob(headNode.sha),
      ]);
      assert.ok(headByPath, "Encrypted V4 head is missing from the Contents API.");
      assert.deepEqual([...headByBlob.subarray(0, 4)], [0x4f, 0x47, 0x53, 0x34], "Encrypted V4 head blob was stored without its payload header.");
      assert.deepEqual([...headByPath.bytes.subarray(0, 4)], [0x4f, 0x47, 0x53, 0x34], "Encrypted V4 head path read lost its payload header.");
    }
    const paths = tree.tree.map(entry => entry.path);
    if (mode === "plaintext") assert.equal(paths.includes("Notes/hello.md"), true);
    else {
      assert.equal(paths.some(path => /^\.obsidian-github-sync-v4\/data\/[0-9a-f]{2}\/[0-9a-f]{64}\.enc$/u.test(path)), true);
      for (const segment of ["Notes", "Assets", "hello", "pixel", "md", "bin"]) {
        assert.equal(paths.some(path => path.includes(segment)), false);
      }
      const records = Object.values(sourceIndex.shards).flatMap(shard => Object.values(shard.records));
      for (const record of records) {
        const remote = await client.getFileBytes(record.remotePath, publishedCommitSha);
        assert.ok(remote, `Encrypted V4 object is missing: ${record.remotePath}`);
        const objectNode = tree.tree.find(node => node.path === record.remotePath);
        assert.ok(objectNode, `Encrypted V4 object is missing from the commit tree: ${record.remotePath}`);
        const blobBytes = await client.getBlob(objectNode.sha);
        assert.deepEqual(remote.bytes, blobBytes, `Contents and Git Blob bytes differ: ${record.remotePath}`);
        assert.deepEqual(
          [...remote.bytes.subarray(0, 4)],
          [0x4f, 0x47, 0x53, 0x34],
          `Encrypted V4 object has an invalid header at ${record.remotePath}; length=${remote.bytes.byteLength}`,
        );
        try {
          const decoded = await new V4StorageCodec({ mode, pathLayout: expectedV4PathLayout(mode), keyring }).read(record, async path => {
            const node = tree.tree.find(item => item.path === path);
            if (!node) throw new Error(`Encrypted V4 object is missing: ${path}`);
            return client.getBlob(node.sha);
          });
          assert.deepEqual(decoded, source.files.get(record.path)!.bytes);
        } catch (error) {
          throw new Error(`Encrypted V4 object failed authentication: ${record.remotePath}`, { cause: error });
        }
      }
    }

    const target = new MemoryVault();
    target.set("remove-me.md", new TextEncoder().encode("old"));
    const targetIndex = createEmptyV4LocalIndex({
      repoId: remoteConfig.repoId,
      deviceId: `target-${mode}`,
      mode,
      pathLayout: expectedV4PathLayout(mode),
    });
    const pulled = await new V4SyncSession({
      github: client,
      vault: target,
      index: targetIndex,
      config: remoteConfig,
      keyring,
      conflictPolicy: "copy",
      abortChangePercent: 0,
    }).sync({ operation: "forcePull", allowThresholdOverride: false });

    assert.equal(pulled.mode, "force-pull");
    for (const [path, sourceFile] of source.files) {
      assert.deepEqual(target.files.get(path)!.bytes, sourceFile.bytes, `Pulled bytes differ at ${path}`);
    }
    assert.equal(target.files.has("remove-me.md"), false);

    if (mode === "encrypted") {
      const pushedRecords = Object.values(sourceIndex.shards).flatMap(shard => Object.values(shard.records));
      const pulledRecords = Object.values(targetIndex.shards).flatMap(shard => Object.values(shard.records));
      for (const pushedRecord of pushedRecords) {
        const pulledRecord = pulledRecords.find(record => record.path === pushedRecord.path)!;
        assert.equal(pulledRecord.fileId, pushedRecord.fileId);
        assert.equal(pulledRecord.remotePath, pushedRecord.remotePath);
      }
    }
  } finally {
    console.log(JSON.stringify({
      mode,
      elapsedMs: Number((performance.now() - started).toFixed(1)),
      transport: client.transportMetricsSnapshot,
    }));
  }
}

const config = githubConfig();
installRequestUrlBridge();

after(async () => {
  try {
    await deleteTestBranch(config);
    console.log(`GitHub E2E branch cleanup verified: ${config.branch}`);
  } finally {
    setRequestUrlHandler(null);
  }
});

test("V4 real GitHub REST round trips plaintext and encrypted vaults", { timeout: 120_000 }, async () => {
  await runRoundTrip("plaintext", config);
  await runRoundTrip("encrypted", config);
});
