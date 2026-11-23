export interface SyncPolicySettings {
  syncEnabled?: boolean;
  githubToken?: string;
  githubOwner?: string;
  githubRepo?: string;
  githubBranch?: string;
  vault?: string;
  encryptionMode?: "plaintext" | "encrypted";
  encryptionPassphrase?: string;
  syncOnStartup?: boolean;
  scheduledSyncEnabled?: boolean;
  scheduledSyncIntervalSeconds?: unknown;
}

const MIN_SCHEDULED_SYNC_INTERVAL_SECONDS = 30;

/** Fixed field labels only; never include credentials in a first-use Notice. */
export function missingGitHubSyncConfigFields(settings: SyncPolicySettings): string[] {
  const missing: string[] = []
  if (!settings.githubOwner) missing.push("GitHub owner")
  if (!settings.githubRepo) missing.push("GitHub repository")
  if (settings.githubBranch !== undefined && !settings.githubBranch.trim()) missing.push("GitHub branch")
  if (!settings.githubToken) missing.push("GitHub token")
  if (settings.vault !== undefined && !settings.vault.trim()) missing.push("Device ID")
  if (settings.encryptionMode === "encrypted" && !settings.encryptionPassphrase) {
    missing.push("encryption passphrase")
  }
  return missing
}

export function hasGitHubSyncConfig(settings: SyncPolicySettings): boolean {
  return Boolean(settings.githubToken && settings.githubOwner && settings.githubRepo
    && (settings.githubBranch === undefined || settings.githubBranch.trim())
    && (settings.vault === undefined || settings.vault.trim())
    && (settings.encryptionMode !== "encrypted" || settings.encryptionPassphrase));
}

export function shouldRunStartupSync(settings: SyncPolicySettings): boolean {
  return Boolean(settings.syncEnabled && settings.syncOnStartup && hasGitHubSyncConfig(settings));
}

export function shouldRunScheduledSync(settings: SyncPolicySettings): boolean {
  return Boolean(settings.syncEnabled && settings.scheduledSyncEnabled && hasGitHubSyncConfig(settings));
}

export function normalizeScheduledSyncIntervalSeconds(value: unknown): number {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return 300;
  return Math.max(MIN_SCHEDULED_SYNC_INTERVAL_SECONDS, Math.floor(seconds));
}
