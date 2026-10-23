import type { V4TransportMetricsSnapshot } from "./transport-metrics"

export interface V4RunDiagnostics {
  /** Observed HTTP JSON/binary body bytes, not socket wire bytes or plaintext file bytes. */
  uploadBytes: number
  downloadBytes: number
  apiRequests: number
  apiFailures: number
  /** Sum of individual measured request durations; concurrent requests overlap. */
  apiLatencyMs: number
  inFlightApiRequests: number
  oldestInFlightApiMs: number
  /** Renderer process RSS sample, omitted when unsupported; not system-wide peak. */
  peakRendererRssBytes?: number
  /** Only populated by measured crypto/hash instrumentation; never infer from phase elapsed. */
  hashingMs?: number
  encryptionMs?: number
}

export function createV4RunDiagnostics(
  baseline: V4TransportMetricsSnapshot,
  current: V4TransportMetricsSnapshot,
  _elapsedMs: number,
  peakRendererRssBytes?: number,
): V4RunDiagnostics {
  const delta = (now: number, before: number) => Math.max(0, now - before)
  return {
    uploadBytes: delta(current.requestBytes, baseline.requestBytes),
    downloadBytes: delta(current.responseBytes, baseline.responseBytes),
    apiRequests: delta(current.requests, baseline.requests),
    apiFailures: delta(current.statusClasses.network, baseline.statusClasses.network)
      + delta(current.statusClasses["5xx"], baseline.statusClasses["5xx"]),
    apiLatencyMs: delta(current.apiLatencyMs, baseline.apiLatencyMs),
    inFlightApiRequests: current.inFlightApiRequests,
    oldestInFlightApiMs: current.oldestInFlightApiMs,
    ...(peakRendererRssBytes === undefined ? {} : { peakRendererRssBytes }),
  }
}
