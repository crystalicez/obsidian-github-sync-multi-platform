import { V4CancelledError, throwIfV4Aborted, v4CancellationError } from "./cancellation";
import type {
  V4ConflictBatchRequest,
  V4ConflictBatchResolution,
  V4ConflictFileResolution,
  V4ConflictFileSummary,
  V4ConflictMaterializedFile,
  V4ConflictSideSnapshot,
} from "./conflict-types";

export class V4ConflictStaleGenerationError extends Error {
  constructor(message = "V4 conflict generation changed while work was in flight.") {
    super(message);
    this.name = "V4ConflictStaleGenerationError";
  }
}

export interface V4ConflictCoordinatorFileSnapshot {
  readonly summary: V4ConflictFileSummary;
  readonly resolution?: V4ConflictFileResolution;
  readonly reviewed: boolean;
}

export interface V4ConflictCoordinatorSnapshot {
  readonly active: boolean;
  readonly runId?: string;
  readonly generation?: number;
  readonly contextKey?: string;
  readonly expectedRemoteHead?: string | null;
  readonly pending: boolean;
  readonly canContinue: boolean;
  readonly files: readonly V4ConflictCoordinatorFileSnapshot[];
}

type Subscriber = (snapshot: V4ConflictCoordinatorSnapshot) => void;

interface FileState {
  summary: V4ConflictFileSummary;
  resolution?: V4ConflictFileResolution;
  reviewed: boolean;
}

interface DecisionCacheEntry {
  resolution?: V4ConflictFileResolution;
  reviewed: boolean;
}

interface PendingResolution {
  promise: Promise<V4ConflictBatchResolution>;
  resolve: (resolution: V4ConflictBatchResolution) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  settled: boolean;
}

interface ActiveBatch {
  request: V4ConflictBatchRequest;
  files: FileState[];
  pending?: PendingResolution;
}

function cloneSide(side: V4ConflictSideSnapshot): V4ConflictSideSnapshot {
  return side.exists ? { ...side } : { exists: false };
}

function cloneSummary(summary: V4ConflictFileSummary): V4ConflictFileSummary {
  return {
    ...summary,
    base: cloneSide(summary.base),
    local: cloneSide(summary.local),
    remote: cloneSide(summary.remote),
  };
}

function cloneResolution(resolution: V4ConflictFileResolution | undefined): V4ConflictFileResolution | undefined {
  if (!resolution) return undefined;
  return resolution.kind === "merged"
    ? { ...resolution, bytes: new Uint8Array(resolution.bytes) }
    : { ...resolution };
}

function cloneMaterialized(value: V4ConflictMaterializedFile, summary: V4ConflictFileSummary): V4ConflictMaterializedFile {
  return {
    ...value,
    summary: cloneSummary(summary),
    baseBytes: value.baseBytes ? new Uint8Array(value.baseBytes) : undefined,
    localBytes: value.localBytes ? new Uint8Array(value.localBytes) : undefined,
    remoteBytes: value.remoteBytes ? new Uint8Array(value.remoteBytes) : undefined,
  };
}

function cacheKey(fileId: string, fingerprint: string): string { return `${fileId}:${fingerprint}`; }

function immutableSnapshot(batch: ActiveBatch | undefined): V4ConflictCoordinatorSnapshot {
  if (!batch) return Object.freeze({ active: false, pending: false, canContinue: false, files: Object.freeze([]) });
  const pending = !!batch.pending && !batch.pending.settled;
  const canContinue = pending && batch.files.every(file => !!file.resolution && (!file.summary.requiresReview || file.reviewed));
  const files = batch.files.map(file => Object.freeze({
    summary: Object.freeze(cloneSummary(file.summary)) as V4ConflictFileSummary,
    resolution: cloneResolution(file.resolution),
    reviewed: file.reviewed,
  }));
  return Object.freeze({
    active: true,
    runId: batch.request.runId,
    generation: batch.request.generation,
    contextKey: batch.request.contextKey,
    expectedRemoteHead: batch.request.expectedRemoteHead,
    pending,
    canContinue,
    files: Object.freeze(files),
  });
}

