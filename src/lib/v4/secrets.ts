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

  if (!settings.githubTokenSecretId || !settings.encryptionPassphraseSecretId) migrated = true

  const legacyToken = typeof settings.githubToken === "string" ? settings.githubToken : ""
  const legacyPassphrase =
    typeof settings.encryptionPassphrase === "string" ? settings.encryptionPassphrase : ""

  if (legacyToken) {
    storage.setSecret(githubTokenSecretId, legacyToken)
    migrated = true
  }
  if (legacyPassphrase) {
    storage.setSecret(encryptionPassphraseSecretId, legacyPassphrase)
    migrated = true
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
