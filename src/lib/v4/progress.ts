import type { V4SyncOperation } from "./planner";
import type { V4SyncTrigger } from "./sync-coordinator";

export type V4SyncLifecycle = "idle" | "waiting" | "active" | "success" | "no-change" | "failed";
export type V4SyncPhase =
  | "debouncing"
  | "checking-remote"
  | "loading-index"
  | "scanning-local"
  | "planning"
  | "blocked"
  | "resolving-conflicts"
  | "downloading"
  | "applying"
  | "hashing"
  | "encrypting"
  | "uploading"
  | "committing"
  | "saving-index"
  | "retrying";
export type V4SyncDirection = "pull" | "push";

export interface V4DirectionalProgress {
  completed: number;
  total?: number;
}

export interface V4PhaseTiming {
  phase: V4SyncPhase;
  elapsedMs: number;
  occurrences: number;
}

export interface V4SyncProgressSnapshot {
  lifecycle: V4SyncLifecycle;
  phase?: V4SyncPhase;
  currentPath?: string;
  currentDirection?: V4SyncDirection;
  pull: V4DirectionalProgress;
  push: V4DirectionalProgress;
  operation?: V4SyncOperation;
  trigger?: V4SyncTrigger;
  attempt: number;
  timings: V4PhaseTiming[];
  totalElapsedMs: number;
  lastSyncTime: number;
  errorMessage?: string;
  failurePhase?: V4SyncPhase;
  failurePath?: string;
}

export type V4SyncProgressPatch = Partial<Omit<V4SyncProgressSnapshot, "pull" | "push" | "timings" | "totalElapsedMs">> & {
  pull?: Partial<V4DirectionalProgress>;
  push?: Partial<V4DirectionalProgress>;
};

export type V4BeginRunPatch = Omit<V4SyncProgressPatch, "lifecycle"> & { lifecycle?: never };

export interface V4ProgressStoreOptions {
  throttleMs?: number;
  timingRefreshMs?: number;
  schedule?: (callback: () => void, delay: number) => unknown;
  cancel?: (handle: unknown) => void;
  monotonicNow?: () => number;
}

type V4ProgressSubscriber = (snapshot: V4SyncProgressSnapshot) => void;
type TimingAccumulator = { elapsedMs: number; occurrences: number };

const phaseLabels: Record<V4SyncPhase, string> = {
  "debouncing": "Waiting for changes",
  "checking-remote": "Checking remote",
  "loading-index": "Loading index",
  "scanning-local": "Scanning local",
  "planning": "Planning",
  "blocked": "Blocked",
  "resolving-conflicts": "Resolving conflicts",
  "downloading": "Downloading",
  "applying": "Applying",
  "hashing": "Hashing",
  "encrypting": "Encrypting",
  "uploading": "Uploading",
  "committing": "Committing",
  "saving-index": "Saving index",
  "retrying": "Retrying",
};

function normalizeCount(value: number): number {
  return Math.max(0, Number.isFinite(value) ? Math.floor(value) : 0);
}

function normalizeDirectional(progress: V4DirectionalProgress): V4DirectionalProgress {
  const total = progress.total === undefined ? undefined : normalizeCount(progress.total);
  const completed = Math.min(normalizeCount(progress.completed), total ?? Number.POSITIVE_INFINITY);
  return total === undefined ? { completed } : { completed, total };
}

function mergePatch(snapshot: V4SyncProgressSnapshot, patch: V4SyncProgressPatch): V4SyncProgressSnapshot {
  const { pull, push, ...scalarPatch } = patch;
  return {
    ...snapshot,
    ...scalarPatch,
    pull: normalizeDirectional(pull ? { ...snapshot.pull, ...pull } : snapshot.pull),
    push: normalizeDirectional(push ? { ...snapshot.push, ...push } : snapshot.push),
  };
}

function directionalProgressEqual(left: V4DirectionalProgress, right: V4DirectionalProgress): boolean {
  return left.completed === right.completed && left.total === right.total;
}

function sensitiveProgressEqual(left: V4SyncProgressSnapshot, right: V4SyncProgressSnapshot): boolean {
  return left.currentPath === right.currentPath
    && left.currentDirection === right.currentDirection
    && directionalProgressEqual(left.pull, right.pull)
    && directionalProgressEqual(left.push, right.push);
}

