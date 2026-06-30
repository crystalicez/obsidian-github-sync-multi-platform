import type { EncryptedSnapshotFileRecord, EncryptedSnapshotManifest } from "./snapshot-types";

export interface SnapshotMergeConflict {
  path: string;
  base?: EncryptedSnapshotFileRecord;
  local?: EncryptedSnapshotFileRecord;
  remote?: EncryptedSnapshotFileRecord;
  reason: "both-modified";
}

export interface SnapshotMergeInput {
  base: EncryptedSnapshotManifest;
  local: EncryptedSnapshotManifest;
  remote: EncryptedSnapshotManifest;
  snapshotId: string;
  now: number;
}

export interface SnapshotMergeResult {
  snapshot: EncryptedSnapshotManifest;
  conflicts: SnapshotMergeConflict[];
}

function recordsEqual(a?: EncryptedSnapshotFileRecord, b?: EncryptedSnapshotFileRecord): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.path === b.path
    && a.objectId === b.objectId
    && a.storage === b.storage
    && a.plaintextSha256 === b.plaintextSha256
    && a.size === b.size
    && a.mtime === b.mtime
    && a.packId === b.packId
    && JSON.stringify(a.chunkIds ?? []) === JSON.stringify(b.chunkIds ?? [])
    && Boolean(a.deleted) === Boolean(b.deleted)
    && (a.deletedAt ?? 0) === (b.deletedAt ?? 0);
}

function cloneRecord(record: EncryptedSnapshotFileRecord): EncryptedSnapshotFileRecord {
  return { ...record, chunkIds: record.chunkIds ? [...record.chunkIds] : undefined };
}

function chooseMergedRecord(
  path: string,
  base: EncryptedSnapshotFileRecord | undefined,
  local: EncryptedSnapshotFileRecord | undefined,
  remote: EncryptedSnapshotFileRecord | undefined,
  conflicts: SnapshotMergeConflict[],
): EncryptedSnapshotFileRecord | undefined {
  const localChanged = !recordsEqual(base, local);
  const remoteChanged = !recordsEqual(base, remote);

  if (localChanged && remoteChanged) {
    if (recordsEqual(local, remote)) return local ? cloneRecord(local) : undefined;
    conflicts.push({ path, base, local, remote, reason: "both-modified" });
    return remote ? cloneRecord(remote) : local ? cloneRecord(local) : undefined;
  }
  if (localChanged) return local ? cloneRecord(local) : undefined;
  if (remoteChanged) return remote ? cloneRecord(remote) : undefined;
  return remote ? cloneRecord(remote) : base ? cloneRecord(base) : undefined;
}

export function mergeEncryptedSnapshots(input: SnapshotMergeInput): SnapshotMergeResult {
  const paths = new Set<string>([
    ...Object.keys(input.base.files),
    ...Object.keys(input.local.files),
    ...Object.keys(input.remote.files),
  ]);
  const files: Record<string, EncryptedSnapshotFileRecord> = {};
  const conflicts: SnapshotMergeConflict[] = [];

  for (const path of [...paths].sort()) {
    const record = chooseMergedRecord(path, input.base.files[path], input.local.files[path], input.remote.files[path], conflicts);
    if (record) files[path] = record;
  }

  return {
    conflicts,
    snapshot: {
      formatVersion: 2,
      snapshotId: input.snapshotId,
      parentSnapshotIds: [input.local.snapshotId, input.remote.snapshotId].filter((id, index, ids) => ids.indexOf(id) === index),
      generation: Math.max(input.local.generation, input.remote.generation) + 1,
      createdAt: input.now,
      files,
    },
  };
}