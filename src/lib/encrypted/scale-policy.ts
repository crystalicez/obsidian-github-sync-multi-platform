import { ENCRYPTED_PACK_MODE_FILE_COUNT_THRESHOLD, ENCRYPTED_PACK_MODE_TOTAL_BYTES_THRESHOLD } from "./constants";
import type { EncryptedStorageMode } from "./types";

export interface ScalePolicyInput {
  fileCount: number;
  totalBytes: number;
}

export function chooseEncryptedStorageMode(input: ScalePolicyInput): EncryptedStorageMode {
  if (input.fileCount >= ENCRYPTED_PACK_MODE_FILE_COUNT_THRESHOLD) return "pack";
  if (input.totalBytes >= ENCRYPTED_PACK_MODE_TOTAL_BYTES_THRESHOLD) return "pack";
  return "object";
}
