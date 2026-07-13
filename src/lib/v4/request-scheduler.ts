export type V4RequestKind = "read" | "write";

export interface V4RequestSchedulerOptions {
  readConcurrency?: number;
  writeConcurrency?: number;
  maxAttempts?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

interface QueueItem<T> {
  task: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function retryDelay(error: unknown, attempt: number): number | null {
  const value = error as { status?: number; headers?: Record<string, string> };
  if (value.status !== 403 && value.status !== 429) return null;
  const headers = Object.fromEntries(Object.entries(value.headers ?? {}).map(([key, header]) => [key.toLowerCase(), header]));
  const retryAfter = Number(headers["retry-after"]);
  if (Number.isFinite(retryAfter) && retryAfter >= 0) return retryAfter * 1_000;
  const reset = Number(headers["x-ratelimit-reset"]);
  if (Number.isFinite(reset) && reset > 0) return Math.max(0, reset * 1_000 - Date.now());
  return Math.min(60_000, 1_000 * 2 ** Math.max(0, attempt - 1));
}

export class V4RequestScheduler {
  private readonly limits: Record<V4RequestKind, number>;
  private readonly active: Record<V4RequestKind, number> = { read: 0, write: 0 };
  private readonly queues: Record<V4RequestKind, Array<QueueItem<unknown>>> = { read: [], write: [] };
  private readonly maxAttempts: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(options: V4RequestSchedulerOptions = {}) {
    this.limits = {
      read: Math.max(1, Math.floor(options.readConcurrency ?? 4)),
      write: Math.max(1, Math.floor(options.writeConcurrency ?? 2)),
    };
    this.maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 3));
    this.sleep = options.sleep ?? (milliseconds => new Promise(resolve => globalThis.setTimeout(resolve, milliseconds)));
  }

  run<T>(kind: V4RequestKind, task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queues[kind].push({ task, resolve, reject } as QueueItem<unknown>);
      this.drain(kind);
    });
  }

  private drain(kind: V4RequestKind): void {
    while (this.active[kind] < this.limits[kind] && this.queues[kind].length > 0) {
      const item = this.queues[kind].shift()!;
      this.active[kind] += 1;
      void this.execute(item)
        .then(item.resolve, item.reject)
        .finally(() => {
          this.active[kind] -= 1;
          this.drain(kind);
        });
    }
  }

  private async execute<T>(item: QueueItem<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        return await item.task();
      } catch (error) {
        lastError = error;
        const delay = retryDelay(error, attempt);
        if (delay === null || attempt === this.maxAttempts) throw error;
        await this.sleep(delay);
      }
    }
    throw lastError;
  }
}
