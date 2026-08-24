import assert from "node:assert/strict";
import test, { after } from "node:test";
import { setRequestUrlHandler } from "obsidian";

import { GitHubClient, type GitHubConfig } from "../../src/lib/github-api";
import { randomBytes, toBase64, toBase64Url } from "../../src/lib/bytes";
import { deriveV4Keyring } from "../../src/lib/v4/crypto";
import { createEmptyV4LocalIndex } from "../../src/lib/v4/local-index";
import { expectedV4PathLayout, V4_FORMAT_VERSION, type V4RemoteConfig } from "../../src/lib/v4/protocol-types";
import { V4SyncSession, type V4SessionVault } from "../../src/lib/v4/sync-session";

const forbiddenBranches = new Set(["main", "master", "production", "prod", "release", "stable"]);
const encoder = new TextEncoder();

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function configFromEnv(): GitHubConfig {
  const branch = requiredEnv("GITHUB_E2E_BRANCH");
  if (forbiddenBranches.has(branch.toLowerCase())) throw new Error(`Refusing destructive GitHub E2E branch: ${branch}`);
  return {
    owner: requiredEnv("GITHUB_E2E_OWNER"),
    repo: requiredEnv("GITHUB_E2E_REPO"),
    branch,
    token: requiredEnv("GITHUB_E2E_TOKEN"),
  };
}

function branchPath(config: GitHubConfig): string {
  return config.branch.split("/").map(encodeURIComponent).join("/");
}

async function githubRequest(config: GitHubConfig, apiPath: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`https://api.github.com/repos/${config.owner}/${config.repo}${apiPath}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.headers ?? {}),
    },
  });
}

async function expectJson<T>(response: Response, statuses: readonly number[], action: string): Promise<T> {
  const text = await response.text();
  if (!statuses.includes(response.status)) throw new Error(`${action}: HTTP ${response.status} ${text}`);
  return (text ? JSON.parse(text) : {}) as T;
}

function installRequestUrlBridge(): void {
  setRequestUrlHandler(async raw => {
    const request = raw as { url: string; method?: string; headers?: Record<string, string>; body?: string };
    const response = await fetch(request.url, {
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

async function readBranchHead(config: GitHubConfig): Promise<string | null> {
  const response = await githubRequest(config, `/git/ref/heads/${branchPath(config)}?_=${Date.now()}`);
  if (response.status === 404) return null;
  const ref = await expectJson<{ object?: { sha?: string } }>(response, [200], "Cannot read E2E branch head");
  return ref.object?.sha ?? null;
}

async function deleteTestBranch(config: GitHubConfig): Promise<void> {
  const repository = await expectJson<{ default_branch: string }>(await githubRequest(config, ""), [200], "Cannot inspect E2E repository");
  if (repository.default_branch === config.branch) throw new Error("GITHUB_E2E_BRANCH must not be the repository default branch.");

  const response = await githubRequest(config, `/git/refs/heads/${branchPath(config)}`, { method: "DELETE" });
  if (![204, 404, 422].includes(response.status)) {
    throw new Error(`Cannot delete E2E branch: HTTP ${response.status} ${await response.text()}`);
  }
  await response.arrayBuffer().catch(() => undefined);

  for (let attempt = 0; attempt < 40; attempt++) {
    if ((await readBranchHead(config)) === null) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out deleting E2E branch ${config.branch}`);
}