function immediateMetadataEqual(left: V4SyncProgressSnapshot, right: V4SyncProgressSnapshot): boolean {
  return left.operation === right.operation
    && left.trigger === right.trigger
    && left.attempt === right.attempt
    && left.lastSyncTime === right.lastSyncTime
    && left.errorMessage === right.errorMessage
    && left.failurePhase === right.failurePhase
    && left.failurePath === right.failurePath;
}

function phaseOrLifecycleTransitioned(left: V4SyncProgressSnapshot, right: V4SyncProgressSnapshot): boolean {
  return left.phase !== right.phase || left.lifecycle !== right.lifecycle;
}

function withEligibleSensitiveProgress(
  source: V4SyncProgressSnapshot,
  eligible: V4SyncProgressSnapshot,
): V4SyncProgressSnapshot {
  return {
    ...source,
    currentPath: eligible.currentPath,
    currentDirection: eligible.currentDirection,
    pull: eligible.pull,
    push: eligible.push,
  };
}

function snapshotsEqual(left: V4SyncProgressSnapshot, right: V4SyncProgressSnapshot): boolean {
  return left.lifecycle === right.lifecycle
    && left.phase === right.phase
    && sensitiveProgressEqual(left, right)
    && immediateMetadataEqual(left, right)
    && left.totalElapsedMs === right.totalElapsedMs
    && left.timings.length === right.timings.length
    && left.timings.every((timing, index) => {
      const other = right.timings[index];
      return timing.phase === other.phase
        && timing.elapsedMs === other.elapsedMs
        && timing.occurrences === other.occurrences;
    });
}

function freezeSnapshot(snapshot: V4SyncProgressSnapshot): V4SyncProgressSnapshot {
  const pull = Object.freeze({ ...snapshot.pull });
  const push = Object.freeze({ ...snapshot.push });
  const timings = Object.freeze(snapshot.timings.map(timing => Object.freeze({ ...timing })));
  return Object.freeze({ ...snapshot, pull, push, timings: timings as V4PhaseTiming[] });
}

export function createIdleV4Progress(): V4SyncProgressSnapshot {
  return {
    lifecycle: "idle",
    pull: { completed: 0 },
    push: { completed: 0 },
    attempt: 0,
    timings: [],
    totalElapsedMs: 0,
    lastSyncTime: 0,
  };
}

export function remainingV4Progress(progress: V4DirectionalProgress): number | undefined {
  if (progress.total === undefined) return undefined;
  return Math.max(0, progress.total - progress.completed);
}

export function formatV4PhaseLabel(phase: V4SyncPhase): string {
  return phaseLabels[phase];
}

export function formatV4Duration(elapsedMs: number): string {
  const normalized = Math.max(0, elapsedMs);
  if (normalized > 0 && normalized < 100) return "<0.1s";
  return `${(normalized / 1_000).toFixed(1)}s`;
}

export function formatV4PhaseTiming(timing: V4PhaseTiming): string {
  const attempts = timing.occurrences > 1 ? ` · ${timing.occurrences} attempts` : "";
  return `${formatV4PhaseLabel(timing.phase)} ${formatV4Duration(timing.elapsedMs)}${attempts}`;
}

export function middleTruncateV4Path(path: string, maximumLength: number): string {
  const limit = Math.max(0, Math.floor(maximumLength));
  if (path.length <= limit) return path;
  if (limit === 0) return "";
  if (limit === 1) return "…";

  const separator = path.lastIndexOf("/");
  if (separator > 0) {
    const tail = path.slice(separator);
    const availableHead = limit - tail.length - 1;
    if (availableHead > 0) {
      const headSource = path.slice(0, separator + 1);
      let head = "";
      for (const segment of headSource.split("/")) {
        if (!segment) continue;
        const candidate = `${head}${segment}/`;
        if (candidate.length > availableHead) break;
        head = candidate;
      }
      if (head) return `${head}…${tail}`;
    }
  }

  const remaining = limit - 1;
  const headLength = Math.ceil(remaining / 2);
  const tailLength = Math.floor(remaining / 2);
  return `${path.slice(0, headLength)}…${tailLength > 0 ? path.slice(-tailLength) : ""}`;
}

export class V4ProgressStore {
  private state = createIdleV4Progress();
  private publishedSnapshot = freezeSnapshot(createIdleV4Progress());
  private readonly subscribers = new Set<V4ProgressSubscriber>();
  private readonly schedule: (callback: () => void, delay: number) => unknown;
  private readonly cancel: (handle: unknown) => void;
  private readonly monotonicNow: () => number;
  private readonly throttleMs: number;
  private readonly timingRefreshMs: number;
  private throttleHandle?: unknown;
  private timingRefreshHandle?: unknown;
  private throttlePending = false;
  private disposed = false;
  private runStartedAt?: number;
  private activePhaseStartedAt?: number;
  private lastAcceptedNow?: number;
  private readonly timingOrder: V4SyncPhase[] = [];
  private readonly timingByPhase = new Map<V4SyncPhase, TimingAccumulator>();

