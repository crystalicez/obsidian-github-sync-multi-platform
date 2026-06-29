import { GitHubClient, readGitHubFileBytes } from "../github-api";
import { decryptBytes, encryptBytes, EncryptedPayload } from "./crypto";
import { decodePackArchive, encodePackArchive, PackArchiveFileInput, PackArchiveFileOutput, packObjectPathForId } from "./pack-format";
import { EncryptedPackManifestRecord } from "./types";

export async function uploadEncryptedPack(
  github: GitHubClient,
  key: CryptoKey,
  id: string,
  files: PackArchiveFileInput[],
  existing?: EncryptedPackManifestRecord
): Promise<EncryptedPackManifestRecord> {
  const archive = encodePackArchive(files);
  const payload = JSON.stringify(await encryptBytes(key, archive));
  const objectPath = existing?.objectPath ?? packObjectPathForId(id);
  const remoteSha = await github.putFile(objectPath, payload, existing?.remoteSha);
  return {
    id,
    objectPath,
    remoteSha,
    totalBytes: files.reduce((sum, file) => sum + file.bytes.byteLength, 0),
    fileCount: files.length,
    updatedAt: Date.now(),
  };
}

export async function downloadEncryptedPack(
  github: GitHubClient,
  key: CryptoKey,
  record: EncryptedPackManifestRecord
): Promise<PackArchiveFileOutput[]> {
  const remote = await readGitHubFileBytes(github, record.objectPath);
  if (!remote) throw new Error(`Missing encrypted pack: ${record.objectPath}`);
  const archive = await decryptBytes(key, JSON.parse(new TextDecoder().decode(remote.bytes)) as EncryptedPayload);
  return decodePackArchive(archive);
}
