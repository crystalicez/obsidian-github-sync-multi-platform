import assert from "node:assert/strict";
import test, { after } from "node:test";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { modalButtons, Notice, resetModalTestState, setRequestUrlHandler, TFile } from "obsidian";
import { encryptedDelete, encryptedForcePull, encryptedForcePush, encryptedFullSync, encryptedModify, encryptedRename } from "../../src/lib/encrypted/sync-engine";
import { EncryptedManifestStore } from "../../src/lib/encrypted/manifest-store";
import { EncryptedSnapshotStore } from "../../src/lib/encrypted/snapshot-store";
import type { EncryptedSnapshotManifest } from "../../src/lib/encrypted/snapshot-types";
import { GitHubClient, GitHubConfig } from "../../src/lib/github-api";
import { ENCRYPTED_CONFIG_PATH, ENCRYPTED_FORMAT_VERSION, ENCRYPTED_INDEX_MODE } from "../../src/lib/encrypted/constants";
import { chooseRandomAction, chooseRandomSyncMode, formatTimingRecord, readRandomActionConfig, readRandomActionLimits, requiredChangedFileCounts, type RandomActionKind, type RandomSyncMode, type TimingRecord, type TimingRecordDetails } from "./random-actions";

const benchRecords: TimingRecord[] = [];
const profile = process.env.GITHUB_E2E_PROFILE ?? "quick";
const isRandomProfile = profile === "random";
const runBenchmarks = process.env.GITHUB_E2E_RUN_BENCHMARKS === "1" || profile === "full" || profile === "stress";
const baseTest = isRandomProfile && process.env.GITHUB_E2E_RANDOM_INCLUDE_BASE !== "1" ? test.skip : test;
const benchmarkTest = !isRandomProfile && runBenchmarks ? test : test.skip;
const regressionTest = profile === "quick" || isRandomProfile ? test.skip : test;
const randomTest = process.env.GITHUB_E2E_RUN_RANDOM === "1" || isRandomProfile || profile === "stress" ? test : test.skip;
const forbiddenBranches = new Set(["main", "master", "production", "prod", "release", "stable"]);
const passphrase = "github real e2e passphrase";

async function waitForModalButton(text: string, timeoutMs = 5000): Promise<{ text: string; click: () => void }> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const button = modalButtons.find(item => item.text === text);
    if (button) return button;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for modal button: ${text}`);
}

async function withTimeout<T>(label: string, timeoutMs: number, run: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
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

function shouldRetryStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 429 || status >= 500;
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithRetry(url: string, init: RequestInit, attempts = 3): Promise<Response> {
  let lastResponse: Response | undefined;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const response = await fetch(url, init);
    if (!shouldRetryStatus(response.status) || attempt === attempts) return response;
    lastResponse = response;
    await response.arrayBuffer().catch(() => undefined);
    await sleep(500 * attempt);
  }
  return lastResponse as Response;
}

function installRequestUrlBridge(): void {
  setRequestUrlHandler(async rawOptions => {
    const options = rawOptions as { url: string; method?: string; headers?: Record<string, string>; body?: string };
    const response = await fetchWithRetry(options.url, {
      method: options.method ?? "GET",
      headers: options.headers,
      body: options.body,
    });
    const arrayBuffer = await response.arrayBuffer();
    const text = new TextDecoder().decode(arrayBuffer);
    let json: unknown = undefined;
    if (text) {
      try { json = JSON.parse(text); } catch { json = undefined; }
    }
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      text,
      json,
      arrayBuffer,
    };
  });
}

class GitHubApiError extends Error {
  status: number;

  constructor(apiPath: string, status: number, text: string) {
    super(`GitHub API ${apiPath} failed: HTTP ${status} ${text}`);
    this.status = status;
  }
}

async function githubFetch(config: GitHubConfig, apiPath: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetchWithRetry(`https://api.github.com/repos/${config.owner}/${config.repo}${apiPath}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.token}`,
      Accept: "application/vnd.github.v3+json",
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try { parsed = JSON.parse(text) as unknown; } catch { parsed = text; }
  }
  if (!response.ok) throw new GitHubApiError(apiPath, response.status, text);
  return parsed;
}

async function getBranchHead(config: GitHubConfig): Promise<string> {
  const ref = await githubFetch(config, `/git/ref/heads/${encodeURIComponent(config.branch)}`) as { object: { sha: string } };
  return ref.object.sha;
}

async function forceBranchToCommit(config: GitHubConfig, sha: string): Promise<void> {
  await githubFetch(config, `/git/refs/heads/${encodeURIComponent(config.branch)}`, {
    method: "PATCH",
    body: JSON.stringify({ sha, force: true }),
  });
}

