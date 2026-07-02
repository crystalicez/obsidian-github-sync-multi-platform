import { toBase64Url, utf8ToBytes } from "../encrypted/bytes";
import { encryptV3BinaryPayload, v3PayloadSha256 } from "./binary-format";
import { encryptedV3ObjectPath } from "./object-store";
import { type V3LocalIndexShard } from "./local-index";
import { type EncryptedV3Shard, type EncryptedV3ShardRecord } from "./protocol-types";
import { v3ShardPath } from "./paths";

function encodeJson(value: unknown): Uint8Array {
  return utf8ToBytes(JSON.stringify(value));
}

export async function encryptV3Path(input: { keyMaterial: Uint8Array; repoId: string; pathId: string; path: string }): Promise<string> {
  return toBase64Url(await encryptV3BinaryPayload(input.keyMaterial, utf8ToBytes(input.path), {
    aad: `${input.repoId}:${input.pathId}:path`,
    kind: "shard",
  }));
}

export async function encryptV3LocalShard(input: {
  keyMaterial: Uint8Array;
  repoId: string;
  deviceId: string;
  bucket: string;
  shard: V3LocalIndexShard;
}): Promise<{ path: string; bytes: Uint8Array; hash: string }> {
  const remoteShard: EncryptedV3Shard = {
    formatVersion: 3,
    bucket: input.bucket,
    records: Object.fromEntries(Object.entries(input.shard.records).map(([id, local]) => [id, {
      pathId: local.pathId,
      encryptedPath: "",
      fileId: local.fileId,
      plaintextSha256: local.plaintextSha256,
      size: local.size,
      mtime: local.mtime,
      storage: "loose",
      objectPath: encryptedV3ObjectPath(local.fileId),
      version: local.remoteVersion,
      updatedBy: input.deviceId,
      updatedAt: Date.now(),
      deleted: local.deleted,
    } satisfies EncryptedV3ShardRecord])),
  };
  const bytes = await encryptV3BinaryPayload(input.keyMaterial, encodeJson(remoteShard), {
    aad: `${input.repoId}:${input.bucket}:shard`,
    kind: "shard",
  });
  return { path: v3ShardPath(input.bucket), bytes, hash: await v3PayloadSha256(bytes) };
}
