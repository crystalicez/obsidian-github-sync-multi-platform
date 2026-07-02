import { normalizeV3VaultPath } from "./paths";

export type EncryptedV3QueuedChange =
  | { type: "modify"; path: string; mtime: number }
  | { type: "delete"; path: string; mtime: number }
  | { type: "rename"; oldPath: string; path: string; mtime: number };

function clone(change: EncryptedV3QueuedChange): EncryptedV3QueuedChange {
  return { ...change };
}

export function coalesceV3Changes(changes: EncryptedV3QueuedChange[]): EncryptedV3QueuedChange[] {
  const byPath = new Map<string, EncryptedV3QueuedChange>();
  for (const raw of changes) {
    const change = raw.type === "rename"
      ? { ...raw, oldPath: normalizeV3VaultPath(raw.oldPath), path: normalizeV3VaultPath(raw.path) }
      : { ...raw, path: normalizeV3VaultPath(raw.path) };

    if (change.type === "rename") {
      const previousRename = byPath.get(change.oldPath);
      const oldPath = previousRename?.type === "rename" ? previousRename.oldPath : change.oldPath;
      byPath.delete(change.oldPath);
      byPath.delete(change.path);
      byPath.set(change.path, { type: "rename", oldPath, path: change.path, mtime: Math.max(change.mtime, previousRename?.mtime ?? change.mtime) });
      continue;
    }

    if (change.type === "delete") {
      byPath.set(change.path, clone(change));
      continue;
    }

    const existing = byPath.get(change.path);
    if (existing?.type === "delete") continue;
    if (existing?.type === "rename") {
      byPath.set(change.path, { ...existing, mtime: Math.max(existing.mtime, change.mtime) });
      continue;
    }
    byPath.set(change.path, clone(change));
  }
  return [...byPath.values()];
}

export class EncryptedV3ChangeBatcher {
  private readonly changes: EncryptedV3QueuedChange[] = [];

  get size(): number {
    return coalesceV3Changes(this.changes).length;
  }

  enqueue(change: EncryptedV3QueuedChange): void {
    this.changes.push(change);
  }

  flush(): EncryptedV3QueuedChange[] {
    const batch = coalesceV3Changes(this.changes);
    this.changes.length = 0;
    return batch;
  }
}
