import { assertSafeGitHubBranch, assertSafeGitHubRepositoryCoordinates } from "./github-config"
import { compileV4IgnorePathRegex } from "./v4/ignore"
import { assertDistinctV4SecretIds } from "./v4/secrets"
import { assertV4Pbkdf2Iterations, V4_MIN_NEW_PBKDF2_ITERATIONS } from "./v4/kdf-policy"

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

function assertPluginSettingsSafe(value: unknown, allowUnsafeLegacyRouting: boolean): void {
  const settings = asRecord(value)

  const githubOwner = requireString(settings, "githubOwner")
  const githubRepo = requireString(settings, "githubRepo")
  const githubBranch = requireString(settings, "githubBranch")
  if (!allowUnsafeLegacyRouting) {
    assertSafeGitHubRepositoryCoordinates(githubOwner, githubRepo, { allowEmpty: true })
    assertSafeGitHubBranch(githubBranch, true)
  }
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
  assertDistinctV4SecretIds(settings)
  assertV4Pbkdf2Iterations(settings["newVaultKdfIterations"], V4_MIN_NEW_PBKDF2_ITERATIONS)

  if (settings["encryptionMode"] !== "plaintext" && settings["encryptionMode"] !== "encrypted") {
    throw new Error("Invalid plugin settings: encryptionMode is unsupported.")
  }
  if (
    settings["conflictPolicy"] !== "copy"
    && settings["conflictPolicy"] !== "newer"
    && settings["conflictPolicy"] !== "merge"
    && settings["conflictPolicy"] !== "ask"
  ) {
    throw new Error("Invalid plugin settings: conflictPolicy is unsupported.")
  }

  const abortChangePercent = settings["abortChangePercent"]
  if (
    typeof abortChangePercent !== "number"
    || !Number.isFinite(abortChangePercent)
    || abortChangePercent < 0
    || abortChangePercent > 100
  ) {
    throw new Error("Invalid plugin settings: abortChangePercent must be between 0 and 100.")
  }

  if (settings["scheduledSyncIntervalSeconds"] !== undefined) {
    const interval = settings["scheduledSyncIntervalSeconds"]
    if (typeof interval !== "number" || !Number.isFinite(interval) || interval <= 0) {
      throw new Error("Invalid plugin settings: scheduledSyncIntervalSeconds must be a positive number.")
    }
  }

  if (settings["lastSyncTime"] !== undefined) {
    const lastSyncTime = settings["lastSyncTime"]
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

/** Runtime and Settings Save always enforce strict GitHub routing. */
export function assertPluginSettingsRuntimeSafe(value: unknown): void {
  assertPluginSettingsSafe(value, false)
}

/**
 * Only startup loading may retain malformed legacy routing values for repair.
 * Every other validation remains strict. The caller must disable GitHub client
 * construction and secret migration until explicit repair and Settings Save.
 * Returns true when malformed (not merely missing) saved routing is present.
 */
export function assertPluginSettingsRepairableOnLoad(value: unknown): boolean {
  assertPluginSettingsSafe(value, true)
  const settings = value as RuntimeSettings
  try {
    assertSafeGitHubRepositoryCoordinates(
      settings["githubOwner"] as string, settings["githubRepo"] as string, { allowEmpty: true },
    )
    assertSafeGitHubBranch(settings["githubBranch"] as string, true)
    return false
  } catch {
    return true
  }
}

/** Load legacy blank branch/Device ID values for repair, but never save them again. */
export function assertPluginSettingsSavable(value: unknown): void {
  assertPluginSettingsRuntimeSafe(value)
  const settings = value as RuntimeSettings
  const token = settings["githubToken"]
  // Permit an intentionally unconfigured token, but not a nonempty unusable credential.
  if (typeof token === "string" && token.length > 0 && !token.trim()) {
    throw new Error("GitHub token must not contain only spaces.")
  }
  if (!(settings["githubBranch"] as string).trim()) throw new Error("GitHub branch is required.")
  if (!(settings["vault"] as string).trim()) throw new Error("Device ID is required.")
}
