const SECRET_SETTING_KEYS = new Set(["githubToken", "encryptionPassphrase"]);

export type SyncConsoleLogLevel = "debug" | "info" | "warn";

export function sanitizeDebugSettings(settings: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settings)) {
    sanitized[key] = SECRET_SETTING_KEYS.has(key) && value ? "***HIDDEN***" : value;
  }
  return sanitized;
}

function sanitizeConsoleValue(value: unknown, key = ""): unknown {
  if (SECRET_SETTING_KEYS.has(key) && value) return "***HIDDEN***";
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (Array.isArray(value)) return value.map(item => sanitizeConsoleValue(item));
  if (value && typeof value === "object") {
    const sanitized: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) sanitized[entryKey] = sanitizeConsoleValue(entryValue, entryKey);
    return sanitized;
  }
  return value;
}

export function syncConsoleLog(settings: { consoleLoggingEnabled?: boolean } | undefined, level: SyncConsoleLogLevel, message: string, details?: Record<string, unknown>): void {
  if (!settings?.consoleLoggingEnabled) return;
  const safeDetails = details ? sanitizeConsoleValue(details) : undefined;
  const prefix = "[Encrypted GitHub Sync]";
  if (safeDetails === undefined) console[level](prefix, message);
  else console[level](prefix, message, safeDetails);
}

export function createDebugPayload(settings: Record<string, unknown>, pluginVersion: string): Record<string, unknown> {
  return {
    settings: sanitizeDebugSettings(settings),
    pluginVersion,
  };
}