# Opaque Stable Encrypted Paths Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the folder-preserving encrypted layout with deterministic stable opaque objects so encrypted Git paths reveal no vault path segment while file history survives file and folder renames.

**Architecture:** Complete logical paths remain only in AES-GCM encrypted index and journal payloads. Content, parts, and packs use keyed stable identifiers derived from `fileId`, distributed across fixed two-hex-character technical buckets; path layout is an explicit protocol field and the old encrypted layout can only migrate through confirmed Force Push.

**Tech Stack:** TypeScript 5.9, Obsidian API 1.12, Web Crypto HMAC-SHA-256/AES-256-GCM, GitHub REST Git Database API, Node test runner, esbuild.

## Global Constraints

- Encrypted Git paths and payloads must reveal no plaintext directory name, directory depth, filename, extension, complete logical path, plaintext content, or plaintext hash.
- Opaque object paths must be deterministic for one repository and stable `fileId`, stable across content updates and logical renames, and different across repositories or file identities.
- Technical buckets are exactly the first two hexadecimal characters of a 64-character keyed object identifier and do not model vault directories.
- Plaintext mode keeps normalized vault paths unchanged.
- Existing encrypted repositories without `pathLayout: "opaque-stable-v1"` require confirmed Force Push; normal sync and Force Pull reject them before content or local writes.
- One sync publishes content, encrypted metadata, journal pages, and deletions in one compare-and-swap Git commit.
- Use TDD for every task and do not weaken the existing 50 MiB split threshold, 48 MiB part size, five-second debounce, modification guard, or no-change fast path.

---

### Task 1: Path-layout protocol and stable object identities

**Files:**
- Modify: `src/lib/v4/protocol-types.ts`
- Modify: `src/lib/v4/paths.ts`
- Modify: `src/lib/v4/remote-index.ts`
- Test: `tests/v4/protocol-core.test.ts`
- Test: `tests/v4/remote-index.test.ts`

**Interfaces:**
- Produces: `V4PathLayout`, `expectedV4PathLayout(mode)`, `effectiveV4PathLayout(config)`, `objectIdForV4File(pathKey, fileId)`, `opaqueV4ObjectPath(pathKey, fileId)` and `opaqueV4PackPath(pathKey, packId)`.
- `effectiveV4PathLayout` returns `"encrypted-folders-v0"` only as a legacy sentinel; it is never written into a new config.

- [ ] **Step 1: Replace the old folder-preservation assertions with failing opaque identity tests**

```ts
test("v4 encrypted object identity is stable by file identity and repository key", async () => {
  const keyA = new Uint8Array(32).fill(3);
  const keyB = new Uint8Array(32).fill(4);
  const first = await opaqueV4ObjectPath(keyA, "file-1");
  assert.equal(first, await opaqueV4ObjectPath(keyA, "file-1"));
  assert.notEqual(first, await opaqueV4ObjectPath(keyA, "file-2"));
  assert.notEqual(first, await opaqueV4ObjectPath(keyB, "file-1"));
  assert.match(first, /^\.obsidian-github-sync-v4\/data\/[0-9a-f]{2}\/[0-9a-f]{64}\.enc$/u);
  assert.doesNotMatch(first, /Projects|Secret|note|\.md/u);
});

test("v4 path layout distinguishes new plaintext, new encrypted, and legacy encrypted configs", () => {
  assert.equal(expectedV4PathLayout("plaintext"), "plaintext-v1");
  assert.equal(expectedV4PathLayout("encrypted"), "opaque-stable-v1");
  assert.equal(effectiveV4PathLayout({ formatVersion: 4, mode: "encrypted", repoId: "o/r#main" }), "encrypted-folders-v0");
});
```

- [ ] **Step 2: Run the suite and verify RED**

Run: `npm test`

Expected: FAIL because `opaqueV4ObjectPath`, `expectedV4PathLayout`, and `effectiveV4PathLayout` do not exist and the current path contains plaintext folders.

- [ ] **Step 3: Add the protocol field and keyed identity helpers**

