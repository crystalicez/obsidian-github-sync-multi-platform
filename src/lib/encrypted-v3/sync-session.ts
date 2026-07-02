import { commitGitTreeChanges, type GitAtomicGithub } from "../v3/git-atomic-writer";
import { sha256Hex, toBase64Url, utf8ToBytes } from "../encrypted/bytes";
import { encryptV3BinaryPayload } from "./binary-format";
import { coalesceV3Changes, type EncryptedV3QueuedChange } from "./change-batcher";
import { type V3LocalIndex, type V3LocalIndexAdapter, saveV3LocalIndexShard } from "./local-index";
import { encryptV3LooseObject } from "./object-store";
import { bucketForV3PathId, createV3PathId, normalizeV3VaultPath } from "./paths";
import { ENCRYPTED_V3_HEAD_PATH, type EncryptedV3RemoteHead } from "./protocol-types";
import { encryptV3LocalShard } from "./shard-store";

const OBJECT_ID_BYTES = 18;

export interface EncryptedV3VaultFile {
  path: string;
  size: number;
  mtime: number;
}

export interface EncryptedV3Vault {
  listFiles(): Promise<EncryptedV3VaultFile[]>;
  read(path: string): Promise<Uint8Array>;
}

export interface EncryptedV3SyncSessionInput {
  github: GitAtomicGithub;
  vault: EncryptedV3Vault;
  adapter: V3LocalIndexAdapter;
  indexRoot: string;
  index: V3LocalIndex;
  keyMaterial: Uint8Array;
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

export class EncryptedV3SyncSession {
  constructor(private readonly input: EncryptedV3SyncSessionInput) {}

  async sync(options: { operation: "normal" | "forcePush" | "forcePull" }): Promise<EncryptedV3SyncResult> {
    const phases: Array<[string, number]> = [];
    const ref = await timed(phases, "preflight.remoteRef", () => this.input.github.getGitRef());
    if (options.operation === "normal" && this.input.index.remoteCommitSha === ref.sha && !this.hasDirtyLocalRecords()) {
      return {
        mode: "noop",
        operation: "normal",
        changedFiles: 0,
        changedBytes: 0,
        phaseSummary: phaseSummary(phases),
      };
    }

    const files = await timed(phases, "force.listLocalFiles", () => this.input.vault.listFiles());
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
    const batch = await timed(phases, "queue.collect", async () => coalesceV3Changes(changes));
    const deletes = batch.filter((change): change is Extract<EncryptedV3QueuedChange, { type: "delete" }> => change.type === "delete");
    const renames = batch.filter((change): change is Extract<EncryptedV3QueuedChange, { type: "rename" }> => change.type === "rename");
    const modifies = batch.filter((change): change is Extract<EncryptedV3QueuedChange, { type: "modify" }> => change.type === "modify");
    if (modifies.length === 0 && renames.length === 0 && deletes.length === 0) {
      return { mode: "noop", operation: context.operation ?? "localChange", changedFiles: 0, changedBytes: 0, phaseSummary: phaseSummary(phases) };
    }

    const files = [];
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

    for (const file of files) {
      const pathId = await timed(phases, "path.id", () => createV3PathId(this.input.keyMaterial, file.path));
      const bucket = bucketForV3PathId(pathId);
      changedBuckets.add(bucket);
      const plaintextSha256 = await timed(phases, "hashLocalFile", () => sha256Hex(file.bytes));
      const generation = this.input.index.generation + 1;
      const objectId = stableObjectId(plaintextSha256, pathId, generation);
      const encryptedObject = await timed(phases, "push.encryptObjects", () => encryptV3LooseObject({
        keyMaterial: this.input.keyMaterial,
        repoId: this.input.index.repoId,
        objectId,
        plaintext: file.bytes,
      }));
      remoteFiles.push(encryptedObject);

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

    const commit = await timed(phases, "git.atomicCommit", () => commitGitTreeChanges(this.input.github, {
      message: `sync: encrypted v3 ${context.operation ?? "localChange"}`,
      files: remoteFiles,
    }));
    this.input.index.remoteCommitSha = commit.commitSha;

    for (const bucket of changedBuckets) {
      await timed(phases, "localIndex.save", () => saveV3LocalIndexShard(this.input.adapter, this.input.indexRoot, this.input.index, bucket));
    }

    return {
      mode: context.mode ?? "loose-delta",
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
}
