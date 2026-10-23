const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const BYTE_STRING_CHUNK_SIZE = 0x8000;
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const HEX_TABLE = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, "0"));

function asUint8Array(value: ArrayBuffer | Uint8Array): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

function readIndexedByte(bytes: Uint8Array, index: number): number {
  const byte = bytes[index];
  if (byte === undefined) throw new RangeError("Byte access out of bounds.");
  return byte;
}

function getHexPair(bytes: Uint8Array, index: number): string {
  const hex = HEX_TABLE[readIndexedByte(bytes, index)];
  if (hex === undefined) throw new RangeError("Missing hex lookup.");
  return hex;
}

function encodeBase64Bytes(bytes: Uint8Array, alphabet: string, padding: boolean): string {
  if (alphabet.length !== 64) throw new RangeError("Invalid Base64 alphabet length.");
  const chunks: string[] = [];
  let chunk = "";
  let i = 0;
  for (; i + 2 < bytes.byteLength; i += 3) {
    const value = (readIndexedByte(bytes, i) << 16) | (readIndexedByte(bytes, i + 1) << 8) | readIndexedByte(bytes, i + 2);
    chunk += alphabet.charAt((value >>> 18) & 63)
      + alphabet.charAt((value >>> 12) & 63)
      + alphabet.charAt((value >>> 6) & 63)
      + alphabet.charAt(value & 63);
    if (chunk.length >= BYTE_STRING_CHUNK_SIZE) {
      chunks.push(chunk);
      chunk = "";
    }
  }

  if (i < bytes.byteLength) {
    const first = readIndexedByte(bytes, i);
    const second = i + 1 < bytes.byteLength ? readIndexedByte(bytes, i + 1) : 0;
    const value = (first << 16) | (second << 8);
    chunk += alphabet.charAt((value >>> 18) & 63) + alphabet.charAt((value >>> 12) & 63);
    if (i + 1 < bytes.byteLength) chunk += alphabet.charAt((value >>> 6) & 63);
    else if (padding) chunk += "=";
    if (padding) chunk += "=";
  }

  if (chunk.length > 0) chunks.push(chunk);
  return chunks.join("");
}

export function utf8ToBytes(value: string): Uint8Array {
  return textEncoder.encode(value);
}

export function bytesToUtf8(value: ArrayBuffer | Uint8Array): string {
  return textDecoder.decode(asUint8Array(value));
}

export function toBase64(value: ArrayBuffer | Uint8Array): string {
  const bytes = asUint8Array(value);
  const bufferConstructor = (globalThis as typeof globalThis & { Buffer?: { from(input: Uint8Array): { toString(encoding: "base64"): string } } }).Buffer;
  if (bufferConstructor) return bufferConstructor.from(bytes).toString("base64");
  return encodeBase64Bytes(bytes, BASE64_ALPHABET, true);
}

export function toBase64Url(value: ArrayBuffer | Uint8Array): string {
  const bytes = asUint8Array(value);
  const bufferConstructor = (globalThis as typeof globalThis & { Buffer?: { from(input: Uint8Array): { toString(encoding: "base64url"): string } } }).Buffer;
  if (bufferConstructor) return bufferConstructor.from(bytes).toString("base64url");
  return encodeBase64Bytes(bytes, BASE64URL_ALPHABET, false);
}

export function fromBase64(value: string): Uint8Array {
  const normalized = value.replace(/\s/g, "");
  const bufferConstructor = (globalThis as typeof globalThis & { Buffer?: { from(input: string, encoding: "base64"): Uint8Array } }).Buffer;
  if (bufferConstructor) return new Uint8Array(bufferConstructor.from(normalized, "base64"));
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  return fromBase64(padded);
}

export function toHex(value: ArrayBuffer | Uint8Array): string {
  const bytes = asUint8Array(value);
  const bufferConstructor = (globalThis as typeof globalThis & { Buffer?: { from(input: Uint8Array): { toString(encoding: "hex"): string } } }).Buffer;
  if (bufferConstructor) return bufferConstructor.from(bytes).toString("hex");
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += BYTE_STRING_CHUNK_SIZE) {
    let chunk = "";
    const end = Math.min(offset + BYTE_STRING_CHUNK_SIZE, bytes.byteLength);
    for (let i = offset; i < end; i++) chunk += getHexPair(bytes, i);
    chunks.push(chunk);
  }
  return chunks.join("");
}

export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

export async function sha256Hex(value: ArrayBuffer | Uint8Array): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", value as any));
}
