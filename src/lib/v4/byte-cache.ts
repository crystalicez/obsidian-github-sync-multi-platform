export class V4ByteCache {
  private readonly entries = new Map<string, Uint8Array>()
  private currentBytes = 0
  readonly maxBytes: number

  constructor(maxBytes: number) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new TypeError("maxBytes must be a non-negative safe integer")
    this.maxBytes = maxBytes
  }

  get byteLength(): number { return this.currentBytes }
  get size(): number { return this.entries.size }

  has(key: string): boolean { return this.entries.has(key) }

  get(key: string): Uint8Array | undefined {
    const value = this.entries.get(key)
    if (!value) return undefined
    this.entries.delete(key)
    this.entries.set(key, value)
    return value
  }

  set(key: string, value: Uint8Array): boolean {
    this.delete(key)
    if (value.byteLength > this.maxBytes) return false
    while (this.currentBytes + value.byteLength > this.maxBytes) {
      const oldest = this.entries.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.delete(oldest)
    }
    this.entries.set(key, value)
    this.currentBytes += value.byteLength
    return true
  }

  take(key: string): Uint8Array | undefined {
    const value = this.entries.get(key)
    if (!value) return undefined
    this.entries.delete(key)
    this.currentBytes -= value.byteLength
    return value
  }

  delete(key: string): boolean {
    const value = this.entries.get(key)
    if (!value) return false
    this.entries.delete(key)
    this.currentBytes -= value.byteLength
    return true
  }

  clear(): void {
    this.entries.clear()
    this.currentBytes = 0
  }

  retain(keys: ReadonlySet<string>): void {
    for (const key of [...this.entries.keys()]) if (!keys.has(key)) this.delete(key)
  }
}