```ts
export type V4PathLayout = "plaintext-v1" | "opaque-stable-v1";
export type V4EffectivePathLayout = V4PathLayout | "encrypted-folders-v0";

export interface V4RemoteConfig {
  formatVersion: typeof V4_FORMAT_VERSION;
  mode: V4StorageMode;
  repoId: string;
  pathLayout?: V4PathLayout;
  // existing crypto fields remain unchanged
}

export function expectedV4PathLayout(mode: V4StorageMode): V4PathLayout {
  return mode === "encrypted" ? "opaque-stable-v1" : "plaintext-v1";
}

export function effectiveV4PathLayout(config: V4RemoteConfig): V4EffectivePathLayout {
  return config.pathLayout ?? (config.mode === "encrypted" ? "encrypted-folders-v0" : "plaintext-v1");
}

export async function objectIdForV4File(pathKey: Uint8Array, fileId: string): Promise<string> {
  if (!fileId) throw new Error("V4 file identity is required for an opaque object path.");
  return toHex(await hmac(pathKey, `object-id:${fileId}`));
}

export async function opaqueV4ObjectPath(pathKey: Uint8Array, fileId: string): Promise<string> {
  const objectId = await objectIdForV4File(pathKey, fileId);
  return `${V4_ROOT}/data/${objectId.slice(0, 2)}/${objectId}.enc`;
}

export async function opaqueV4PackPath(pathKey: Uint8Array, packId: string): Promise<string> {
  const objectId = toHex(await hmac(pathKey, `pack-id:${packId}`));
  return `${V4_ROOT}/packs/${objectId.slice(0, 2)}/${objectId}.enc`;
}
```

Update new config fixtures to write `pathLayout: expectedV4PathLayout(mode)` while keeping decoding permissive enough to identify the legacy sentinel.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `npm test`

Expected: all protocol and remote-index tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/v4/protocol-types.ts src/lib/v4/paths.ts src/lib/v4/remote-index.ts tests/v4/protocol-core.test.ts tests/v4/remote-index.test.ts
git commit -m "feat: define opaque stable V4 path layout"
```

---

### Task 2: Opaque single-file, part, and pack storage

**Files:**
- Modify: `src/lib/v4/storage-codec.ts`
- Modify: `src/lib/v4/large-files.ts`
- Modify: `src/lib/v4/sync-session.ts`
- Test: `tests/v4/storage-codec.test.ts`
- Test: `tests/v4/storage-history.test.ts`

**Interfaces:**
- Consumes: `opaqueV4ObjectPath`, `opaqueV4PackPath`, `objectIdForV4File`, `V4RemoteConfig.pathLayout`.
- Changes `V4StorageCodec` constructor to `{ mode, pathLayout, keyring? }`.
- Changes encrypted content/part AAD from path-based identity to stable file identity for `opaque-stable-v1`.
- Changes `preparePack(folder, packId, entries)` to `preparePack(packId, entries)`; grouping may remain folder-local in memory but no folder reaches the remote path.
- Update every codec call site in `sync-session.ts`, `history-service.ts`, and their tests to pass `expectedV4PathLayout(mode)` or the decoded config layout in the same task so the task ends type-correct.

- [ ] **Step 1: Write failing leakage and rename-stability tests**

```ts
test("v4 encrypted codec hides the complete path and keeps one object path across rename", async () => {
  const keys = await deriveV4Keyring({ passphrase: "pass", repoId: "o/r#main", salt: bytes("salt"), iterations: 10 });
  const codec = new V4StorageCodec({ mode: "encrypted", pathLayout: "opaque-stable-v1", keyring: keys });
  const before = await codec.prepare("Projects/Secret/note.md", bytes("body"), "v1", 1, "stable-file");
  const after = await codec.prepare("Archive/renamed.txt", bytes("body 2"), "v2", 2, "stable-file");
  assert.equal(before.record.remotePath, after.record.remotePath);
  for (const segment of ["Projects", "Secret", "note", "md", "Archive", "renamed", "txt"]) {
    assert.equal(before.record.remotePath.includes(segment), false);
    assert.equal(after.record.remotePath.includes(segment), false);
  }
  assert.equal(new TextDecoder().decode(await codec.read(after.record, async () => after.files[0].bytes)), "body 2");
});

