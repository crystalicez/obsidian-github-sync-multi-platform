import assert from "node:assert/strict";
import test, { after } from "node:test";
import { setRequestUrlHandler } from "obsidian";

import { GitHubClient, type GitHubConfig } from "../../src/lib/github-api";
import { randomBytes, toBase64, toBase64Url } from "../../src/lib/bytes";
import { deriveV4Keyring, type V4Keyring } from "../../src/lib/v4/crypto";
import { V4HistoryService } from "../../src/lib/v4/history-service";
import { createEmptyV4LocalIndex, type V4LocalIndex } from "../../src/lib/v4/local-index";
import { expectedV4PathLayout, V4_FORMAT_VERSION, type V4RemoteConfig, type V4StorageMode } from "../../src/lib/v4/protocol-types";
import { V4StorageCodec } from "../../src/lib/v4/storage-codec";
import { V4SyncSession, type V4SessionVault, type V4SyncRunState } from "../../src/lib/v4/sync-session";
import {
  encodeGitHubE2ERefPath,
  readGitHubE2ETargetEnvironment,
  resetGitHubE2EDisposableBranch,
  resolveGitHubE2ETarget,
} from "./support/target-safety";

const encoder = new TextEncoder();

type E2ESession = Pick<V4SyncSession, "sync">;

interface ModeContext {
  mode: V4StorageMode;
  remoteConfig: V4RemoteConfig;
  keyring?: V4Keyring;
}

interface DeviceContext {
  name: string;
  vault: MemoryVault;
  index: V4LocalIndex;
  client: GitHubClient;
  session: E2ESession;
  rawSession: V4SyncSession;
}

interface InterferenceState {
  armed: boolean;
  fired: boolean;
  marker?: string;
  externalCommitSha?: string;
}

const interference: InterferenceState = { armed: false, fired: false };

function branchPath(config: GitHubConfig): string {
  return encodeGitHubE2ERefPath(config.branch);
}

function bytes(text: string): Uint8Array {
  return encoder.encode(text);
}

