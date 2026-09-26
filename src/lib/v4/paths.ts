import { toBase64Url, toHex, utf8ToBytes } from "../bytes";
import { V4_ROOT } from "./protocol-types";

const WINDOWS_RESERVED_SEGMENT = /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/iu;
const PORTABLE_SEGMENT_FORBIDDEN = /[\u0000-\u001f<>:"|?*]/u;
const MAX_PORTABLE_SEGMENT_UTF8_BYTES = 255;

function assertPortableV4PathSegment(segment: string, originalPath: string): void {
  if (
    !segment
    || segment === "."
    || segment === ".."
    || PORTABLE_SEGMENT_FORBIDDEN.test(segment)
    || /[ .]$/u.test(segment)
    || WINDOWS_RESERVED_SEGMENT.test(segment)
    || new TextEncoder().encode(segment).byteLength > MAX_PORTABLE_SEGMENT_UTF8_BYTES
  ) {
    throw new Error(`Unsafe cross-platform V4 vault path: ${originalPath}`);
  }
}

export function normalizeV4VaultPath(path: string): string {
  const normalized = path.replace(/\\/gu, "/").replace(/^\/+|\/+$/gu, "").replace(/\/{2,}/gu, "/");
  const segments = normalized.split("/");
  if (!normalized) throw new Error(`Unsafe V4 vault path: ${path}`);
  for (const segment of segments) assertPortableV4PathSegment(segment, path);
  return normalized;
}

async function hmac(keyBytes: Uint8Array, value: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", keyBytes as any, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8ToBytes(value) as any));
}

export async function pathIdForV4Path(pathKey: Uint8Array, path: string): Promise<string> {
  return toHex(await hmac(pathKey, `path-id:${normalizeV4VaultPath(path)}`));
}

export async function objectIdForV4File(pathKey: Uint8Array, fileId: string): Promise<string> {
  if (!fileId) throw new Error("V4 file identity is required for an opaque object path.");
  return toHex(await hmac(pathKey, `object-id:${fileId}`));
}

export function bucketForV4PathId(pathId: string): string {
  if (!/^[0-9a-f]{64}$/u.test(pathId)) throw new Error("Invalid V4 path id.");
  return pathId.slice(0, 2);
}

export async function encryptedV4RemotePath(pathKey: Uint8Array, path: string): Promise<string> {
  const normalized = normalizeV4VaultPath(path);
  const segments = normalized.split("/");
  segments.pop();
  const folder = segments.join("/");
  const token = toBase64Url(await hmac(pathKey, `remote-basename:${normalized}`)).slice(0, 32);
  return `${V4_ROOT}/data/${folder ? `${folder}/` : ""}${token}.enc`;
}

export async function opaqueV4ObjectPath(pathKey: Uint8Array, fileId: string): Promise<string> {
  const objectId = await objectIdForV4File(pathKey, fileId);
  return `${V4_ROOT}/data/${objectId.slice(0, 2)}/${objectId}.enc`;
}

export async function opaqueV4PackPath(pathKey: Uint8Array, packId: string): Promise<string> {
  const objectId = toHex(await hmac(pathKey, `pack-id:${packId}`));
  return `${V4_ROOT}/packs/${objectId.slice(0, 2)}/${objectId}.enc`;
}
