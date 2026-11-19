const SENSITIVE_DEBUG_KEYS = new Set([
  "githubtoken",
  "encryptionpassphrase",
  "authorization",
  "proxyauthorization",
  "token",
  "accesstoken",
  "refreshtoken",
  "apikey",
  "xapikey",
  "password",
  "passphrase",
  "secret",
]);

export type SyncConsoleLogLevel = "debug" | "info" | "warn";

export function redactConfiguredSecrets(
  text: string,
  settings: { githubToken?: string; encryptionPassphrase?: string },
): string {
  let safe = text;
  const secrets = [...new Set([settings.githubToken, settings.encryptionPassphrase])]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .sort((left, right) => right.length - left.length);
  for (const secret of secrets) safe = safe.replaceAll(secret, "***HIDDEN***");
  return safe;
}

function normalizedDebugKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

function isSensitiveDebugKey(key: string): boolean {
  return SENSITIVE_DEBUG_KEYS.has(normalizedDebugKey(key));
}

export function sanitizeDebugSettings(settings: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settings)) {
    sanitized[key] = isSensitiveDebugKey(key) && value !== undefined && value !== null ? "***HIDDEN***" : value;
  }
  return sanitized;
}

function safeErrorScalar(value: unknown): string | number | boolean | undefined {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : undefined;
}

function sanitizeConsoleValue(
  value: unknown,
  key = "",
  seen: WeakSet<object> = new WeakSet<object>(),
  depth = 0,
  settings: { githubToken?: string; encryptionPassphrase?: string } = {},
): unknown {
  if (isSensitiveDebugKey(key) && value !== undefined && value !== null) return "***HIDDEN***";
  if (depth > 8) return "[Truncated]";
  if (value instanceof Error) {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    const candidate = value as Error & {
      status?: unknown
      code?: unknown
      retryClass?: unknown
      cause?: unknown
    };
    const sanitized: Record<string, unknown> = {
      name: redactConfiguredSecrets(value.name, settings),
      message: redactConfiguredSecrets(value.message, settings),
    };
    const status = safeErrorScalar(candidate.status);
    const code = safeErrorScalar(candidate.code);
    const retryClass = safeErrorScalar(candidate.retryClass);
    if (status !== undefined) sanitized["status"] = sanitizeConsoleValue(status, "", seen, depth + 1, settings);
    if (code !== undefined) sanitized["code"] = sanitizeConsoleValue(code, "", seen, depth + 1, settings);
    if (retryClass !== undefined) sanitized["retryClass"] = sanitizeConsoleValue(retryClass, "", seen, depth + 1, settings);
    if (candidate.cause !== undefined) sanitized["cause"] = sanitizeConsoleValue(candidate.cause, "cause", seen, depth + 1, settings);
    return sanitized;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    return value.map(item => sanitizeConsoleValue(item, "", seen, depth + 1, settings));
  }
  if (value && typeof value === "object") {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    const sanitized: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
      sanitized[redactConfiguredSecrets(entryKey, settings)] = sanitizeConsoleValue(entryValue, entryKey, seen, depth + 1, settings);
    }
    return sanitized;
  }
  return typeof value === "string" ? redactConfiguredSecrets(value, settings) : value;
}

export function syncConsoleLog(
  settings: { consoleLoggingEnabled?: boolean; githubToken?: string; encryptionPassphrase?: string } | undefined,
  level: SyncConsoleLogLevel,
  message: string,
  details?: Record<string, unknown>,
): void {
  if (!settings?.consoleLoggingEnabled) return;
  const safeDetails = details ? sanitizeConsoleValue(details, "", new WeakSet<object>(), 0, settings) : undefined;
  const safeMessage = redactConfiguredSecrets(message, settings);
  const prefix = "[Encrypted GitHub Sync]";
  if (safeDetails === undefined) console[level](prefix, safeMessage);
  else console[level](prefix, safeMessage, safeDetails);
}

export function createDebugPayload(settings: Record<string, unknown>, pluginVersion: string): Record<string, unknown> {
  return {
    settings: sanitizeDebugSettings(settings),
    pluginVersion,
  };
}
