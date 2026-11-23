import { assertSafeGitHubBranch, assertSafeGitHubOwner, assertSafeGitHubRepository } from "./github-config";

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

function hasValidGitHubRoutingField(value: string | undefined, validate: (field: string) => void): boolean {
  if (!value) return false
  try { validate(value); return true }
  catch { return false }
}

/** Fixed field labels only; never include credentials in a first-use Notice. */
export function missingGitHubSyncConfigFields(settings: SyncPolicySettings): string[] {
  const missing: string[] = []
  if (!hasValidGitHubRoutingField(settings.githubOwner, assertSafeGitHubOwner)) missing.push("GitHub owner")
  if (!hasValidGitHubRoutingField(settings.githubRepo, assertSafeGitHubRepository)) missing.push("GitHub repository")
  if (settings.githubBranch !== undefined
    && !hasValidGitHubRoutingField(settings.githubBranch, assertSafeGitHubBranch)) missing.push("GitHub branch")
  if (!settings.githubToken?.trim()) missing.push("GitHub token")
  if (settings.vault !== undefined && !settings.vault.trim()) missing.push("Device ID")
  if (settings.encryptionMode === "encrypted" && !settings.encryptionPassphrase) {
    missing.push("encryption passphrase")
  }
  return missing
}

export function hasGitHubSyncConfig(settings: SyncPolicySettings): boolean {
  return missingGitHubSyncConfigFields(settings).length === 0;
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
