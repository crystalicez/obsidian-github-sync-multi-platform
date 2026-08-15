import { normalizeV4VaultPath } from "./paths";
import type { V4SyncOperation } from "./planner";
import { V4CancelledError } from "./cancellation";

export type V4SyncTrigger = "startup" | "localChange" | "scheduled" | "manual" | "forcePush" | "forcePull";
export type V4QueuedChange =
  | { type: "modify"; path: string; mtime: number }
  | { type: "replace"; oldPath: string; path: string; mtime: number }
  | { type: "delete"; path: string; mtime: number }
  | { type: "rename"; oldPath: string; path: string; mtime: number }
  | { type: "folderRename"; oldPath: string; path: string; mtime: number }
  | { type: "folderDelete"; path: string; mtime: number }
  | { type: "rescan"; mtime: number };
type V4PathChange = Exclude<V4QueuedChange, { type: "rescan" }>;

export interface V4SyncRequest {
  operation: V4SyncOperation;
  trigger: V4SyncTrigger;
  allowThresholdOverride?: boolean;
}

export interface V4CoordinatorExecutionResult { changedFiles: number; }
export interface V4CoordinatorRunResult extends V4CoordinatorExecutionResult { status: "completed" | "busy" | "skipped"; }

export interface V4SyncCoordinatorOptions {
  execute(request: V4SyncRequest, changes: V4QueuedChange[], signal: AbortSignal): Promise<V4CoordinatorExecutionResult>;
  notice?: (message: string) => void;
  schedule?: (callback: () => void, delay: number) => unknown;
  cancel?: (handle: any) => void;
  debounceMs?: number;
}

export function coalesceV4Changes(changes: V4QueuedChange[]): V4QueuedChange[] {
  if (changes.some(change => change.type === "rescan")) {
    return [{ type: "rescan", mtime: Math.max(...changes.map(change => change.mtime)) }];
  }
  const byPath = new Map<string | symbol, V4QueuedChange>();
  const pathChanges = changes
    .filter((change): change is V4PathChange => change.type !== "rescan")
    .map((raw): V4PathChange => raw.type === "rename" || raw.type === "replace" || raw.type === "folderRename"
      ? { ...raw, oldPath: normalizeV4VaultPath(raw.oldPath), path: normalizeV4VaultPath(raw.path) }
      : { ...raw, path: normalizeV4VaultPath(raw.path) });

  if (pathChanges.some(change => change.type === "folderRename" || change.type === "folderDelete")) {
    return pathChanges;
  }

  const priorRenameEndpoints = new Set<string>();
  const priorRenameDestinations = new Set<string>();
  for (const change of pathChanges) {
    if (change.type === "delete" && priorRenameDestinations.has(change.path)) {
      return [...pathChanges, { type: "rescan", mtime: Math.max(...pathChanges.map(item => item.mtime)) }];
    }
    if (change.type !== "rename") continue;
    if (priorRenameEndpoints.has(change.oldPath) || priorRenameEndpoints.has(change.path)) {
      return [...pathChanges, { type: "rescan", mtime: Math.max(...pathChanges.map(item => item.mtime)) }];
    }
    priorRenameEndpoints.add(change.oldPath);
    priorRenameEndpoints.add(change.path);
    priorRenameDestinations.add(change.path);
  }

  for (const change of pathChanges) {
    if (change.type === "folderRename") {
      byPath.set(Symbol("folderRename"), change);
      continue;
    }
    if (change.type === "rename") {
      const previous = byPath.get(change.oldPath);
      if (previous?.type === "replace") {
        byPath.delete(change.oldPath);
        byPath.delete(change.path);
        byPath.set(change.path, { type: "replace", oldPath: previous.oldPath, path: change.path, mtime: Math.max(change.mtime, previous.mtime) });
        continue;
      }
      const oldPath = previous?.type === change.type ? previous.oldPath : change.oldPath;
      byPath.delete(change.oldPath);
      byPath.delete(change.path);
      byPath.set(change.path, { type: change.type, oldPath, path: change.path, mtime: Math.max(change.mtime, previous?.mtime ?? change.mtime) });
      continue;
    }
    if (change.type === "delete" || change.type === "folderDelete") {
      const previous = byPath.get(change.path);
      if (change.type === "delete" && previous?.type === "replace") {
        byPath.delete(change.path);
        byPath.set(previous.oldPath, { type: "delete", path: previous.oldPath, mtime: Math.max(previous.mtime, change.mtime) });
        continue;
      }
      const renameType = change.type === "delete" ? "rename" : "folderRename";
      if (previous?.type === renameType) {
        byPath.delete(change.path);
        byPath.set(previous.oldPath, { type: change.type, path: previous.oldPath, mtime: Math.max(previous.mtime, change.mtime) });
        continue;
      }
      byPath.set(change.path, { ...change });
      continue;
    }
    const previous = byPath.get(change.path);
    if (previous?.type === "rename") {
      byPath.set(change.path, { ...previous, mtime: Math.max(previous.mtime, change.mtime) });
      continue;
    }
    if (change.type === "modify" && (previous?.type === "delete" || previous?.type === "replace")) {
      byPath.set(change.path, { type: "replace", oldPath: previous.type === "replace" ? previous.oldPath : change.path, path: change.path, mtime: Math.max(previous.mtime, change.mtime) });
      continue;
    }
    byPath.set(change.path, { ...change });
  }
  return [...byPath.values()];
}