function deterministicBinary(length: number, seed: number): Uint8Array {
  const output = new Uint8Array(length);
  let value = seed >>> 0;
  for (let index = 0; index < output.length; index++) {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    output[index] = value >>> 24;
  }
  return output;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
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

async function expectJson<T>(response: Response, successStatuses: readonly number[], action: string): Promise<T> {
  const text = await response.text();
  if (!successStatuses.includes(response.status)) throw new Error(`${action}: HTTP ${response.status} ${text}`);
  return (text ? JSON.parse(text) : {}) as T;
}

async function publishExternalCommit(config: GitHubConfig, marker: string): Promise<string> {
  const encodedBranch = branchPath(config);
  const ref = await expectJson<{ object?: { sha?: string } }>(
    await githubRequest(config, `/git/ref/heads/${encodedBranch}?_=${Date.now()}`),
    [200],
    "Cannot read branch before external E2E commit",
  );
  const headSha = ref.object?.sha;
  if (!headSha) throw new Error("External E2E branch ref is missing a commit SHA.");

  const commit = await expectJson<{ tree?: { sha?: string } }>(
    await githubRequest(config, `/git/commits/${headSha}`),
    [200],
    "Cannot read commit before external E2E commit",
  );
  const baseTree = commit.tree?.sha;
  if (!baseTree) throw new Error("External E2E base commit is missing its tree SHA.");

  const blob = await expectJson<{ sha?: string }>(
    await githubRequest(config, "/git/blobs", {
      method: "POST",
      body: JSON.stringify({ content: toBase64(bytes(`external-e2e:${marker}\n`)), encoding: "base64" }),
    }),
    [201],
    "Cannot create external E2E blob",
  );
  if (!blob.sha) throw new Error("External E2E blob response is missing SHA.");

  const tree = await expectJson<{ sha?: string }>(
    await githubRequest(config, "/git/trees", {
      method: "POST",
      body: JSON.stringify({
        base_tree: baseTree,
        tree: [{ path: `.e2e-external/${marker}.txt`, mode: "100644", type: "blob", sha: blob.sha }],
      }),
    }),
    [201],
    "Cannot create external E2E tree",
  );
  if (!tree.sha) throw new Error("External E2E tree response is missing SHA.");

  const externalCommit = await expectJson<{ sha?: string }>(
    await githubRequest(config, "/git/commits", {
      method: "POST",
      body: JSON.stringify({ message: `external-e2e:${marker}`, tree: tree.sha, parents: [headSha] }),
    }),
    [201],
    "Cannot create external E2E commit",
  );
  if (!externalCommit.sha) throw new Error("External E2E commit response is missing SHA.");

  await expectJson<unknown>(
    await githubRequest(config, `/git/refs/heads/${encodedBranch}`, {
      method: "PATCH",
      body: JSON.stringify({ sha: externalCommit.sha, force: false }),
    }),
    [200],
    "Cannot publish external E2E commit",
  );
  return externalCommit.sha;
}

function installRequestUrlBridge(config: GitHubConfig): void {
  const refSuffix = `/git/refs/heads/${branchPath(config)}`;
  setRequestUrlHandler(async raw => {
    const request = raw as { url: string; method?: string; headers?: Record<string, string>; body?: string };
    const method = (request.method ?? "GET").toUpperCase();
    if (interference.armed && !interference.fired && method === "PATCH" && request.url.includes(refSuffix)) {
      interference.fired = true;
      interference.externalCommitSha = await publishExternalCommit(config, interference.marker ?? "controlled-race");
    }

    const response = await fetchWithRetry(request.url, {
      method,
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

function resetInterference(): void {
  interference.armed = false;
  interference.fired = false;
  interference.marker = undefined;
  interference.externalCommitSha = undefined;
}

function armInterference(marker: string): void {
  resetInterference();
  interference.armed = true;
  interference.marker = marker;
}

async function waitForBranchHead(config: GitHubConfig, expectedSha: string, timeoutMs = 15_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    const response = await githubRequest(config, `/git/ref/heads/${branchPath(config)}?_=${Date.now()}`);
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

class MemoryVault implements V4SessionVault {
  readonly files = new Map<string, { bytes: Uint8Array; mtime: number }>();

  set(path: string, content: Uint8Array, mtime = Date.now()): void {
    this.files.set(path, { bytes: new Uint8Array(content), mtime });
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

  async write(path: string, content: Uint8Array, mtime?: number) {
    this.set(path, content, mtime);
  }

  async trash(path: string) {
    this.files.delete(path);
  }
}

function repoId(config: GitHubConfig): string {
  return `${config.owner}/${config.repo}#${config.branch}`;
}

async function createModeContext(mode: V4StorageMode, config: GitHubConfig): Promise<ModeContext> {
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
  const keyring = mode === "encrypted"
    ? await deriveV4Keyring({ passphrase: "v4-real-github-e2e", repoId: remoteConfig.repoId, salt, iterations: 10_000 })
    : undefined;
  return { mode, remoteConfig, keyring };
}

function createDevice(name: string, config: GitHubConfig, context: ModeContext, now?: () => number): DeviceContext {
  const vault = new MemoryVault();
  const index = createEmptyV4LocalIndex({
    repoId: context.remoteConfig.repoId,
    deviceId: name,
    mode: context.mode,
    pathLayout: expectedV4PathLayout(context.mode),
  });
  const client = new GitHubClient(config);
  const sessionInput = {
    github: client,
    vault,
    index,
    config: context.remoteConfig,
    keyring: context.keyring,
    conflictPolicy: "copy" as const,
    abortChangePercent: 0,
    now,
  };
  const rawSession = new V4SyncSession(sessionInput);
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
          console.warn(`GitHub E2E retrying normal sync after recoverable CAS race (attempt ${attempt + 1}/3): ${message}`);
        }
      }
      throw lastError;
    },
  };
  return { name, vault, index, client, session, rawSession };
}

function liveRecords(device: DeviceContext) {
  return Object.values(device.index.shards).flatMap(shard => Object.values(shard.records)).filter(record => !record.deleted);
}

function recordFor(device: DeviceContext, path: string) {
  const record = liveRecords(device).find(candidate => candidate.path === path);
  if (!record) throw new Error(`${device.name} is missing V4 record for ${path}`);
  return record;
}

function assertVaultEquals(actual: MemoryVault, expected: MemoryVault, label: string): void {
  const actualPaths = [...actual.files.keys()].sort();
  const expectedPaths = [...expected.files.keys()].sort();
  assert.deepEqual(actualPaths, expectedPaths, `${label}: path set differs`);
  for (const path of expectedPaths) {
    const actualFile = actual.files.get(path);
    const expectedFile = expected.files.get(path)!;
    assert.ok(actualFile, `${label}: missing ${path}`);
    assert.deepEqual(actualFile.bytes, expectedFile.bytes, `${label}: bytes differ at ${path}`);
  }
}

function assertVaultContainsBytes(vault: MemoryVault, expected: Uint8Array, label: string): void {
  assert.equal([...vault.files.values()].some(file => sameBytes(file.bytes, expected)), true, label);
}

function assertNoConflictCopies(vault: MemoryVault, label: string): void {
  assert.equal([...vault.files.keys()].some(path => path.includes(".conflict-remote-")), false, label);
}

async function verifyEncryptedObjectTransport(device: DeviceContext, context: ModeContext, path?: string): Promise<void> {
  if (context.mode !== "encrypted") return;
  const commitSha = device.index.remoteCommitSha;
  assert.ok(commitSha, `${device.name}: missing remote commit SHA`);
  const commit = await device.client.getGitCommit(commitSha);
  const tree = await device.client.getTreeAt(commit.treeSha, true);
  const records = path ? [recordFor(device, path)] : liveRecords(device);
  const codec = new V4StorageCodec({ mode: context.mode, pathLayout: expectedV4PathLayout(context.mode), keyring: context.keyring });

  for (const record of records) {
    const node = tree.tree.find(item => item.path === record.remotePath);
    assert.ok(node, `${device.name}: missing remote object ${record.remotePath}`);
    const [byPath, byBlob] = await Promise.all([
      device.client.getFileBytes(record.remotePath, commitSha),
      device.client.getBlob(node.sha),
    ]);
    assert.ok(byPath, `${device.name}: Contents read missing ${record.remotePath}`);
    assert.deepEqual(byPath.bytes, byBlob, `${device.name}: Contents/Git Blob mismatch for ${record.remotePath}`);

    const decoded = await codec.read(record, async remotePath => {
      const remoteNode = tree.tree.find(item => item.path === remotePath);
      if (!remoteNode) throw new Error(`${device.name}: missing encrypted storage object ${remotePath}`);
      return device.client.getBlob(remoteNode.sha);
    });
    const local = device.vault.files.get(record.path);
    assert.ok(local, `${device.name}: missing local bytes for ${record.path}`);
    assert.deepEqual(decoded, local.bytes, `${device.name}: encrypted authentication mismatch for ${record.path}`);
  }
}

function scenarioMetrics(scenario: string, mode: V4StorageMode, started: number, devices: DeviceContext[]): void {
  console.log(JSON.stringify({
    scenario,
    mode,
    elapsedMs: Number((performance.now() - started).toFixed(1)),
    devices: Object.fromEntries(devices.map(device => [device.name, device.client.transportMetricsSnapshot])),
  }));
}

async function runScenario(
  config: GitHubConfig,
  mode: V4StorageMode,
  scenario: string,
  body: (input: {
    context: ModeContext;
    device: (name: string, now?: () => number) => DeviceContext;
  }) => Promise<void>,
): Promise<void> {
  await resetGitHubE2EDisposableBranch(targetEnvironment);
  const context = await createModeContext(mode, config);
  const devices: DeviceContext[] = [];
  const started = performance.now();

  try {
    await body({
      context,
      device: (name, now) => {
        const created = createDevice(name, config, context, now);
        devices.push(created);
        return created;
      },
    });
  } catch (error) {
    throw new Error(`GitHub E2E scenario failed: ${scenario} (${mode})`, { cause: error });
  } finally {
    scenarioMetrics(scenario, mode, started, devices);
    resetInterference();
  }
}

function seedBaseline(vault: MemoryVault, mode: V4StorageMode): void {
  vault.set("Notes/hello.md", bytes(`hello from ${mode}`), 1);
  vault.set("Assets/pixel.bin", new Uint8Array([0, 1, 2, 255]), 2);
  vault.set("Notes/สวัสดี 🌏/mañana.md", bytes("สวัสดี\nmañana\n🌏\n"), 3);
  vault.set("Projects/2026 Q3/[draft] #1.md", bytes("# draft\nspaces + punctuation\n"), 4);
  vault.set(".workspace/user-state.json", bytes('{"open":true,"pane":"left"}\n'), 5);
  vault.set("Empty/zero-byte.bin", new Uint8Array(), 6);
  vault.set("Assets/medium-1m.bin", deterministicBinary(1024 * 1024, 0x51a7), 7);
}

async function runBaselineScenario(config: GitHubConfig, mode: V4StorageMode): Promise<void> {
  await runScenario(config, mode, "baseline-edge-path-roundtrip", async ({ context, device }) => {
    const source = device("device-a");
    seedBaseline(source.vault, mode);
    const pushed = await source.session.sync({ operation: "forcePush", allowThresholdOverride: false });
    assert.equal(pushed.mode, "force-push");
    await waitForBranchHead(config, source.index.remoteCommitSha!);

    if (mode === "encrypted") {
      const beforeRename = recordFor(source, "Notes/hello.md");
      const renamed = source.vault.files.get("Notes/hello.md")!;
      source.vault.files.delete("Notes/hello.md");
      source.vault.set("Notes/hello-renamed.md", renamed.bytes, 8);
      await source.session.sync({
        operation: "normal",
        allowThresholdOverride: false,
        changes: [{ type: "rename", oldPath: "Notes/hello.md", path: "Notes/hello-renamed.md", mtime: 8 }],
      });
      const afterRename = recordFor(source, "Notes/hello-renamed.md");
      assert.equal(afterRename.fileId, beforeRename.fileId);
      assert.equal(afterRename.remotePath, beforeRename.remotePath);
    }

    assert.equal((await source.session.sync({ operation: "normal", allowThresholdOverride: false })).mode, "noop");
    const publishedCommitSha = source.index.remoteCommitSha!;
    const history = new V4HistoryService({ github: source.client, config: context.remoteConfig, keyring: context.keyring });
    const historyPage = await history.listCommits();
    const publishedHistoryCommit = historyPage.items.find(item => item.sha === publishedCommitSha && item.source === "plugin");
    assert.ok(publishedHistoryCommit?.journalId);
    const historyChanges = await history.getCommitChanges(publishedHistoryCommit);
    assert.equal(historyChanges.some(change => change.path === (mode === "encrypted" ? "Notes/hello-renamed.md" : "Notes/hello.md")), true);

    const commit = await source.client.getGitCommit(publishedCommitSha);
    const tree = await source.client.getTreeAt(commit.treeSha, true);
    if (mode === "plaintext") {
      for (const path of source.vault.files.keys()) {
        assert.equal(tree.tree.some(node => node.path === path), true, `plaintext tree missing ${path}`);
      }
    } else {
      const logicalPaths = new Set(source.vault.files.keys());
      assert.equal(tree.tree.some(node => logicalPaths.has(node.path)), false, "encrypted tree leaked a logical path");
      assert.equal(tree.tree.some(node => /^\.obsidian-github-sync-v4\/data\/[0-9a-f]{2}\/[0-9a-f]{64}\.enc$/u.test(node.path)), true);
      for (const segment of ["Notes", "Assets", "hello", "pixel", "mañana", "draft", "workspace", "md", "bin"]) {
        assert.equal(tree.tree.some(node => node.path.includes(segment)), false, `encrypted tree leaked logical segment: ${segment}`);
      }

      const headPath = ".obsidian-github-sync-v4/head";
      const headNode = tree.tree.find(node => node.path === headPath);
      assert.ok(headNode, "Encrypted V4 head is missing from the published commit tree.");
      const [headByPath, headByBlob] = await Promise.all([
        source.client.getFileBytes(headPath, publishedCommitSha),
        source.client.getBlob(headNode.sha),
      ]);
      assert.ok(headByPath, "Encrypted V4 head is missing from the Contents API.");
      assert.deepEqual(headByPath.bytes, headByBlob, "Encrypted V4 head Contents/Git Blob mismatch.");
      assert.deepEqual([...headByBlob.subarray(0, 4)], [0x4f, 0x47, 0x53, 0x34]);
      await verifyEncryptedObjectTransport(source, context);
    }

    const target = device("device-c");
    target.vault.set("remove-me.md", bytes("old"), 1);
    const pulled = await target.session.sync({ operation: "forcePull", allowThresholdOverride: false });
    assert.equal(pulled.mode, "force-pull");
    assertVaultEquals(target.vault, source.vault, `${mode} baseline force pull`);

    if (mode === "encrypted") {
      for (const sourceRecord of liveRecords(source)) {
        const targetRecord = recordFor(target, sourceRecord.path);
        assert.equal(targetRecord.fileId, sourceRecord.fileId);
        assert.equal(targetRecord.remotePath, sourceRecord.remotePath);
      }
    }
  });
}

async function runStaleCatchupScenario(config: GitHubConfig, mode: V4StorageMode): Promise<void> {
  await runScenario(config, mode, "two-device-stale-catchup-and-disjoint-push", async ({ device }) => {
    const a = device("device-a");
    a.vault.set("shared.md", bytes("shared-base\n"), 1);
    a.vault.set("A-only.md", bytes("a-v1\n"), 2);
    a.vault.set("Assets/shared.bin", deterministicBinary(4096, 11), 3);
    await a.session.sync({ operation: "forcePush", allowThresholdOverride: false });

    const b = device("device-b");
    await b.session.sync({ operation: "forcePull", allowThresholdOverride: false });
    b.vault.set("B-local.md", bytes("created on stale device b\n"), 10);

    a.vault.set("A-only.md", bytes("a-v2\n"), 11);
    a.vault.set("nested/new-from-a.md", bytes("new from a\n"), 12);
    await a.session.sync({
      operation: "normal",
      allowThresholdOverride: false,
      changes: [
        { type: "modify", path: "A-only.md", mtime: 11 },
        { type: "modify", path: "nested/new-from-a.md", mtime: 12 },
      ],
    });

    const caughtUp = await b.session.sync({
      operation: "normal",
      allowThresholdOverride: false,
      changes: [{ type: "modify", path: "B-local.md", mtime: 10 }],
    });
    assert.equal(["pull-push", "push"].includes(caughtUp.mode), true);
    assert.deepEqual(b.vault.files.get("A-only.md")?.bytes, bytes("a-v2\n"));
    assert.deepEqual(b.vault.files.get("nested/new-from-a.md")?.bytes, bytes("new from a\n"));
    assert.deepEqual(b.vault.files.get("B-local.md")?.bytes, bytes("created on stale device b\n"));
    assertNoConflictCopies(b.vault, "disjoint stale catch-up created a conflict copy");

    const c = device("device-c");
    await c.session.sync({ operation: "forcePull", allowThresholdOverride: false });
    assertVaultEquals(c.vault, b.vault, "fresh device after disjoint stale catch-up");
  });
}

async function runCopyConflictScenario(config: GitHubConfig, mode: V4StorageMode): Promise<void> {
  await runScenario(config, mode, "two-device-same-file-copy-conflict", async ({ context, device }) => {
    const a = device("device-a");
    a.vault.set("shared.md", bytes("base\n"), 1);
    await a.session.sync({ operation: "forcePush", allowThresholdOverride: false });

    const fixedNow = 424242;
    const b = device("device-b", () => fixedNow);
    await b.session.sync({ operation: "forcePull", allowThresholdOverride: false });

    a.vault.set("shared.md", bytes("from-a\n"), 2);
    await a.session.sync({
      operation: "normal",
      allowThresholdOverride: false,
      changes: [{ type: "modify", path: "shared.md", mtime: 2 }],
    });

    b.vault.set("shared.md", bytes("from-b\n"), 3);
    await b.session.sync({
      operation: "normal",
      allowThresholdOverride: false,
      changes: [{ type: "modify", path: "shared.md", mtime: 3 }],
    });

    const conflictPath = `shared.conflict-remote-device-b-${fixedNow}.md`;
    assert.deepEqual(b.vault.files.get("shared.md")?.bytes, bytes("from-b\n"));
    assert.deepEqual(b.vault.files.get(conflictPath)?.bytes, bytes("from-a\n"));
    assert.equal([...b.vault.files.keys()].filter(path => path.includes(".conflict-remote-")).length, 1);

    const c = device("device-c");
    await c.session.sync({ operation: "forcePull", allowThresholdOverride: false });
    assert.deepEqual(c.vault.files.get("shared.md")?.bytes, bytes("from-b\n"));
    assert.deepEqual(c.vault.files.get(conflictPath)?.bytes, bytes("from-a\n"));
    await verifyEncryptedObjectTransport(c, context);
  });
}

async function runRenameVsEditScenario(config: GitHubConfig, mode: V4StorageMode): Promise<void> {
  await runScenario(config, mode, "two-device-rename-vs-stale-edit", async ({ device }) => {
    const a = device("device-a");
    const base = bytes("rename-base\n");
    const staleEdit = bytes("edited-on-stale-device-b\n");
    a.vault.set("Notes/rename-me.md", base, 1);
    await a.session.sync({ operation: "forcePush", allowThresholdOverride: false });

    const b = device("device-b", () => 515151);
    await b.session.sync({ operation: "forcePull", allowThresholdOverride: false });
    const oldRecord = recordFor(a, "Notes/rename-me.md");

    a.vault.files.delete("Notes/rename-me.md");
    a.vault.set("Notes/renamed.md", base, 2);
    await a.session.sync({
      operation: "normal",
      allowThresholdOverride: false,
      changes: [{ type: "rename", oldPath: "Notes/rename-me.md", path: "Notes/renamed.md", mtime: 2 }],
    });
    const renamedRecord = recordFor(a, "Notes/renamed.md");
    assert.equal(renamedRecord.fileId, oldRecord.fileId);
    if (mode === "encrypted") assert.equal(renamedRecord.remotePath, oldRecord.remotePath);

    b.vault.set("Notes/rename-me.md", staleEdit, 3);
    await b.session.sync({
      operation: "normal",
      allowThresholdOverride: false,
      changes: [{ type: "modify", path: "Notes/rename-me.md", mtime: 3 }],
    });

    const c = device("device-c");
    await c.session.sync({ operation: "forcePull", allowThresholdOverride: false });
    assertVaultContainsBytes(c.vault, base, "rename lineage bytes were lost");
    assertVaultContainsBytes(c.vault, staleEdit, "stale edited lineage bytes were lost");
    for (const record of liveRecords(c)) {
      assert.ok(c.vault.files.has(record.path), `fresh pull missing record path ${record.path}`);
    }
  });
}

async function runDeleteRecreateScenario(config: GitHubConfig, mode: V4StorageMode): Promise<void> {
  await runScenario(config, mode, "two-device-delete-recreate-identity-break", async ({ device }) => {
    const a = device("device-a");
    a.vault.set("Notes/reborn.md", bytes("generation-one\n"), 1);
    await a.session.sync({ operation: "forcePush", allowThresholdOverride: false });

    const b = device("device-b");
    await b.session.sync({ operation: "forcePull", allowThresholdOverride: false });
    const oldFileId = recordFor(a, "Notes/reborn.md").fileId;

    a.vault.files.delete("Notes/reborn.md");
    await a.session.sync({
      operation: "normal",
      allowThresholdOverride: false,
      changes: [{ type: "delete", path: "Notes/reborn.md", mtime: 2 }],
    });

    a.vault.set("Notes/reborn.md", bytes("generation-two\n"), 3);
    await a.session.sync({
      operation: "normal",
      allowThresholdOverride: false,
      changes: [{ type: "modify", path: "Notes/reborn.md", mtime: 3 }],
    });
    const newRecord = recordFor(a, "Notes/reborn.md");
    assert.notEqual(newRecord.fileId, oldFileId, "delete/recreate reused the old file identity");

    await b.session.sync({ operation: "normal", allowThresholdOverride: false });
    assert.deepEqual(b.vault.files.get("Notes/reborn.md")?.bytes, bytes("generation-two\n"));
    assert.equal(recordFor(b, "Notes/reborn.md").fileId, newRecord.fileId);
  });
}

async function runBinaryOverwriteScenario(config: GitHubConfig, mode: V4StorageMode): Promise<void> {
  await runScenario(config, mode, "two-device-binary-overwrite", async ({ context, device }) => {
    const revisionOne = deterministicBinary(256 * 1024, 0x1010);
    const revisionTwo = deterministicBinary(256 * 1024, 0x2020);
    const a = device("device-a");
    a.vault.set("Assets/shared.bin", revisionOne, 1);
    await a.session.sync({ operation: "forcePush", allowThresholdOverride: false });

    const b = device("device-b");
    await b.session.sync({ operation: "forcePull", allowThresholdOverride: false });
    b.vault.set("Assets/shared.bin", revisionTwo, 2);
    await b.session.sync({
      operation: "normal",
      allowThresholdOverride: false,
      changes: [{ type: "modify", path: "Assets/shared.bin", mtime: 2 }],
    });

    await a.session.sync({ operation: "normal", allowThresholdOverride: false });
    assert.deepEqual(a.vault.files.get("Assets/shared.bin")?.bytes, revisionTwo);
    await verifyEncryptedObjectTransport(a, context, "Assets/shared.bin");
  });
}

async function runControlledRaceScenario(config: GitHubConfig): Promise<void> {
  await runScenario(config, "plaintext", "controlled-external-branch-head-race", async ({ device }) => {
    const a = device("device-a");
    a.vault.set("race.md", bytes("base\n"), 1);
    await a.session.sync({ operation: "forcePush", allowThresholdOverride: false });

    a.vault.set("race.md", bytes("plugin-after-race\n"), 2);
    armInterference("controlled-race");
    let publishError: unknown;
    try {
      await a.rawSession.sync({
        operation: "normal",
        allowThresholdOverride: false,
        changes: [{ type: "modify", path: "race.md", mtime: 2 }],
      });
    } catch (error) {
      publishError = error;
    }
    interference.armed = false;

    assert.equal(interference.fired, true, "controlled branch-head interference hook did not fire");
    const externalCommitSha = interference.externalCommitSha;
    assert.ok(externalCommitSha, "controlled branch-head interference did not create an external commit");
    assert.ok(publishError, "plugin publish unexpectedly succeeded over an externally advanced branch");
    const publishMessage = publishError instanceof Error ? publishError.message : String(publishError);
    assert.match(publishMessage, /(branch head changed|Failed to update git ref: HTTP (409|422))/i);

    const afterRaceHistory = await a.client.listCommits({ perPage: 100 });
    assert.equal(afterRaceHistory.some(commit => commit.sha === externalCommitSha), true, "external commit is not reachable after rejected plugin publish");

    const rerun = await a.session.sync({
      operation: "normal",
      allowThresholdOverride: false,
      changes: [{ type: "modify", path: "race.md", mtime: 2 }],
    });
    assert.equal(["push", "pull-push", "noop"].includes(rerun.mode), true);
    assert.deepEqual(a.vault.files.get("race.md")?.bytes, bytes("plugin-after-race\n"));

    const finalHistory = await a.client.listCommits({ perPage: 100 });
    assert.equal(finalHistory.some(commit => commit.sha === externalCommitSha), true, "external commit disappeared after replan");

    const c = device("device-c");
    await c.session.sync({ operation: "forcePull", allowThresholdOverride: false });
    assert.deepEqual(c.vault.files.get("race.md")?.bytes, bytes("plugin-after-race\n"));
  });
}

const targetEnvironment = readGitHubE2ETargetEnvironment();
const initialTarget = await resolveGitHubE2ETarget(targetEnvironment);
const config = initialTarget.config;
installRequestUrlBridge(config);

after(async () => {
  try {
    await resetGitHubE2EDisposableBranch(targetEnvironment);
    console.log(`GitHub E2E branch cleanup verified: ${config.branch}`);
  } finally {
    setRequestUrlHandler(null);
  }
});

test("V4 real GitHub REST survives realistic superuser and two-device scenarios", { timeout: 900_000 }, async () => {
  for (const mode of ["plaintext", "encrypted"] as const) {
    await runBaselineScenario(config, mode);
    await runStaleCatchupScenario(config, mode);
    await runCopyConflictScenario(config, mode);
    await runRenameVsEditScenario(config, mode);
    await runDeleteRecreateScenario(config, mode);
    await runBinaryOverwriteScenario(config, mode);
  }
  await runControlledRaceScenario(config);
});
