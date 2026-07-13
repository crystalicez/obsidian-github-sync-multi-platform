import { toBase64Url, toHex, utf8ToBytes } from "../bytes";
import { V4_ROOT } from "./protocol-types";

export function normalizeV4VaultPath(path: string): string {
  const normalized = path.replace(/\\/gu, "/").replace(/^\/+|\/+$/gu, "").replace(/\/{2,}/gu, "/");
  const segments = normalized.split("/");
  if (!normalized || segments.some(segment => !segment || segment === "." || segment === "..")) {
    throw new Error(`Unsafe V4 vault path: ${path}`);
  }
  return normalized;
}

async function hmac(keyBytes: Uint8Array, value: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", keyBytes as any, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8ToBytes(value) as any));
}

export async function pathIdForV4Path(pathKey: Uint8Array, path: string): Promise<string> {
  return toHex(await hmac(pathKey, `path-id:${normalizeV4VaultPath(path)}`));
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