export class V4SyncCoordinator {
  private readonly pending: V4QueuedChange[] = [];
  private active?: Promise<V4CoordinatorRunResult>;
  private activeController?: AbortController;
  private timer?: unknown;
  private flushAfterActive = false;
  private disposed = false;
  private readonly schedule: (callback: () => void, delay: number) => unknown;
  private readonly cancel: (handle: any) => void;
  private readonly debounceMs: number;

  constructor(private readonly options: V4SyncCoordinatorOptions) {
    this.schedule = options.schedule ?? ((callback, delay) => globalThis.setTimeout(callback, delay));
    this.cancel = options.cancel ?? (handle => globalThis.clearTimeout(handle));
    this.debounceMs = options.debounceMs ?? 5_000;
  }

  get isSyncing(): boolean { return this.active !== undefined; }
  get pendingCount(): number { return this.disposed ? 0 : coalesceV4Changes(this.pending).length; }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.activeController?.abort(new V4CancelledError("V4 coordinator disposed."))
    if (this.timer !== undefined) this.cancel(this.timer)
    this.timer = undefined
    this.flushAfterActive = false
    this.pending.length = 0
  }

  enqueue(change: V4QueuedChange): void {
    if (this.disposed) return;
    this.pending.push(change);
    if (this.timer !== undefined) this.cancel(this.timer);
    this.timer = this.schedule(() => {
      this.timer = undefined;
      void this.flushLocalChanges();
    }, this.debounceMs);
  }

  async run(request: V4SyncRequest): Promise<V4CoordinatorRunResult> {
    if (this.disposed) return { status: "skipped", changedFiles: 0 };
    if (this.active) {
      if (request.trigger === "scheduled" || request.trigger === "startup") return { status: "skipped", changedFiles: 0 };
      this.options.notice?.("GitHub Sync: Sync already in progress");
      return { status: "busy", changedFiles: 0 };
    }
    if (this.timer !== undefined && (request.trigger === "scheduled" || request.trigger === "startup")) {
      return { status: "skipped", changedFiles: 0 };
    }
    if (this.timer !== undefined) {
      this.cancel(this.timer);
      this.timer = undefined;
    }
    const changes = this.flushPending();
    return this.start(request, changes);
  }

  async whenIdle(): Promise<void> {
    while (this.active) await this.active;
  }

  private async flushLocalChanges(): Promise<V4CoordinatorRunResult> {
    if (this.disposed) return { status: "skipped", changedFiles: 0 };
    if (this.active) {
      this.flushAfterActive = true;
      return { status: "busy", changedFiles: 0 };
    }
    const changes = this.flushPending();
    if (changes.length === 0) return { status: "completed", changedFiles: 0 };
    return this.start({ operation: "normal", trigger: "localChange" }, changes);
  }

  private flushPending(): V4QueuedChange[] {
    const changes = coalesceV4Changes(this.pending);
    this.pending.length = 0;
    return changes;
  }

  private start(request: V4SyncRequest, changes: V4QueuedChange[]): Promise<V4CoordinatorRunResult> {
    if (this.disposed) return Promise.resolve({ status: "skipped", changedFiles: 0 });
    const controller = new AbortController();
    this.activeController = controller;
    let resolveExecution!: (result: V4CoordinatorRunResult) => void;
    let rejectExecution!: (error: unknown) => void;
    const execution = new Promise<V4CoordinatorRunResult>((resolve, reject) => {
      resolveExecution = resolve;
      rejectExecution = reject;
    });
    let tracked!: Promise<V4CoordinatorRunResult>;
    tracked = execution.finally(() => {
      if (this.active === tracked) this.active = undefined;
      if (this.activeController === controller) this.activeController = undefined;
      if (this.disposed) {
        this.pending.length = 0;
        this.flushAfterActive = false;
        return;
      }
      if (this.pending.length > 0 && this.flushAfterActive) {
        this.flushAfterActive = false;
        void this.flushLocalChanges();
      }
    });
    this.active = tracked;
    try {
      this.options.execute(request, changes, controller.signal).then(
        result => resolveExecution({ status: "completed", ...result }),
        rejectExecution,
      );
    } catch (error) {
      rejectExecution(error);
    }
    return tracked;
  }
}
