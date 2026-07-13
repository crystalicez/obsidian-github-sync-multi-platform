import { compileIgnorePathRegex, isIgnoredPath } from "../encrypted/ignore";
import { normalizeV4VaultPath } from "./paths";
import { V4_ROOT } from "./protocol-types";

export interface V4ScopeSettings {
  configDir: string;
  pluginId: string;
  ignorePathRegex: string;
  syncObsidianConfig: boolean;
  syncBookmarks: boolean;
  syncPlugins: boolean;
}

function isHardExcludedConfigPath(path: string, configDir: string, pluginId: string): boolean {
  const relative = path.slice(configDir.length + 1);
  if (relative === "workspace.json" || relative === "workspace-mobile.json") return true;
  if (/^(cache|logs?|temp|tmp)(\/|$)/iu.test(relative)) return true;
  return relative === `plugins/${pluginId}` || relative.startsWith(`plugins/${pluginId}/`);
}

export function isPathInV4SyncScope(path: string, settings: V4ScopeSettings): boolean {
  return createV4ScopePredicate(settings)(path);
}

export function createV4ScopePredicate(settings: V4ScopeSettings): (path: string) => boolean {
  const rules = compileIgnorePathRegex(settings.ignorePathRegex);
  const configDir = normalizeV4VaultPath(settings.configDir);
  return (path: string) => {
  const normalized = normalizeV4VaultPath(path);
  if (normalized === V4_ROOT || normalized.startsWith(`${V4_ROOT}/`)) return false;
  if (isIgnoredPath(normalized, rules)) return false;
  if (normalized !== configDir && !normalized.startsWith(`${configDir}/`)) return true;
  if (normalized === configDir || isHardExcludedConfigPath(normalized, configDir, settings.pluginId)) return false;
  const relative = normalized.slice(configDir.length + 1);
  if (relative === "bookmarks.json") return settings.syncBookmarks;
  if (relative === "community-plugins.json") return settings.syncPlugins;
  if (relative === "plugins" || relative.startsWith("plugins/")) return settings.syncPlugins;
  return settings.syncObsidianConfig;
  };
}
