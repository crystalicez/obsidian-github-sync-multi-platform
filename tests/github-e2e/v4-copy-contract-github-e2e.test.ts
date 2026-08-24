import assert from "node:assert/strict";
import test, { after } from "node:test";
import { setRequestUrlHandler } from "obsidian";

import { GitHubClient, type GitHubConfig } from "../../src/lib/github-api";
import { randomBytes, toBase64Url } from "../../src/lib/bytes";
import { deriveV4Keyring, type V4Keyring } from "../../src/lib/v4/crypto";
import { createEmptyV4LocalIndex, type V4LocalIndex } from "../../src/lib/v4/local-index";
import { expectedV4PathLayout, V4_FORMAT_VERSION, type V4RemoteConfig, type V4StorageMode } from "../../src/lib/v4/protocol-types";
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

function installRequestUrlBridge(): void {
  setRequestUrlHandler(async raw => {
    const request = raw as { url: string; method?: string; headers?: Record<string, string>; body?: string };
    const response = await fetch(request.url, { method: request.method ?? "GET", headers: request.headers, body: request.body });
    const arrayBuffer = await response.arrayBuffer();
    const text = new TextDecoder().decode(arrayBuffer);
    let json: unknown;
    try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
    return { status: response.status, headers: Object.fromEntries(response.headers.entries()), text, json, arrayBuffer };
  });
}

async function deleteTestBranch(config: GitHubConfig): Promise<void> {
  const repoResponse = await githubRequest(config, "");
  if (!repoResponse.ok) throw new Error(`Cannot inspect E2E repo: HTTP ${repoResponse.status}`);
  const repository = await repoResponse.json() as { default_branch: string };
  if (repository.default_branch === config.branch) throw new Error("GITHUB_E2E_BRANCH must not be the repository default branch.");

  const response = await githubRequest(config, `/git/refs/heads/${branchPath(config)}`, { method: "DELETE" });
  if (![204, 404, 422].includes(response.status)) throw new Error(`Cannot delete E2E branch: HTTP ${response.status} ${await response.text()}`);
  await response.arrayBuffer().catch(() => undefined);
}

class MemoryVault implements V4SessionVault {
  readonly files = new Map<string, { bytes: Uint8Array; mtime: number }>();
  set(path: string, bytes: Uint8Array, mtime: number) { this.files.set(path, { bytes: new Uint8Array(bytes), mtime }); }
  async listFiles() { return [...this.files].map(([path, file]) => ({ path, size: file.bytes.byteLength, mtime: file.mtime })); }
  async stat(path: string) { const file = this.files.get(path); return file ? { path, size: file.bytes.byteLength, mtime: file.mtime } : null; }
  async read(path: string) { const file = this.files.get(path); if (!file) throw new Error(`Missing ${path}`); return new Uint8Array(file.bytes); }
  async write(path: string, bytes: Uint8Array, mtime?: number) { this.set(path, bytes, mtime ?? Date.now()); }
  async trash(path: string) { this.files.delete(path); }
}

interface ModeContext { mode: V4StorageMode; config: V4RemoteConfig; keyring?: V4Keyring; }
interface Device { vault: MemoryVault; index: V4LocalIndex; session: V4SyncSession; }

function repoId(config: GitHubConfig): string { return `${config.owner}/${config.repo}#${config.branch}`; }

async function modeContext(mode: V4StorageMode, github: GitHubConfig): Promise<ModeContext> {
  if (mode === "plaintext") return {
    mode,
    config: { formatVersion: V4_FORMAT_VERSION, mode, repoId: repoId(github), pathLayout: expectedV4PathLayout(mode) },
  };
  const salt = randomBytes(16);
  const config: V4RemoteConfig = {
    formatVersion: V4_FORMAT_VERSION,
    mode,
    repoId: repoId(github),
    pathLayout: expectedV4PathLayout(mode),
    algorithm: "AES-GCM",
    kdf: "PBKDF2-SHA-256",
    kdfParams: { iterations: 10_000, salt: toBase64Url(salt) },
  };
  const keyring = await deriveV4Keyring({ passphrase: "v4-copy-contract-e2e", repoId: config.repoId, salt, iterations: 10_000 });
  return { mode, config, keyring };
}