test("v4 encrypted part and pack paths contain only protocol coordinates", async () => {
  const keys = await deriveV4Keyring({ passphrase: "pass", repoId: "o/r#main", salt: bytes("salt"), iterations: 10 });
  const codec = new V4StorageCodec({ mode: "encrypted", pathLayout: "opaque-stable-v1", keyring: keys });
  const chunked = await codec.prepare("Private/large-secret.md", new Uint8Array(V4_LARGE_FILE_THRESHOLD_BYTES + 1), "v-large", 1, "large-file");
  const packedInput = await codec.prepare("Folder/secret.md", bytes("secret"), "v-pack", 1, "packed-file");
  const packed = await codec.preparePack("pack-1", [{ record: packedInput.record, plaintext: bytes("secret") }]);
  assert.match(chunked.record.partPaths![0], /^\.obsidian-github-sync-v4\/parts\/[0-9a-f]{2}\/[0-9a-f]{64}\/v-large\/000001\.enc$/u);
  assert.match(packed.file.path, /^\.obsidian-github-sync-v4\/packs\/[0-9a-f]{2}\/[0-9a-f]{64}\.enc$/u);
  assert.doesNotMatch([...chunked.record.partPaths!, packed.file.path].join("\n"), /Private|Folder|secret|\.md/u);
});
```

- [ ] **Step 2: Run and verify RED**

Run: `npm test`

Expected: FAIL because constructors lack `pathLayout`, encrypted paths expose `Projects`, `Archive`, or pack folders, and rename changes the remote basename token.

- [ ] **Step 3: Implement stable paths and stable AAD**

```ts
export class V4StorageCodec {
  constructor(private readonly options: { mode: V4StorageMode; pathLayout: V4PathLayout; keyring?: V4Keyring }) {}

  private contentAad(record: { fileId: string; pathId: string; remoteVersion: string }): string {
    return this.options.pathLayout === "opaque-stable-v1"
      ? `${record.fileId}:${record.remoteVersion}`
      : `${record.pathId}:${record.remoteVersion}`;
  }
}
```

In `prepare`, compute `stableFileId = fileId ?? pathId`, use `opaqueV4ObjectPath(pathKey, stableFileId)`, and bind AES-GCM content and parts to `stableFileId`. Build encrypted part paths as:

```ts
const objectId = await objectIdForV4File(pathKey, fileId);
const prefix = `${V4_ROOT}/parts/${objectId.slice(0, 2)}/${objectId}/${version}`;
```

Use `opaqueV4PackPath(pathKey, packId)` in `preparePack`; remove `normalizedFolder` from remote path construction and update the sync-session call site.

- [ ] **Step 4: Run and verify GREEN**

Run: `npm test`

Expected: storage, parts, packs, encryption, and history descriptor tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/v4/storage-codec.ts src/lib/v4/large-files.ts src/lib/v4/sync-session.ts tests/v4/storage-codec.test.ts tests/v4/storage-history.test.ts
git commit -m "feat: store encrypted V4 objects at opaque paths"
```

---

### Task 3: Persist and validate path-layout compatibility

**Files:**
- Modify: `src/lib/v4/local-index.ts`
- Modify: `src/lib/v4/runtime.ts`
- Modify: `src/lib/v4/sync-session.ts`
- Modify: `src/lib/v4/history-service.ts`
- Test: `tests/v4/local-index.test.ts`
- Test: `tests/v4/settings-secrets.test.ts`
- Test: `tests/v4/sync-session.test.ts`

**Interfaces:**
- Adds required `pathLayout: V4PathLayout` to `V4LocalIndex` and `createEmptyV4LocalIndex` input.
- Runtime-created configs always include the expected layout.
- Normal sync, Force Pull, and history reject `encrypted-folders-v0`; Force Push may select `opaque-stable-v1` for migration.
- Produces: `assertV4PathLayoutCompatible(remote, desired, operation): void` for session/runtime guards.

- [ ] **Step 1: Write failing persistence and rejection tests**

```ts
test("v4 local index persists the selected path layout", async () => {
  const index = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "d", mode: "encrypted", pathLayout: "opaque-stable-v1" });
  await saveV4LocalIndexHeader(adapter, "index", index);
  assert.equal((await loadV4LocalIndex(adapter, "index")).pathLayout, "opaque-stable-v1");
});

test("v4 rejects legacy encrypted layout except for Force Push migration", () => {
  const legacy = { formatVersion: 4 as const, mode: "encrypted" as const, repoId: "o/r#main" };
  const desired = { ...legacy, pathLayout: "opaque-stable-v1" as const };
  assert.throws(() => assertV4PathLayoutCompatible(legacy, desired, "normal"), /Force Push/iu);
  assert.throws(() => assertV4PathLayoutCompatible(legacy, desired, "forcePull"), /Force Push/iu);
  assert.doesNotThrow(() => assertV4PathLayoutCompatible(legacy, desired, "forcePush"));
});
```

