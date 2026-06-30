export type EncryptedQueuedChange =
  | { type: "modify"; path: string; mtime: number }
  | { type: "delete"; path: string; mtime: number }
  | { type: "rename"; oldPath: string; path: string; mtime: number };

function cloneChange(change: EncryptedQueuedChange): EncryptedQueuedChange {
  return { ...change };
}

export class EncryptedChangeQueue {
  private readonly changesByPath = new Map<string, EncryptedQueuedChange>();

  get size(): number {
    return this.changesByPath.size;
  }

  enqueue(change: EncryptedQueuedChange): void {
    if (change.type === "rename") {
      this.changesByPath.delete(change.oldPath);
      const existingTarget = this.changesByPath.get(change.path);
      const mtime = Math.max(change.mtime, existingTarget?.mtime ?? change.mtime);
      this.changesByPath.set(change.path, { ...change, mtime });
      return;
    }

    if (change.type === "delete") {
      this.changesByPath.set(change.path, cloneChange(change));
      return;
    }

    const existing = this.changesByPath.get(change.path);
    if (existing?.type === "delete") return;
    if (existing?.type === "rename") {
      this.changesByPath.set(change.path, { ...existing, mtime: Math.max(existing.mtime, change.mtime) });
      return;
    }
    this.changesByPath.set(change.path, cloneChange(change));
  }

  flush(): EncryptedQueuedChange[] {
    const batch = [...this.changesByPath.values()].map(cloneChange);
    this.changesByPath.clear();
    return batch;
  }

  clear(): void {
    this.changesByPath.clear();
  }
}