async function createCommit(config: GitHubConfig, message: string, treeSha: string, parents: string[]): Promise<string> {
  const commit = await githubFetch(config, "/git/commits", {
    method: "POST",
    body: JSON.stringify({ message, tree: treeSha, parents }),
  }) as { sha: string };
  return commit.sha;
}

async function createCommitWithFiles(config: GitHubConfig, message: string, files: Record<string, string>, parents: string[]): Promise<string> {
  const tree = await githubFetch(config, "/git/trees", {
    method: "POST",
    body: JSON.stringify({
      tree: Object.entries(files).map(([filePath, content]) => ({ path: filePath, mode: "100644", type: "blob", content })),
    }),
  }) as { sha: string };
  return createCommit(config, message, tree.sha, parents);
}

function encryptedEmptyConfig(): string {
  return JSON.stringify({
    formatVersion: ENCRYPTED_FORMAT_VERSION,
    indexMode: ENCRYPTED_INDEX_MODE,
    algorithm: "AES-GCM",
    kdf: "PBKDF2-SHA-256",
    kdfParams: { iterations: 600000, salt: "AAAAAAAAAAAAAAAAAAAAAA" },
    createdAt: 0,
    updatedAt: 0,
  }, null, 2);
}
async function createBranchFromCommit(config: GitHubConfig, sha: string): Promise<void> {
  await githubFetch(config, "/git/refs", {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${config.branch}`, sha }),
  });
}

async function bootstrapEmptyRepository(config: GitHubConfig): Promise<void> {
  const repo = await githubFetch(config, "") as { default_branch: string };
  const bootstrapContent = Buffer.from("bootstrap empty repository for destructive GitHub E2E tests\n", "utf8").toString("base64");
  await githubFetch(config, "/contents/.github-e2e-bootstrap", {
    method: "PUT",
    body: JSON.stringify({
      message: "test: bootstrap empty repository for github e2e",
      content: bootstrapContent,
    }),
  });

  const defaultRef = await githubFetch(config, `/git/ref/heads/${encodeURIComponent(repo.default_branch)}`) as { object: { sha: string } };
  await createBranchFromCommit(config, defaultRef.object.sha);
}

async function ensureTestBranch(config: GitHubConfig): Promise<void> {
  const refPath = `/git/ref/heads/${encodeURIComponent(config.branch)}`;
  try {
    await githubFetch(config, refPath);
    return;
  } catch (error) {
    if (!(error instanceof GitHubApiError) || (error.status !== 404 && error.status !== 409)) throw error;
    if (error.status === 409) {
      await bootstrapEmptyRepository(config);
      return;
    }
  }

  const repo = await githubFetch(config, "") as { default_branch: string };
  try {
    const defaultRef = await githubFetch(config, `/git/ref/heads/${encodeURIComponent(repo.default_branch)}`) as { object: { sha: string } };
    await createBranchFromCommit(config, defaultRef.object.sha);
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 409) {
      await bootstrapEmptyRepository(config);
      return;
    }
    throw error;
  }
}

async function resetTestBranch(config: GitHubConfig): Promise<GitHubClient> {
  console.log("[github-e2e] reset test branch");
  await ensureTestBranch(config);
  const parentSha = await getBranchHead(config);
  const resetSha = await createCommitWithFiles(config, "test: reset github e2e encrypted branch", { [ENCRYPTED_CONFIG_PATH]: encryptedEmptyConfig() }, [parentSha]);
  await forceBranchToCommit(config, resetSha);
  return new GitHubClient(config);
}

async function resetForeignBranch(config: GitHubConfig): Promise<GitHubClient> {
  console.log("[github-e2e] reset test branch to foreign state");
  await ensureTestBranch(config);
  const parentSha = await getBranchHead(config);
  const resetSha = await createCommitWithFiles(config, "test: reset github e2e foreign branch", { "README.md": "foreign remote" }, [parentSha]);
  await forceBranchToCommit(config, resetSha);
  return new GitHubClient(config);
}

class RealE2EVault {
  files = new Map<string, Uint8Array>();
  mtimes = new Map<string, number>();
  folders = new Set<string>();

  constructor(entries: Record<string, string | Uint8Array> = {}) {
    for (const [path, value] of Object.entries(entries)) {
      this.set(path, typeof value === "string" ? new TextEncoder().encode(value) : value);
    }
  }

  set(filePath: string, bytes: Uint8Array): void {
    this.files.set(filePath, bytes);
    this.mtimes.set(filePath, Date.now());
    const parts = filePath.split("/");
    for (let index = 1; index < parts.length; index++) this.folders.add(parts.slice(0, index).join("/"));
  }

  getText(filePath: string): string {
    const bytes = this.files.get(filePath);
    assert.ok(bytes, `Missing local file: ${filePath}`);
    return new TextDecoder().decode(bytes);
  }

  getFiles(): TFile[] {
    return [...this.files.entries()].map(([filePath, bytes]) => {
      const file = new TFile(filePath, bytes);
      file.stat.mtime = this.mtimes.get(filePath) ?? Date.now();
      return file;
    });
  }

  getAbstractFileByPath(filePath: string): TFile | { path: string } | null {
    const bytes = this.files.get(filePath);
    if (bytes) {
      const file = new TFile(filePath, bytes);
      file.stat.mtime = this.mtimes.get(filePath) ?? Date.now();
      return file;
    }
    if (this.folders.has(filePath)) return { path: filePath };
    return null;
  }

  async readBinary(file: TFile): Promise<ArrayBuffer> {
    const bytes = this.files.get(file.path) ?? new Uint8Array();
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }

  async read(file: TFile): Promise<string> {
    return new TextDecoder().decode(this.files.get(file.path) ?? new Uint8Array());
  }

  async createFolder(folderPath: string): Promise<void> { this.folders.add(folderPath); }
  async create(filePath: string, content: string): Promise<void> { this.set(filePath, new TextEncoder().encode(content)); }
  async modify(file: TFile, content: string): Promise<void> { this.set(file.path, new TextEncoder().encode(content)); }
  async createBinary(filePath: string, buffer: ArrayBuffer): Promise<void> { this.set(filePath, new Uint8Array(buffer)); }
  async modifyBinary(file: TFile, buffer: ArrayBuffer): Promise<void> { this.set(file.path, new Uint8Array(buffer)); }
  async delete(file: TFile): Promise<void> { this.files.delete(file.path); }
}

function plugin(vault: RealE2EVault, githubClient: GitHubClient) {
  return {
    app: { vault },
    githubClient,
    settings: {
      encryptionMode: "encrypted",
      syncEnabled: true,
      syncOnLocalChange: true,
      encryptionPassphrase: passphrase,
      ignorePathRegex: "",
      conflictPolicy: "copy",
    },
    syncData: { files: {}, encrypted: { files: {} } },
    isSyncInProgress: false,
    isWatchEnabled: true,
    debounceTimers: new Map<string, ReturnType<typeof setTimeout>>(),
    ignoredFiles: new Set<string>(),
    disableWatch() { this.isWatchEnabled = false; },
    enableWatch() { this.isWatchEnabled = true; },
    addIgnoredFile(_path: string) {},
    removeIgnoredFile(_path: string) {},
    async saveSyncData() {},
    async saveSettings() {},
    updateStats() { return Promise.resolve(); },
  };
}

function inferOperation(name: string): string | undefined {
  if (/forcePush/iu.test(name)) return "forcePush";
  if (/forcePull|verify/iu.test(name)) return "forcePull";
  if (/localModify|localDelete|localRename/iu.test(name)) return "push";
  if (/sync|random\.step/iu.test(name)) return "push";
  return undefined;
}

function phaseName(operation: string | undefined, boundary: "before" | "after"): string {
  return operation ? `${boundary}-${operation.replace(/[A-Z]/gu, match => `-${match.toLowerCase()}`).replace(/^-/, "")}` : boundary;
}

async function measure<T>(name: string, run: () => Promise<T>, details: TimingRecordDetails = {}): Promise<T> {
  const operation = details.operation ?? inferOperation(name);
  const beforePhase = phaseName(operation, "before");
  console.log(`[github-e2e] ${beforePhase} ${name} files=${details.files ?? "?"} changed=${details.changedFiles ?? "?"} bytes=${details.bytes ?? "?"}`);
  Notice.messages.length = 0;
  const started = performance.now();
  try {
    const result = await withTimeout(name, Number(process.env.GITHUB_E2E_STEP_TIMEOUT_MS ?? "120000"), run);
    const syncFailure = Notice.messages.find(message => /Encrypted .* failed/i.test(message));
    if (syncFailure) throw new Error(syncFailure);
    const elapsedMs = Math.round((performance.now() - started) * 100) / 100;
    const record = formatTimingRecord(name, elapsedMs, { ...details, operation, phase: details.phase ?? phaseName(operation, "after") });
    benchRecords.push(record);
    console.log(`[github-e2e] ${record.phase} ${name}: ${record.elapsedMs}ms files=${record.files ?? "?"} changed=${record.changedFiles ?? "?"} ms/file=${record.msPerFile ?? "?"} ms/changed=${record.msPerChangedFile ?? "?"}`);
    if (name.startsWith("random.")) await appendRandomDebug({ phase: "timing", timing: record });
    return result;
  } catch (error) {
    console.error(`[github-e2e] failed ${name}: ${(error as Error).message}`);
    throw error;
  }
}
async function waitForRemoteTree(config: GitHubConfig, predicate: (paths: string[]) => boolean, label: string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 30000) {
    const tree = await new GitHubClient(config).getTree().catch(() => null);
    const paths = tree?.tree.filter(node => node.type === "blob").map(node => node.path) ?? [];
    if (predicate(paths)) return;
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for remote tree: ${label}`);
}
async function loadRemoteSnapshot(config: GitHubConfig): Promise<EncryptedSnapshotManifest> {
  const client = new GitHubClient(config);
  const loaded = await new EncryptedManifestStore(client, passphrase, true).loadOrCreateKey();
  const snapshotStore = new EncryptedSnapshotStore(client, loaded.key);
  const head = await snapshotStore.loadHead();
  if (!head) throw new Error("remote v2 snapshot head is missing");
  const snapshot = await snapshotStore.loadSnapshot(head.head.snapshotId);
  if (!snapshot) throw new Error("remote v2 snapshot is missing");
  return snapshot;
}

async function waitForRemoteSnapshot(config: GitHubConfig, predicate: (snapshot: EncryptedSnapshotManifest) => boolean, label: string): Promise<void> {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < 30000) {
    try {
      const snapshot = await loadRemoteSnapshot(config);
      if (predicate(snapshot)) return;
    } catch (error) {
      lastError = error;
    }
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for remote snapshot: ${label}${lastError instanceof Error ? ` (${lastError.message})` : ""}`);
}
async function loadRemoteV3Vault(config: GitHubConfig): Promise<RealE2EVault> {
  const vault = new RealE2EVault();
  Notice.messages.length = 0;
  await encryptedForcePull(plugin(vault, new GitHubClient(config)) as never);
  const syncFailure = Notice.messages.find(message => /Encrypted .* failed/i.test(message));
  if (syncFailure) throw new Error(syncFailure);
  return vault;
}

async function waitForRemoteV3Vault(config: GitHubConfig, predicate: (vault: RealE2EVault) => boolean, label: string): Promise<RealE2EVault> {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < 30000) {
    try {
      const vault = await loadRemoteV3Vault(config);
      if (predicate(vault)) return vault;
    } catch (error) {
      lastError = error;
    }
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for remote v3 vault: ${label}${lastError instanceof Error ? ` (${lastError.message})` : ""}`);
}
function repeatedBytes(size: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < bytes.length; index++) bytes[index] = (index + seed) % 251;
  return bytes;
}

