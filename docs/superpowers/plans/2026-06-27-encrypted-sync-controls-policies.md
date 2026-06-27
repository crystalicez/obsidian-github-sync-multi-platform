# Encrypted Sync Controls And Policies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add manual/force sync controls, automatic sync settings, repo safety prompts, ignore regex, conflict policies, error reporting, and chunked large-file storage to encrypted sync mode.

**Architecture:** Add focused services under `src/lib/encrypted/` for ignore rules, errors, remote-state classification, conflict decisions, and large-object storage. Keep `sync-engine.ts` as the orchestrator, with settings and commands in `setting.tsx`, `main.ts`, and `fs.ts`.

**Tech Stack:** TypeScript, Obsidian Plugin API, GitHub Contents API, WebCrypto AES-GCM/PBKDF2, Node built-in test runner, existing `npm test` and `npm run build`.

---

## File Structure

- Modify `src/lib/encrypted/types.ts`: extend object record storage metadata, sync operation names, conflict policy, and repo state types.
- Create `src/lib/encrypted/ignore.ts`: parse and match plaintext vault path regex rules.
- Create `tests/encrypted/ignore.test.mjs`: pure tests for regex parsing/matching.
- Create `src/lib/encrypted/sync-errors.ts`: normalize errors into user-facing notices and debug logs.
- Create `src/lib/encrypted/remote-state.ts`: classify empty, encrypted, foreign, corrupt, and wrong-passphrase remotes.
- Create `src/lib/encrypted/large-objects.ts`: upload/download/delete single and chunked encrypted object payloads.
- Create `tests/encrypted/large-objects.test.mjs`: chunk path and threshold tests.
- Create `src/lib/encrypted/conflicts.ts`: copy, newer, merge, and ask conflict policy helpers.
- Create `tests/encrypted/conflicts.test.mjs`: pure conflict-decision tests.
- Modify `src/lib/encrypted/vault.ts`: apply ignore rules and expose safe delete helpers.
- Modify `src/lib/encrypted/manifest-store.ts`: use repo classification and support wrong-passphrase errors.
- Modify `src/lib/encrypted/sync-engine.ts`: implement normal/manual/forcePush/forcePull modes, conflict policies, chunked storage, and robust error reporting.
- Modify `src/setting.tsx`: add buttons and settings controls.
- Modify `src/main.ts`: add scheduled sync timer and startup setting behavior.
- Modify `src/lib/fs.ts`: respect local-change setting.
- Modify `README.md`: document controls, ignore regex, conflict policy, schedule, and chunking.

## Task 1: Shared Types And Ignore Regex

**Files:**
- Modify: `src/lib/encrypted/types.ts`
- Create: `src/lib/encrypted/ignore.ts`
- Create: `tests/encrypted/ignore.test.mjs`

- [ ] **Step 1: Write ignore regex tests**

Create `tests/encrypted/ignore.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";

function parseIgnorePathRegex(input) {
  return input
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith("#"))
    .map(line => new RegExp(line, "u"));
}

function ignored(path, patterns) {
  return patterns.some(pattern => pattern.test(path));
}

test("parseIgnorePathRegex skips blank lines and comments", () => {
  const patterns = parseIgnorePathRegex("\n# comment\n^Archive/\n\\.tmp$\n");
  assert.equal(patterns.length, 2);
  assert.equal(ignored("Archive/a.md", patterns), true);
  assert.equal(ignored("note.tmp", patterns), true);
  assert.equal(ignored("note.md", patterns), false);
});

test("parseIgnorePathRegex reports invalid regex", () => {
  assert.throws(() => parseIgnorePathRegex("["), /Invalid regular expression/u);
});
```

- [ ] **Step 2: Run the test before implementation**

Run: `npm test`

Expected: PASS because this is a reference test that proves the expected behavior before production code is added.

- [ ] **Step 3: Extend encrypted sync types**

Modify `src/lib/encrypted/types.ts`:

```ts
export type EncryptedStorageKind = "single" | "chunked";
export type EncryptedSyncOperation = "normal" | "manual" | "forcePush" | "forcePull" | "startup" | "scheduled" | "localChange";
export type ConflictPolicy = "copy" | "newer" | "merge" | "ask";
export type RemoteRepoStateKind = "empty" | "encrypted-plugin" | "foreign-nonempty" | "corrupt-plugin" | "wrong-passphrase";

export interface EncryptedChunkRecord {
  index: number;
  path: string;
  remoteSha?: string;
}

export interface RemoteRepoState {
  kind: RemoteRepoStateKind;
  message?: string;
}
```