export class V4ConflictResolutionCoordinator {
  private current?: ActiveBatch;
  private readonly decisionCache = new Map<string, DecisionCacheEntry>();
  private readonly subscribers = new Set<Subscriber>();

  get snapshot(): V4ConflictCoordinatorSnapshot { return immutableSnapshot(this.current); }

  subscribe(subscriber: Subscriber): () => void {
    this.subscribers.add(subscriber);
    subscriber(this.snapshot);
    return () => { this.subscribers.delete(subscriber); };
  }

  async resolveBatch(request: V4ConflictBatchRequest, signal?: AbortSignal): Promise<V4ConflictBatchResolution> {
    throwIfV4Aborted(signal);
    if (!request.runId || !request.contextKey) throw new Error("V4 conflict batch requires run and context identity.");
    if (!Number.isSafeInteger(request.generation) || request.generation < 1) throw new Error("V4 conflict generation must be a positive safe integer.");
    const ids = new Set<string>();
    for (const file of request.files) {
      if (!file.fileId || !file.fingerprint) throw new Error("V4 conflict file identity and fingerprint are required.");
      if (ids.has(file.fileId)) throw new Error(`Duplicate V4 conflict file: ${file.fileId}`);
      ids.add(file.fileId);
    }

    if (this.current) {
      if (this.current.request.runId !== request.runId) throw new Error("Cannot advance a different V4 conflict run.");
      if (this.current.request.contextKey !== request.contextKey) throw new Error("Cannot advance a different V4 conflict context.");
      if (request.generation <= this.current.request.generation) {
        throw new Error(`V4 conflict generation must advance beyond ${this.current.request.generation}.`);
      }
      if (this.current.pending && !this.current.pending.settled) {
        this.settlePending(this.current.pending, "reject", new V4ConflictStaleGenerationError());
      }
    }

    const copiedRequest: V4ConflictBatchRequest = {
      ...request,
      files: request.files.map(cloneSummary),
    };
    const files: FileState[] = copiedRequest.files.map(summary => {
      const cached = this.decisionCache.get(cacheKey(summary.fileId, summary.fingerprint));
      return {
        summary,
        resolution: cloneResolution(cached?.resolution),
        reviewed: cached?.reviewed ?? false,
      };
    });

    let resolvePromise!: (resolution: V4ConflictBatchResolution) => void;
    let rejectPromise!: (error: unknown) => void;
    const promise = new Promise<V4ConflictBatchResolution>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const pending: PendingResolution = {
      promise,
      resolve: resolvePromise,
      reject: rejectPromise,
      signal,
      settled: false,
    };
    if (signal) {
      pending.onAbort = () => this.abortCurrent(signal);
      signal.addEventListener("abort", pending.onAbort, { once: true });
    }
    this.current = { request: copiedRequest, files, pending };
    this.publish();
    return promise;
  }

  setResolution(resolution: V4ConflictFileResolution): void {
    const batch = this.requireCurrent();
    const file = batch.files.find(candidate => candidate.summary.fileId === resolution.fileId);
    if (!file) throw new Error(`Unknown V4 conflict file: ${resolution.fileId}`);
    if (file.summary.fingerprint !== resolution.fingerprint) throw new Error(`V4 conflict fingerprint changed for ${resolution.fileId}.`);
    file.resolution = cloneResolution(resolution);
    this.remember(file);
    this.publish();
  }

  markReviewed(fileId: string, reviewed = true): void {
    const file = this.requireFile(fileId);
    file.reviewed = reviewed;
    this.remember(file);
    this.publish();
  }

