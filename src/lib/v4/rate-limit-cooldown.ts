import { sha256Hex, utf8ToBytes } from "../bytes"

/**
 * A tiny crash-tolerant, token-scoped cache for GitHub retry deadlines.
 *
 * Only the SHA-256 token fingerprint and deadline are stored. Never persist
 * access tokens, endpoint URLs, response bodies or logical vault paths.
 * Alternating, checksummed slots preserve the previous valid generation
 * if a process is killed while writing the newest one.
 */
export interface V4CooldownFileAdapter {
  exists(path: string): Promise<boolean>
  read(path: string): Promise<string>
  write(path: string, value: string): Promise<void>
}

interface CooldownPayload {
  version: 1
  generation: number
  byToken: Record<string, number>
}

interface CooldownSlot extends CooldownPayload {
  checksum: string
}

const TOKEN_FINGERPRINT = /^[0-9a-f]{64}$/
const SLOT_FILES = ["v4-rate-limit-0.json", "v4-rate-limit-1.json"] as const

function validPayload(value: unknown): value is CooldownPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const input = value as Partial<CooldownPayload>
  if (input.version !== 1 || !Number.isSafeInteger(input.generation) || (input.generation ?? -1) < 0) return false
  if (!input.byToken || typeof input.byToken !== "object" || Array.isArray(input.byToken)) return false
  return Object.entries(input.byToken).every(([key, deadline]) => TOKEN_FINGERPRINT.test(key)
    && Number.isSafeInteger(deadline) && deadline > 0)
}

async function encode(payload: CooldownPayload): Promise<string> {
  return JSON.stringify({
    ...payload,
    checksum: await sha256Hex(utf8ToBytes(JSON.stringify(payload))),
  } satisfies CooldownSlot)
}

async function decode(text: string): Promise<CooldownSlot | null> {
  let value: unknown
  try { value = JSON.parse(text) } catch { return null }
  if (!validPayload(value)) return null
  const candidate = value as CooldownSlot
  if (typeof candidate.checksum !== "string" || !TOKEN_FINGERPRINT.test(candidate.checksum)) return null
  const payload = { version: 1 as const, generation: candidate.generation, byToken: candidate.byToken }
  return await sha256Hex(utf8ToBytes(JSON.stringify(payload))) === candidate.checksum ? candidate : null
}

export class V4RateLimitCooldownStore {
  private readonly byToken = new Map<string, number>()
  private generation = 0
  private initialized?: Promise<void>
  private pendingWrite: Promise<void> = Promise.resolve()

  constructor(private readonly adapter: V4CooldownFileAdapter, private readonly root: string) {}

  private path(slot: 0 | 1): string { return `${this.root}/${SLOT_FILES[slot]}` }

  private async initialize(): Promise<void> {
    if (this.initialized) return this.initialized
    this.initialized = (async () => {
      let anyPresent = false
      const valid: CooldownSlot[] = []
      for (const slot of [0, 1] as const) {
        if (!await this.adapter.exists(this.path(slot))) continue
        anyPresent = true
        const decoded = await decode(await this.adapter.read(this.path(slot)))
        if (decoded) valid.push(decoded)
      }
      if (anyPresent && valid.length === 0) {
        throw new Error("GitHub rate-limit state is corrupt; refusing requests until it is repaired.")
      }
      valid.sort((a, b) => b.generation - a.generation)
      const current = valid[0]
      if (!current) return
      this.generation = current.generation
      for (const [token, deadline] of Object.entries(current.byToken)) this.byToken.set(token, deadline)
    })()
    return this.initialized
  }

  async load(tokenFingerprint: string): Promise<number> {
    if (!TOKEN_FINGERPRINT.test(tokenFingerprint)) throw new Error("Invalid GitHub cooldown token fingerprint.")
    await this.initialize()
    // Do not dispatch again if the latest server deadline could not be
    // written durably. The caller must repair plugin-data storage first.
    await this.pendingWrite
    return this.byToken.get(tokenFingerprint) ?? 0
  }

  async save(tokenFingerprint: string, deadlineEpochMs: number): Promise<void> {
    if (!TOKEN_FINGERPRINT.test(tokenFingerprint)) throw new Error("Invalid GitHub cooldown token fingerprint.")
    if (!Number.isSafeInteger(deadlineEpochMs) || deadlineEpochMs <= 0) {
      throw new Error("Invalid GitHub cooldown deadline.")
    }
    await this.initialize()
    if ((this.byToken.get(tokenFingerprint) ?? 0) >= deadlineEpochMs) {
      await this.pendingWrite
      return
    }
    this.byToken.set(tokenFingerprint, deadlineEpochMs)
    // Serialize writes across all clients (including a settings swap while
    // a pinned old run is active); never allow an earlier file to win.
    const nextWrite = this.pendingWrite.catch(() => undefined).then(async () => {
      const next = ++this.generation
      const payload: CooldownPayload = {
        version: 1,
        generation: next,
        byToken: Object.fromEntries([...this.byToken].sort(([a], [b]) => a.localeCompare(b))),
      }
      await this.adapter.write(this.path((next % 2) as 0 | 1), await encode(payload))
    })
    this.pendingWrite = nextWrite
    await nextWrite
  }
}