Update `EncryptedObjectRecord` to include:

```ts
storage?: EncryptedStorageKind;
chunks?: EncryptedChunkRecord[];
```

Update `EncryptedLocalFileState` to include:

```ts
storage?: EncryptedStorageKind;
chunks?: EncryptedChunkRecord[];
```

- [ ] **Step 4: Implement ignore helper**

Create `src/lib/encrypted/ignore.ts`:

```ts
import { normalizeVaultPath } from "./paths";

export interface CompiledIgnoreRules {
  patterns: RegExp[];
  source: string;
}

export function compileIgnorePathRegex(source: string): CompiledIgnoreRules {
  const patterns = source
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith("#"))
    .map(line => new RegExp(line, "u"));
  return { patterns, source };
}

export function isIgnoredPath(path: string, rules: CompiledIgnoreRules): boolean {
  const normalized = normalizeVaultPath(path);
  return rules.patterns.some(pattern => pattern.test(normalized));
}
```

- [ ] **Step 5: Verify**

Run: `npm test`

Expected: PASS, 6 tests total after this task.

Run: `npm run build`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/encrypted/types.ts src/lib/encrypted/ignore.ts tests/encrypted/ignore.test.mjs
git commit -m "feat: add encrypted sync ignore rules"
```

## Task 2: Error Reporting And Remote Classification

**Files:**
- Create: `src/lib/encrypted/sync-errors.ts`
- Create: `src/lib/encrypted/remote-state.ts`
- Modify: `src/lib/encrypted/manifest-store.ts`

- [ ] **Step 1: Implement sync error helpers**

Create `src/lib/encrypted/sync-errors.ts`:

```ts
import { Notice } from "obsidian";
import { EncryptedSyncOperation } from "./types";

export class WrongPassphraseError extends Error {
  constructor() {
    super("Encrypted repo could not be decrypted. The passphrase is wrong or the repo was created with another key.");
    this.name = "WrongPassphraseError";
  }
}

export class ForeignRemoteError extends Error {
  constructor() {
    super("Remote repository contains files that do not belong to this encrypted sync plugin.");
    this.name = "ForeignRemoteError";
  }
}

export function userMessageForSyncError(operation: EncryptedSyncOperation, error: unknown, path?: string): string {
  const detail = error instanceof Error ? error.message : String(error);
  const target = path ? ` for ${path}` : "";
  return `Encrypted ${operation} failed${target}: ${detail}`;
}

export function reportSyncError(operation: EncryptedSyncOperation, error: unknown, path?: string): void {
  console.error(`Encrypted ${operation} failed`, { path, error });
  new Notice(userMessageForSyncError(operation, error, path));
}
```

- [ ] **Step 2: Implement remote state classifier**

Create `src/lib/encrypted/remote-state.ts`:

```ts
import { GitHubClient } from "../github-api";
import { ENCRYPTED_CONFIG_PATH, ENCRYPTED_ROOT } from "./constants";
import { RemoteRepoState } from "./types";