  async materialize(fileId: string): Promise<V4ConflictMaterializedFile> {
    const batch = this.requireCurrent();
    const file = batch.files.find(candidate => candidate.summary.fileId === fileId);
    if (!file) throw new Error(`Unknown V4 conflict file: ${fileId}`);
    const { runId, contextKey, generation } = batch.request;
    throwIfV4Aborted(batch.pending?.signal);
    const value = await batch.request.materialize(fileId, generation);
    const current = this.current;
    if (!current
      || current.request.runId !== runId
      || current.request.contextKey !== contextKey
      || current.request.generation !== generation) {
      throw new V4ConflictStaleGenerationError();
    }
    const currentFile = current.files.find(candidate => candidate.summary.fileId === fileId);
    if (!currentFile
      || value.generation !== generation
      || value.summary.fileId !== fileId
      || value.summary.fingerprint !== currentFile.summary.fingerprint) {
      throw new V4ConflictStaleGenerationError();
    }
    throwIfV4Aborted(current.pending?.signal);
    return cloneMaterialized(value, currentFile.summary);
  }

  continueBatch(): void {
    const batch = this.requireCurrent();
    const pending = batch.pending;
    if (!pending || pending.settled) throw new Error("V4 conflict batch is not waiting for continuation.");
    for (const file of batch.files) {
      if (!file.resolution) throw new Error(`Resolve V4 conflict file before continuing: ${file.summary.displayPath}`);
      if (file.summary.requiresReview && !file.reviewed) throw new Error(`Review V4 conflict file before continuing: ${file.summary.displayPath}`);
      if (file.resolution.fingerprint !== file.summary.fingerprint) throw new Error(`V4 conflict fingerprint changed for ${file.summary.fileId}.`);
    }
    const resolution: V4ConflictBatchResolution = {
      runId: batch.request.runId,
      generation: batch.request.generation,
      files: batch.files.map(file => cloneResolution(file.resolution)!),
    };
    for (const file of batch.files) this.remember(file);
    this.settlePending(pending, "resolve", resolution);
    batch.pending = undefined;
    this.publish();
  }

  completeRun(runId: string): void {
    if (!this.current || this.current.request.runId !== runId) return;
    if (this.current.pending && !this.current.pending.settled) {
      this.settlePending(this.current.pending, "reject", new V4CancelledError("V4 conflict run completed while resolution was pending."));
    }
    this.clear();
  }

  cancel(reason?: unknown): void {
    if (!this.current) return;
    if (this.current.pending && !this.current.pending.settled) {
      this.settlePending(this.current.pending, "reject", reason instanceof V4CancelledError ? reason : new V4CancelledError(reason));
    }
    this.clear();
  }

  private requireCurrent(): ActiveBatch {
    if (!this.current) throw new Error("No active V4 conflict batch.");
    return this.current;
  }

  private requireFile(fileId: string): FileState {
    const file = this.requireCurrent().files.find(candidate => candidate.summary.fileId === fileId);
    if (!file) throw new Error(`Unknown V4 conflict file: ${fileId}`);
    return file;
  }

  private remember(file: FileState): void {
    this.decisionCache.set(cacheKey(file.summary.fileId, file.summary.fingerprint), {
      resolution: cloneResolution(file.resolution),
      reviewed: file.reviewed,
    });
  }

  private abortCurrent(signal: AbortSignal): void {
    if (!this.current) return;
    const pending = this.current.pending;
    if (pending && !pending.settled) this.settlePending(pending, "reject", v4CancellationError(signal));
    this.clear();
  }

  private settlePending(
    pending: PendingResolution,
    mode: "resolve" | "reject",
    value: V4ConflictBatchResolution | unknown,
  ): void {
    if (pending.settled) return;
    pending.settled = true;
    if (pending.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort);
    if (mode === "resolve") pending.resolve(value as V4ConflictBatchResolution);
    else pending.reject(value);
  }

  private clear(): void {
    const pending = this.current?.pending;
    if (pending?.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort);
    this.current = undefined;
    this.decisionCache.clear();
    this.publish();
  }

  private publish(): void {
    const snapshot = this.snapshot;
    for (const subscriber of [...this.subscribers]) subscriber(snapshot);
  }
}
