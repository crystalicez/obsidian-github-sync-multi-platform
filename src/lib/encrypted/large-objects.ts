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
