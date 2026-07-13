import { commitGitTreeChanges, type GitAtomicGithub } from "../v3/git-atomic-writer";
import { bytesToUtf8, fromBase64, fromBase64Url, sha256Hex, toBase64Url, utf8ToBytes } from "../encrypted/bytes";
import { isTextLikePath, mergeTextContent } from "../encrypted/conflicts";
import type { PackArchiveFileInput } from "../encrypted/pack-format";
import { conflictPathFor } from "../encrypted/paths";
import type { ConflictPolicy } from "../encrypted/types";
import { decryptV3BinaryPayload, encryptV3BinaryPayload } from "./binary-format";
import { coalesceV3Changes, type EncryptedV3QueuedChange } from "./change-batcher";
import { type V3LocalIndex, type V3LocalIndexAdapter, saveV3LocalIndexHeader, saveV3LocalIndexShard } from "./local-index";
import { ENCRYPTED_V3_LOOSE_OBJECT_MAX_BYTES, encryptV3ChunkedObject, encryptV3LooseObject } from "./object-store";
import { decryptV3BasePack, encryptV3BasePack } from "./pack-store";
import { bucketForV3PathId, createV3PathId, normalizeV3VaultPath } from "./paths";
import { ENCRYPTED_V3_HEAD_PATH, ENCRYPTED_V3_ROOT, type EncryptedV3RemoteHead, type EncryptedV3Shard, type EncryptedV3ShardRecord } from "./protocol-types";
import { encryptV3LocalShard, encryptV3Path } from "./shard-store";

const OBJECT_ID_BYTES = 18;
const V3_PACK_FORCE_PUSH_FILE_THRESHOLD = 256;
const V3_PACK_LOCAL_BATCH_FILE_THRESHOLD = 64;
const V3_PACK_MAX_FILES = 1000;

export interface EncryptedV3VaultFile {
  path: string;
  size: number;
  mtime: number;
}

export interface EncryptedV3Vault {
  listFiles(): Promise<EncryptedV3VaultFile[]>;
  read(path: string): Promise<Uint8Array>;
  write?(path: string, bytes: Uint8Array): Promise<void>;
  delete?(path: string): Promise<void>;
}

export interface EncryptedV3RemoteReadable {
  getFile(path: string): Promise<{ content: string; sha: string; path: string; size?: number } | null>;
  getBlob?(sha: string): Promise<Uint8Array>;
}

export interface EncryptedV3SyncSessionInput {
  github: GitAtomicGithub;
  vault: EncryptedV3Vault;
  adapter: V3LocalIndexAdapter;
  indexRoot: string;
  index: V3LocalIndex;
  keyMaterial: Uint8Array;
  looseObjectMaxBytes?: number;
  conflictPolicy?: ConflictPolicy;
}

export interface EncryptedV3SyncResult {
  mode: "noop" | "loose-delta" | "base-pack" | "force-push" | "force-pull";
  operation: "normal" | "localChange" | "forcePush" | "forcePull";
  changedFiles: number;
  changedBytes: number;
  commitSha?: string;
  phaseSummary: string;
}

interface PreparedShardWrite {
  bucket: string;
  path: string;
  bytes: Uint8Array;
}

function stableObjectId(contentSha: string, pathId: string, generation: number): string {
  return toBase64Url(utf8ToBytes(`${contentSha}:${pathId}:${generation}`)).slice(0, OBJECT_ID_BYTES);
}

function encodeJson(value: unknown): Uint8Array {
  return utf8ToBytes(JSON.stringify(value));
}

function phaseSummary(phases: Array<[string, number]>): string {
  return phases.map(([name, duration]) => `${name}=${duration}ms`).join(", ");
}

async function timed<T>(phases: Array<[string, number]>, name: string, fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    return await fn();
  } finally {
    phases.push([name, Date.now() - started]);
  }
}

async function withDecryptContext<T>(context: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const message = (error as Error).message || String(error);
    throw new Error(`${message} [${context}]`, { cause: error });
  }
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, mapper: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index], index);
    }
  }));
  return results;
}

export class EncryptedV3SyncSession {
  constructor(private readonly input: EncryptedV3SyncSessionInput) {}