- [ ] **Step 2: Run and verify RED**

Run: `npm test`

Expected: FAIL because local indexes do not persist `pathLayout` and the session accepts a missing encrypted layout.

- [ ] **Step 3: Implement exact layout selection and guards**

```ts
export function assertV4PathLayoutCompatible(remote: V4RemoteConfig, desired: V4RemoteConfig, operation: V4SyncOperation): void {
  const actual = effectiveV4PathLayout(remote);
  const expected = expectedV4PathLayout(desired.mode);
  if (actual === expected) return;
  if (operation === "forcePush") return;
  throw new Error(`Remote encrypted path layout is ${actual}; confirmed Force Push is required to migrate to ${expected}.`);
}
```

Make runtime config creation return `pathLayout: expectedV4PathLayout(mode)`. Reuse the old encrypted config's salt/KDF parameters during Force Push but replace its layout with `opaque-stable-v1`. Rebuild a local index whenever repo ID, mode, or path layout differs. Keep `createEmptyV4LocalIndex` input backward-compatible as `pathLayout?: V4PathLayout`, always persisting `input.pathLayout ?? expectedV4PathLayout(input.mode)`. Construct history and storage codecs with the config layout.

- [ ] **Step 4: Run and verify GREEN**

Run: `npm test`

Expected: local-index, runtime configuration, rejection, and history tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/v4/local-index.ts src/lib/v4/runtime.ts src/lib/v4/sync-session.ts src/lib/v4/history-service.ts tests/v4/local-index.test.ts tests/v4/settings-secrets.test.ts tests/v4/sync-session.test.ts
git commit -m "feat: enforce V4 encrypted path layout compatibility"
```

---

### Task 4: Preserve descendant identity through folder events

**Files:**
- Modify: `src/lib/v4/sync-coordinator.ts`
- Modify: `src/lib/v4/runtime.ts`
- Modify: `src/lib/v4/sync-session.ts`
- Modify: `src/main.ts`
- Modify: `tests/stubs/obsidian.ts`
- Test: `tests/v4/sync-coordinator.test.ts`
- Test: `tests/v4/sync-session.test.ts`

**Interfaces:**
- Replaces identity-losing folder `rescan` events with `folderRename` and `folderDelete` queue entries.
- Produces `enqueueFolderRename(oldPath, path)` and `enqueueFolderDelete(path)` runtime entrypoints.
- `scanLocal` applies prefix mappings to indexed descendant identities before scanning final vault state.
- Adds test helper `indexRecordByPath(index, path)` in `sync-session.test.ts` for identity assertions in Tasks 4 and 5.

- [ ] **Step 1: Write failing coalescing and identity tests**

```ts
test("v4 folder rename keeps descendant changes as one prefix mapping", () => {
  assert.deepEqual(coalesceV4Changes([
    { type: "folderRename", oldPath: "A", path: "B", mtime: 1 },
    { type: "modify", path: "B/note.md", mtime: 2 },
  ]), [
    { type: "folderRename", oldPath: "A", path: "B", mtime: 1 },
    { type: "modify", path: "B/note.md", mtime: 2 },
  ]);
});

test("v4 nested folder rename preserves descendant fileId and opaque remotePath", async () => {
  const before = indexRecordByPath(index, "A/Nested/note.md");
  const file = vault.files.get("A/Nested/note.md")!;
  vault.files.delete("A/Nested/note.md");
  vault.files.set("B/Nested/note.md", { ...file, mtime: 2 });
  await session().sync({
    operation: "normal",
    allowThresholdOverride: false,
    changes: [{ type: "folderRename", oldPath: "A", path: "B", mtime: 2 }],
  });
  const after = indexRecordByPath(index, "B/Nested/note.md");
  assert.equal(after.fileId, before.fileId);
  assert.equal(after.remotePath, before.remotePath);
});
```

- [ ] **Step 2: Run and verify RED**

Run: `npm test`

Expected: FAIL because folder events collapse to `rescan` and the renamed descendants receive new identities.

- [ ] **Step 3: Add explicit folder event types and prefix identity mapping**

```ts
export type V4QueuedChange =
  | { type: "modify"; path: string; mtime: number }
  | { type: "delete"; path: string; mtime: number }
  | { type: "rename"; oldPath: string; path: string; mtime: number }
  | { type: "folderRename"; oldPath: string; path: string; mtime: number }
  | { type: "folderDelete"; path: string; mtime: number }
  | { type: "rescan"; mtime: number };
