import { sha256Hex } from "../bytes";
import { normalizeV4VaultPath } from "./paths";
import { V4_ROOT, type V4StorageMode } from "./protocol-types";

export const V4_LARGE_FILE_THRESHOLD_BYTES = 50 * 1024 * 1024;
export const V4_PART_BYTES = 48 * 1024 * 1024;

export function shouldUseV4Parts(logicalBytes: number, predictedRemoteBytes = logicalBytes): boolean {
  return logicalBytes > V4_LARGE_FILE_THRESHOLD_BYTES || predictedRemoteBytes > V4_LARGE_FILE_THRESHOLD_BYTES;
}

export function splitV4Parts(bytes: Uint8Array, partBytes = V4_PART_BYTES): Uint8Array[] {
  if (!Number.isInteger(partBytes) || partBytes <= 0) throw new Error("V4 part size must be a positive integer.");
  const parts: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += partBytes) parts.push(bytes.subarray(offset, Math.min(bytes.byteLength, offset + partBytes)));
  return parts.length > 0 ? parts : [bytes.subarray(0, 0)];
}

export function buildV4PartPaths(input: {
  mode: V4StorageMode;
  logicalPath: string;
  version: string;
  partCount: number;
  opaqueId?: string;
}): string[] {
  const normalized = normalizeV4VaultPath(input.logicalPath);
  const segments = normalized.split("/");
  const basename = segments.pop()!;
  const folder = segments.join("/");
  const visibleName = input.mode === "plaintext" ? basename : input.opaqueId;
  if (!visibleName) throw new Error("Encrypted V4 part paths require an opaque id.");
  const root = input.mode === "plaintext" ? `${V4_ROOT}/large` : `${V4_ROOT}/parts`;
  const coordinates = input.mode === "plaintext"
    ? `${folder ? `${folder}/` : ""}${visibleName}`
    : `${visibleName.slice(0, 2)}/${visibleName}`;
  const prefix = `${root}/${coordinates}/${input.version}`;
  return Array.from({ length: input.partCount }, (_, index) => `${prefix}/${String(index + 1).padStart(6, "0")}.${input.mode === "plaintext" ? "part" : "enc"}`);
}

export async function joinAndVerifyV4Parts(parts: Uint8Array[], expectedSha256: string): Promise<Uint8Array> {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.byteLength;
  }
  if (await sha256Hex(joined) !== expectedSha256) throw new Error("V4 large-file hash mismatch.");
  return joined;
}