function device(name: string, github: GitHubConfig, context: ModeContext, now?: () => number): Device {
  const vault = new MemoryVault();
  const index = createEmptyV4LocalIndex({
    repoId: context.config.repoId,
    deviceId: name,
    mode: context.mode,
    pathLayout: expectedV4PathLayout(context.mode),
  });
  const session = new V4SyncSession({
    github: new GitHubClient(github),
    vault,
    index,
    config: context.config,
    keyring: context.keyring,
    conflictPolicy: "copy",
    abortChangePercent: 0,
    now,
  });
  return { vault, index, session };
}

function liveRecords(index: V4LocalIndex) {
  return Object.values(index.shards).flatMap(shard => Object.values(shard.records)).filter(record => !record.deleted);
}

function recordAt(index: V4LocalIndex, path: string) {
  const record = liveRecords(index).find(candidate => candidate.path === path);
  assert.ok(record, `missing record ${path}`);
  return record;
}

const github = configFromEnv();
installRequestUrlBridge();

after(async () => {
  try { await deleteTestBranch(github); }
  finally { setRequestUrlHandler(null); }
});

test("real GitHub rename versus stale edit follows exact local-primary Copy contract", { timeout: 300_000 }, async () => {
  for (const mode of ["plaintext", "encrypted"] as const) {
    await deleteTestBranch(github);
    const context = await modeContext(mode, github);
    const a = device("device-a", github, context);
    const b = device("device-b", github, context, () => 515151);
    const c = device("device-c", github, context);
    const base = encoder.encode("rename-base\n");
    const stale = encoder.encode("stale-local-edit\n");

    a.vault.set("old.md", base, 1);
    await a.session.sync({ operation: "forcePush", allowThresholdOverride: false });
    await b.session.sync({ operation: "forcePull", allowThresholdOverride: false });
    const originalFileId = recordAt(b.index, "old.md").fileId;

    a.vault.files.delete("old.md");
    a.vault.set("new.md", base, 2);
    await a.session.sync({ operation: "normal", allowThresholdOverride: false, changes: [{ type: "rename", oldPath: "old.md", path: "new.md", mtime: 2 }] });

    b.vault.set("old.md", stale, 3);
    await b.session.sync({ operation: "normal", allowThresholdOverride: false, changes: [{ type: "modify", path: "old.md", mtime: 3 }] });

    const copyPath = "new.conflict-remote-device-b-515151.md";
    assert.deepEqual([...b.vault.files.keys()].sort(), [copyPath, "old.md"]);
    assert.deepEqual(b.vault.files.get("old.md")?.bytes, stale);
    assert.deepEqual(b.vault.files.get(copyPath)?.bytes, base);
    assert.equal(recordAt(b.index, "old.md").fileId, originalFileId);
    assert.notEqual(recordAt(b.index, copyPath).fileId, originalFileId);

    await c.session.sync({ operation: "forcePull", allowThresholdOverride: false });
    assert.deepEqual([...c.vault.files.keys()].sort(), [copyPath, "old.md"]);
    assert.deepEqual(c.vault.files.get("old.md")?.bytes, stale);
    assert.deepEqual(c.vault.files.get(copyPath)?.bytes, base);
    assert.equal(recordAt(c.index, "old.md").fileId, originalFileId);
    assert.equal(recordAt(c.index, copyPath).fileId, recordAt(b.index, copyPath).fileId);

    if (mode === "encrypted") {
      assert.notEqual(recordAt(c.index, "old.md").remotePath, "old.md");
      assert.notEqual(recordAt(c.index, copyPath).remotePath, copyPath);
      assert.notEqual(recordAt(c.index, "old.md").remotePath, recordAt(c.index, copyPath).remotePath);
    }
  }
});
