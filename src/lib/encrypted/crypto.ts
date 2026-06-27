import { AES_GCM_NONCE_BYTES } from "./constants";
import { bytesToUtf8, fromBase64Url, randomBytes, toBase64Url, utf8ToBytes } from "./bytes";
import { EncryptedRepoConfig } from "./types";

export interface EncryptedPayload {
  nonce: string;
  ciphertext: string;
}

function asArrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

export async function deriveEncryptionKey(passphrase: string, config: EncryptedRepoConfig): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey("raw", asArrayBuffer(utf8ToBytes(passphrase)), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: asArrayBuffer(fromBase64Url(config.kdfParams.salt)),
      iterations: config.kdfParams.iterations,
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function encryptBytes(key: CryptoKey, plaintext: ArrayBuffer | Uint8Array): Promise<EncryptedPayload> {
  const nonce = randomBytes(AES_GCM_NONCE_BYTES);
  const bytes = plaintext instanceof Uint8Array ? plaintext : new Uint8Array(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: asArrayBuffer(nonce) }, key, asArrayBuffer(bytes));
  return { nonce: toBase64Url(nonce), ciphertext: toBase64Url(ciphertext) };
}

export async function decryptBytes(key: CryptoKey, payload: EncryptedPayload): Promise<Uint8Array> {
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: asArrayBuffer(fromBase64Url(payload.nonce)) },
    key,
    asArrayBuffer(fromBase64Url(payload.ciphertext))
  );
  return new Uint8Array(plaintext);
}

export async function encryptJson(key: CryptoKey, value: unknown): Promise<string> {
  return JSON.stringify(await encryptBytes(key, utf8ToBytes(JSON.stringify(value))));
}

export async function decryptJson<T>(key: CryptoKey, value: string): Promise<T> {
  const payload = JSON.parse(value) as EncryptedPayload;
  return JSON.parse(bytesToUtf8(await decryptBytes(key, payload))) as T;
}