installRequestUrlBridge();

after(async () => {
  await mkdir(path.join(process.cwd(), ".tmp"), { recursive: true });
  await writeFile(path.join(process.cwd(), ".tmp", "github-e2e-results.json"), JSON.stringify({ generatedAt: new Date().toISOString(), profile, runBenchmarks, records: benchRecords }, null, 2));
});

baseTest("github e2e: encrypted force push/pull round trips real vault content without plaintext remote paths", { timeout: 120000 }, async () => {
  const config = githubConfig();
  const client = await resetTestBranch(config);
  const source = new RealE2EVault({
    "Notes/hello.md": "hello from real GitHub",
    "Notes/ไทย/emoji-😀.md": "unicode path survives",
    "assets/pixel.png": repeatedBytes(1024, 7),
  });

  await measure("forcePush.smallVault", () => encryptedForcePush(plugin(source, client) as never), { files: source.files.size });

  const treeAfterPush = await client.getTree();
  assert.equal(treeAfterPush.tree.some(node => node.path.includes("Notes/hello.md")), false);
  assert.equal(treeAfterPush.tree.some(node => node.path === ".obsidian-github-sync-v3/head.enc"), true);

  const pulled = new RealE2EVault();
  await measure("forcePull.smallVault", () => encryptedForcePull(plugin(pulled, client) as never), { files: source.files.size });

  assert.equal(pulled.getText("Notes/hello.md"), "hello from real GitHub");
  assert.equal(pulled.getText("Notes/ไทย/emoji-😀.md"), "unicode path survives");
  assert.equal(pulled.files.get("assets/pixel.png")?.byteLength, 1024);
});

