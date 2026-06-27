# Encrypted Obsidian GitHub Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional encrypted sync mode that hides Obsidian file contents, filenames, and folder structure from GitHub.

**Architecture:** Keep the existing plaintext sync path intact and route encrypted mode through a new focused engine under `src/lib/encrypted/`. The encrypted engine stores non-secret repo metadata in `.obsidian-github-sync-encrypted/config.json`, stores sensitive path/object mapping in `manifest.enc`, and stores encrypted file bytes as opaque objects under `.obsidian-github-sync-encrypted/objects/`.

**Tech Stack:** TypeScript, Obsidian plugin API, GitHub Contents API, WebCrypto AES-GCM, PBKDF2-SHA-256 first with config-versioned KDF metadata, Node test runner for pure helper tests, existing `npm run build` verification.

---

## File Structure

- Modify `package.json`: add a `test` script using Node's built-in test runner for plain JavaScript test files.
- Modify `src/setting.tsx`: add encrypted sync settings fields and UI controls for enabling encrypted mode and entering the passphrase.
- Modify `src/main.ts`: initialize encrypted settings safely and route full sync / watcher behavior based on `settings.encryptionMode`.
- Modify `src/lib/fs.ts`: delegate encrypted-mode modify/delete/rename/full sync to the encrypted engine while preserving existing plaintext behavior.
- Modify `src/lib/github-api.ts`: add raw bytes helpers and a `getFileBytes()` decoder so encrypted objects never pass through string decoding.
- Create `src/lib/encrypted/constants.ts`: encrypted remote layout constants and size limits.
- Create `src/lib/encrypted/types.ts`: config, manifest, object record, and local state types.
- Create `src/lib/encrypted/bytes.ts`: base64, UTF-8, hex, random bytes, and SHA-256 helpers.
- Create `src/lib/encrypted/crypto.ts`: passphrase key derivation and AES-GCM encrypt/decrypt helpers.
- Create `src/lib/encrypted/paths.ts`: path normalization, collision detection, object path generation, and conflict filename generation.
- Create `src/lib/encrypted/manifest-store.ts`: load/create/save encrypted config and manifest through `GitHubClient`.
- Create `src/lib/encrypted/vault.ts`: vault file scan/read/write helpers that operate on bytes.
- Create `src/lib/encrypted/sync-engine.ts`: encrypted push, pull, delete, rename, full sync, and conflict handling.
- Create `tests/encrypted/*.test.mjs`: pure helper regression tests for byte encoding, path handling, and leakage checks.

## Task 1: Test Harness And Pure Byte Helpers

**Files:**
- Modify: `package.json`
- Create: `src/lib/encrypted/bytes.ts`
- Create: `tests/encrypted/bytes.test.mjs`

- [ ] **Step 1: Add the test script**

Change `package.json` scripts to include:

```json
"test": "node --test tests/**/*.test.mjs"
```

- [ ] **Step 2: Write failing byte helper tests**

Create `tests/encrypted/bytes.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";

const bytes = new TextEncoder().encode("ภาษาไทย/emoji 🚀").buffer;

function toBase64Url(input) {
  const data = input instanceof Uint8Array ? input : new Uint8Array(input);
  return Buffer.from(data).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function fromBase64Url(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  return new Uint8Array(Buffer.from(padded, "base64")).buffer;
}

test("base64url round trips arbitrary UTF-8 bytes", () => {
  const encoded = toBase64Url(bytes);
  assert.equal(encoded.includes("+"), false);
  assert.equal(encoded.includes("/"), false);
  assert.deepEqual(new Uint8Array(fromBase64Url(encoded)), new Uint8Array(bytes));
});
```

- [ ] **Step 3: Run the test to verify the harness**

Run: `npm test`

Expected: PASS for the inline reference test. This confirms the runner works before wiring project code into tests.

- [ ] **Step 4: Implement project byte helpers**

Create `src/lib/encrypted/bytes.ts`:

