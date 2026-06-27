import { ENCRYPTED_OBJECTS_ROOT } from "./constants";

export function normalizeVaultPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/u, "").split("/").filter(Boolean).join("/");
}

export function detectCaseInsensitiveCollisions(paths: string[]): string[][] {
  const seen = new Map<string, string>();
  const collisions: string[][] = [];
  for (const rawPath of paths) {
    const path = normalizeVaultPath(rawPath);
    const key = path.toLocaleLowerCase("en-US");
    const first = seen.get(key);
    if (first && first !== path) collisions.push([first, path]);
    else seen.set(key, path);
  }
  return collisions;
}

export function objectPathForId(id: string): string {
  return `${ENCRYPTED_OBJECTS_ROOT}/${id.slice(0, 2)}/${id.slice(2, 4)}/${id}.enc`;
}

export function conflictPathFor(path: string, timestamp: number, source: string): string {
  const normalized = normalizeVaultPath(path);
  const dot = normalized.lastIndexOf(".");
  const slash = normalized.lastIndexOf("/");
  const stamp = new Date(timestamp).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/u, "Z");
  if (dot <= slash) return `${normalized}.sync-conflict-${stamp}-${source}`;
  return `${normalized.slice(0, dot)}.sync-conflict-${stamp}-${source}${normalized.slice(dot)}`;
}
