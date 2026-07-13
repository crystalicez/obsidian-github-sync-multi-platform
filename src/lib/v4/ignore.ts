import { normalizeV4VaultPath } from "./paths";

export interface V4CompiledIgnoreRules {
  patterns: RegExp[];
}

export function compileV4IgnorePathRegex(source: string): V4CompiledIgnoreRules {
  const patterns = source
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith("#"))
    .map(line => new RegExp(line, "u"));
  return { patterns };
}

export function isV4IgnoredPath(path: string, rules: V4CompiledIgnoreRules): boolean {
  const normalized = normalizeV4VaultPath(path);
  return rules.patterns.some(pattern => pattern.test(normalized));
}