```ts
export function utf8ToBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export function bytesToUtf8(value: ArrayBuffer | Uint8Array): string {
  return new TextDecoder().decode(value instanceof Uint8Array ? value : new Uint8Array(value));
}

export function toBase64Url(value: ArrayBuffer | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

export function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function toHex(value: ArrayBuffer | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

export async function sha256Hex(value: ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  return toHex(await crypto.subtle.digest("SHA-256", bytes));
}
```

- [ ] **Step 5: Commit**

```bash
git add package.json src/lib/encrypted/bytes.ts tests/encrypted/bytes.test.mjs
git commit -m "test: add encrypted sync byte helper harness"
```

## Task 2: Types, Constants, And Path Safety

**Files:**
- Create: `src/lib/encrypted/constants.ts`
- Create: `src/lib/encrypted/types.ts`
- Create: `src/lib/encrypted/paths.ts`
- Create: `tests/encrypted/paths.test.mjs`

- [ ] **Step 1: Write path behavior tests**

Create `tests/encrypted/paths.test.mjs` with reference assertions for expected behavior:

```js
import assert from "node:assert/strict";
import test from "node:test";

function normalizeVaultPath(path) {
  return path.replace(/\\/g, "/").replace(/^\/+/u, "").split("/").filter(Boolean).join("/");
}

function detectCaseInsensitiveCollisions(paths) {
  const seen = new Map();
  const collisions = [];
  for (const path of paths) {
    const key = normalizeVaultPath(path).toLocaleLowerCase("en-US");
    const first = seen.get(key);
    if (first && first !== path) collisions.push([first, path]);
    else seen.set(key, path);
  }
  return collisions;
}

test("normalization preserves Thai and emoji path text", () => {
  assert.equal(normalizeVaultPath("\\โฟลเดอร์//บันทึก 🚀.md"), "โฟลเดอร์/บันทึก 🚀.md");
});

test("case-insensitive collisions are detected", () => {
  assert.deepEqual(detectCaseInsensitiveCollisions(["Note.md", "folder/ok.md", "note.md"]), [["Note.md", "note.md"]]);
});
```

- [ ] **Step 2: Create constants**

Create `src/lib/encrypted/constants.ts`:

```ts
export const ENCRYPTED_ROOT = ".obsidian-github-sync-encrypted";
export const ENCRYPTED_CONFIG_PATH = `${ENCRYPTED_ROOT}/config.json`;
export const ENCRYPTED_MANIFEST_PATH = `${ENCRYPTED_ROOT}/manifest.enc`;
export const ENCRYPTED_OBJECTS_ROOT = `${ENCRYPTED_ROOT}/objects`;
export const ENCRYPTED_FORMAT_VERSION = 1;
export const ENCRYPTED_INDEX_MODE = "single";
export const AES_GCM_NONCE_BYTES = 12;
export const OBJECT_ID_BYTES = 24;
export const MAX_ENCRYPTED_FILE_SIZE = 10 * 1024 * 1024;
```

- [ ] **Step 3: Create encrypted sync types**

Create `src/lib/encrypted/types.ts`:

```ts
export interface EncryptedRepoConfig {
  formatVersion: 1;
  indexMode: "single";
  algorithm: "AES-GCM";
  kdf: "PBKDF2-SHA-256";
  kdfParams: { iterations: number; salt: string };
  createdAt: number;
  updatedAt: number;
}

export interface EncryptedObjectRecord {
  id: string;
  path: string;
  objectPath: string;
  plaintextSha256: string;
  remoteSha?: string;
  size: number;
  mtime: number;
  deleted?: boolean;
  deletedAt?: number;
}

export interface EncryptedManifest {
  formatVersion: 1;
  indexMode: "single";
  updatedAt: number;
  files: Record<string, EncryptedObjectRecord>;
}

export interface EncryptedLocalFileState {
  plaintextSha256: string;
  objectPath: string;
  remoteSha?: string;
  manifestUpdatedAt: number;
}
```

- [ ] **Step 4: Create path helpers**

