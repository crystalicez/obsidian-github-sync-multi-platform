import { randomBytes, sha256Hex, utf8ToBytes } from "../encrypted/bytes";

const MAGIC = new Uint8Array([0x4f, 0x47, 0x53, 0x56, 0x33, 0x42, 0x49, 0x4e]); // OGSV3BIN
const VERSION = 1;
const NONCE_BYTES = 12;
const HEADER_BYTES = MAGIC.byteLength + 1 + 1 + NONCE_BYTES;

export interface V3BinaryEncryptOptions {
  aad: string;
  kind: "object" | "chunk" | "pack" | "shard" | "head";
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

async function importAesKey(keyMaterial: Uint8Array): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", keyMaterial as any);
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

function aadBytes(kind: string, aad: string): Uint8Array {
  return utf8ToBytes(`${kind}\n${aad}`);
}

export async function encryptV3BinaryPayload(keyMaterial: Uint8Array, plaintext: Uint8Array, options: V3BinaryEncryptOptions): Promise<Uint8Array> {
  const key = await importAesKey(keyMaterial);
  const nonce = randomBytes(NONCE_BYTES);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce as any, additionalData: aadBytes(options.kind, options.aad) as any },
    key,
    plaintext as any,
  ));
  return concatBytes([MAGIC, new Uint8Array([VERSION, options.kind.length]), nonce, utf8ToBytes(options.kind), ciphertext]);
}

export async function decryptV3BinaryPayload(keyMaterial: Uint8Array, payload: Uint8Array, aad: string): Promise<Uint8Array> {
  if (payload.byteLength < HEADER_BYTES) throw new Error("Invalid v3 binary payload: too short.");
  for (let i = 0; i < MAGIC.byteLength; i++) {
    if (payload[i] !== MAGIC[i]) throw new Error("Invalid v3 binary payload: bad magic.");
  }
  if (payload[MAGIC.byteLength] !== VERSION) throw new Error("Invalid v3 binary payload: unsupported version.");
  const kindLength = payload[MAGIC.byteLength + 1];
  const nonceStart = MAGIC.byteLength + 2;
  const kindStart = nonceStart + NONCE_BYTES;
  const ciphertextStart = kindStart + kindLength;
  if (payload.byteLength < ciphertextStart) throw new Error("Invalid v3 binary payload: truncated kind.");
  const nonce = payload.slice(nonceStart, kindStart);
  const kind = new TextDecoder().decode(payload.slice(kindStart, ciphertextStart));
  const ciphertext = payload.slice(ciphertextStart);
  const key = await importAesKey(keyMaterial);
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce as any, additionalData: aadBytes(kind, aad) as any },
      key,
      ciphertext as any,
    );
    return new Uint8Array(plaintext);
  } catch (error) {
    throw new Error("Encrypted v3 payload could not be decrypted. The passphrase is wrong or the remote data is corrupt.", { cause: error });
  }
}

export async function v3PayloadSha256(payload: Uint8Array): Promise<string> {
  return sha256Hex(payload);
}