baseTest("github e2e: modify rename delete and normal sync behave against real GitHub", { timeout: 120000 }, async () => {
  const config = githubConfig();
  const client = await resetTestBranch(config);
  const source = new RealE2EVault({ "Notes/a.md": "a1", "Notes/delete-me.md": "bye" });
  const instance = plugin(source, client) as never;
  await encryptedForcePush(instance);

  source.set("Notes/a.md", new TextEncoder().encode("a2"));
  await measure("localModify.singleFile", () => encryptedModify(source.getAbstractFileByPath("Notes/a.md") as TFile, instance, false));

  source.set("Notes/renamed.md", new TextEncoder().encode("renamed body"));
  source.files.delete("Notes/a.md");
  await measure("localRename.singleFile", () => encryptedRename(source.getAbstractFileByPath("Notes/renamed.md") as TFile, "Notes/a.md", instance, false));

  source.files.delete("Notes/delete-me.md");
  await measure("localDelete.singleFile", () => encryptedDelete(new TFile("Notes/delete-me.md"), instance, false));

  const pulled = await waitForRemoteV3Vault(config, vault =>
    vault.getText("Notes/renamed.md") === "renamed body"
    && !vault.files.has("Notes/a.md")
    && !vault.files.has("Notes/delete-me.md"),
    "rename/delete reflected",
  );
  assert.equal(pulled.getText("Notes/renamed.md"), "renamed body");
  assert.equal(pulled.files.has("Notes/a.md"), false);
  assert.equal(pulled.files.has("Notes/delete-me.md"), false);
});

