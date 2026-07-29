export interface V4ResourceLimits {
  maxVaultReads: number
  maxCryptoJobs: number
  maxResidentBytes: number
  maxCacheBytes: number
  maxPackPlaintextBytes: number
  maxTransportTransientBytes: number
}

export type V4ResourceName = "vault-reads" | "crypto-jobs" | "resident-bytes" | "transport-bytes"

export class V4ResourceReservationTooLargeError extends Error {
  readonly resource: V4ResourceName
  readonly requested: number
  readonly maximum: number

  constructor(resource: V4ResourceName, requested: number, maximum: number) {
    super(`V4 ${resource} reservation ${requested} exceeds maximum ${maximum}.`)
    this.name = "V4ResourceReservationTooLargeError"
    this.resource = resource
    this.requested = requested
    this.maximum = maximum
  }
}

interface Waiter {
  weight: number
  resolve: () => void
}

class FifoWeightedPool {
  private inUse = 0
  private readonly queue: Waiter[] = []
  private readonly resource: V4ResourceName
  readonly maximum: number

  constructor(resource: V4ResourceName, maximum: number) {
    if (!Number.isSafeInteger(maximum) || maximum < 1) throw new TypeError(`${resource} maximum must be a positive safe integer`)
    this.resource = resource
    this.maximum = maximum
  }

  async run<T>(weight: number, task: () => Promise<T>): Promise<T> {
    const release = await this.reserve(weight)
    try {
      return await task()
    } finally {
      release()
    }
  }

  async reserve(weight: number): Promise<() => void> {
    if (!Number.isSafeInteger(weight) || weight < 0) throw new TypeError(`${this.resource} reservation must be a non-negative safe integer`)
    if (weight > this.maximum) throw new V4ResourceReservationTooLargeError(this.resource, weight, this.maximum)
    if (weight === 0) return () => {}
    await this.acquire(weight)
    let released = false
    return () => {
      if (released) return
      released = true
      this.inUse -= weight
      this.drain()
    }
  }

  private acquire(weight: number): Promise<void> {
    if (this.queue.length === 0 && this.inUse + weight <= this.maximum) {
      this.inUse += weight
      return Promise.resolve()
    }
    return new Promise<void>(resolve => {
      this.queue.push({ weight, resolve })
      this.drain()
    })
  }

  private drain(): void {
    while (this.queue.length > 0) {
      const next = this.queue[0]
      if (this.inUse + next.weight > this.maximum) return
      this.queue.shift()
      this.inUse += next.weight
      next.resolve()
    }
  }
}

export interface V4ResourceController {
  readonly limits: V4ResourceLimits
  withVaultRead<T>(task: () => Promise<T>): Promise<T>
  withCrypto<T>(task: () => Promise<T>): Promise<T>
  withResidentBytes<T>(bytes: number, task: () => Promise<T>): Promise<T>
  reserveResidentBytes(bytes: number): Promise<() => void>
  withTransportBytes<T>(bytes: number, task: () => Promise<T>): Promise<T>
}

export const DEFAULT_V4_RESOURCE_LIMITS: V4ResourceLimits = {
  maxVaultReads: 4,
  maxCryptoJobs: 2,
  maxResidentBytes: 256 * 1024 * 1024,
  maxCacheBytes: 64 * 1024 * 1024,
  maxPackPlaintextBytes: 32 * 1024 * 1024,
  maxTransportTransientBytes: 256 * 1024 * 1024,
}

export function createV4ResourceController(limits: V4ResourceLimits): V4ResourceController {
  const vaultReads = new FifoWeightedPool("vault-reads", limits.maxVaultReads)
  const cryptoJobs = new FifoWeightedPool("crypto-jobs", limits.maxCryptoJobs)
  const residentBytes = new FifoWeightedPool("resident-bytes", limits.maxResidentBytes)
  const transportBytes = new FifoWeightedPool("transport-bytes", limits.maxTransportTransientBytes)
  return {
    limits,
    withVaultRead: task => vaultReads.run(1, task),
    withCrypto: task => cryptoJobs.run(1, task),
    withResidentBytes: (bytes, task) => residentBytes.run(bytes, task),
    reserveResidentBytes: bytes => residentBytes.reserve(bytes),
    withTransportBytes: (bytes, task) => transportBytes.run(bytes, task),
  }
}

export function resolveV4ResourceLimits(overrides: Partial<V4ResourceLimits> | undefined): V4ResourceLimits {
  return { ...DEFAULT_V4_RESOURCE_LIMITS, ...overrides }
}

export function estimateV4GitBlobTransportBytes(rawBytes: number): number {
  if (!Number.isSafeInteger(rawBytes) || rawBytes < 0) throw new TypeError("rawBytes must be a non-negative safe integer")
  const base64Bytes = 4 * Math.ceil(rawBytes / 3)
  const jsonBodyBytes = base64Bytes + 64
  return rawBytes + rawBytes + base64Bytes + jsonBodyBytes
}