```

Before a full vault scan, map every indexed record whose path equals `oldPath` or starts with `${oldPath}/` to the new prefix while retaining its `fileId`. Folder delete needs no remap; the final scan omits descendants and the planner produces deletions. Update `main.ts` to pass TFolder old/new paths instead of enqueueing a generic rescan.

- [ ] **Step 4: Run and verify GREEN**

Run: `npm test`

Expected: coordinator and nested folder rename/delete integration tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/v4/sync-coordinator.ts src/lib/v4/runtime.ts src/lib/v4/sync-session.ts src/main.ts tests/stubs/obsidian.ts tests/v4/sync-coordinator.test.ts tests/v4/sync-session.test.ts
git commit -m "fix: preserve V4 identities across folder operations"
```

---

### Task 5: Atomic legacy-layout migration and content-preserving renames

**Files:**
- Modify: `src/lib/v4/storage-codec.ts`
- Modify: `src/lib/v4/sync-session.ts`
- Modify: `src/lib/v4/runtime.ts`
- Test: `tests/v4/sync-session.test.ts`

**Interfaces:**
- Adds `V4StorageCodec.relocate(record, logicalPath): Promise<V4FileRecord>` to update encrypted path metadata without changing the stable content descriptor.
- Force Push with a legacy remote treats all local logical files as required opaque writes while retaining old records only for atomic deletion discovery.

- [ ] **Step 1: Write failing rename and migration tests**

```ts
test("v4 content-preserving rename writes metadata and journal without uploading a new content blob", async () => {
  const oldRemotePath = indexRecordByPath(index, "old.md").remotePath;
  const file = vault.files.get("old.md")!;
  vault.files.delete("old.md");
  vault.files.set("new.md", { ...file, mtime: 2 });
  await session().sync({
    operation: "normal",
    allowThresholdOverride: false,
    changes: [{ type: "rename", oldPath: "old.md", path: "new.md", mtime: 2 }],
  });
  const renamed = indexRecordByPath(index, "new.md");
  assert.equal(renamed.remotePath, oldRemotePath);
  assert.equal(github.lastEntries.some(entry => entry.path === oldRemotePath), false);
});

test("v4 confirmed Force Push migrates legacy encrypted paths in one commit", async () => {
  const github = new MemoryGitHub();
  const vault = new MemoryVault();
  const plaintext = enc("legacy secret");
  vault.files.set("PrivateFolder/note.md", { bytes: plaintext, mtime: 1 });
  const legacyConfig: V4RemoteConfig = {
    formatVersion: V4_FORMAT_VERSION,
    mode: "encrypted",
    repoId: "o/r#main",
    algorithm: "AES-GCM",
    kdf: "PBKDF2-SHA-256",
    kdfParams: { iterations: 10, salt: "c2FsdA" },
  };
  const desiredConfig = { ...legacyConfig, pathLayout: "opaque-stable-v1" as const };
  const keys = await deriveV4Keyring({ passphrase: "pass", repoId: "o/r#main", salt: enc("salt"), iterations: 10 });
  const legacyRecord: V4IndexFileRecord = {
    path: "PrivateFolder/note.md",
    pathId: "aa".padEnd(64, "0"),
    fileId: "stable-file",
    plaintextSha256: await sha256Hex(plaintext),
    size: plaintext.byteLength,
    mtime: 1,
    remoteVersion: "legacy-v",
    remotePath: ".obsidian-github-sync-v4/data/PrivateFolder/legacy.enc",
    storage: "single",
  };
  const legacyHead: V4RemoteHead = {
    formatVersion: 4,
    mode: "encrypted",
    epoch: 1,
    generation: 1,
    journalId: "legacy-v",
    shardHashes: { aa: "legacy-shard" },
    updatedAt: 1,
    deviceId: "old",
  };
  const legacyFiles = await buildV4RemoteMetadata({ config: legacyConfig, head: legacyHead, records: [legacyRecord], keyring: keys });
  legacyFiles.push({ path: legacyRecord.remotePath, bytes: await encryptV4Payload(keys.contentKey, plaintext, { kind: "content", aad: `${legacyRecord.pathId}:legacy-v` }) });
  await publishV4TreeChanges(github, { message: "obsidian-sync-v4:legacy-v", files: legacyFiles });
  const index = createEmptyV4LocalIndex({ repoId: "o/r#main", deviceId: "new", mode: "encrypted", pathLayout: "opaque-stable-v1" });
  const legacyEncryptedSession = new V4SyncSession({ github, vault, index, config: desiredConfig, keyring: keys, conflictPolicy: "copy", abortChangePercent: 0 });
  github.commitMessages.length = 0;
  const result = await legacyEncryptedSession.sync({ operation: "forcePush", allowThresholdOverride: true });
  assert.equal(result.mode, "force-push");
  assert.equal(github.commitMessages.length, 1);
  assert.equal([...github.files.keys()].some(path => path.includes("PrivateFolder")), false);
  assert.equal([...github.files.keys()].some(path => /^\.obsidian-github-sync-v4\/data\/[0-9a-f]{2}\/[0-9a-f]{64}\.enc$/u.test(path)), true);
});
```

