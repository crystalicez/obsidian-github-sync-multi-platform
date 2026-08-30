import assert from "node:assert/strict";
import test, { after } from "node:test";
import { setRequestUrlHandler } from "obsidian";

import { GitHubClient, type GitHubConfig } from "../../src/lib/github-api";
import { randomBytes, toBase64Url } from "../../src/lib/bytes";
import { deriveV4Keyring, type V4Keyring } from "../../src/lib/v4/crypto";
import { createEmptyV4LocalIndex, type V4LocalIndex } from "../../src/lib/v4/local-index";
import { expectedV4PathLayout, V4_FORMAT_VERSION, type V4RemoteConfig, type V4StorageMode } from "../../src/lib/v4/protocol-types";
import { V4SyncSession, type V4SessionVault, type V4SyncRunState } from "../../src/lib/v4/sync-session";
import {
  encodeGitHubE2ERefPath,
  readGitHubE2ETargetEnvironment,
  resetGitHubE2EDisposableBranch,
  resolveGitHubE2ETarget,
} from "./support/target-safety";

const encoder = new TextEncoder();
type E2ESession = Pick<V4SyncSession, "sync">;

function branchPath(config: GitHubConfig): string {
  return encodeGitHubE2ERefPath(config.branch);
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
interface Device { vault: MemoryVault; index: V4LocalIndex; session: E2ESession; }

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
  const client = new GitHubClient(github);
  const sessionInput = {
    github: client,
    vault,
    index,
    config: context.config,
    keyring: context.keyring,
    conflictPolicy: "copy" as const,
    abortChangePercent: 0,
    now,
  };
  const session: E2ESession = {
    async sync(options) {
      const runState: V4SyncRunState = { conflictCopies: new Map(), conflictCopyStages: new Map() };
      let lastError: unknown;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          return await new V4SyncSession({ ...sessionInput, runState }).sync(options);
        } catch (error) {
          lastError = error;
          const message = error instanceof Error ? error.message : String(error);
          const retryable = options.operation === "normal" && /branch head changed|stale ref/i.test(message);
          if (!retryable || attempt === 3) throw error;
          runState.conflictCopyStages?.clear();
          console.warn(`Copy-contract E2E retrying normal sync after recoverable CAS race (attempt ${attempt + 1}/3): ${message}`);
        }
      }
      throw lastError;
    },
  };
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

const targetEnvironment = readGitHubE2ETargetEnvironment();
const initialTarget = await resolveGitHubE2ETarget(targetEnvironment);
const github = initialTarget.config;
installRequestUrlBridge();

after(async () => {
  try { await resetGitHubE2EDisposableBranch(targetEnvironment); }
  finally { setRequestUrlHandler(null); }
});

test("real GitHub rename versus stale edit follows exact local-primary Copy contract", { timeout: 300_000 }, async () => {
  for (const mode of ["plaintext", "encrypted"] as const) {
    await resetGitHubE2EDisposableBranch(targetEnvironment);
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