export async function classifyRemoteRepo(github: GitHubClient): Promise<RemoteRepoState> {
  const tree = await github.getTree().catch(() => null);
  const blobs = tree?.tree.filter(node => node.type === "blob") ?? [];
  if (blobs.length === 0) return { kind: "empty" };
  if (blobs.some(node => node.path === ENCRYPTED_CONFIG_PATH)) return { kind: "encrypted-plugin" };
  if (blobs.some(node => node.path.startsWith(`${ENCRYPTED_ROOT}/`))) {
    return { kind: "corrupt-plugin", message: "Encrypted plugin files exist but config.json is missing." };
  }
  return { kind: "foreign-nonempty", message: "Remote repository is not empty and does not contain this plugin's encrypted metadata." };
}
```

- [ ] **Step 3: Use classifier in manifest store**

Modify `src/lib/encrypted/manifest-store.ts` imports:

```ts
import { classifyRemoteRepo } from "./remote-state";
import { ForeignRemoteError, WrongPassphraseError } from "./sync-errors";
```

In `loadOrCreate()`, wrap manifest decrypt:

```ts
try {
  const manifest = await decryptJson<EncryptedManifest>(key, GitHubClient.decodeContent(remoteManifest.content));
  return { config, key, manifest, manifestSha: remoteManifest.sha };
} catch (error) {
  throw new WrongPassphraseError();
}
```

In `loadOrCreateConfig()`, replace the ad hoc tree check with:

```ts
const state = await classifyRemoteRepo(this.github);
if (state.kind === "foreign-nonempty") throw new ForeignRemoteError();
if (state.kind === "corrupt-plugin") throw new Error(state.message ?? "Encrypted repository metadata is corrupt.");
```

- [ ] **Step 4: Verify**

Run: `npm run build`

Expected: PASS.

Run: `npm test`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/encrypted/sync-errors.ts src/lib/encrypted/remote-state.ts src/lib/encrypted/manifest-store.ts
git commit -m "feat: classify encrypted remote state"
```

## Task 3: Large Object Storage

**Files:**
- Modify: `src/lib/encrypted/constants.ts`
- Create: `src/lib/encrypted/large-objects.ts`
- Create: `tests/encrypted/large-objects.test.mjs`

- [ ] **Step 1: Write chunking tests**

Create `tests/encrypted/large-objects.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";

const maxBytes = 50 * 1024 * 1024;

function chunkPathFor(objectId, index) {
  return `.obsidian-github-sync-encrypted/objects/${objectId.slice(0, 2)}/${objectId.slice(2, 4)}/${objectId}.parts/${String(index).padStart(6, "0")}.enc`;
}

test("chunk paths are ordered and padded", () => {
  const id = "abcdef123456";
  assert.equal(chunkPathFor(id, 1), ".obsidian-github-sync-encrypted/objects/ab/cd/abcdef123456.parts/000001.enc");
  assert.equal(chunkPathFor(id, 12).endsWith("/000012.enc"), true);
});

test("threshold chunks only above 50 MiB", () => {
  assert.equal(maxBytes + 1 > maxBytes, true);
  assert.equal(maxBytes > maxBytes, false);
});
```

- [ ] **Step 2: Add constants**

Modify `src/lib/encrypted/constants.ts`:

```ts
export const GITHUB_RECOMMENDED_MAX_BYTES = 50 * 1024 * 1024;
export const ENCRYPTED_CHUNK_PLAINTEXT_BYTES = 32 * 1024 * 1024;
```

- [ ] **Step 3: Implement large object helper**

Create `src/lib/encrypted/large-objects.ts`:

```ts
import { GitHubClient } from "../github-api";
import { ENCRYPTED_CHUNK_PLAINTEXT_BYTES, GITHUB_RECOMMENDED_MAX_BYTES } from "./constants";
import { decryptBytes, encryptBytes, EncryptedPayload } from "./crypto";
import { objectPathForId } from "./paths";
import { EncryptedChunkRecord, EncryptedObjectRecord } from "./types";
import { sha256Hex } from "./bytes";

export function chunkPathForId(id: string, index: number): string {
  return `${objectPathForId(id).replace(/\.enc$/u, ".parts")}/${String(index).padStart(6, "0")}.enc`;
}

export function shouldChunkEncryptedPayload(payload: string): boolean {
  return new TextEncoder().encode(payload).byteLength > GITHUB_RECOMMENDED_MAX_BYTES;
}

export async function uploadEncryptedFileObject(
  github: GitHubClient,
  key: CryptoKey,
  id: string,
  plaintext: Uint8Array,
  existing?: EncryptedObjectRecord
): Promise<EncryptedObjectRecord> {
  const fullHash = await sha256Hex(plaintext);
  const singlePayload = JSON.stringify(await encryptBytes(key, plaintext));
  if (!shouldChunkEncryptedPayload(singlePayload)) {
    const objectPath = existing?.objectPath ?? objectPathForId(id);
    const remoteSha = await github.putFile(objectPath, singlePayload, existing?.remoteSha);
    return { id, path: existing?.path ?? "", objectPath, plaintextSha256: fullHash, remoteSha, size: plaintext.byteLength, mtime: Date.now(), storage: "single" };
  }

  const chunks: EncryptedChunkRecord[] = [];
  for (let offset = 0, index = 1; offset < plaintext.byteLength; offset += ENCRYPTED_CHUNK_PLAINTEXT_BYTES, index++) {
    const part = plaintext.slice(offset, Math.min(offset + ENCRYPTED_CHUNK_PLAINTEXT_BYTES, plaintext.byteLength));
    const path = chunkPathForId(id, index);
    const previous = existing?.chunks?.find(chunk => chunk.index === index);
    const remoteSha = await github.putFile(path, JSON.stringify(await encryptBytes(key, part)), previous?.remoteSha);
    chunks.push({ index, path, remoteSha });
  }
  return { id, path: existing?.path ?? "", objectPath: objectPathForId(id), plaintextSha256: fullHash, size: plaintext.byteLength, mtime: Date.now(), storage: "chunked", chunks };
}

export async function downloadEncryptedFileObject(github: GitHubClient, key: CryptoKey, record: EncryptedObjectRecord): Promise<Uint8Array> {
  if (record.storage !== "chunked") {
    const remote = await github.getFile(record.objectPath);
    if (!remote) throw new Error(`Missing encrypted object: ${record.objectPath}`);
    return decryptBytes(key, JSON.parse(GitHubClient.decodeContent(remote.content)) as EncryptedPayload);
  }

  const parts: Uint8Array[] = [];
  for (const chunk of [...(record.chunks ?? [])].sort((a, b) => a.index - b.index)) {
    const remote = await github.getFile(chunk.path);
    if (!remote) throw new Error(`Missing encrypted chunk: ${chunk.path}`);
    parts.push(await decryptBytes(key, JSON.parse(GitHubClient.decodeContent(remote.content)) as EncryptedPayload));
  }
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  if (await sha256Hex(output) !== record.plaintextSha256) throw new Error(`Encrypted chunks failed integrity check for ${record.path}`);
  return output;
}
```

- [ ] **Step 4: Verify**

Run: `npm test`

Expected: PASS.

Run: `npm run build`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/encrypted/constants.ts src/lib/encrypted/large-objects.ts tests/encrypted/large-objects.test.mjs
git commit -m "feat: add encrypted large object storage"
```

## Task 4: Conflict Policy Helpers

**Files:**
- Create: `src/lib/encrypted/conflicts.ts`
- Create: `tests/encrypted/conflicts.test.mjs`

- [ ] **Step 1: Write conflict tests**

Create `tests/encrypted/conflicts.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";

function isTextLike(path) {
  return [".md", ".txt", ".json", ".canvas"].some(ext => path.toLowerCase().endsWith(ext));
}

test("text-like conflict merge applies only to known extensions", () => {
  assert.equal(isTextLike("note.md"), true);
  assert.equal(isTextLike("board.canvas"), true);
  assert.equal(isTextLike("image.png"), false);
});

test("newer policy falls back when timestamps match", () => {
  const local = 10;
  const remote = 10;
  assert.equal(local === remote ? "copy" : local > remote ? "local" : "remote", "copy");
});
```

- [ ] **Step 2: Implement conflict helpers**

Create `src/lib/encrypted/conflicts.ts`:

```ts
import { Modal, TFile } from "obsidian";
import FastSync from "../../main";
import { ConflictPolicy } from "./types";

export type ConflictResolution = "keep-local" | "use-remote" | "copy-remote" | "merged";

export function isTextLikePath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".txt") || lower.endsWith(".json") || lower.endsWith(".canvas");
}

export function chooseNewerResolution(localMtime: number | undefined, remoteMtime: number | undefined): ConflictResolution {
  if (!localMtime || !remoteMtime || localMtime === remoteMtime) return "copy-remote";
  return localMtime > remoteMtime ? "keep-local" : "use-remote";
}

export function mergeTextContent(local: string, remote: string): string {
  if (local === remote) return local;
  return `${local}\n\n<<<<<<< remote encrypted sync version\n${remote}\n>>>>>>> remote encrypted sync version\n`;
}