- [ ] **Step 2: Run and verify RED**

Run: `npm test`

Expected: rename uploads encrypted content again and Force Push does not rewrite unchanged logical files from the old layout.

- [ ] **Step 3: Implement relocation and migration planning**

```ts
async relocate(record: V4FileRecord, logicalPath: string): Promise<V4FileRecord> {
  return {
    ...record,
    pathId: await this.pathId(normalizeV4VaultPath(logicalPath)),
  };
}
```

For a rename whose local hash equals the previous record hash, call `relocate` and reuse `remotePath`, `remoteVersion`, `storage`, `partPaths`, and `packId`. For a layout migration, pass an empty logical remote set to the Force Push planner so every local file is encoded in the new layout, while retaining the actual old records/tree when calculating deletions. Keep the configured branch head as the expected CAS SHA.

- [ ] **Step 4: Run and verify GREEN**

Run: `npm test`

Expected: rename-reuse, migration, atomic deletion, no-change, conflict, and force-operation tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/v4/storage-codec.ts src/lib/v4/sync-session.ts src/lib/v4/runtime.ts tests/v4/sync-session.test.ts
git commit -m "feat: migrate encrypted V4 paths atomically"
```

---

### Task 6: History guarantees and encrypted leakage gate

**Files:**
- Modify: `src/lib/v4/history-service.ts`
- Modify: `src/lib/v4/history-journal.ts`
- Modify: `tests/v4/history-service.test.ts`
- Create: `tests/v4/opaque-leakage.test.ts`
- Modify: `scripts/run-tests.mjs`

**Interfaces:**
- History remains keyed by stable `fileId`; journal descriptors use opaque paths and complete logical paths only inside encrypted page payloads.
- Produces a release gate that scans every encrypted remote path and stored byte sequence for known plaintext fixtures.

- [ ] **Step 1: Write failing cross-rename history and leakage tests**

```ts
test("v4 encrypted history follows one fileId across file and folder renames", async () => {
  const versions = await service.getFileVersions("stable-file");
  assert.deepEqual(versions.map(version => version.change.path), [
    "Projects/Secret/note.md",
    "Archive/Secret/note.md",
    "Archive/Secret/renamed.txt",
  ]);
  assert.equal(new Set(versions.map(version => (version.change.after ?? version.change.before)!.remotePath)).size, 1);
});