regressionTest("github e2e: regression cases cover wrong passphrase, foreign remote prompt, stale sha retry, and missing delete", { timeout: 240000 }, async () => {
  const config = githubConfig();
  const client = await resetTestBranch(config);

  console.log("[github-e2e] regression: stale sha retry");
  const firstSha = await client.putFile("stale-sha.md", "one");
  await client.putFile("stale-sha.md", "two", firstSha);
  const staleRetrySha = await client.putFile("stale-sha.md", "three", firstSha);
  assert.ok(staleRetrySha);
  await client.deleteFile("already-missing.md", "fake-sha");

  console.log("[github-e2e] regression: foreign remote cancel");
  const foreignClient = await resetForeignBranch(config);
  await waitForRemoteTree(config, paths => paths.includes("README.md") && !paths.includes(ENCRYPTED_CONFIG_PATH), "foreign README only");
  const vault = new RealE2EVault({ "Notes/a.md": "local" });
  const foreignInstance = plugin(vault, foreignClient) as never;
  Notice.messages.length = 0;
  resetModalTestState();
  const cancelled = encryptedForcePush(foreignInstance);
  const cancelButton = await waitForModalButton("Cancel");
  cancelButton.click();
  await withTimeout("foreign force push cancellation", 10000, () => cancelled);
  assert.match(Notice.messages.at(-1) ?? "", /cancelled/i);

  console.log("[github-e2e] regression: wrong passphrase");
  await resetTestBranch(config);
  await measure("regression.forcePushSecret", () => encryptedForcePush(plugin(new RealE2EVault({ "Notes/secret.md": "secret" }), client) as never));
  const wrongPassClient = new GitHubClient(config);
  const wrongPassInstance = plugin(new RealE2EVault(), wrongPassClient) as ReturnType<typeof plugin>;
  wrongPassInstance.settings.encryptionPassphrase = "wrong passphrase";
  Notice.messages.length = 0;
  console.log("[github-e2e] regression: wrong passphrase force pull");
  await withTimeout("wrong passphrase force pull", 30000, () => encryptedForcePull(wrongPassInstance as never));
  assert.match(Notice.messages.at(-1) ?? "", /passphrase|decrypt|wrong/i);
});

benchmarkTest("github e2e: benchmark pack mode on real GitHub", { timeout: 600000 }, async () => {
  const config = githubConfig();
  const client = await resetTestBranch(config);
  const fileCount = Number(process.env.GITHUB_E2E_PACK_FILES ?? "10050");
  const entries: Record<string, string | Uint8Array> = {};
  for (let index = 0; index < fileCount; index++) entries[`many/note-${String(index).padStart(5, "0")}.md`] = `note-${index}`;
  const source = new RealE2EVault(entries);

  const sourceInstance = plugin(source, client) as never;

  await measure("forcePush.packMode", () => encryptedForcePush(sourceInstance), { files: fileCount });
  const tree = await client.getTree();
  assert.equal(tree.tree.some(node => node.path.startsWith(".obsidian-github-sync-encrypted/packs/")), true);
  assert.equal(tree.tree.some(node => node.path.includes("many/note-00000.md")), false);

  source.set("many/note-00000.md", new TextEncoder().encode("note-0 changed once"));
  await measure("sync.packModeOneFile", () => encryptedFullSync(sourceInstance), { files: fileCount, changedFiles: 1 });

  const pulled = new RealE2EVault();
  await measure("forcePull.packMode", () => encryptedForcePull(plugin(pulled, client) as never), { files: fileCount });
  assert.equal(pulled.files.size, fileCount);

  source.files.clear();
  source.mtimes.clear();
  source.set("small/only.md", new TextEncoder().encode("shrunk"));
  await measure("forcePush.shrinkVault", () => encryptedForcePush(plugin(source, client) as never), { files: 1 });
  const shrinkTree = await client.getTree();
  assert.equal(shrinkTree.tree.some(node => node.path.startsWith(".obsidian-github-sync-encrypted/packs/")), false);
});

