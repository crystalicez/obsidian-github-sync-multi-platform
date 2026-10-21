import { V4_ENCRYPTED_PAYLOAD_OVERHEAD_BYTES } from "./crypto";

export const V4_METADATA_MAX_BYTES = {
  config: 64 * 1024,
  head: 256 * 1024,
  shard: 16 * 1024 * 1024,
  journal: 32 * 1024 * 1024,
} as const;

export type V4MetadataKind = keyof typeof V4_METADATA_MAX_BYTES;

/** Bounds JSON before parsing; encrypted payloads include only the fixed AES-GCM framing overhead. */
export function assertV4MetadataBytes(bytes: Uint8Array, kind: V4MetadataKind, encrypted = false): void {
  const limit = V4_METADATA_MAX_BYTES[kind] + (encrypted ? V4_ENCRYPTED_PAYLOAD_OVERHEAD_BYTES : 0);
  if (bytes.byteLength > limit) {
    throw new Error(`V4 ${kind} metadata exceeds the ${limit}-byte limit.`);
  }
}