  async sync(options: { operation: "normal" | "forcePush" | "forcePull" }): Promise<EncryptedV3SyncResult> {
    const phases: Array<[string, number]> = [];
    const ref = await timed(phases, "preflight.remoteRef", () => this.input.github.getGitRef());
    if (options.operation === "forcePull") return this.forcePull(ref.sha, phases);
    if (options.operation === "normal" && this.input.index.remoteCommitSha === ref.sha && !this.hasDirtyLocalRecords()) {
      return {
        mode: "noop",
        operation: "normal",
        changedFiles: 0,
        changedBytes: 0,
        phaseSummary: phaseSummary(phases),
      };
    }
    if (options.operation === "normal" && this.input.index.remoteCommitSha !== ref.sha) {
      if (this.hasDirtyLocalRecords()) throw new Error("Encrypted v3 conflict: remote changed while local encrypted index has dirty records.");
      return this.forcePull(ref.sha, phases, "normal", false);
    }

    const files = await timed(phases, "force.listLocalFiles", () => this.input.vault.listFiles());
    if (options.operation === "forcePush" && files.length === 0) return this.forcePushEmpty(phases);
    if (options.operation === "forcePush" && files.length >= V3_PACK_FORCE_PUSH_FILE_THRESHOLD) {
      return this.forcePushPacked(files, phases);
    }
    return this.flushLocalChanges(files.map(file => ({ type: "modify", path: file.path, mtime: file.mtime })), {
      operation: options.operation === "forcePush" ? "forcePush" : "localChange",
      phases,
      mode: options.operation === "forcePush" ? "force-push" : "loose-delta",
    });
  }

