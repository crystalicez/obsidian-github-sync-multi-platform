export type V4TransportStatusClass = "2xx" | "3xx" | "4xx" | "5xx" | "network"

export interface V4TransportMetricsSnapshot {
  requests: number
  mutations: number
  requestBytes: number
  responseBytes: number
  apiLatencyMs: number
  inFlightApiRequests: number
  oldestInFlightApiMs: number
  retries: number
  cooldownMs: number
  pacingMs: number
  unknownOutcomes: number
  transientBytesPeak: number
  statusClasses: Record<V4TransportStatusClass, number>
}

export class V4TransportMetrics {
  private readonly state: V4TransportMetricsSnapshot = {
    requests: 0,
    mutations: 0,
    requestBytes: 0,
    responseBytes: 0,
    apiLatencyMs: 0,
    inFlightApiRequests: 0,
    oldestInFlightApiMs: 0,
    retries: 0,
    cooldownMs: 0,
    pacingMs: 0,
    unknownOutcomes: 0,
    transientBytesPeak: 0,
    statusClasses: { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0, network: 0 },
  }

  private readonly inFlight = new Map<number, number>()
  private nextRequestId = 0
  private readonly now: () => number

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? (() => globalThis.performance?.now() ?? Date.now())
  }

  recordRequest(input: { mutation: boolean; requestBytes?: number; transientBytes?: number }): number {
    const id = ++this.nextRequestId
    this.inFlight.set(id, this.now())
    this.state.requests++
    if (input.mutation) this.state.mutations++
    this.state.requestBytes += Math.max(0, input.requestBytes ?? 0)
    this.state.transientBytesPeak = Math.max(this.state.transientBytesPeak, Math.max(0, input.transientBytes ?? 0))
    return id
  }

  finishRequest(id: number): void {
    const beganAt = this.inFlight.get(id)
    if (beganAt === undefined) return
    this.inFlight.delete(id)
    this.state.apiLatencyMs += Math.max(0, this.now() - beganAt)
  }

  recordResponse(status: number, responseBytes = 0): void {
    const statusClass = status >= 200 && status < 300 ? "2xx"
      : status >= 300 && status < 400 ? "3xx"
        : status >= 400 && status < 500 ? "4xx"
          : "5xx"
    this.state.statusClasses[statusClass]++
    this.state.responseBytes += Math.max(0, responseBytes)
  }

  recordNetworkFailure(): void { this.state.statusClasses.network++ }
  recordRetry(): void { this.state.retries++ }
  recordCooldown(milliseconds: number): void { this.state.cooldownMs += Math.max(0, milliseconds) }
  recordPacing(milliseconds: number): void { this.state.pacingMs += Math.max(0, milliseconds) }
  recordUnknownOutcome(): void { this.state.unknownOutcomes++ }

  get snapshot(): V4TransportMetricsSnapshot {
    const now = this.now()
    const startedAt = this.inFlight.size ? Math.min(...this.inFlight.values()) : undefined
    return {
      ...this.state,
      inFlightApiRequests: this.inFlight.size,
      oldestInFlightApiMs: startedAt === undefined ? 0 : Math.max(0, now - startedAt),
      statusClasses: { ...this.state.statusClasses },
    }
  }
}
