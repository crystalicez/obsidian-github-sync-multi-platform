import { compileV4IgnorePathRegex } from "./v4/ignore"

type RuntimeSettings = Record<string, unknown>

function asRecord(value: unknown): RuntimeSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid plugin settings: expected an object.")
  }
  return value as RuntimeSettings
}

function requireString(settings: RuntimeSettings, key: string): string {
  const value = settings[key]
  if (typeof value !== "string") throw new Error(`Invalid plugin settings: ${key} must be a string.`)
  return value
}

function optionalString(settings: RuntimeSettings, key: string): void {
  if (settings[key] !== undefined && typeof settings[key] !== "string") {
    throw new Error(`Invalid plugin settings: ${key} must be a string.`)
  }
}

function optionalBoolean(settings: RuntimeSettings, key: string): void {
  if (settings[key] !== undefined && typeof settings[key] !== "boolean") {
    throw new Error(`Invalid plugin settings: ${key} must be a boolean.`)
  }
}

export function assertPluginSettingsRuntimeSafe(value: unknown): void {
  const settings = asRecord(value)

  requireString(settings, "githubOwner")
  requireString(settings, "githubRepo")
  requireString(settings, "githubBranch")
  requireString(settings, "vault")
  const ignorePathRegex = requireString(settings, "ignorePathRegex")
  compileV4IgnorePathRegex(ignorePathRegex)

  for (const key of [
    "githubToken",
    "githubTokenSecretId",
    "encryptionPassphrase",
    "encryptionPassphraseSecretId",
    "clipboardReadTip",
  ]) optionalString(settings, key)

  if (settings.encryptionMode !== "plaintext" && settings.encryptionMode !== "encrypted") {
    throw new Error("Invalid plugin settings: encryptionMode is unsupported.")
  }
  if (
    settings.conflictPolicy !== "copy"
    && settings.conflictPolicy !== "newer"
    && settings.conflictPolicy !== "merge"
    && settings.conflictPolicy !== "ask"
  ) {
    throw new Error("Invalid plugin settings: conflictPolicy is unsupported.")
  }

  const abortChangePercent = settings.abortChangePercent
  if (
    typeof abortChangePercent !== "number"
    || !Number.isFinite(abortChangePercent)
    || abortChangePercent < 0
    || abortChangePercent > 100
  ) {
    throw new Error("Invalid plugin settings: abortChangePercent must be between 0 and 100.")
  }

  if (settings.scheduledSyncIntervalSeconds !== undefined) {
    const interval = settings.scheduledSyncIntervalSeconds
    if (typeof interval !== "number" || !Number.isFinite(interval) || interval <= 0) {
      throw new Error("Invalid plugin settings: scheduledSyncIntervalSeconds must be a positive number.")
    }
  }

  if (settings.lastSyncTime !== undefined) {
    const lastSyncTime = settings.lastSyncTime
    if (typeof lastSyncTime !== "number" || !Number.isFinite(lastSyncTime) || lastSyncTime < 0) {
      throw new Error("Invalid plugin settings: lastSyncTime must be a non-negative number.")
    }
  }

  for (const key of [
    "syncEnabled",
    "syncOnStartup",
    "syncOnLocalChange",
    "scheduledSyncEnabled",
    "syncObsidianConfig",
    "syncBookmarks",
    "syncPlugins",
    "statusBarStatusEnabled",
    "consoleLoggingEnabled",
  ]) optionalBoolean(settings, key)
}
