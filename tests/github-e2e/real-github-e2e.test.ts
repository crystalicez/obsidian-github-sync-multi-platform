import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { modalButtons, Notice, resetModalTestState, setRequestUrlHandler, TFile } from "obsidian";
import { encryptedDelete, encryptedForcePull, encryptedForcePush, encryptedFullSync, encryptedModify, encryptedRename } from "../../src/lib/encrypted/sync-engine";
import { EncryptedManifestStore } from "../../src/lib/encrypted/manifest-store";
import { GitHubClient, GitHubConfig } from "../../src/lib/github-api";
import { ENCRYPTED_CONFIG_PATH, ENCRYPTED_FORMAT_VERSION, ENCRYPTED_INDEX_MODE } from "../../src/lib/encrypted/constants";

interface BenchRecord {
  name: string;
  elapsedMs: number;
  details?: Record<string, number | string | boolean>;
}

const benchRecords: BenchRecord[] = [];
const profile = process.env.GITHUB_E2E_PROFILE ?? "quick";
const runBenchmarks = process.env.GITHUB_E2E_RUN_BENCHMARKS === "1" || profile === "full" || profile === "stress";
const benchmarkTest = runBenchmarks ? test : test.skip;
const regressionTest = profile === "quick" ? test.skip : test;
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

async function measure<T>(name: string, run: () => Promise<T>, details: BenchRecord["details"] = {}): Promise<T> {
  console.log(`[github-e2e] start ${name}`);
  Notice.messages.length = 0;
  const started = performance.now();
  try {
    const result = await withTimeout(name, Number(process.env.GITHUB_E2E_STEP_TIMEOUT_MS ?? "120000"), run);
    const syncFailure = Notice.messages.find(message => /Encrypted .* failed/i.test(message));
    if (syncFailure) throw new Error(syncFailure);
    const elapsedMs = Math.round((performance.now() - started) * 100) / 100;
    benchRecords.push({ name, elapsedMs, details });
    console.log(`[github-e2e] done ${name}: ${elapsedMs}ms`);
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
async function waitForRemoteManifest(config: GitHubConfig, predicate: (store: Awaited<ReturnType<EncryptedManifestStore["loadOrCreate"]>>) => boolean, label: string): Promise<void> {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < 30000) {
    try {
      const loaded = await new EncryptedManifestStore(new GitHubClient(config), passphrase).loadOrCreate();
      if (predicate(loaded)) return;
    } catch (error) {
      lastError = error;
    }
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for remote manifest: ${label}${lastError instanceof Error ? ` (${lastError.message})` : ""}`);
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

test("github e2e: encrypted force push/pull round trips real vault content without plaintext remote paths", { timeout: 120000 }, async () => {
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
  assert.equal(treeAfterPush.tree.some(node => node.path === ".obsidian-github-sync-encrypted/config.json"), true);

  const pulled = new RealE2EVault();
  await measure("forcePull.smallVault", () => encryptedForcePull(plugin(pulled, client) as never), { files: source.files.size });

  assert.equal(pulled.getText("Notes/hello.md"), "hello from real GitHub");
  assert.equal(pulled.getText("Notes/ไทย/emoji-😀.md"), "unicode path survives");
  assert.equal(pulled.files.get("assets/pixel.png")?.byteLength, 1024);
});

test("github e2e: modify rename delete and normal sync behave against real GitHub", { timeout: 120000 }, async () => {
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

  await waitForRemoteManifest(config, loaded => loaded.manifest.files["Notes/a.md"]?.deleted === true && loaded.manifest.files["Notes/delete-me.md"]?.deleted === true && loaded.manifest.files["Notes/renamed.md"]?.deleted !== true, "rename/delete reflected");

  const pulled = new RealE2EVault();
  await encryptedForcePull(plugin(pulled, client) as never);
  assert.equal(pulled.getText("Notes/renamed.md"), "renamed body");
  assert.equal(pulled.files.has("Notes/a.md"), false);
  assert.equal(pulled.files.has("Notes/delete-me.md"), false);

  const store = new EncryptedManifestStore(client, passphrase);
  const loaded = await store.loadOrCreate();
  assert.equal(loaded.manifest.files["Notes/a.md"].deleted, true);
  assert.equal(loaded.manifest.files["Notes/delete-me.md"].deleted, true);
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

benchmarkTest("github e2e: benchmark large chunked object on real GitHub", { timeout: 600000 }, async () => {
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