  async flushLocalChanges(
    changes: EncryptedV3QueuedChange[],
    context: { operation?: "localChange" | "forcePush"; phases?: Array<[string, number]>; mode?: EncryptedV3SyncResult["mode"] } = {},
  ): Promise<EncryptedV3SyncResult> {
    const phases = context.phases ?? [];
    if ((context.operation ?? "localChange") !== "forcePush") await this.reconcileRemoteBeforeLocalPush(phases);
    const batch = await timed(phases, "queue.collect", async () => coalesceV3Changes(changes));
    const deletes = batch.filter((change): change is Extract<EncryptedV3QueuedChange, { type: "delete" }> => change.type === "delete");
    const renames = batch.filter((change): change is Extract<EncryptedV3QueuedChange, { type: "rename" }> => change.type === "rename");
    const modifies = batch.filter((change): change is Extract<EncryptedV3QueuedChange, { type: "modify" }> => change.type === "modify");
    if (modifies.length === 0 && renames.length === 0 && deletes.length === 0) {
      return { mode: "noop", operation: context.operation ?? "localChange", changedFiles: 0, changedBytes: 0, phaseSummary: phaseSummary(phases) };
    }

    const files: Array<{ path: string; mtime: number; bytes: Uint8Array }> = [];
    const remoteFiles: Array<{ path: string; bytes: Uint8Array }> = [];
    const changedBuckets = new Set<string>();

    for (const change of deletes) {
      const path = normalizeV3VaultPath(change.path);
      const pathId = await timed(phases, "path.id", () => createV3PathId(this.input.keyMaterial, path));
      const bucket = bucketForV3PathId(pathId);
      const shard = this.input.index.shards[bucket] ?? { hash: "", records: {} };
      const existing = shard.records[pathId];
      shard.records[pathId] = {
        path,
        pathId,
        fileId: existing?.fileId ?? pathId,
        plaintextSha256: existing?.plaintextSha256 ?? "",
        size: existing?.size ?? 0,
        mtime: change.mtime,
        remoteVersion: `${this.input.index.generation + 1}:deleted`,
        encryptedPath: existing?.encryptedPath,
        objectPath: existing?.objectPath,
        deleted: true,
      };
      this.input.index.shards[bucket] = shard;
      changedBuckets.add(bucket);
    }

    for (const change of renames) {
      const oldPath = normalizeV3VaultPath(change.oldPath);
      const newPath = normalizeV3VaultPath(change.path);
      const oldPathId = await timed(phases, "path.id", () => createV3PathId(this.input.keyMaterial, oldPath));
      const newPathId = await timed(phases, "path.id", () => createV3PathId(this.input.keyMaterial, newPath));
      const oldBucket = bucketForV3PathId(oldPathId);
      const newBucket = bucketForV3PathId(newPathId);
      const oldShard = this.input.index.shards[oldBucket] ?? { hash: "", records: {} };
      const oldRecord = oldShard.records[oldPathId];
      const bytes = await timed(phases, "readLocalFile", () => this.input.vault.read(newPath));
      const plaintextSha256 = await timed(phases, "hashLocalFile", () => sha256Hex(bytes));
      if (oldRecord && !oldRecord.deleted && oldRecord.plaintextSha256 === plaintextSha256) {
        oldShard.records[oldPathId] = { ...oldRecord, deleted: true, mtime: change.mtime, remoteVersion: `${this.input.index.generation + 1}:renamed` };
        const newShard = this.input.index.shards[newBucket] ?? { hash: "", records: {} };
        newShard.records[newPathId] = {
          ...oldRecord,
          path: newPath,
          pathId: newPathId,
          mtime: change.mtime,
          encryptedPath: await encryptV3Path({ keyMaterial: this.input.keyMaterial, repoId: this.input.index.repoId, pathId: newPathId, path: newPath }),
          deleted: false,
        };
        this.input.index.shards[oldBucket] = oldShard;
        this.input.index.shards[newBucket] = newShard;
        changedBuckets.add(oldBucket);
        changedBuckets.add(newBucket);
      } else {
        files.push({ path: newPath, mtime: change.mtime, bytes });
        if (oldRecord) {
          oldShard.records[oldPathId] = { ...oldRecord, deleted: true, mtime: change.mtime, remoteVersion: `${this.input.index.generation + 1}:renamed` };
          this.input.index.shards[oldBucket] = oldShard;
          changedBuckets.add(oldBucket);
        }
      }
    }

    for (const change of modifies) {
      const path = normalizeV3VaultPath(change.path);
      const bytes = await timed(phases, "readLocalFile", () => this.input.vault.read(path));
      files.push({ path, mtime: change.mtime, bytes });
    }

    const changedBytes = files.reduce((sum, file) => sum + file.bytes.byteLength, 0);

    let resultMode = context.mode ?? "loose-delta";
    let looseFiles = files;
    if (context.operation !== "forcePush" && files.length >= V3_PACK_LOCAL_BATCH_FILE_THRESHOLD) {
      const packed = await timed(phases, "push.planPacks", () => this.preparePackedLocalFiles(files, changedBuckets));
      remoteFiles.push(...packed.remoteFiles);
      looseFiles = packed.looseFiles;
      if (packed.remoteFiles.length > 0) resultMode = "base-pack";
    }

    for (const file of looseFiles) {
      const pathId = await timed(phases, "path.id", () => createV3PathId(this.input.keyMaterial, file.path));
      const bucket = bucketForV3PathId(pathId);
      changedBuckets.add(bucket);
      const plaintextSha256 = await timed(phases, "hashLocalFile", () => sha256Hex(file.bytes));
      const generation = this.input.index.generation + 1;
      const objectId = stableObjectId(plaintextSha256, pathId, generation);
      const objectWrite = await timed(phases, "push.encryptObjects", async () => {
        const looseObjectMaxBytes = this.input.looseObjectMaxBytes ?? ENCRYPTED_V3_LOOSE_OBJECT_MAX_BYTES;
        if (file.bytes.byteLength <= looseObjectMaxBytes) {
          const encryptedObject = await encryptV3LooseObject({
            keyMaterial: this.input.keyMaterial,
            repoId: this.input.index.repoId,
            objectId,
            plaintext: file.bytes,
          });
          return { storage: "loose" as const, objectPath: encryptedObject.path, chunkPaths: undefined, files: [encryptedObject] };
        }
        const chunked = await encryptV3ChunkedObject({
          keyMaterial: this.input.keyMaterial,
          repoId: this.input.index.repoId,
          objectId,
          plaintext: file.bytes,
          chunkSize: looseObjectMaxBytes,
        });
        return { storage: "chunked" as const, objectPath: chunked.objectPath, chunkPaths: chunked.chunkPaths, files: chunked.files };
      });
      remoteFiles.push(...objectWrite.files);

      const fileId = this.input.index.shards[bucket]?.records[pathId]?.fileId ?? objectId;
      const version = `${generation}:${plaintextSha256}`;
      const shard = this.input.index.shards[bucket] ?? { hash: "", records: {} };
      shard.records[pathId] = {
        path: file.path,
        pathId,
        fileId,
        plaintextSha256,
        size: file.bytes.byteLength,
        mtime: file.mtime,
        remoteVersion: version,
        encryptedPath: await encryptV3Path({ keyMaterial: this.input.keyMaterial, repoId: this.input.index.repoId, pathId, path: file.path }),
        objectPath: objectWrite.objectPath,
        chunkPaths: objectWrite.chunkPaths,
        storage: objectWrite.storage,
      };
      this.input.index.shards[bucket] = shard;
    }

    for (const write of await timed(phases, "push.encryptTombstoneShards", () => this.prepareChangedShardWrites(changedBuckets))) {
      remoteFiles.push({ path: write.path, bytes: write.bytes });
    }

    this.input.index.generation += 1;
    const head: EncryptedV3RemoteHead = {
      formatVersion: 3,
      epoch: this.input.index.epoch,
      generation: this.input.index.generation,
      headId: `${this.input.index.deviceId}:${this.input.index.generation}`,
      shardHashes: this.input.index.shardHashes,
      deviceId: this.input.index.deviceId,
      updatedAt: Date.now(),
    };
    const headBytes = await timed(phases, "push.encryptHead", () => encryptV3BinaryPayload(this.input.keyMaterial, encodeJson(head), {
      aad: `${this.input.index.repoId}:head`,
      kind: "head",
    }));
    remoteFiles.push({ path: ENCRYPTED_V3_HEAD_PATH, bytes: headBytes });

    const deletions = context.operation === "forcePush"
      ? await timed(phases, "forcePush.planRemotePrune", () => this.planForcePushRemotePrune(remoteFiles))
      : [];
    const commit = await timed(phases, "git.atomicCommit", () => commitGitTreeChanges(this.input.github, {
      message: `sync: encrypted v3 ${context.operation ?? "localChange"}`,
      files: remoteFiles,
      deletions,
    }));
    this.input.index.remoteCommitSha = commit.commitSha;

    for (const bucket of changedBuckets) {
      await timed(phases, "localIndex.save", () => saveV3LocalIndexShard(this.input.adapter, this.input.indexRoot, this.input.index, bucket));
    }

    return {
      mode: resultMode,
      operation: context.operation ?? "localChange",
      changedFiles: batch.length,
      changedBytes,
      commitSha: commit.commitSha,
      phaseSummary: phaseSummary(phases),
    };
  }

