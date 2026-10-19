export type V4WorkKind = "hashing" | "encryption" | "decryption"
export type V4PublicationStage = "preparing-metadata" | "uploading-metadata" | "creating-commit" | "publishing"

export interface V4RunDiagnosticsSnapshot {
  uploadBytes: number
  downloadBytes: number
  uploadRequestMs: number
  downloadRequestMs: number
  apiRequests: number
  apiFailures: number
  apiLatencyMs: number
  apiMaxLatencyMs: number
  inFlightApiRequests: number
  oldestInFlightApiMs: number
  hashingMs: number
  encryptionMs: number
  decryptionMs: number
  peakRendererRssBytes?: number
  publicationStage?: V4PublicationStage
  publicationStageMs?: number
  metadataUploaded?: number
  metadataTotal?: number
}

export class V4RunDiagnostics {
  private readonly inFlight = new Map<number, number>()
  private nextRequestId = 0
  private publicationStageStartedAt?: number
  private readonly data: V4RunDiagnosticsSnapshot = {
    uploadBytes: 0,
    downloadBytes: 0,
    uploadRequestMs: 0,
    downloadRequestMs: 0,
    apiRequests: 0,
    apiFailures: 0,
    apiLatencyMs: 0,
    apiMaxLatencyMs: 0,
    inFlightApiRequests: 0,
    oldestInFlightApiMs: 0,
    hashingMs: 0,
    encryptionMs: 0,
    decryptionMs: 0,
  }

  constructor(
    private readonly now: () => number = () => performance.now(),
    private readonly rendererRss: () => number | undefined = () => {
      if (typeof process === "undefined" || typeof process.memoryUsage !== "function") return undefined
      return process.memoryUsage().rss
    },
  ) {
    this.sampleMemory()
  }

  setPublicationStage(stage: V4PublicationStage, metadataTotal?: number): void {
    this.data.publicationStage = stage
    this.publicationStageStartedAt = this.now()
    if (metadataTotal !== undefined) {
      this.data.metadataTotal = metadataTotal
      this.data.metadataUploaded = 0
    }
  }

  recordMetadataUploaded(): void {
    if (this.data.publicationStage === "uploading-metadata") this.data.metadataUploaded = (this.data.metadataUploaded ?? 0) + 1
  }

  sampleMemory(): void {
    try {
      const bytes = this.rendererRss()
      if (bytes !== undefined && Number.isSafeInteger(bytes) && bytes > 0) {
        this.data.peakRendererRssBytes = Math.max(this.data.peakRendererRssBytes ?? 0, bytes)
      }
    } catch {
      // Memory probes are optional and must not interrupt a sync.
    }
  }

  beginRequest(): () => void {
    const id = ++this.nextRequestId
    this.inFlight.set(id, this.now())
    return () => { this.inFlight.delete(id) }
  }

  recordRequest(input: { method: string; requestBytes: number; responseBytes: number; elapsedMs: number; failed: boolean }): void {
    const elapsedMs = Math.max(0, input.elapsedMs)
    this.data.apiRequests++
    this.data.apiLatencyMs += elapsedMs
    this.data.apiMaxLatencyMs = Math.max(this.data.apiMaxLatencyMs, elapsedMs)
    if (input.failed) this.data.apiFailures++
    if (input.method === "GET" || input.method === "HEAD") {
      this.data.downloadBytes += Math.max(0, input.responseBytes)
      this.data.downloadRequestMs += elapsedMs
    } else {
      this.data.uploadBytes += Math.max(0, input.requestBytes)
      this.data.uploadRequestMs += elapsedMs
      this.data.downloadBytes += Math.max(0, input.responseBytes)
      this.data.downloadRequestMs += elapsedMs
    }
    this.sampleMemory()
  }

  recordWork(kind: V4WorkKind, milliseconds: number): void {
    this.data[`${kind}Ms`] += Math.max(0, milliseconds)
  }

  measure<T>(kind: V4WorkKind, task: () => T): T {
    const started = this.now()
    try { return task() }
    finally { this.data[`${kind}Ms`] += Math.max(0, this.now() - started) }
  }

  async measureAsync<T>(kind: V4WorkKind, task: () => Promise<T>): Promise<T> {
    const started = this.now()
    try { return await task() }
    finally { this.data[`${kind}Ms`] += Math.max(0, this.now() - started) }
  }

  get snapshot(): V4RunDiagnosticsSnapshot {
    let oldestInFlightApiMs = 0
    if (this.inFlight.size > 0) {
      oldestInFlightApiMs = Math.max(0, this.now() - Math.min(...this.inFlight.values()))
    }
    return {
      ...this.data,
      inFlightApiRequests: this.inFlight.size,
      oldestInFlightApiMs,
      ...(this.publicationStageStartedAt !== undefined
        ? { publicationStageMs: Math.max(0, this.now() - this.publicationStageStartedAt) }
        : {}),
    }
  }
}

export function formatV4Rate(bytes: number, requestMs: number): string {
  if (requestMs <= 0 || bytes <= 0) return "—"
  return `${(bytes / (requestMs / 1_000) / 1_048_576).toFixed(2)} MiB/s`
}

export function formatV4Size(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(2)} MiB`
}
