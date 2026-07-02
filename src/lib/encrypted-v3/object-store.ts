import { encryptV3BinaryPayload } from "./binary-format";
import { ENCRYPTED_V3_ROOT } from "./protocol-types";

export const ENCRYPTED_V3_LOOSE_OBJECT_MAX_BYTES = 24 * 1024 * 1024;

export function encryptedV3ObjectPath(objectId: string): string {
  return `${ENCRYPTED_V3_ROOT}/objects/${objectId.slice(0, 2)}/${objectId.slice(2, 4)}/${objectId}.bin.enc`;
}

export function encryptedV3ChunkPath(objectId: string, index: number): string {
  return `${ENCRYPTED_V3_ROOT}/chunks/${objectId.slice(0, 2)}/${objectId.slice(2, 4)}/${objectId}/${String(index).padStart(6, "0")}.bin.enc`;
}

export async function encryptV3LooseObject(input: {
  keyMaterial: Uint8Array;
  repoId: string;
  objectId: string;
  plaintext: Uint8Array;
}): Promise<{ path: string; bytes: Uint8Array }> {
  return {
    path: encryptedV3ObjectPath(input.objectId),
    bytes: await encryptV3BinaryPayload(input.keyMaterial, input.plaintext, {
      aad: `${input.repoId}:${input.objectId}`,
      kind: "object",
    }),
  };
}

export async function encryptV3ChunkedObject(input: {
  keyMaterial: Uint8Array;
  repoId: string;
  objectId: string;
  plaintext: Uint8Array;
  chunkSize?: number;
}): Promise<{ objectPath: string; chunkPaths: string[]; files: Array<{ path: string; bytes: Uint8Array }> }> {
  const chunkSize = input.chunkSize ?? ENCRYPTED_V3_LOOSE_OBJECT_MAX_BYTES;
  const files: Array<{ path: string; bytes: Uint8Array }> = [];
  const chunkPaths: string[] = [];
  for (let offset = 0, index = 0; offset < input.plaintext.byteLength; offset += chunkSize, index++) {
    const path = encryptedV3ChunkPath(input.objectId, index);
    const bytes = input.plaintext.subarray(offset, Math.min(offset + chunkSize, input.plaintext.byteLength));
    files.push({
      path,
      bytes: await encryptV3BinaryPayload(input.keyMaterial, bytes, {
        aad: `${input.repoId}:${input.objectId}:chunk:${index}`,
        kind: "object",
      }),
    });
    chunkPaths.push(path);
  }
  return {
    objectPath: `${ENCRYPTED_V3_ROOT}/chunks/${input.objectId.slice(0, 2)}/${input.objectId.slice(2, 4)}/${input.objectId}`,
    chunkPaths,
    files,
  };
}