  private hasDirtyLocalRecords(): boolean {
    return Object.values(this.input.index.shards).some(shard => Object.values(shard.records).some(record => record.dirty));
  }

  private async reconcileRemoteBeforeLocalPush(phases: Array<[string, number]>): Promise<void> {
    const expectedSha = this.input.index.remoteCommitSha;
    if (!expectedSha) return;
    const conflictError = new Error("Encrypted v3 conflict: remote changed before local changes could be pushed.");
    const delays = [0, 250, 500, 1000, 2000];
    for (const delay of delays) {
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
      const ref = await timed(phases, "preflight.remoteRef", () => this.input.github.getGitRef());
      if (ref.sha === expectedSha) return;
      try {
        await timed(phases, "preflight.mergeRemoteBeforePush", () => this.forcePull(ref.sha, phases, "normal", false));
        return;
      } catch {
        // GitHub can briefly expose an older branch ref while contents/blob reads
        // are not coherent yet. Retry before surfacing a real conflict.
      }
    }
    throw conflictError;
  }

  private async forcePull(
    remoteCommitSha: string,
    phases: Array<[string, number]>,
    operation: "forcePull" | "normal" = "forcePull",
    deleteLocalExtras = true,
  ): Promise<EncryptedV3SyncResult> {
    if (typeof this.input.vault.write !== "function" || typeof this.input.vault.delete !== "function") {
      throw new Error("Encrypted v3 force pull requires vault write/delete support.");
    }
    const headFile = await timed(phases, "pull.head", () => this.readRemoteFile(ENCRYPTED_V3_HEAD_PATH));
    const head = JSON.parse(bytesToUtf8(await withDecryptContext("head", () => decryptV3BinaryPayload(this.input.keyMaterial, headFile, `${this.input.index.repoId}:head`)))) as EncryptedV3RemoteHead;
    const remotePaths = new Set<string>();
    let changedBytes = 0;
    let changedFiles = 0;
    const previousShards = this.input.index.shards;

    this.input.index.epoch = head.epoch;
    this.input.index.generation = head.generation;
    this.input.index.shardHashes = { ...head.shardHashes };
    this.input.index.shards = {};

    const remoteShards = await timed(phases, "pull.changedShards", () => mapWithConcurrency(Object.keys(head.shardHashes), 8, async (bucket) => {
      const shardFile = await this.readRemoteFile(`.obsidian-github-sync-v3/shards/${bucket}.enc`);
      const shard = JSON.parse(bytesToUtf8(await withDecryptContext(`shard:${bucket}`, () => decryptV3BinaryPayload(this.input.keyMaterial, shardFile, `${this.input.index.repoId}:${bucket}:shard`)))) as EncryptedV3Shard;
      return { bucket, shard };
    }));

    for (const { bucket, shard } of remoteShards) {
      const localShard = { hash: head.shardHashes[bucket], records: {} as V3LocalIndex["shards"][string]["records"] };
      for (const record of Object.values(shard.records)) {
        const path = await this.decryptRecordPath(record);
        localShard.records[record.pathId] = {
          path,
          pathId: record.pathId,
          fileId: record.fileId,
          plaintextSha256: record.plaintextSha256,
          size: record.size,
          mtime: record.mtime,
          remoteVersion: record.version,
          encryptedPath: record.encryptedPath,
          objectPath: record.objectPath,
          storage: record.storage,
          chunkPaths: record.chunkPaths,
          deleted: record.deleted,
        };
        if (record.deleted) continue;
        const plaintext = record.storage === "base-pack"
          ? await this.readPackedRecord(record, path, phases)
          : record.storage === "chunked"
            ? await this.readChunkedRecord(record, phases)
            : await this.readLooseRecord(record, phases);
        const applied = await timed(phases, "vault.applyRemote", () => this.applyRemoteRecord({
          path,
          pathId: record.pathId,
          plaintext,
          remoteMtime: record.mtime,
          previousShards,
          force: operation === "forcePull",
        }));
        remotePaths.add(path);
        changedBytes += plaintext.byteLength;
        if (applied) changedFiles += 1;
      }
      this.input.index.shards[bucket] = localShard;
      await timed(phases, "localIndex.save", () => saveV3LocalIndexShard(this.input.adapter, this.input.indexRoot, this.input.index, bucket));
    }

    if (deleteLocalExtras) {
      const localFiles = await timed(phases, "forcePull.listLocalFiles", () => this.input.vault.listFiles());
      for (const file of localFiles) {
        const path = normalizeV3VaultPath(file.path);
        if (!remotePaths.has(path)) await timed(phases, "vault.deleteExtra", () => this.input.vault.delete!(path));
      }
    }
    this.input.index.remoteCommitSha = remoteCommitSha;
    return {
      mode: "force-pull",
      operation,
      changedFiles,
      changedBytes,
      phaseSummary: phaseSummary(phases),
    };
  }