class DeterministicRandom {
  constructor(private state: number) {}

  next(): number {
    this.state |= 0;
    this.state = (this.state + 0x6D2B79F5) | 0;
    let value = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  }

  int(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  pick<T>(items: T[]): T {
    return items[this.int(0, items.length - 1)];
  }
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function randomAscii(random: DeterministicRandom, length: number): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 \n-_*[]()#";
  let output = "";
  for (let index = 0; index < length; index++) output += alphabet[random.int(0, alphabet.length - 1)];
  return output;
}

function randomImageBytes(random: DeterministicRandom, size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < bytes.length; index++) bytes[index] = random.int(0, 255);
  return bytes;
}

function randomTotalBytes(files: Map<string, Uint8Array>): number {
  let total = 0;
  for (const bytes of files.values()) total += bytes.byteLength;
  return total;
}

function mapsEqualBytes(actual: Map<string, Uint8Array>, expected: Map<string, Uint8Array>): { ok: true } | { ok: false; reason: string } {
  if (actual.size !== expected.size) return { ok: false, reason: `file count mismatch actual=${actual.size} expected=${expected.size}` };
  for (const [filePath, expectedBytes] of expected.entries()) {
    const actualBytes = actual.get(filePath);
    if (!actualBytes) return { ok: false, reason: `missing file ${filePath}` };
    if (actualBytes.byteLength !== expectedBytes.byteLength) return { ok: false, reason: `size mismatch ${filePath} actual=${actualBytes.byteLength} expected=${expectedBytes.byteLength}` };
    for (let index = 0; index < expectedBytes.byteLength; index++) {
      if (actualBytes[index] !== expectedBytes[index]) return { ok: false, reason: `byte mismatch ${filePath} at ${index}` };
    }
  }
  return { ok: true };
}

const randomDebugPath = path.join(process.cwd(), ".tmp", "github-e2e-random-debug.jsonl");

async function resetRandomDebug(): Promise<void> {
  await mkdir(path.dirname(randomDebugPath), { recursive: true });
  await writeFile(randomDebugPath, "");
}

