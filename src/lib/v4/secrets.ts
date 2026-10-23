export interface SecretStorageLike {
  getSecret(id: string): string | null
  setSecret(id: string, value: string): void
}

export interface V4SecretBackedSettings {
  githubToken?: string
  encryptionPassphrase?: string
  githubTokenSecretId?: string
  encryptionPassphraseSecretId?: string
}

export interface SecretMigrationResult<T extends V4SecretBackedSettings> {
  settings: T & {
    githubToken: string
    encryptionPassphrase: string
    githubTokenSecretId: string
    encryptionPassphraseSecretId: string
  }
  migrated: boolean
}

/** Prevent credential and passphrase aliasing before any secret-storage mutation. */
export function assertDistinctV4SecretIds(settings: V4SecretBackedSettings): void {
  const tokenId = settings.githubTokenSecretId ?? ""
  const passphraseId = settings.encryptionPassphraseSecretId ?? ""
  if (tokenId && passphraseId && tokenId === passphraseId) {
    throw new Error("GitHub token and encryption passphrase secret IDs must be distinct.")
  }
}

function loadSecret(storage: SecretStorageLike, id: string): string {
  return id ? storage.getSecret(id) ?? "" : ""
}

export function migrateV4Secrets<T extends V4SecretBackedSettings>(
  settings: T,
  storage: SecretStorageLike,
  idFactory: (prefix: string) => string,
): SecretMigrationResult<T> {
  let migrated = false
  const githubTokenSecretId = settings.githubTokenSecretId || idFactory("github-token")
  const encryptionPassphraseSecretId =
    settings.encryptionPassphraseSecretId || idFactory("encryption-passphrase")
  assertDistinctV4SecretIds({ githubTokenSecretId, encryptionPassphraseSecretId })

  if (!settings.githubTokenSecretId || !settings.encryptionPassphraseSecretId) migrated = true

  const legacyToken = typeof settings.githubToken === "string" ? settings.githubToken : ""
  const legacyPassphrase =
    typeof settings.encryptionPassphrase === "string" ? settings.encryptionPassphrase : ""

  // Snapshot before writing anything: a failed second write cannot strand a
  // partially migrated credential. A partially executed failing write is also
  // rolled back when SecretStorage remains available.
  const previous = new Map<string, string | null>()
  if (legacyToken) previous.set(githubTokenSecretId, storage.getSecret(githubTokenSecretId))
  if (legacyPassphrase && !previous.has(encryptionPassphraseSecretId)) {
    previous.set(encryptionPassphraseSecretId, storage.getSecret(encryptionPassphraseSecretId))
  }
  try {
    if (legacyToken) {
      storage.setSecret(githubTokenSecretId, legacyToken)
      migrated = true
    }
    if (legacyPassphrase) {
      storage.setSecret(encryptionPassphraseSecretId, legacyPassphrase)
      migrated = true
    }
  } catch (error) {
    for (const [id, value] of previous) {
      try { storage.setSecret(id, value ?? "") } catch { /* Preserve first error; rollback best-effort. */ }
    }
    throw error
  }

  return {
    settings: {
      ...settings,
      githubTokenSecretId,
      encryptionPassphraseSecretId,
      githubToken: legacyToken || loadSecret(storage, githubTokenSecretId),
      encryptionPassphrase:
        legacyPassphrase || loadSecret(storage, encryptionPassphraseSecretId),
    },
    migrated,
  }
}

export function storeV4Secrets(
  settings: V4SecretBackedSettings,
  storage: SecretStorageLike,
): void {
  assertDistinctV4SecretIds(settings)
  if (settings.githubTokenSecretId) {
    storage.setSecret(settings.githubTokenSecretId, settings.githubToken ?? "")
  }
  if (settings.encryptionPassphraseSecretId) {
    storage.setSecret(
      settings.encryptionPassphraseSecretId,
      settings.encryptionPassphrase ?? "",
    )
  }
}

export function sanitizeV4SettingsForPersistence<T extends V4SecretBackedSettings>(
  settings: T,
): Omit<T, "githubToken" | "encryptionPassphrase"> {
  const { githubToken: _githubToken, encryptionPassphrase: _passphrase, ...safe } = settings
  return safe
}