Create `src/lib/encrypted/paths.ts`:

```ts
import { ENCRYPTED_OBJECTS_ROOT } from "./constants";

export function normalizeVaultPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/u, "").split("/").filter(Boolean).join("/");
}

export function detectCaseInsensitiveCollisions(paths: string[]): string[][] {
  const seen = new Map<string, string>();
  const collisions: string[][] = [];
  for (const rawPath of paths) {
    const path = normalizeVaultPath(rawPath);
    const key = path.toLocaleLowerCase("en-US");
    const first = seen.get(key);
    if (first && first !== path) collisions.push([first, path]);
    else seen.set(key, path);
  }
  return collisions;
}

export function objectPathForId(id: string): string {
  return `${ENCRYPTED_OBJECTS_ROOT}/${id.slice(0, 2)}/${id.slice(2, 4)}/${id}.enc`;
}

export function conflictPathFor(path: string, timestamp: number, source: string): string {
  const normalized = normalizeVaultPath(path);
  const dot = normalized.lastIndexOf(".");
  const stamp = new Date(timestamp).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/u, "Z");
  if (dot <= normalized.lastIndexOf("/")) return `${normalized}.sync-conflict-${stamp}-${source}`;
  return `${normalized.slice(0, dot)}.sync-conflict-${stamp}-${source}${normalized.slice(dot)}`;
}
```

- [ ] **Step 5: Run verification**

Run: `npm run build`

Expected: TypeScript and esbuild complete without errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/encrypted/constants.ts src/lib/encrypted/types.ts src/lib/encrypted/paths.ts tests/encrypted/paths.test.mjs
git commit -m "feat: add encrypted sync path model"
```

## Task 3: Crypto Codec

**Files:**
- Create: `src/lib/encrypted/crypto.ts`
- Create: `tests/encrypted/leakage.test.mjs`

- [ ] **Step 1: Write leakage test for remote layout assumptions**

Create `tests/encrypted/leakage.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";

test("remote object path does not contain plaintext path", () => {
  const plaintextPath = "โฟลเดอร์/private note.md";
  const opaqueId = "00112233445566778899aabbccddeeff0011223344556677";
  const objectPath = `.obsidian-github-sync-encrypted/objects/${opaqueId.slice(0, 2)}/${opaqueId.slice(2, 4)}/${opaqueId}.enc`;
  assert.equal(objectPath.includes("private"), false);
  assert.equal(objectPath.includes("โฟลเดอร์"), false);
  assert.equal(objectPath.includes(plaintextPath), false);
});
```

- [ ] **Step 2: Implement AES-GCM codec**

Create `src/lib/encrypted/crypto.ts`:

```ts
import { AES_GCM_NONCE_BYTES } from "./constants";
import { EncryptedRepoConfig } from "./types";
import { bytesToUtf8, fromBase64Url, randomBytes, toBase64Url, utf8ToBytes } from "./bytes";

export interface EncryptedPayload {
  nonce: string;
  ciphertext: string;
}

export async function deriveEncryptionKey(passphrase: string, config: EncryptedRepoConfig): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey("raw", utf8ToBytes(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: fromBase64Url(config.kdfParams.salt),
      iterations: config.kdfParams.iterations,
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function encryptBytes(key: CryptoKey, plaintext: ArrayBuffer | Uint8Array): Promise<EncryptedPayload> {
  const nonce = randomBytes(AES_GCM_NONCE_BYTES);
  const bytes = plaintext instanceof Uint8Array ? plaintext : new Uint8Array(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, bytes);
  return { nonce: toBase64Url(nonce), ciphertext: toBase64Url(ciphertext) };
}

export async function decryptBytes(key: CryptoKey, payload: EncryptedPayload): Promise<Uint8Array> {
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64Url(payload.nonce) },
    key,
    fromBase64Url(payload.ciphertext)
  );
  return new Uint8Array(plaintext);
}