  private async applyRemoteRecord(input: {
    path: string;
    pathId: string;
    plaintext: Uint8Array;
    remoteMtime: number;
    previousShards: V3LocalIndex["shards"];
    force: boolean;
  }): Promise<boolean> {
    if (input.force) {
      await this.input.vault.write!(input.path, input.plaintext);
      return true;
    }
    const existing = await this.readLocalIfExists(input.path);
    if (!existing) {
      await this.input.vault.write!(input.path, input.plaintext);
      return true;
    }
    const remoteHash = await sha256Hex(input.plaintext);
    const localHash = await sha256Hex(existing);
    if (localHash === remoteHash) return false;
    const previous = Object.values(input.previousShards).map(shard => shard.records[input.pathId]).find(Boolean);
    if (previous && !previous.deleted && previous.plaintextSha256 === localHash) {
      await this.input.vault.write!(input.path, input.plaintext);
      return true;
    }

    const policy = this.input.conflictPolicy ?? "copy";
    if (policy === "newer" && previous?.mtime && previous.mtime > input.remoteMtime) return false;
    if (policy === "newer" && previous?.mtime && previous.mtime < input.remoteMtime) {
      await this.input.vault.write!(input.path, input.plaintext);
      return true;
    }
    if (policy === "merge" && isTextLikePath(input.path)) {
      const merged = utf8ToBytes(mergeTextContent(bytesToUtf8(existing), bytesToUtf8(input.plaintext)));
      await this.input.vault.write!(input.path, merged);
      return true;
    }

    await this.input.vault.write!(conflictPathFor(input.path, Date.now(), "remote"), input.plaintext);
    return true;
  }

  private async readLocalIfExists(path: string): Promise<Uint8Array | null> {
    try {
      return await this.input.vault.read(path);
    } catch {
      return null;
    }
  }

  private async decryptRecordPath(record: EncryptedV3ShardRecord): Promise<string> {
    const encryptedPath = fromBase64Url(record.encryptedPath);
    return bytesToUtf8(await withDecryptContext(`path:${record.pathId}`, () => decryptV3BinaryPayload(this.input.keyMaterial, encryptedPath, `${this.input.index.repoId}:${record.pathId}:path`)));
  }

  private readonly packCache = new Map<string, Map<string, Uint8Array>>();
  private readonly packPromises = new Map<string, Promise<Map<string, Uint8Array>>>();

