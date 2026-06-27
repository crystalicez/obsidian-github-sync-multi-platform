import { normalizeVaultPath } from "./paths";

export interface CompiledIgnoreRules {
  patterns: RegExp[];
  source: string;
}

export function compileIgnorePathRegex(source: string): CompiledIgnoreRules {
  const patterns = source
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith("#"))
    .map(line => new RegExp(line, "u"));
  return { patterns, source };
}

export function isIgnoredPath(path: string, rules: CompiledIgnoreRules): boolean {
  const normalized = normalizeVaultPath(path);
  return rules.patterns.some(pattern => pattern.test(normalized));
}