import type { ConflictPolicy } from "./types";

export interface SyncSettingsPolicyInput {
  syncEnabled?: boolean;
  encryptionMode?: "plaintext" | "encrypted";
  githubToken?: string;
  githubOwner?: string;
  githubRepo?: string;
  syncOnStartup?: boolean;
  syncOnLocalChange?: boolean;
  scheduledSyncEnabled?: boolean;
  scheduledSyncIntervalSeconds?: unknown;
  conflictPolicy?: unknown;
  ignorePathRegex?: string;
}

const CONFLICT_POLICIES: ConflictPolicy[] = ["copy", "newer", "merge", "ask"];

export function hasGitHubSyncConfig(settings: SyncSettingsPolicyInput): boolean {
  return Boolean(settings.githubToken && settings.githubOwner && settings.githubRepo);
}

export function syncModeUsesEncryption(settings: SyncSettingsPolicyInput): boolean {
  return settings.encryptionMode === "encrypted";
}

export function shouldRunStartupSync(settings: SyncSettingsPolicyInput): boolean {
  return Boolean(settings.syncEnabled && settings.syncOnStartup && hasGitHubSyncConfig(settings));
}

export function shouldRunScheduledSync(settings: SyncSettingsPolicyInput): boolean {
  return Boolean(settings.syncEnabled && settings.scheduledSyncEnabled);
}

export function shouldHandleEncryptedLocalChange(settings: SyncSettingsPolicyInput, eventEnter: boolean): boolean {
  if (!syncModeUsesEncryption(settings)) return false;
  if (!eventEnter) return true;
  return Boolean(settings.syncEnabled && settings.syncOnLocalChange);
}

export function normalizeScheduledSyncIntervalSeconds(value: unknown): number {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return 300;
  return Math.floor(seconds);
}

export function effectiveConflictPolicy(value: unknown): ConflictPolicy {
  return CONFLICT_POLICIES.includes(value as ConflictPolicy) ? value as ConflictPolicy : "copy";
}