export async function encryptJson(key: CryptoKey, value: unknown): Promise<string> {
  return JSON.stringify(await encryptBytes(key, utf8ToBytes(JSON.stringify(value))));
}

export async function decryptJson<T>(key: CryptoKey, value: string): Promise<T> {
  const payload = JSON.parse(value) as EncryptedPayload;
  return JSON.parse(bytesToUtf8(await decryptBytes(key, payload))) as T;
}
```

- [ ] **Step 3: Build**

Run: `npm run build`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/lib/encrypted/crypto.ts tests/encrypted/leakage.test.mjs
git commit -m "feat: add encrypted sync crypto codec"
```

## Task 4: GitHub Raw Bytes And Manifest Store

**Files:**
- Modify: `src/lib/github-api.ts`
- Create: `src/lib/encrypted/manifest-store.ts`

- [ ] **Step 1: Add GitHub byte decoder helpers**

Modify `src/lib/github-api.ts` to add:

```ts
async getFileBytes(path: string): Promise<{ bytes: Uint8Array; sha: string } | null> {
  const file = await this.getFile(path);
  if (!file) return null;
  if (!file.content && file.download_url) {
    const response = await requestUrl({ url: file.download_url, headers: this.headers });
    return { bytes: new Uint8Array(response.arrayBuffer), sha: file.sha };
  }
  return { bytes: GitHubClient.decodeContentBytes(file.content), sha: file.sha };
}

static decodeContentBytes(base64Content: string): Uint8Array {
  const binary = atob(base64Content.replace(/\n/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
```

- [ ] **Step 2: Create manifest store**

Create `src/lib/encrypted/manifest-store.ts`:

```ts
import { GitHubClient } from "../github-api";
import { ENCRYPTED_CONFIG_PATH, ENCRYPTED_FORMAT_VERSION, ENCRYPTED_INDEX_MODE, ENCRYPTED_MANIFEST_PATH } from "./constants";
import { decryptJson, deriveEncryptionKey, encryptJson } from "./crypto";
import { EncryptedManifest, EncryptedRepoConfig } from "./types";
import { bytesToUtf8, randomBytes, toBase64Url } from "./bytes";

const DEFAULT_PBKDF2_ITERATIONS = 600000;

export class EncryptedManifestStore {
  constructor(private readonly github: GitHubClient, private readonly passphrase: string) {}

  async loadOrCreate(): Promise<{ config: EncryptedRepoConfig; manifest: EncryptedManifest; manifestSha?: string; key: CryptoKey }> {
    const config = await this.loadOrCreateConfig();
    const key = await deriveEncryptionKey(this.passphrase, config);
    const remoteManifest = await this.github.getFile(ENCRYPTED_MANIFEST_PATH);
    if (!remoteManifest) {
      return { config, key, manifest: { formatVersion: ENCRYPTED_FORMAT_VERSION, indexMode: ENCRYPTED_INDEX_MODE, updatedAt: Date.now(), files: {} } };
    }
    const manifest = await decryptJson<EncryptedManifest>(key, GitHubClient.decodeContent(remoteManifest.content));
    return { config, key, manifest, manifestSha: remoteManifest.sha };
  }

  async save(manifest: EncryptedManifest, key: CryptoKey, manifestSha?: string): Promise<string> {
    manifest.updatedAt = Date.now();
    const encrypted = await encryptJson(key, manifest);
    return this.github.putFile(ENCRYPTED_MANIFEST_PATH, encrypted, manifestSha);
  }

  private async loadOrCreateConfig(): Promise<EncryptedRepoConfig> {
    const remoteConfig = await this.github.getFile(ENCRYPTED_CONFIG_PATH);
    if (remoteConfig) return JSON.parse(GitHubClient.decodeContent(remoteConfig.content)) as EncryptedRepoConfig;

    const now = Date.now();
    const config: EncryptedRepoConfig = {
      formatVersion: ENCRYPTED_FORMAT_VERSION,
      indexMode: ENCRYPTED_INDEX_MODE,
      algorithm: "AES-GCM",
      kdf: "PBKDF2-SHA-256",
      kdfParams: { iterations: DEFAULT_PBKDF2_ITERATIONS, salt: toBase64Url(randomBytes(16)) },
      createdAt: now,
      updatedAt: now,
    };
    await this.github.putFile(ENCRYPTED_CONFIG_PATH, JSON.stringify(config, null, 2));
    return config;
  }
}
```