  private async readPackedRecord(record: EncryptedV3ShardRecord, path: string, phases: Array<[string, number]>): Promise<Uint8Array> {
    let pack = this.packCache.get(record.objectPath);
    if (!pack) {
      let promise = this.packPromises.get(record.objectPath);
      if (!promise) {
        promise = (async () => {
          const packBytes = await timed(phases, "pull.pack", () => this.readRemoteFile(record.objectPath));
          const files = await withDecryptContext(`pack:${record.objectPath}`, () => decryptV3BasePack({ keyMaterial: this.input.keyMaterial, repoId: this.input.index.repoId, packPath: record.objectPath, bytes: packBytes }));
          return new Map(files.map(file => [normalizeV3VaultPath(file.path), file.bytes]));
        })();
        this.packPromises.set(record.objectPath, promise);
      }
      pack = await promise;
      this.packCache.set(record.objectPath, pack);
    }
    const bytes = pack.get(path);
    if (!bytes) throw new Error(`Encrypted v3 pack is missing file: ${path}`);
    return bytes;
  }

  private async readLooseRecord(record: EncryptedV3ShardRecord, phases: Array<[string, number]>): Promise<Uint8Array> {
    const objectBytes = await timed(phases, "pull.object", () => this.readRemoteFile(record.objectPath));
    const objectId = objectIdFromPath(record.objectPath);
    return withDecryptContext(`object:${record.objectPath}`, () => decryptV3BinaryPayload(this.input.keyMaterial, objectBytes, `${this.input.index.repoId}:${objectId}`));
  }