  constructor(options: V4ProgressStoreOptions = {}) {
    this.schedule = options.schedule ?? ((callback, delay) => globalThis.setTimeout(callback, delay));
    this.cancel = options.cancel ?? (handle => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.monotonicNow = options.monotonicNow ?? (() => globalThis.performance?.now() ?? Date.now());
    this.throttleMs = options.throttleMs ?? 400;
    this.timingRefreshMs = options.timingRefreshMs ?? 1_000;
  }

  get snapshot(): V4SyncProgressSnapshot {
    return freezeSnapshot(this.publishedSnapshot);
  }

  subscribe(subscriber: V4ProgressSubscriber): () => void {
    if (this.disposed) return () => undefined;
    this.subscribers.add(subscriber);
    this.notifyOne(subscriber, this.publishedSnapshot);
    return () => { this.subscribers.delete(subscriber); };
  }

  beginRun(patch: V4BeginRunPatch = {}): void {
    if (this.disposed) return;
    this.cancelThrottle();
    this.cancelTimingRefresh();
    this.timingOrder.length = 0;
    this.timingByPhase.clear();

    const now = this.observeMonotonicNow();
    this.runStartedAt = now;
    this.activePhaseStartedAt = undefined;
    const previousLastSyncTime = this.state.lastSyncTime;
    this.state = mergePatch(
      { ...createIdleV4Progress(), lifecycle: "active", lastSyncTime: previousLastSyncTime },
      { ...patch, lifecycle: "active" },
    );
    if (this.state.phase) this.openPhase(this.state.phase, now);
    this.refreshTimingSnapshot(now);
    this.publish();
    this.scheduleTimingRefresh();
  }

  update(patch: V4SyncProgressPatch): void {
    if (this.disposed) return;
    const now = this.observeMonotonicNow();
    const working = this.state;
    const next = mergePatch(working, patch);
    if (snapshotsEqual(working, next)) return;

    const phaseChanged = working.phase !== next.phase;
    const immediateTransition = phaseOrLifecycleTransitioned(working, next);
    const metadataChanged = !immediateMetadataEqual(working, next);
    if (immediateTransition && this.throttlePending) this.flushPendingSensitive(now);

    const previousLifecycle = working.lifecycle;
    const runEnded = previousLifecycle === "active" && next.lifecycle !== "active";

    if (previousLifecycle !== "active" && next.lifecycle === "active" && this.runStartedAt === undefined) {
      this.runStartedAt = now;
      this.timingOrder.length = 0;
      this.timingByPhase.clear();
    }
    if (phaseChanged && previousLifecycle === "active") this.closeActivePhase(now);
    this.state = next;
    if (phaseChanged && this.state.lifecycle === "active" && this.state.phase) this.openPhase(this.state.phase, now);
    if (previousLifecycle !== "active" && this.state.lifecycle === "active" && this.state.phase && this.activePhaseStartedAt === undefined) {
      this.openPhase(this.state.phase, now);
    }
    if (runEnded) {
      this.closeActivePhase(now);
      this.cancelTimingRefresh();
    }
    this.refreshTimingSnapshot(now);
    if (runEnded) this.runStartedAt = undefined;

    if (this.state.lifecycle === "active") this.scheduleTimingRefresh();
    if (immediateTransition) {
      this.cancelThrottle();
      this.publish();
      return;
    }

    const sensitivePending = !sensitiveProgressEqual(this.state, this.publishedSnapshot);
    if (sensitivePending) {
      this.throttlePending = true;
      this.scheduleThrottle();
    } else {
      this.cancelThrottle();
    }
    if (metadataChanged) this.publishEligibleState();
  }

  finish(lifecycle: Extract<V4SyncLifecycle, "success" | "no-change" | "failed">, patch: V4SyncProgressPatch = {}): void {
    if (this.disposed) return;
    const now = this.observeMonotonicNow();
    if (this.throttlePending) this.flushPendingSensitive(now);
    this.closeActivePhase(now);
    this.cancelTimingRefresh();
    const failurePatch = lifecycle === "failed"
      ? {
          failurePhase: patch.failurePhase ?? this.state.phase,
          failurePath: patch.failurePath ?? this.state.currentPath,
        }
      : {};
    this.state = mergePatch(this.state, { ...failurePatch, ...patch, lifecycle });
    this.refreshTimingSnapshot(now);
    this.runStartedAt = undefined;
    this.publish();
  }

  flush(): void {
    if (this.disposed || !this.throttlePending) return;
    this.refreshTimingSnapshot(this.observeMonotonicNow());
    this.publishEligibleState();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelThrottle();
    this.cancelTimingRefresh();
    this.subscribers.clear();
  }

  private observeMonotonicNow(): number {
    const observed = this.monotonicNow();
    if (this.lastAcceptedNow === undefined || observed > this.lastAcceptedNow) this.lastAcceptedNow = observed;
    return this.lastAcceptedNow;
  }

  private openPhase(phase: V4SyncPhase, now: number): void {
    let timing = this.timingByPhase.get(phase);
    if (!timing) {
      timing = { elapsedMs: 0, occurrences: 0 };
      this.timingByPhase.set(phase, timing);
      this.timingOrder.push(phase);
    }
    timing.occurrences += 1;
    this.activePhaseStartedAt = now;
  }

  private closeActivePhase(now: number): void {
    if (this.activePhaseStartedAt === undefined || !this.state.phase) return;
    const timing = this.timingByPhase.get(this.state.phase);
    if (timing) timing.elapsedMs += Math.max(0, now - this.activePhaseStartedAt);
    this.activePhaseStartedAt = undefined;
  }

  private refreshTimingSnapshot(now: number): void {
    const activeElapsed = this.activePhaseStartedAt === undefined ? 0 : Math.max(0, now - this.activePhaseStartedAt);
    this.state = {
      ...this.state,
      timings: this.timingOrder.map(phase => {
        const timing = this.timingByPhase.get(phase)!;
        return {
          phase,
          elapsedMs: timing.elapsedMs + (phase === this.state.phase ? activeElapsed : 0),
          occurrences: timing.occurrences,
        };
      }),
      totalElapsedMs: this.runStartedAt === undefined ? this.state.totalElapsedMs : Math.max(0, now - this.runStartedAt),
    };
  }

  private scheduleThrottle(): void {
    if (this.throttleHandle !== undefined) return;
    this.throttleHandle = this.schedule(() => {
      this.throttleHandle = undefined;
      if (this.disposed || !this.throttlePending) return;
      this.flushPendingSensitive(this.observeMonotonicNow());
    }, this.throttleMs);
  }

  private flushPendingSensitive(now: number): void {
    if (!this.throttlePending) return;
    this.cancelThrottle();
    this.refreshTimingSnapshot(now);
    this.publish();
  }

  private scheduleTimingRefresh(): void {
    if (this.timingRefreshHandle !== undefined || this.state.lifecycle !== "active" || this.runStartedAt === undefined) return;
    this.timingRefreshHandle = this.schedule(() => {
      this.timingRefreshHandle = undefined;
      if (this.disposed || this.state.lifecycle !== "active") return;
      this.refreshTimingSnapshot(this.observeMonotonicNow());
      this.publishEligibleState();
      this.scheduleTimingRefresh();
    }, this.timingRefreshMs);
  }

  private publishEligibleState(): void {
    if (!this.throttlePending) {
      this.publish();
      return;
    }
    this.publish(withEligibleSensitiveProgress(this.state, this.publishedSnapshot));
  }

  private cancelThrottle(): void {
    if (this.throttleHandle !== undefined) this.cancel(this.throttleHandle);
    this.throttleHandle = undefined;
    this.throttlePending = false;
  }

  private cancelTimingRefresh(): void {
    if (this.timingRefreshHandle !== undefined) this.cancel(this.timingRefreshHandle);
    this.timingRefreshHandle = undefined;
  }

  private publish(source: V4SyncProgressSnapshot = this.state): void {
    const snapshot = freezeSnapshot(source);
    if (snapshotsEqual(this.publishedSnapshot, snapshot)) return;
    this.publishedSnapshot = snapshot;
    for (const subscriber of this.subscribers) this.notifyOne(subscriber, snapshot);
  }

  private notifyOne(subscriber: V4ProgressSubscriber, snapshot: V4SyncProgressSnapshot): void {
    try {
      subscriber(snapshot);
    } catch {
      // A UI subscriber must not prevent the store or other subscribers from advancing.
    }
  }
}