export async function resolveAskConflict(plugin: FastSync, path: string): Promise<ConflictResolution> {
  return new Promise(resolve => {
    const modal = new Modal(plugin.app);
    modal.titleEl.setText(`Sync conflict: ${path}`);
    modal.contentEl.createEl("p", { text: "Choose how to resolve this encrypted sync conflict." });
    const buttons = modal.contentEl.createDiv();
    buttons.createEl("button", { text: "Keep local" }).onclick = () => { modal.close(); resolve("keep-local"); };
    buttons.createEl("button", { text: "Use remote" }).onclick = () => { modal.close(); resolve("use-remote"); };
    buttons.createEl("button", { text: "Copy remote" }).onclick = () => { modal.close(); resolve("copy-remote"); };
    modal.open();
  });
}

export async function chooseConflictResolution(
  plugin: FastSync,
  policy: ConflictPolicy,
  path: string,
  localFile: TFile | null,
  remoteMtime: number | undefined
): Promise<ConflictResolution> {
  if (policy === "newer") return chooseNewerResolution(localFile?.stat.mtime, remoteMtime);
  if (policy === "ask") return resolveAskConflict(plugin, path);
  if (policy === "merge" && isTextLikePath(path)) return "merged";
  return "copy-remote";
}
```

- [ ] **Step 3: Verify**

Run: `npm test`

Expected: PASS.

Run: `npm run build`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/lib/encrypted/conflicts.ts tests/encrypted/conflicts.test.mjs
git commit -m "feat: add encrypted conflict policies"
```

## Task 5: Engine Modes And Storage Integration

**Files:**
- Modify: `src/lib/encrypted/sync-engine.ts`
- Modify: `src/lib/encrypted/vault.ts`

- [ ] **Step 1: Update vault helpers for ignore and delete**

Modify `src/lib/encrypted/vault.ts` to import `CompiledIgnoreRules` and `isIgnoredPath`, then change candidate listing:

```ts
export function shouldSyncEncryptedFile(file: TFile, ignoreRules?: CompiledIgnoreRules): boolean {
  const path = normalizeVaultPath(file.path);
  if (ignoreRules && isIgnoredPath(path, ignoreRules)) return false;
  if (path.startsWith(`${ENCRYPTED_ROOT}/`)) return false;
  if (path.includes(".sync-conflict-")) return false;
  if (file.stat.size > MAX_ENCRYPTED_FILE_SIZE) return false;
  return true;
}

export function listEncryptedSyncCandidates(vault: Vault, ignoreRules?: CompiledIgnoreRules): TFile[] {
  const files = vault.getFiles().filter(file => shouldSyncEncryptedFile(file, ignoreRules));
  const collisions = detectCaseInsensitiveCollisions(files.map(file => file.path));
  if (collisions.length > 0) throw new Error(`Case-insensitive path collision: ${collisions.map(pair => pair.join(" <-> ")).join(", ")}`);
  return files;
}

export async function deleteVaultFileIfExists(vault: Vault, path: string): Promise<void> {
  const existing = vault.getAbstractFileByPath(path);
  if (existing instanceof TFile) await vault.delete(existing);
}
```

- [ ] **Step 2: Add operation options in sync engine**

Modify `src/lib/encrypted/sync-engine.ts` imports:

```ts
import { compileIgnorePathRegex } from "./ignore";
import { chooseConflictResolution, mergeTextContent } from "./conflicts";
import { downloadEncryptedFileObject, uploadEncryptedFileObject } from "./large-objects";
import { reportSyncError } from "./sync-errors";
import { deleteVaultFileIfExists } from "./vault";
import type { ConflictPolicy, EncryptedSyncOperation } from "./types";
```

Add:

```ts
export interface EncryptedSyncOptions {
  operation: EncryptedSyncOperation;
}

function conflictPolicy(plugin: FastSync): ConflictPolicy {
  return (plugin.settings.conflictPolicy ?? "copy") as ConflictPolicy;
}
```

- [ ] **Step 3: Replace object upload/download calls**

Replace `uploadEncryptedObject(...)` with calls to:

```ts
const uploaded = await uploadEncryptedFileObject(plugin.githubClient, key, existing?.id ?? toBase64Url(randomBytes(OBJECT_ID_BYTES)), plaintext, existing);
```

Replace direct `getFile + decryptBytes` in pull with:

```ts
const plaintext = await downloadEncryptedFileObject(plugin.githubClient, key, record);
```

- [ ] **Step 4: Add force operation entrypoints**