  private async readChunkedRecord(record: EncryptedV3ShardRecord, phases: Array<[string, number]>): Promise<Uint8Array> {
    const chunkPaths = record.chunkPaths ?? [];
    if (chunkPaths.length === 0) throw new Error(`Encrypted v3 chunked record is missing chunk paths: ${record.pathId}`);
    const objectId = record.objectPath.split("/").at(-1) ?? "";
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (const [index, path] of chunkPaths.entries()) {
      const chunkBytes = await timed(phases, "pull.chunk", () => this.readRemoteFile(path));
      const plaintext = await withDecryptContext(`chunk:${path}`, () => decryptV3BinaryPayload(this.input.keyMaterial, chunkBytes, `${this.input.index.repoId}:${objectId}:chunk:${index}`));
      chunks.push(plaintext);
      total += plaintext.byteLength;
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return merged;
  }

  private async preparePackedLocalFiles(
    files: Array<{ path: string; mtime: number; bytes: Uint8Array }>,
    changedBuckets: Set<string>,
  ): Promise<{ remoteFiles: Array<{ path: string; bytes: Uint8Array }>; looseFiles: Array<{ path: string; mtime: number; bytes: Uint8Array }> }> {
    const maxPackBytes = this.input.looseObjectMaxBytes ?? ENCRYPTED_V3_LOOSE_OBJECT_MAX_BYTES;
    const remoteFiles: Array<{ path: string; bytes: Uint8Array }> = [];
    const looseFiles: Array<{ path: string; mtime: number; bytes: Uint8Array }> = [];
    const groups: Array<Array<{ path: string; mtime: number; bytes: Uint8Array }>> = [];
    let current: Array<{ path: string; mtime: number; bytes: Uint8Array }> = [];
    let currentBytes = 0;

    for (const file of files) {
      if (file.bytes.byteLength > maxPackBytes) {
        looseFiles.push(file);
        continue;
      }
      if (current.length > 0 && (currentBytes + file.bytes.byteLength > maxPackBytes || current.length >= V3_PACK_MAX_FILES)) {
        groups.push(current);
        current = [];
        currentBytes = 0;
      }
      current.push(file);
      currentBytes += file.bytes.byteLength;
    }
    if (current.length > 0) groups.push(current);

    for (const [groupIndex, group] of groups.entries()) {
      const packId = `${this.input.index.deviceId}-${Date.now()}-${this.input.index.generation + 1}-${groupIndex}-${group.length}`;
      const packPath = `.obsidian-github-sync-v3/packs/base/${packId}.pack.enc`;
      const packFiles: PackArchiveFileInput[] = [];
      for (const file of group) {
        const pathId = await createV3PathId(this.input.keyMaterial, file.path);
        const bucket = bucketForV3PathId(pathId);
        const plaintextSha256 = await sha256Hex(file.bytes);
        const generation = this.input.index.generation + 1;
        const shard = this.input.index.shards[bucket] ?? { hash: "", records: {} };
        const existing = shard.records[pathId];
        shard.records[pathId] = {
          path: file.path,
          pathId,
          fileId: existing?.fileId ?? pathId,
          plaintextSha256,
          size: file.bytes.byteLength,
          mtime: file.mtime,
          remoteVersion: `${generation}:${plaintextSha256}`,
          encryptedPath: await encryptV3Path({ keyMaterial: this.input.keyMaterial, repoId: this.input.index.repoId, pathId, path: file.path }),
          objectPath: packPath,
          storage: "base-pack",
        };
        this.input.index.shards[bucket] = shard;
        changedBuckets.add(bucket);
        packFiles.push({ path: file.path, mtime: file.mtime, bytes: file.bytes, plaintextSha256 });
      }
      remoteFiles.push(await encryptV3BasePack({
        keyMaterial: this.input.keyMaterial,
        repoId: this.input.index.repoId,
        packId,
        files: packFiles,
      }));
    }

    return { remoteFiles, looseFiles };
  }

  private async readRemoteFile(path: string): Promise<Uint8Array> {
    const readable = this.input.github as GitAtomicGithub & EncryptedV3RemoteReadable;
    if (typeof readable.getBlob === "function") {
      const sha = await this.findRemoteBlobSha(path);
      if (sha) return readable.getBlob(sha);
    }
    if (typeof readable.getFile !== "function") throw new Error("Encrypted v3 pull requires GitHub getFile support.");
    const file = await readable.getFile(path);
    if (!file) throw new Error(`Missing encrypted v3 remote file: ${path}`);
    return fromBase64(file.content);
  }

  private remoteBlobShaCache: Map<string, string> | null = null;

  private async findRemoteBlobSha(path: string): Promise<string | null> {
    if (!this.remoteBlobShaCache) {
      const tree = await this.input.github.getTree();
      if (tree.truncated) throw new Error("Cannot read encrypted v3 remote files from a truncated remote tree.");
      this.remoteBlobShaCache = new Map(tree.tree.filter(node => node.type === "blob").map(node => [node.path, node.sha]));
    }
    return this.remoteBlobShaCache.get(path) ?? null;
  }

  private async forcePushPacked(files: EncryptedV3VaultFile[], phases: Array<[string, number]>): Promise<EncryptedV3SyncResult> {
    const packFiles: PackArchiveFileInput[] = [];
    let changedBytes = 0;
    const changedBuckets = new Set<string>();
    const packId = `${this.input.index.deviceId}-${Date.now()}-${files.length}`;
    const packPath = `.obsidian-github-sync-v3/packs/base/${packId}.pack.enc`;
    for (const file of files) {
      const path = normalizeV3VaultPath(file.path);
      const bytes = await timed(phases, "readLocalFile", () => this.input.vault.read(path));
      const plaintextSha256 = await timed(phases, "hashLocalFile", () => sha256Hex(bytes));
      const pathId = await timed(phases, "path.id", () => createV3PathId(this.input.keyMaterial, path));
      const bucket = bucketForV3PathId(pathId);
      const shard = this.input.index.shards[bucket] ?? { hash: "", records: {} };
      shard.records[pathId] = {
        path,
        pathId,
        fileId: pathId,
        plaintextSha256,
        size: bytes.byteLength,
        mtime: file.mtime,
        remoteVersion: `${this.input.index.generation + 1}:${plaintextSha256}`,
        encryptedPath: await encryptV3Path({ keyMaterial: this.input.keyMaterial, repoId: this.input.index.repoId, pathId, path }),
        objectPath: packPath,
        storage: "base-pack",
      };
      this.input.index.shards[bucket] = shard;
      changedBuckets.add(bucket);
      changedBytes += bytes.byteLength;
      packFiles.push({ path, mtime: file.mtime, bytes, plaintextSha256 });
    }

    const pack = await timed(phases, "push.encryptPack", () => encryptV3BasePack({
      keyMaterial: this.input.keyMaterial,
      repoId: this.input.index.repoId,
      packId,
      files: packFiles,
    }));
    const remoteFiles: Array<{ path: string; bytes: Uint8Array }> = [pack];
    for (const write of await timed(phases, "push.encryptShards", () => this.prepareChangedShardWrites(changedBuckets))) {
      remoteFiles.push({ path: write.path, bytes: write.bytes });
    }
    this.input.index.generation += 1;
    const head: EncryptedV3RemoteHead = {
      formatVersion: 3,
      epoch: this.input.index.epoch,
      generation: this.input.index.generation,
      headId: `${this.input.index.deviceId}:${this.input.index.generation}`,
      shardHashes: this.input.index.shardHashes,
      deviceId: this.input.index.deviceId,
      updatedAt: Date.now(),
    };
    const headBytes = await timed(phases, "push.encryptHead", () => encryptV3BinaryPayload(this.input.keyMaterial, encodeJson(head), {
      aad: `${this.input.index.repoId}:head`,
      kind: "head",
    }));
    remoteFiles.push({ path: ENCRYPTED_V3_HEAD_PATH, bytes: headBytes });
    const deletions = await timed(phases, "forcePush.planRemotePrune", () => this.planForcePushRemotePrune(remoteFiles));
    const commit = await timed(phases, "git.atomicCommit", () => commitGitTreeChanges(this.input.github, {
      message: "sync: encrypted v3 forcePush pack",
      files: remoteFiles,
      deletions,
    }));
    this.input.index.remoteCommitSha = commit.commitSha;
    for (const bucket of changedBuckets) await timed(phases, "localIndex.save", () => saveV3LocalIndexShard(this.input.adapter, this.input.indexRoot, this.input.index, bucket));
    return { mode: "force-push", operation: "forcePush", changedFiles: files.length, changedBytes, commitSha: commit.commitSha, phaseSummary: phaseSummary(phases) };
  }

  private async forcePushEmpty(phases: Array<[string, number]>): Promise<EncryptedV3SyncResult> {
    this.input.index.generation += 1;
    this.input.index.shardHashes = {};
    this.input.index.shards = {};
    const head: EncryptedV3RemoteHead = {
      formatVersion: 3,
      epoch: this.input.index.epoch,
      generation: this.input.index.generation,
      headId: `${this.input.index.deviceId}:${this.input.index.generation}`,
      shardHashes: {},
      deviceId: this.input.index.deviceId,
      updatedAt: Date.now(),
    };
    const headBytes = await timed(phases, "push.encryptHead", () => encryptV3BinaryPayload(this.input.keyMaterial, encodeJson(head), {
      aad: `${this.input.index.repoId}:head`,
      kind: "head",
    }));
    const remoteFiles = [{ path: ENCRYPTED_V3_HEAD_PATH, bytes: headBytes }];
    const deletions = await timed(phases, "forcePush.planRemotePrune", () => this.planForcePushRemotePrune(remoteFiles));
    const commit = await timed(phases, "git.atomicCommit", () => commitGitTreeChanges(this.input.github, {
      message: "sync: encrypted v3 forcePush empty",
      files: remoteFiles,
      deletions,
    }));
    this.input.index.remoteCommitSha = commit.commitSha;
    await timed(phases, "localIndex.save", () => saveV3LocalIndexHeader(this.input.adapter, this.input.indexRoot, this.input.index));
    return { mode: "force-push", operation: "forcePush", changedFiles: 0, changedBytes: 0, commitSha: commit.commitSha, phaseSummary: phaseSummary(phases) };
  }

  private async prepareChangedShardWrites(changedBuckets: Set<string>): Promise<PreparedShardWrite[]> {
    const writes: PreparedShardWrite[] = [];
    for (const bucket of changedBuckets) {
      const shard = this.input.index.shards[bucket];
      if (!shard) continue;
      const encrypted = await encryptV3LocalShard({
        keyMaterial: this.input.keyMaterial,
        repoId: this.input.index.repoId,
        deviceId: this.input.index.deviceId,
        bucket,
        shard,
      });
      shard.hash = encrypted.hash;
      this.input.index.shardHashes[bucket] = shard.hash;
      writes.push({ bucket, path: encrypted.path, bytes: encrypted.bytes });
    }
    return writes;
  }

  private async planForcePushRemotePrune(remoteFiles: Array<{ path: string; bytes: Uint8Array }>): Promise<string[]> {
    const nextPaths = new Set(remoteFiles.map(file => file.path));
    const tree = await this.input.github.getTree();
    if (tree.truncated) throw new Error("Cannot force push encrypted v3 mirror from a truncated remote tree.");
    return tree.tree
      .filter(node => node.type === "blob" && node.path.startsWith(`${ENCRYPTED_V3_ROOT}/`) && !nextPaths.has(node.path))
      .map(node => node.path);
  }
}

function objectIdFromPath(path: string): string {
  const name = path.split("/").at(-1) ?? "";
  return name.replace(/\.bin\.enc$/u, "");
}
