import { toHex, utf8ToBytes } from "../encrypted/bytes";

function normalizeSlashes(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/u, "").replace(/\/+/g, "/");
}

export function normalizeV3VaultPath(path: string): string {
  return normalizeSlashes(path).split("/").filter(Boolean).join("/");
}

async function importHmacKey(keyBytes: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", keyBytes as any, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

export async function createV3PathId(pathKey: Uint8Array, normalizedPath: string): Promise<string> {
  const key = await importHmacKey(pathKey);
  const signature = await crypto.subtle.sign("HMAC", key, utf8ToBytes(normalizeV3VaultPath(normalizedPath)) as any);
  return toHex(signature);
}

export function bucketForV3PathId(pathId: string): string {
  const normalized = pathId.toLowerCase();
  if (!/^[0-9a-f]{64}$/u.test(normalized)) throw new Error("Invalid v3 path id.");
  return normalized.slice(0, 2);
}

export function v3ShardPath(bucket: string): string {
  if (!/^[0-9a-f]{2}$/u.test(bucket)) throw new Error("Invalid v3 shard bucket.");
  return `.obsidian-github-sync-v3/shards/${bucket}.enc`;
}
