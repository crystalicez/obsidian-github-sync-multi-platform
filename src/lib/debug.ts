const SECRET_SETTING_KEYS = new Set(["githubToken", "encryptionPassphrase"]);

export function sanitizeDebugSettings(settings: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settings)) {
    sanitized[key] = SECRET_SETTING_KEYS.has(key) && value ? "***HIDDEN***" : value;
  }
  return sanitized;
}
