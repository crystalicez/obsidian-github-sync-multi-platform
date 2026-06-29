import { GitHubClient, readGitHubFileBytes, readGitHubBlobOrFileBytes } from "../github-api";
import { ENCRYPTED_CHUNK_PLAINTEXT_BYTES, GITHUB_RECOMMENDED_MAX_BYTES } from "./constants";
import { decryptBytes, encryptBytes, EncryptedPayload } from "./crypto";
import { objectPathForId } from "./paths";
import { EncryptedChunkRecord, EncryptedObjectRecord } from "./types";
import { sha256Hex } from "./bytes";

export function chunkPathForId(id: string, index: number): string {
  return `${encryptedChunkObjectsRoot(id)}/${String(index).padStart(6, "0")}.enc`;
}

function encryptedChunkObjectsRoot(id: string): string {
  return `${objectPathForId(id).slice(0, -4)}.parts`;
}

export function shouldChunkEncryptedPayload(payload: string): boolean {
  return new TextEncoder().encode(payload).byteLength > GITHUB_RECOMMENDED_MAX_BYTES;
}

export function shouldChunkPlaintext(plaintext: Uint8Array): boolean {
  const estimatedEncryptedSize = 50 + 16 + (plaintext.byteLength + 16) * 4 / 3;
  return estimatedEncryptedSize > GITHUB_RECOMMENDED_MAX_BYTES;
}

async function deleteStaleChunks(
  github: GitHubClient,
  existing: EncryptedObjectRecord | undefined,
  activeChunkPaths: Set<string>
): Promise<void> {
  for (const chunk of existing?.chunks ?? []) {
    if (activeChunkPaths.has(chunk.path) || !chunk.remoteSha) continue;
    await github.deleteFile(chunk.path, chunk.remoteSha);
  }
}

export async function uploadEncryptedFileObject(
  github: GitHubClient,
  key: CryptoKey,
  id: string,
  plaintext: Uint8Array,
  existing?: EncryptedObjectRecord
): Promise<EncryptedObjectRecord> {
  const fullHash = await sha256Hex(plaintext);
  if (!shouldChunkPlaintext(plaintext)) {
    const singlePayload = JSON.stringify(await encryptBytes(key, plaintext));
    const objectPath = existing?.objectPath ?? objectPathForId(id);
    const remoteSha = await github.putFile(objectPath, singlePayload, existing?.remoteSha);
    await deleteStaleChunks(github, existing, new Set());
    return { id, path: existing?.path ?? "", objectPath, plaintextSha256: fullHash, remoteSha, size: plaintext.byteLength, mtime: Date.now(), storage: "single" };
  }

  const chunks: EncryptedChunkRecord[] = [];
  const previousChunksByIndex = new Map((existing?.chunks ?? []).map(chunk => [chunk.index, chunk] as const));
  for (let offset = 0, index = 1; offset < plaintext.byteLength; offset += ENCRYPTED_CHUNK_PLAINTEXT_BYTES, index++) {
    const part = plaintext.subarray(offset, Math.min(offset + ENCRYPTED_CHUNK_PLAINTEXT_BYTES, plaintext.byteLength));
    const path = chunkPathForId(id, index);
    const previous = previousChunksByIndex.get(index);
    const remoteSha = await github.putFile(path, JSON.stringify(await encryptBytes(key, part)), previous?.remoteSha);
    chunks.push({ index, path, remoteSha });
  }
  await deleteStaleChunks(github, existing, new Set(chunks.map(chunk => chunk.path)));
  return { id, path: existing?.path ?? "", objectPath: objectPathForId(id), plaintextSha256: fullHash, size: plaintext.byteLength, mtime: Date.now(), storage: "chunked", chunks };
}

export async function downloadEncryptedFileObject(github: GitHubClient, key: CryptoKey, record: EncryptedObjectRecord): Promise<Uint8Array> {
  if (record.storage !== "chunked") {
    const remote = await readGitHubBlobOrFileBytes(github, record.objectPath, record.remoteSha);
    if (!remote) throw new Error(`Missing encrypted object: ${record.objectPath}`);
    return decryptBytes(key, JSON.parse(new TextDecoder().decode(remote.bytes)) as EncryptedPayload);
  }

  const parts: Uint8Array[] = [];
  for (const chunk of [...(record.chunks ?? [])].sort((a, b) => a.index - b.index)) {
    const remote = await readGitHubBlobOrFileBytes(github, chunk.path, chunk.remoteSha);
    if (!remote) throw new Error(`Missing encrypted chunk: ${chunk.path}`);
    parts.push(await decryptBytes(key, JSON.parse(new TextDecoder().decode(remote.bytes)) as EncryptedPayload));
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