async function appendRandomDebug(event: Record<string, unknown>): Promise<void> {
  await mkdir(path.dirname(randomDebugPath), { recursive: true });
  await appendFile(randomDebugPath, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
}

function cloneBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

type RandomEventOperation =
  | { type: "modify"; path: string }
  | { type: "delete"; path: string }
  | { type: "rename"; oldPath: string; path: string };

randomTest("github e2e: random real-usage actions preserve vault state", { timeout: envNumber("GITHUB_E2E_RANDOM_TIMEOUT_MS", 900000) }, async () => {
  const config = githubConfig();
  const client = await resetTestBranch(config);
  const { actionCount, verifyEvery } = readRandomActionConfig(process.env);
  const seed = envNumber("GITHUB_E2E_RANDOM_SEED", Date.now() >>> 0);
  const random = new DeterministicRandom(seed);
  const { maxAddFiles, maxEditFiles, maxEditChars, maxDeleteFiles, maxRenameFiles, maxMoveFiles, maxImages, loopMaxAddFiles, loopMaxEditFiles, loopMaxDeleteFiles, loopMaxRenameFiles, loopMaxMoveFiles, loopMaxImages } = readRandomActionLimits(process.env);
  const source = new RealE2EVault();
  const expected = new Map<string, Uint8Array>();
  const instance = plugin(source, client) as never;
  let fileSerial = 0;
  let imageSerial = 0;

  await resetRandomDebug();
  await appendRandomDebug({ phase: "start", seed, actionCount, maxAddFiles, maxEditFiles, maxEditChars, maxDeleteFiles, maxRenameFiles, maxMoveFiles, maxImages, loopMaxAddFiles, loopMaxEditFiles, loopMaxDeleteFiles, loopMaxRenameFiles, loopMaxMoveFiles, loopMaxImages, verifyEvery, requiredChangedFileCounts: requiredChangedFileCounts() });
  await measure("random.initialForcePush", () => encryptedForcePush(instance), { operation: "forcePush", files: 0, changedFiles: 0, bytes: 0 });


  async function runRequiredCopyBatch(count: number, label: string): Promise<void> {
    const samples: string[] = [];
    const before = { files: expected.size, bytes: randomTotalBytes(expected) };
    await appendRandomDebug({ phase: "before-required-copy", label, count, before });
    for (let index = 0; index < count; index++) {
      const filePath = `required-copy/${label}/copied-${String(fileSerial++).padStart(6, "0")}.md`;
      const bytes = new TextEncoder().encode(`copied-${label}-${index}-${randomAscii(random, Math.max(1, Math.min(maxEditChars, 32)))}`);
      source.set(filePath, bytes);
      expected.set(filePath, cloneBytes(bytes));
      if (samples.length < 5) samples.push(filePath);
    }
    const afterMutation = { files: expected.size, bytes: randomTotalBytes(expected), changedCount: count, samples, syncMode: "bulk" as const };
    await appendRandomDebug({ phase: "after-required-copy-before-sync", label, afterMutation });
    await measure(`random.requiredCopy.${label}.${count}`, () => encryptedFullSync(instance), { operation: "push", phase: "after-push", action: "requiredCopy", files: afterMutation.files, bytes: afterMutation.bytes, changedFiles: count, batchLabel: label });
  }

  for (const count of requiredChangedFileCounts()) {
    const label = count >= 2000 ? "copy-2000-plus" : `changed-${count}`;
    await runRequiredCopyBatch(count, label);
  }

  const requiredPulled = new RealE2EVault();
  await measure("random.requiredCopy.verify", () => encryptedForcePull(plugin(requiredPulled, client) as never), { operation: "forcePull", files: expected.size, changedFiles: expected.size, bytes: randomTotalBytes(expected) });
  const requiredComparison = mapsEqualBytes(requiredPulled.files, expected);
  await appendRandomDebug({ phase: "required-copy-verify", files: expected.size, bytes: randomTotalBytes(expected), comparison: requiredComparison });
  assert.equal(requiredComparison.ok, true, requiredComparison.ok ? undefined : requiredComparison.reason);
  async function runEventOperation(event: RandomEventOperation): Promise<void> {
    if (event.type === "modify") {
      const file = source.getAbstractFileByPath(event.path);
      assert.ok(file instanceof TFile, `Expected modified file to exist: ${event.path}`);
      await encryptedModify(file, instance, true);
      return;
    }
    if (event.type === "delete") {
      await encryptedDelete(event.path, instance, true);
      return;
    }
    await encryptedRename(event.path, event.oldPath, instance, true);
  }

  async function syncRandomStep(step: number, action: RandomActionKind, changedCount: number, samples: string[], events: RandomEventOperation[]): Promise<void> {
    const syncMode: RandomSyncMode = chooseRandomSyncMode(action, changedCount, random);
    const afterMutation = { files: expected.size, bytes: randomTotalBytes(expected), changedCount, samples, syncMode };
    await appendRandomDebug({ phase: "after-mutation-before-sync", step, action, afterMutation, events: events.slice(0, 10) });
    await measure(`random.step.${step}.${action}.${syncMode}`, async () => {
      if (syncMode === "event" && events.length > 0) {
        for (const event of events) await runEventOperation(event);
      } else {
        await encryptedFullSync(instance);
      }
    }, { step, action, syncMode, files: afterMutation.files, bytes: afterMutation.bytes, changedFiles: changedCount });
    if (verifyEvery > 0 && step % verifyEvery === 0) {
      const pulled = new RealE2EVault();
      await measure(`random.verify.${step}`, () => encryptedForcePull(plugin(pulled, client) as never), { step, files: expected.size, changedFiles: expected.size });
      const comparison = mapsEqualBytes(pulled.files, expected);
      await appendRandomDebug({ phase: "verify", step, action, afterMutation, comparison });
      assert.equal(comparison.ok, true, comparison.ok ? undefined : comparison.reason);
    } else {
      await appendRandomDebug({ phase: "after", step, action, afterMutation });
    }
  }

  for (let step = 1; step <= actionCount; step++) {
    const existingPaths = [...expected.keys()];
    const textPaths = existingPaths.filter(filePath => /\.(md|txt)$/iu.test(filePath));
    const action = chooseRandomAction(existingPaths.length, random);
    const samples: string[] = [];
    const events: RandomEventOperation[] = [];
    const before = { files: expected.size, bytes: randomTotalBytes(expected) };

    await appendRandomDebug({ phase: "before", step, action, before });
    let changedCount = 0;
    if (action === "addFiles") {
      const count = random.int(1, Math.max(1, loopMaxAddFiles));
      changedCount = count;
      for (let index = 0; index < count; index++) {
        const filePath = `notes/b${random.int(0, 99)}/note-${String(fileSerial++).padStart(6, "0")}-${random.int(0, 999999)}.md`;
        const bytes = new TextEncoder().encode(randomAscii(random, random.int(1, Math.max(1, maxEditChars))));
        source.set(filePath, bytes);
        expected.set(filePath, cloneBytes(bytes));
        events.push({ type: "modify", path: filePath });
        if (samples.length < 5) samples.push(filePath);
      }
    } else if (action === "editText" && textPaths.length > 0) {
      const count = Math.min(textPaths.length, random.int(1, Math.max(1, loopMaxEditFiles)));
      changedCount = count;
      for (let index = 0; index < count; index++) {
        const filePath = random.pick(textPaths);
        const current = new TextDecoder().decode(expected.get(filePath) ?? new Uint8Array());
        const editLength = random.int(1, Math.max(1, maxEditChars));
        const next = random.next() < 0.5
          ? current.slice(0, Math.max(0, current.length - editLength))
          : `${current}${randomAscii(random, editLength)}`;
        const bytes = new TextEncoder().encode(next);
        source.set(filePath, bytes);
        expected.set(filePath, cloneBytes(bytes));
        events.push({ type: "modify", path: filePath });
        if (samples.length < 5) samples.push(filePath);
      }
    } else if (action === "addImages") {
      const count = random.int(1, Math.max(1, loopMaxImages));
      changedCount = count;
      for (let index = 0; index < count; index++) {
        const filePath = `assets/random-${String(imageSerial++).padStart(5, "0")}-${random.int(0, 999999)}.png`;
        const bytes = randomImageBytes(random, random.int(1024, 64 * 1024));
        source.set(filePath, bytes);
        expected.set(filePath, cloneBytes(bytes));
        events.push({ type: "modify", path: filePath });
        if (samples.length < 5) samples.push(filePath);
      }
    } else if (action === "deleteFiles" && existingPaths.length > 0) {
      const count = Math.min(existingPaths.length, random.int(1, Math.max(1, loopMaxDeleteFiles)));
      changedCount = count;
      for (let index = 0; index < count; index++) {
        const filePath = random.pick([...expected.keys()]);
        source.files.delete(filePath);
        source.mtimes.delete(filePath);
        expected.delete(filePath);
        events.push({ type: "delete", path: filePath });
        if (samples.length < 5) samples.push(filePath);
      }
    } else if ((action === "renameFiles" || action === "moveFiles") && existingPaths.length > 0) {
      const limit = action === "renameFiles" ? loopMaxRenameFiles : loopMaxMoveFiles;
      const count = Math.min(existingPaths.length, random.int(1, Math.max(1, limit)));
      changedCount = count;
      for (let index = 0; index < count; index++) {
        const oldPath = random.pick([...expected.keys()]);
        const bytes = expected.get(oldPath);
        if (!bytes) continue;
        const extension = oldPath.endsWith(".png") ? "png" : "md";
        const newPath = action === "moveFiles"
          ? `moved/f${random.int(0, 50)}/${String(fileSerial++).padStart(6, "0")}-${random.int(0, 999999)}.${extension}`
          : oldPath.replace(/[^/]+$/u, `renamed-${String(fileSerial++).padStart(6, "0")}-${random.int(0, 999999)}.${extension}`);
        source.files.delete(oldPath);
        source.mtimes.delete(oldPath);
        source.set(newPath, cloneBytes(bytes));
        expected.delete(oldPath);
        expected.set(newPath, cloneBytes(bytes));
        events.push({ type: "rename", oldPath, path: newPath });
        if (samples.length < 5) samples.push(`${oldPath} -> ${newPath}`);
      }
    }

    await syncRandomStep(step, action, changedCount, samples, events);
  }

  const pulled = new RealE2EVault();
  await measure("random.finalVerify", () => encryptedForcePull(plugin(pulled, client) as never), { files: expected.size, changedFiles: expected.size });
  const comparison = mapsEqualBytes(pulled.files, expected);
  await appendRandomDebug({ phase: "complete", seed, steps: actionCount, files: expected.size, bytes: randomTotalBytes(expected), comparison });
  assert.equal(comparison.ok, true, comparison.ok ? undefined : comparison.reason);
});benchmarkTest("github e2e: benchmark large chunked object on real GitHub", { timeout: 600000 }, async () => {
  const config = githubConfig();
  const client = await resetTestBranch(config);
  const largeMiB = Number(process.env.GITHUB_E2E_LARGE_MIB ?? "51");
  const source = new RealE2EVault({ "large/blob.bin": repeatedBytes(largeMiB * 1024 * 1024, 19) });

  await measure("forcePush.chunkedObject", () => encryptedForcePush(plugin(source, client) as never), { files: 1, largeMiB });
  const tree = await client.getTree();
  assert.equal(tree.tree.some(node => node.path.includes("large/blob.bin")), false);
  assert.equal(tree.tree.some(node => node.path.includes(".parts/")), true);

  const pulled = new RealE2EVault();
  await measure("forcePull.chunkedObject", () => encryptedForcePull(plugin(pulled, client) as never), { files: 1, largeMiB });
  assert.equal(pulled.files.get("large/blob.bin")?.byteLength, largeMiB * 1024 * 1024);
});
