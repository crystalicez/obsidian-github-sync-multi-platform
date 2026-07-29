import type { V4Keyring } from "./crypto"

export interface V4KeyringCacheKey {
  repoId: string
  salt: string
  iterations: number
  mode: string
  credentialGeneration: number
}

interface V4KeyringCacheEntry {
  fingerprint: string
  promise: Promise<V4Keyring>
  resolved?: V4Keyring
}

function fingerprint(key: V4KeyringCacheKey): string {
  return JSON.stringify([key.repoId, key.salt, key.iterations, key.mode, key.credentialGeneration])
}

// Best effort only: JavaScript engines may retain copies internally, so this is not guaranteed zeroization.
function clearKeyring(keyring: V4Keyring): void {
  for (const bytes of Object.values(keyring)) bytes.fill(0)
}

export class V4KeyringCache {
  private entry?: V4KeyringCacheEntry
  private readonly retired = new Set<V4Keyring>()
  private disposed = false

  get(key: V4KeyringCacheKey, derive: () => Promise<V4Keyring>): Promise<V4Keyring> {
    if (this.disposed) return Promise.reject(new Error("V4 keyring cache is disposed."))
    const nextFingerprint = fingerprint(key)
    if (this.entry?.fingerprint === nextFingerprint) return this.entry.promise
    if (this.entry?.resolved) this.retired.add(this.entry.resolved)
    const entry: V4KeyringCacheEntry = {
      fingerprint: nextFingerprint,
      promise: derive(),
    }
    this.entry = entry
    entry.promise.then(
      keyring => {
        entry.resolved = keyring
        if (this.disposed || this.entry !== entry) {
          this.retired.add(keyring)
          if (this.disposed) this.clearOwnedSecrets()
        }
      },
      () => { if (this.entry === entry) this.entry = undefined },
    )
    return entry.promise
  }

  invalidate(): void {
    if (this.entry?.resolved) this.retired.add(this.entry.resolved)
    this.entry = undefined
  }

  clearOwnedSecrets(): void {
    if (this.entry?.resolved) this.retired.add(this.entry.resolved)
    this.entry = undefined
    for (const keyring of this.retired) clearKeyring(keyring)
    this.retired.clear()
  }

  dispose(): void {
    this.disposed = true
    this.clearOwnedSecrets()
  }
}