test("encrypted V4 remote paths and payloads contain no logical path or content fixture", async () => {
  const forbidden = ["Projects", "Secret", "note", "md", "private body"];
  const haystacks = [...github.files].flatMap(([path, value]) => [path, new TextDecoder().decode(value)]);
  for (const value of forbidden) for (const haystack of haystacks) assert.equal(haystack.includes(value), false);
});
```

- [ ] **Step 2: Run and verify RED**

Run: `npm test`

Expected: the leakage gate finds plaintext folders in current single, part, or pack paths, or history loses identity across folder rename.

- [ ] **Step 3: Complete history codec wiring and release scan**

Construct history codecs with `config.pathLayout`, keep journal path fields inside the already encrypted journal page, and register `tests/v4/opaque-leakage.test.ts` in `scripts/run-tests.mjs`. Ensure the scan covers single objects, chunk parts, packs, config/head/index/journal payloads, and deleted historical descriptors reachable from the test commit chain.

- [ ] **Step 4: Run and verify GREEN**

Run: `npm test`

Expected: all unit/integration tests PASS and the new leakage gate reports no plaintext fixture.

- [ ] **Step 5: Commit**

```bash
git add src/lib/v4/history-service.ts src/lib/v4/history-journal.ts tests/v4/history-service.test.ts tests/v4/opaque-leakage.test.ts scripts/run-tests.mjs
git commit -m "test: enforce opaque encrypted paths and history"
```

---

### Task 7: Real GitHub round trip, documentation, and final verification

**Files:**
- Modify: `tests/github-e2e/v4-real-github-e2e.test.ts`
- Modify: `docs/superpowers/specs/2026-07-13-unified-github-rest-sync-v4-design.md`
- Modify: `docs/superpowers/plans/2026-07-13-unified-github-rest-sync-v4.md`
- Modify: `README.md`

**Interfaces:**
- Real E2E asserts new config layout, opaque encrypted paths, byte equality after pull, stable identity after rename, and cleanup of the dedicated test branch.

- [ ] **Step 1: Extend the real E2E assertions**

```ts
assert.equal(remoteConfig.pathLayout, mode === "encrypted" ? "opaque-stable-v1" : "plaintext-v1");
if (mode === "encrypted") {
  assert.equal(paths.some(path => /^\.obsidian-github-sync-v4\/data\/[0-9a-f]{2}\/[0-9a-f]{64}\.enc$/u.test(path)), true);
  for (const segment of ["Notes", "Assets", "hello", "pixel", "md", "bin"]) assert.equal(paths.some(path => path.includes(segment)), false);
  const pushedRecords = Object.values(sourceIndex.shards).flatMap(shard => Object.values(shard.records));
  const pulledRecords = Object.values(targetIndex.shards).flatMap(shard => Object.values(shard.records));
  for (const pushedRecord of pushedRecords) {
    const pulledRecord = pulledRecords.find(record => record.path === pushedRecord.path)!;
    assert.equal(pulledRecord.fileId, pushedRecord.fileId);
    assert.equal(pulledRecord.remotePath, pushedRecord.remotePath);
  }
}
```

- [ ] **Step 2: Run compile-only and verify the E2E test builds**

Run: `$env:GITHUB_E2E_COMPILE_ONLY='1'; npm run test:github-e2e; Remove-Item Env:GITHUB_E2E_COMPILE_ONLY`

Expected: `GitHub E2E bundle compiled` and exit code 0.

- [ ] **Step 3: Update user and architecture documentation**

Document exactly:

```text
Encrypted mode hides every directory name, filename, extension, and file content. GitHub stores stable opaque objects in fixed technical buckets; the plugin reconstructs logical paths from authenticated encrypted metadata. Repositories created by the earlier encrypted V4 layout require a confirmed Force Push before normal sync or Force Pull.
```

Remove all statements that encrypted mode preserves plaintext folders.

- [ ] **Step 4: Run the full local release gate**

Run: `npm test`

Expected: all tests PASS with zero failures.

Run: `npm run build`

Expected: TypeScript and production esbuild exit 0.

Run: `git diff --check`

Expected: exit 0 with no whitespace errors.

- [ ] **Step 5: Run the real GitHub REST E2E when credentials are configured**

Run: `npm run test:github-e2e:quick`

Expected: plaintext and encrypted V4 round trips PASS; encrypted remote paths contain no fixture path segment; the dedicated test branch is deleted afterward. If sandbox networking is denied, rerun the same command with approved network access rather than substituting a mock.

- [ ] **Step 6: Commit**

```bash
git add tests/github-e2e/v4-real-github-e2e.test.ts docs/superpowers/specs/2026-07-13-unified-github-rest-sync-v4-design.md docs/superpowers/plans/2026-07-13-unified-github-rest-sync-v4.md README.md
git commit -m "docs: finalize opaque encrypted V4 layout"
```