- [ ] **Step 3: Build**

Run: `npm run build`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/lib/github-api.ts src/lib/encrypted/manifest-store.ts
git commit -m "feat: add encrypted manifest storage"
```

## Task 5: Vault Byte IO And Scanner

**Files:**
- Create: `src/lib/encrypted/vault.ts`

- [ ] **Step 1: Create byte-safe vault helpers**

Create `src/lib/encrypted/vault.ts`:

```ts
import { TFile, Vault } from "obsidian";
import { ENCRYPTED_ROOT, MAX_ENCRYPTED_FILE_SIZE } from "./constants";
import { detectCaseInsensitiveCollisions, normalizeVaultPath } from "./paths";

export function shouldSyncEncryptedFile(file: TFile): boolean {
  const path = normalizeVaultPath(file.path);
  if (path.startsWith(`${ENCRYPTED_ROOT}/`)) return false;
  if (path.includes(".sync-conflict-")) return false;
  if (file.stat.size > MAX_ENCRYPTED_FILE_SIZE) return false;
  return true;
}

export function listEncryptedSyncCandidates(vault: Vault): TFile[] {
  const files = vault.getFiles().filter(shouldSyncEncryptedFile);
  const collisions = detectCaseInsensitiveCollisions(files.map(file => file.path));
  if (collisions.length > 0) {
    throw new Error(`Case-insensitive path collision: ${collisions.map(pair => pair.join(" <-> ")).join(", ")}`);
  }
  return files;
}

export async function readVaultFileBytes(vault: Vault, file: TFile): Promise<Uint8Array> {
  return new Uint8Array(await vault.readBinary(file));
}