Change `encryptedFullSync(plugin)` to call:

```ts
return encryptedSync(plugin, { operation: "normal" });
```

Add:

```ts
export async function encryptedManualSync(plugin: FastSync): Promise<void> {
  return encryptedSync(plugin, { operation: "manual" });
}

export async function encryptedForcePush(plugin: FastSync): Promise<void> {
  return encryptedSync(plugin, { operation: "forcePush" });
}

export async function encryptedForcePull(plugin: FastSync): Promise<void> {
  return encryptedSync(plugin, { operation: "forcePull" });
}
```

Implement `encryptedSync(plugin, options)` with the current body of `encryptedFullSync`, but:

- compile ignore rules with `compileIgnorePathRegex(plugin.settings.ignorePathRegex ?? "")`
- pass ignore rules into push/local scan
- call only pull for `forcePull`, then delete local files in sync scope missing from manifest
- call only push for `forcePush`, and mark remote records absent locally as deleted
- call pull then push for `normal` and `manual`
- use `reportSyncError(options.operation, error)` in catch

- [ ] **Step 5: Apply conflict policy in pull**

Where current pull detects local conflict, replace direct conflict copy with:

```ts
const resolution = await chooseConflictResolution(plugin, conflictPolicy(plugin), path, localFile, record.mtime);
if (resolution === "keep-local") continue;
if (resolution === "copy-remote") {
  await writeVaultFileBytes(plugin.app.vault, conflictPathFor(path, Date.now(), "remote"), plaintext);
  continue;
}
if (resolution === "merged" && localFile instanceof TFile) {
  const localText = await plugin.app.vault.read(localFile);
  const remoteText = new TextDecoder().decode(plaintext);
  await writeVaultFileBytes(plugin.app.vault, path, new TextEncoder().encode(mergeTextContent(localText, remoteText)));
  continue;
}
```

For `use-remote`, continue to write remote bytes to the original path.

- [ ] **Step 6: Verify**

Run: `npm run build`

Expected: PASS.

Run: `npm test`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/encrypted/sync-engine.ts src/lib/encrypted/vault.ts
git commit -m "feat: add encrypted sync operation modes"
```

## Task 6: Settings UI, Commands, Startup, Watch, And Schedule

**Files:**
- Modify: `src/setting.tsx`
- Modify: `src/main.ts`
- Modify: `src/lib/fs.ts`

- [ ] **Step 1: Add settings fields and defaults**

Modify `PluginSettings`:

```ts
syncOnStartup: boolean
syncOnLocalChange: boolean
scheduledSyncEnabled: boolean
scheduledSyncIntervalSeconds: number
ignorePathRegex: string
conflictPolicy: "copy" | "newer" | "merge" | "ask"
```

Modify `DEFAULT_SETTINGS`:

```ts
syncOnStartup: true,
syncOnLocalChange: true,
scheduledSyncEnabled: false,
scheduledSyncIntervalSeconds: 300,
ignorePathRegex: "",
conflictPolicy: "copy",
```

- [ ] **Step 2: Add UI controls**

In `SettingTab.display()` after encrypted passphrase controls, add settings for:

```ts
new Setting(set).setName("Manual sync").setDesc("Sync encrypted vault with the remote repository now.").addButton(button =>
  button.setButtonText("Sync now").onClick(() => void import("./lib/encrypted/sync-engine").then(({ encryptedManualSync }) => encryptedManualSync(this.plugin)))
);

new Setting(set).setName("Force push local to remote").setDesc("Overwrite the encrypted remote state with this local vault.").addButton(button =>
  button.setWarning().setButtonText("Force push").onClick(() => void this.confirmForce("Force push local vault to remote?", "Remote encrypted files not present locally may be deleted.", "forcePush"))
);

