import { ENCRYPTED_PACK_MAX_FILES, ENCRYPTED_PACK_PLAINTEXT_BYTES } from "./constants";
import { packObjectPathForId } from "./pack-format";
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
  let totalBytes = 0;

  for (const file of sorted) {
    if (file.size > maxPackBytes) throw new Error(`File is too large for encrypted pack mode: ${file.path}`);
    const wouldExceedBytes = current.files.length > 0 && current.totalBytes + file.size > maxPackBytes;
    const wouldExceedCount = current.files.length >= maxFilesPerPack;
    if (wouldExceedBytes || wouldExceedCount) {
      packs.push(current);
      current = createPack(packs.length + 1);
    }
    current.files.push(file);
    current.totalBytes += file.size;
    totalBytes += file.size;
  }

  if (current.files.length > 0) packs.push(current);
  return { totalFiles: sorted.length, totalBytes, packs };
}
