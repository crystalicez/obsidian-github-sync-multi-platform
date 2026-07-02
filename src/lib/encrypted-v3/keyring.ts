import { sha256Hex, utf8ToBytes } from "../encrypted/bytes";

export interface EncryptedV3Keyring {
  masterKey: Uint8Array;
  pathKey: Uint8Array;
  contentKey: Uint8Array;
  shardKey: Uint8Array;
  headKey: Uint8Array;
}

async function hmacSha256(keyBytes: Uint8Array, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", keyBytes as any, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8ToBytes(message) as any));
}

export async function deriveEncryptedV3Keyring(input: { passphrase: string; repoId: string; salt: Uint8Array }): Promise<EncryptedV3Keyring> {
  const material = await crypto.subtle.importKey("raw", utf8ToBytes(input.passphrase) as any, "PBKDF2", false, ["deriveBits"]);
  const masterKey = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: input.salt as any, iterations: 250_000 },
    material,
    256,
  ));
  const scope = `obsidian-github-sync-v3:${input.repoId}`;
  return {
    masterKey,
    pathKey: await hmacSha256(masterKey, `${scope}:path`),
    contentKey: await hmacSha256(masterKey, `${scope}:content`),
    shardKey: await hmacSha256(masterKey, `${scope}:shard`),
    headKey: await hmacSha256(masterKey, `${scope}:head`),
  };
}

export async function fingerprintEncryptedV3Keyring(keyring: EncryptedV3Keyring): Promise<string> {
  return sha256Hex(keyring.masterKey);
}