export async function writeVaultFileBytes(vault: Vault, path: string, bytes: Uint8Array): Promise<void> {
  const folderPath = path.split("/").slice(0, -1).join("/");
  if (folderPath && !vault.getAbstractFileByPath(folderPath)) await vault.createFolder(folderPath);
  const existing = vault.getAbstractFileByPath(path);
  if (existing instanceof TFile) await vault.modifyBinary(existing, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  else await vault.createBinary(path, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}
```

- [ ] **Step 2: Build**

Run: `npm run build`

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/lib/encrypted/vault.ts
git commit -m "feat: add encrypted vault byte io"
```

## Task 6: Encrypted Sync Engine

**Files:**
- Create: `src/lib/encrypted/sync-engine.ts`
- Modify: `src/main.ts`

- [ ] **Step 1: Extend plugin local state types**

Modify `src/main.ts` `SyncData` to include encrypted state:

```ts
export interface SyncData {
  files: { [path: string]: FileState };
  encrypted?: {
    files: { [path: string]: import("./lib/encrypted/types").EncryptedLocalFileState };
    manifestSha?: string;
  };
}
```

Ensure `loadSyncData()` initializes `encrypted` lazily:

```ts
this.syncData = data.syncData ?? { files: {} };
if (!this.syncData.encrypted) this.syncData.encrypted = { files: {} };
```

- [ ] **Step 2: Implement encrypted sync engine**

Create `src/lib/encrypted/sync-engine.ts`:

```ts
import { Notice, TAbstractFile, TFile } from "obsidian";
import FastSync from "../../main";
import { GitHubClient } from "../github-api";
import { OBJECT_ID_BYTES } from "./constants";
import { decryptBytes, encryptBytes } from "./crypto";
import { EncryptedManifestStore } from "./manifest-store";
import { conflictPathFor, normalizeVaultPath, objectPathForId } from "./paths";
import { EncryptedManifest, EncryptedObjectRecord } from "./types";
import { listEncryptedSyncCandidates, readVaultFileBytes, shouldSyncEncryptedFile, writeVaultFileBytes } from "./vault";
import { randomBytes, sha256Hex, toBase64Url } from "./bytes";

function requireEncryptedPassphrase(plugin: FastSync): string {
  const passphrase = plugin.settings.encryptionPassphrase?.trim();
  if (!passphrase) throw new Error("Encrypted sync passphrase is required.");
  return passphrase;
}

async function loadStore(plugin: FastSync) {
  const store = new EncryptedManifestStore(plugin.githubClient, requireEncryptedPassphrase(plugin));
  return { store, ...(await store.loadOrCreate()) };
}

async function uploadEncryptedObject(plugin: FastSync, key: CryptoKey, plaintext: Uint8Array, existing?: EncryptedObjectRecord): Promise<EncryptedObjectRecord> {
  const payload = await encryptBytes(key, plaintext);
  const objectId = existing?.id ?? toBase64Url(randomBytes(OBJECT_ID_BYTES));
  const objectPath = existing?.objectPath ?? objectPathForId(objectId);
  const sha = await plugin.githubClient.putFile(objectPath, JSON.stringify(payload), existing?.remoteSha);
  return {
    id: objectId,
    path: existing?.path ?? "",
    objectPath,
    plaintextSha256: await sha256Hex(plaintext),
    remoteSha: sha,
    size: plaintext.byteLength,
    mtime: Date.now(),
  };
}

export async function encryptedFullSync(plugin: FastSync): Promise<void> {
  if (plugin.isSyncInProgress || !plugin.githubClient) return;
  plugin.isSyncInProgress = true;
  plugin.disableWatch();
  try {
    const { store, key, manifest, manifestSha } = await loadStore(plugin);
    await pullEncryptedChanges(plugin, key, manifest);
    await pushEncryptedLocalChanges(plugin, key, manifest);
    const newManifestSha = await store.save(manifest, key, manifestSha);
    plugin.syncData.encrypted = { files: {}, manifestSha: newManifestSha };
    for (const [path, record] of Object.entries(manifest.files)) {
      if (!record.deleted) {
        plugin.syncData.encrypted.files[path] = {
          plaintextSha256: record.plaintextSha256,
          objectPath: record.objectPath,
          remoteSha: record.remoteSha,
          manifestUpdatedAt: manifest.updatedAt,
        };
      }
    }
    await plugin.saveSyncData();
    new Notice("Encrypted sync completed");
  } catch (error) {
    console.error("Encrypted sync failed:", error);
    new Notice(`Encrypted sync failed: ${(error as Error).message}`);
  } finally {
    plugin.isSyncInProgress = false;
    plugin.enableWatch();
  }
}

export async function encryptedModify(file: TAbstractFile, plugin: FastSync, eventEnter = false): Promise<void> {
  if (!(file instanceof TFile)) return;
  if (!plugin.isWatchEnabled && eventEnter) return;
  if (!shouldSyncEncryptedFile(file) || !plugin.githubClient) return;
  await encryptedFullSync(plugin);
}

export async function encryptedDelete(file: TAbstractFile, plugin: FastSync, eventEnter = false): Promise<void> {
  if (!plugin.isWatchEnabled && eventEnter) return;
  if (!plugin.githubClient) return;
  const { store, key, manifest, manifestSha } = await loadStore(plugin);
  const path = normalizeVaultPath(file.path);
  const record = manifest.files[path];
  if (record) {
    record.deleted = true;
    record.deletedAt = Date.now();
    await store.save(manifest, key, manifestSha);
    delete plugin.syncData.encrypted?.files[path];
    await plugin.saveSyncData();
  }
}

export async function encryptedRename(_file: TAbstractFile, _oldfile: string, plugin: FastSync, eventEnter = false): Promise<void> {
  if (!plugin.isWatchEnabled && eventEnter) return;
  await encryptedFullSync(plugin);
}

async function pullEncryptedChanges(plugin: FastSync, key: CryptoKey, manifest: EncryptedManifest): Promise<void> {
  for (const [path, record] of Object.entries(manifest.files)) {
    if (record.deleted) continue;
    const localState = plugin.syncData.encrypted?.files[path];
    if (localState?.plaintextSha256 === record.plaintextSha256) continue;
    const remote = await plugin.githubClient.getFile(record.objectPath);
    if (!remote) throw new Error(`Missing encrypted object: ${record.objectPath}`);
    const plaintext = await decryptBytes(key, JSON.parse(GitHubClient.decodeContent(remote.content)));
    const localFile = plugin.app.vault.getAbstractFileByPath(path);
    if (localFile instanceof TFile && localState && localState.plaintextSha256 !== await sha256Hex(await readVaultFileBytes(plugin.app.vault, localFile))) {
      await writeVaultFileBytes(plugin.app.vault, conflictPathFor(path, Date.now(), "remote"), plaintext);
    } else {
      await writeVaultFileBytes(plugin.app.vault, path, plaintext);
    }
  }
}

async function pushEncryptedLocalChanges(plugin: FastSync, key: CryptoKey, manifest: EncryptedManifest): Promise<void> {
  for (const file of listEncryptedSyncCandidates(plugin.app.vault)) {
    const path = normalizeVaultPath(file.path);
    const plaintext = await readVaultFileBytes(plugin.app.vault, file);
    const plaintextSha256 = await sha256Hex(plaintext);
    if (manifest.files[path]?.plaintextSha256 === plaintextSha256) continue;
    const uploaded = await uploadEncryptedObject(plugin, key, plaintext, manifest.files[path]);
    manifest.files[path] = { ...uploaded, path, plaintextSha256, mtime: file.stat.mtime };
  }
}
```

- [ ] **Step 3: Build and fix type errors only within encrypted modules**

Run: `npm run build`

Expected: PASS after adjusting imports and strict null checks.

- [ ] **Step 4: Commit**

```bash
git add src/main.ts src/lib/encrypted/sync-engine.ts
git commit -m "feat: add encrypted sync engine"
```

## Task 7: Settings UI And Routing

**Files:**
- Modify: `src/setting.tsx`
- Modify: `src/lib/fs.ts`
- Modify: `src/main.ts`

- [ ] **Step 1: Add settings fields**

Modify `PluginSettings` in `src/setting.tsx`:

```ts
encryptionMode: "plaintext" | "encrypted"
encryptionPassphrase: string
```

Add defaults:

```ts
encryptionMode: "plaintext",
encryptionPassphrase: "",
```

- [ ] **Step 2: Add settings controls**

In `SettingTab.display()`, after GitHub token settings, add:

```ts
new Setting(set)
  .setName("Encrypted sync")
  .setDesc("Encrypt file contents, filenames, and folder structure before uploading to GitHub")
  .addToggle(toggle =>
    toggle.setValue(this.plugin.settings.encryptionMode === "encrypted").onChange(async value => {
      this.plugin.settings.encryptionMode = value ? "encrypted" : "plaintext";
      await this.plugin.saveSettings();
      this.display();
    })
  );

if (this.plugin.settings.encryptionMode === "encrypted") {
  new Setting(set)
    .setName("Encryption passphrase")
    .setDesc("Enter the same passphrase on every device. Losing it means the encrypted repo cannot be decrypted.")
    .addText(text => {
      text.inputEl.type = "password";
      text.setValue(this.plugin.settings.encryptionPassphrase).onChange(async value => {
        this.plugin.settings.encryptionPassphrase = value;
        await this.plugin.saveSettings();
      });
    });
}
```

- [ ] **Step 3: Route fs events to encrypted mode**

At the top of `src/lib/fs.ts`, import:

```ts
import { encryptedDelete, encryptedFullSync, encryptedModify, encryptedRename } from "./encrypted/sync-engine";
```

At the start of `NoteModify`, `NoteDelete`, and `NoteRename`, add:

```ts
if (plugin.settings.encryptionMode === "encrypted") {
  void encryptedModify(file, plugin, eventEnter);
  return;
}
```

Use `encryptedDelete` and `encryptedRename` in the matching functions.

At the start of `overrideRemoteAllFilesImpl()` and `syncAllFilesImpl()`, add:

```ts
if (plugin.settings.encryptionMode === "encrypted") {
  await encryptedFullSync(plugin);
  return;
}
```

- [ ] **Step 4: Disable stats upload in encrypted mode**

In `src/main.ts` `updateStats()`, add:

```ts
if (this.settings.encryptionMode === "encrypted") return;
```

- [ ] **Step 5: Build**

Run: `npm run build`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/setting.tsx src/lib/fs.ts src/main.ts
git commit -m "feat: route sync through encrypted mode"
```

## Task 8: Migration Guard And Documentation

**Files:**
- Modify: `README.md`
- Modify: `src/lib/encrypted/manifest-store.ts`
- Modify: `docs/superpowers/specs/2026-06-27-encrypted-obsidian-github-sync-design.md`

- [ ] **Step 1: Add plaintext repo guard**

In `EncryptedManifestStore.loadOrCreateConfig()`, before creating config, inspect the remote tree and block obvious plaintext repos:

```ts
const tree = await this.github.getTree().catch(() => null);
const plaintextBlob = tree?.tree.find(node =>
  node.type === "blob" &&
  !node.path.startsWith(".obsidian-github-sync-encrypted/") &&
  (node.path.endsWith(".md") || node.path.includes("/"))
);
if (plaintextBlob) {
  throw new Error("Encrypted sync cannot initialize in a repo that already contains plaintext files. Use an explicit migration flow first.");
}
```

- [ ] **Step 2: Document encrypted mode**

Add a README section:

```md
## Encrypted Sync Mode

Encrypted sync mode stores only non-secret format metadata in GitHub. Note contents, attachment bytes, filenames, and folder structure are encrypted before upload. Use the same passphrase on every device.

Do not enable encrypted mode against a repository that already contains plaintext notes unless you are intentionally running a migration. The first encrypted version does not silently remove old plaintext files.
```

- [ ] **Step 3: Build**

Run: `npm run build`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add README.md src/lib/encrypted/manifest-store.ts docs/superpowers/specs/2026-06-27-encrypted-obsidian-github-sync-design.md
git commit -m "docs: describe encrypted sync migration guard"
```

## Task 9: Final Verification

**Files:**
- Verify only.

- [ ] **Step 1: Install dependencies if needed**

Run: `npm install`

Expected: dependencies are present and lockfile remains consistent.

- [ ] **Step 2: Run tests**

Run: `npm test`

Expected: all `tests/encrypted/*.test.mjs` pass.

- [ ] **Step 3: Run production build**

Run: `npm run build`

Expected: TypeScript check and esbuild production bundle complete.

- [ ] **Step 4: Inspect git diff**

Run: `git diff --stat upstream/master...HEAD`

Expected: only encrypted sync implementation, tests, docs, and settings changes appear.

- [ ] **Step 5: Final commit if verification fixes were needed**

```bash
git add .
git commit -m "chore: verify encrypted sync implementation"
```

Only run this commit if Task 9 required follow-up code or doc fixes.

## Self-Review Notes

- Spec coverage: repo layout, config/manifest/object model, passphrase KDF, AES-GCM payloads, path privacy, conflict copies, case collision detection, migration guard, and failure-closed behavior are covered by Tasks 1-8.
- Intentional first-version gap: Argon2id is not implemented in this plan because the current project has no runtime dependencies and WebCrypto gives reliable PBKDF2/AES-GCM across Obsidian platforms. The config records KDF metadata so Argon2id can be added later.
- Remaining risk: true atomic file replacement depends on Obsidian Vault API support. The first implementation uses Obsidian `modifyBinary`/`createBinary`; a later hardening pass can add adapter-level temp file writes if the target platforms support them consistently.