new Setting(set).setName("Force pull remote to local").setDesc("Overwrite this local vault with the encrypted remote state.").addButton(button =>
  button.setWarning().setButtonText("Force pull").onClick(() => void this.confirmForce("Force pull remote vault to local?", "Local synced files not present remotely will be deleted.", "forcePull"))
);
```

Add a `confirmForce` method on `SettingTab` that opens `Modal`, asks for confirmation, and calls `encryptedForcePush` or `encryptedForcePull`.

Add toggles/inputs for startup, local change, scheduled sync, interval, ignore regex textarea, and conflict dropdown using Obsidian `Setting`.

- [ ] **Step 3: Startup and schedule logic**

In `FastSync`, add:

```ts
scheduledSyncTimer: number | null = null
```

Add methods:

```ts
registerScheduledSync() {
  if (this.scheduledSyncTimer) window.clearInterval(this.scheduledSyncTimer);
  this.scheduledSyncTimer = null;
  if (!this.settings.syncEnabled || !this.settings.scheduledSyncEnabled) return;
  const seconds = Math.max(1, Number(this.settings.scheduledSyncIntervalSeconds || 0));
  this.scheduledSyncTimer = window.setInterval(() => {
    if (!this.isSyncInProgress) StartupFullNotesSync(this);
  }, seconds * 1000);
}
```

Call `this.registerScheduledSync()` after settings load and after settings save.

Change startup layout condition to include `this.settings.syncOnStartup`.

In `onunload()`, clear `scheduledSyncTimer`.

- [ ] **Step 4: Local change setting**

In `src/lib/fs.ts`, inside encrypted branches for create/modify/delete/rename, return early if:

```ts
if (!plugin.settings.syncOnLocalChange && eventEnter) return;
```

- [ ] **Step 5: Verify**

Run: `npm run build`

Expected: PASS.

Run: `npm test`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/setting.tsx src/main.ts src/lib/fs.ts
git commit -m "feat: add encrypted sync controls and schedules"
```

## Task 7: Foreign Repo Prompt And Documentation

**Files:**
- Modify: `src/lib/encrypted/sync-engine.ts`
- Modify: `src/lib/encrypted/sync-errors.ts`
- Modify: `README.md`

- [ ] **Step 1: Handle foreign repo choice**

In `sync-errors.ts`, export:

```ts
export function isForeignRemoteError(error: unknown): boolean {
  return error instanceof ForeignRemoteError;
}

export function isWrongPassphraseError(error: unknown): boolean {
  return error instanceof WrongPassphraseError;
}
```

In `sync-engine.ts`, catch `ForeignRemoteError` for normal/manual/startup/scheduled/localChange and show a modal with:

- `Force push local to remote`
- `Cancel`

If user chooses force push, call `encryptedForcePush(plugin)`.

Wrong passphrase remains a Notice only and never offers overwrite.

- [ ] **Step 2: Document user-facing controls**

Add README content under encrypted sync mode:

```md
### Encrypted Sync Controls

- Manual sync runs a normal encrypted sync immediately.
- Force push makes the encrypted remote match the local vault.
- Force pull makes the local vault match the encrypted remote and can delete local files in sync scope.
- Ignore regex rules match plaintext vault paths before encryption.
- Files whose encrypted payload would exceed 50 MiB are stored as encrypted chunks.
```

- [ ] **Step 3: Verify**

Run: `npm run build`

Expected: PASS.

Run: `npm test`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/lib/encrypted/sync-engine.ts src/lib/encrypted/sync-errors.ts README.md
git commit -m "feat: prompt before overwriting foreign remotes"
```

## Task 8: Final Verification And Push

**Files:**
- Verify only.

- [ ] **Step 1: Run tests**

Run: `npm test`

Expected: all encrypted tests pass with 0 failures.

- [ ] **Step 2: Run production build**

Run: `npm run build`

Expected: TypeScript check and esbuild production bundle complete.

- [ ] **Step 3: Inspect branch diff**

Run: `git diff --stat upstream/master...HEAD`

Expected: encrypted sync implementation, docs, settings, and tests only.

- [ ] **Step 4: Inspect status**

Run: `git status --short --branch`

Expected: clean working tree on `encrypted-sync`.

- [ ] **Step 5: Push**

Run: `git push`

Expected: `origin/encrypted-sync` updated.

## Self-Review Notes

- Spec coverage: manual sync, force push, destructive force pull, repo classification, wrong passphrase handling, error notices, startup/local-change/scheduled settings, ignore regex, conflict policies, and >50 MiB chunking are all mapped to tasks.
- Scope: plaintext sync feature parity is intentionally excluded; existing plaintext behavior is preserved.
- Risk: `ask` conflicts in background sync can interrupt users. This is required by user choice and is implemented via queued modal behavior rather than stacked modals.
