import { randomBytes, toHex, utf8ToBytes } from "../bytes";

const MAGIC = new Uint8Array([0x4f, 0x47, 0x53, 0x34]);
const PAYLOAD_VERSION = 1;
const NONCE_BYTES = 12;

export interface V4Keyring {
  masterKey: Uint8Array;
  pathKey: Uint8Array;
  contentKey: Uint8Array;
  indexKey: Uint8Array;
  journalKey: Uint8Array;
}

export interface V4PayloadContext {
  kind: "content" | "path" | "index" | "head" | "journal" | "pack" | "part";
  aad: string;
}

async function hmacSha256(keyBytes: Uint8Array, value: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", keyBytes as any, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8ToBytes(value) as any));
}

export async function deriveV4Keyring(input: {
  passphrase: string;
  repoId: string;
  salt: Uint8Array;
  iterations?: number;
}): Promise<V4Keyring> {
  const material = await crypto.subtle.importKey("raw", utf8ToBytes(input.passphrase) as any, "PBKDF2", false, ["deriveBits"]);
  const masterKey = new Uint8Array(await crypto.subtle.deriveBits({
    name: "PBKDF2",
    hash: "SHA-256",
    salt: input.salt as any,
    iterations: input.iterations ?? 600_000,
  }, material, 256));
  const scope = `obsidian-github-sync-v4:${input.repoId}`;
  return {
    masterKey,
    pathKey: await hmacSha256(masterKey, `${scope}:path`),
    contentKey: await hmacSha256(masterKey, `${scope}:content`),
    indexKey: await hmacSha256(masterKey, `${scope}:index`),
    journalKey: await hmacSha256(masterKey, `${scope}:journal`),
  };
}

function payloadAad(context: V4PayloadContext): Uint8Array {
  return utf8ToBytes(`ogs4:${context.kind}:${context.aad}`);
}

async function importAesKey(keyBytes: Uint8Array): Promise<CryptoKey> {
  const normalized = keyBytes.byteLength === 32
    ? keyBytes
    : new Uint8Array(await crypto.subtle.digest("SHA-256", keyBytes as any));
  return crypto.subtle.importKey("raw", normalized as any, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

function hasMagic(bytes: Uint8Array): boolean {
  return MAGIC.every((byte, index) => bytes[index] === byte);
}

export async function encryptV4Payload(keyBytes: Uint8Array, plaintext: Uint8Array, context: V4PayloadContext): Promise<Uint8Array> {
  const nonce = randomBytes(NONCE_BYTES);
  const key = await importAesKey(keyBytes);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({
    name: "AES-GCM",
    iv: nonce as any,
    additionalData: payloadAad(context) as any,
  }, key, plaintext as any));
  const result = new Uint8Array(MAGIC.byteLength + 1 + NONCE_BYTES + ciphertext.byteLength);
  result.set(MAGIC, 0);
  result[MAGIC.byteLength] = PAYLOAD_VERSION;
  result.set(nonce, MAGIC.byteLength + 1);
  result.set(ciphertext, MAGIC.byteLength + 1 + NONCE_BYTES);
  return result;
}

export async function decryptV4Payload(keyBytes: Uint8Array, payload: Uint8Array, context: V4PayloadContext): Promise<Uint8Array> {
  if (payload.byteLength < MAGIC.byteLength + 1 + NONCE_BYTES + 16 || !hasMagic(payload)) {
    throw new Error("Invalid encrypted V4 payload header.");
  }
  if (payload[MAGIC.byteLength] !== PAYLOAD_VERSION) throw new Error("Unsupported encrypted V4 payload version.");
  const nonceStart = MAGIC.byteLength + 1;
  const nonce = payload.subarray(nonceStart, nonceStart + NONCE_BYTES);
  const ciphertext = payload.subarray(nonceStart + NONCE_BYTES);
  const key = await importAesKey(keyBytes);
  return new Uint8Array(await crypto.subtle.decrypt({
    name: "AES-GCM",
    iv: nonce as any,
    additionalData: payloadAad(context) as any,
  }, key, ciphertext as any));
}

export async function fingerprintV4Keyring(keyring: V4Keyring): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", keyring.masterKey as any));
}