async function publishExternalCommit(config: GitHubConfig, marker: string): Promise<string> {
  const headSha = await readBranchHead(config);
  if (!headSha) throw new Error("Encrypted E2E branch is missing before external mutation.");
  const commit = await expectJson<{ tree?: { sha?: string } }>(
    await githubRequest(config, `/git/commits/${headSha}`),
    [200],
    "Cannot read encrypted E2E base commit",
  );
  const baseTree = commit.tree?.sha;
  if (!baseTree) throw new Error("Encrypted E2E base commit is missing a tree SHA.");

  const blob = await expectJson<{ sha?: string }>(
    await githubRequest(config, "/git/blobs", {
      method: "POST",
      body: JSON.stringify({ content: toBase64(encoder.encode(`encrypted-external:${marker}\n`)), encoding: "base64" }),
    }),
    [201],
    "Cannot create encrypted external blob",
  );
  if (!blob.sha) throw new Error("Encrypted external blob response is missing SHA.");

  const tree = await expectJson<{ sha?: string }>(
    await githubRequest(config, "/git/trees", {
      method: "POST",
      body: JSON.stringify({
        base_tree: baseTree,
        tree: [{ path: `.e2e-external/${marker}.txt`, mode: "100644", type: "blob", sha: blob.sha }],
      }),
    }),
    [201],
    "Cannot create encrypted external tree",
  );
  if (!tree.sha) throw new Error("Encrypted external tree response is missing SHA.");

  const external = await expectJson<{ sha?: string }>(
    await githubRequest(config, "/git/commits", {
      method: "POST",
      body: JSON.stringify({ message: `external-encrypted-e2e:${marker}`, tree: tree.sha, parents: [headSha] }),
    }),
    [201],
    "Cannot create encrypted external commit",
  );
  if (!external.sha) throw new Error("Encrypted external commit response is missing SHA.");

  await expectJson<unknown>(
    await githubRequest(config, `/git/refs/heads/${branchPath(config)}`, {
      method: "PATCH",
      body: JSON.stringify({ sha: external.sha, force: false }),
    }),
    [200],
    "Cannot publish encrypted external commit",
  );
  return external.sha;
}

class MemoryVault implements V4SessionVault {
  readonly files = new Map<string, { bytes: Uint8Array; mtime: number }>();

  set(path: string, bytes: Uint8Array, mtime: number): void {
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
    this.set(path, bytes, mtime ?? Date.now());
  }

  async trash(path: string) {
    this.files.delete(path);
  }
}

const config = configFromEnv();
installRequestUrlBridge();

after(async () => {
  try {
    await deleteTestBranch(config);
  } finally {
    setRequestUrlHandler(null);
  }
});

test("encrypted V4 refuses an out-of-band GitHub commit without silently overwriting it", { timeout: 180_000 }, async () => {
  await deleteTestBranch(config);
  const repoId = `${config.owner}/${config.repo}#${config.branch}`;
  const salt = randomBytes(16);
  const remoteConfig: V4RemoteConfig = {
    formatVersion: V4_FORMAT_VERSION,
    mode: "encrypted",
    repoId,
    pathLayout: expectedV4PathLayout("encrypted"),
    algorithm: "AES-GCM",
    kdf: "PBKDF2-SHA-256",
    kdfParams: { iterations: 10_000, salt: toBase64Url(salt) },
  };
  const keyring = await deriveV4Keyring({
    passphrase: "v4-encrypted-external-e2e",
    repoId,
    salt,
    iterations: 10_000,
  });
  const vault = new MemoryVault();
  vault.set("Notes/external-guard.md", encoder.encode("encrypted baseline\n"), 1);
  const index = createEmptyV4LocalIndex({
    repoId,
    deviceId: "encrypted-external-device",
    mode: "encrypted",
    pathLayout: expectedV4PathLayout("encrypted"),
  });
  const client = new GitHubClient(config);
  const session = new V4SyncSession({
    github: client,
    vault,
    index,
    config: remoteConfig,
    keyring,
    conflictPolicy: "copy",
    abortChangePercent: 0,
  });

  const initial = await session.sync({ operation: "forcePush", allowThresholdOverride: false });
  assert.equal(initial.mode, "force-push");
  assert.ok(index.remoteCommitSha);

  const externalCommitSha = await publishExternalCommit(config, "encrypted-guard");
  assert.equal(await readBranchHead(config), externalCommitSha);

  await assert.rejects(
    session.sync({ operation: "normal", allowThresholdOverride: false }),
    /External GitHub changes touched an encrypted V4 branch without updating its journal/u,
  );

  assert.equal(await readBranchHead(config), externalCommitSha, "plugin silently overwrote the external encrypted-branch commit");
  assert.notEqual(index.remoteCommitSha, externalCommitSha, "local index trusted an unauthenticated encrypted external commit");
});
