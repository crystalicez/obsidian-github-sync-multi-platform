import { ENCRYPTED_PACK_MAX_FILES, ENCRYPTED_PACK_PLAINTEXT_BYTES } from "./constants";
import { estimateEncryptedPackPayloadBytes, estimateEncryptedPayloadJsonBytes, estimatePackArchiveBytesFromParts, estimatePackHeaderEntryBytes, packObjectPathForId } from "./pack-format";
import { EncryptedPackFileEntry, EncryptedPackPlan, EncryptedPackPlanRecord } from "./types";

export interface PackPlanningOptions {
  maxPackBytes?: number;
  maxFilesPerPack?: number;
}

export interface PackPlanningFile {
  path: string;
  size: number;
  mtime: number;
  plaintextSha256?: string;
}

function packId(index: number): string {
  return String(index).padStart(6, "0");
}

function normalizePlanningFile(file: PackPlanningFile): EncryptedPackFileEntry {
  return {
    path: file.path.replace(/\\/g, "/").replace(/^\/+/u, ""),
    size: file.size,
    mtime: file.mtime,
    plaintextSha256: file.plaintextSha256,
  };
}

function createPack(index: number): EncryptedPackPlanRecord {
  const id = packId(index);
  return { id, objectPath: packObjectPathForId(id), totalBytes: 0, files: [] };
}

export function planEncryptedPacks(files: PackPlanningFile[], options: PackPlanningOptions = {}): EncryptedPackPlan {
  const maxPackBytes = options.maxPackBytes ?? ENCRYPTED_PACK_PLAINTEXT_BYTES;
  const maxFilesPerPack = options.maxFilesPerPack ?? ENCRYPTED_PACK_MAX_FILES;
  if (maxPackBytes <= 0) throw new Error("maxPackBytes must be greater than 0.");
  if (maxFilesPerPack <= 0) throw new Error("maxFilesPerPack must be greater than 0.");

  const sorted = files.map(normalizePlanningFile).sort((a, b) => a.path.localeCompare(b.path));
  const packs: EncryptedPackPlanRecord[] = [];
  let current = createPack(1);
  let currentHeaderEntriesBytes = 0;
  let totalBytes = 0;

  for (const file of sorted) {
    const singleEntryBytes = estimatePackHeaderEntryBytes(file, 0);
    const singlePayloadBytes = estimateEncryptedPayloadJsonBytes(estimatePackArchiveBytesFromParts(file.size, 1, singleEntryBytes));
    if (singlePayloadBytes > maxPackBytes) throw new Error(`File is too large for encrypted pack mode: ${file.path}`);

    const candidateEntryBytes = estimatePackHeaderEntryBytes(file, current.totalBytes);
    const candidatePayloadBytes = estimateEncryptedPayloadJsonBytes(estimatePackArchiveBytesFromParts(current.totalBytes + file.size, current.files.length + 1, currentHeaderEntriesBytes + candidateEntryBytes));
    const wouldExceedBytes = current.files.length > 0 && candidatePayloadBytes > maxPackBytes;
    const wouldExceedCount = current.files.length >= maxFilesPerPack;
    if (wouldExceedBytes || wouldExceedCount) {
      packs.push(current);
      current = createPack(packs.length + 1);
      currentHeaderEntriesBytes = 0;
    }

    const entryBytes = estimatePackHeaderEntryBytes(file, current.totalBytes);
    current.files.push(file);
    current.totalBytes += file.size;
    currentHeaderEntriesBytes += entryBytes;
    totalBytes += file.size;
  }

  if (current.files.length > 0) packs.push(current);
  return { totalFiles: sorted.length, totalBytes, packs };
}
