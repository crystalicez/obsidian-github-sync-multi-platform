export interface SyncPolicySettings {
  syncEnabled?: boolean;
  githubToken?: string;
  githubOwner?: string;
  githubRepo?: string;
  syncOnStartup?: boolean;
  scheduledSyncEnabled?: boolean;
  scheduledSyncIntervalSeconds?: unknown;
}

const MIN_SCHEDULED_SYNC_INTERVAL_SECONDS = 30;

export function hasGitHubSyncConfig(settings: SyncPolicySettings): boolean {
  return Boolean(settings.githubToken && settings.githubOwner && settings.githubRepo);
}

export function shouldRunStartupSync(settings: SyncPolicySettings): boolean {
  return Boolean(settings.syncEnabled && settings.syncOnStartup && hasGitHubSyncConfig(settings));
}

export function shouldRunScheduledSync(settings: SyncPolicySettings): boolean {
  return Boolean(settings.syncEnabled && settings.scheduledSyncEnabled);
}

export function normalizeScheduledSyncIntervalSeconds(value: unknown): number {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return 300;
  return Math.max(MIN_SCHEDULED_SYNC_INTERVAL_SECONDS, Math.floor(seconds));
}
