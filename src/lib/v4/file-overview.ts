export type V4FileFilter = "all" | "changed" | "local-only" | "remote-only" | "synced";
export type V4FileStatus = Exclude<V4FileFilter, "all">;

export interface V4FileOverviewEntry {
  path: string;
  status: V4FileStatus;
  local: boolean;
  remote: boolean;
  /** Tracked-file removal or verified remote rename; do not imply unrelated additions. */
  reason?: "local-deleted" | "remote-deleted" | "remote-renamed-from" | "remote-renamed-to";
  relatedPath?: string;
}
export interface V4FileOverview {
  entries: V4FileOverviewEntry[];
  remoteCommitSha: string;
}
export interface V4FileOverviewInput {
  localFiles: Array<{ path: string; size: number; mtime: number }>;
  remoteFiles: Array<{ path: string; remoteVersion: string; fileId?: string }>;
  baselineFiles: Array<{ path: string; remoteVersion: string; size: number; mtime: number; fileId?: string }>;
  remoteCommitSha: string;
}

export const V4_FILE_FILTERS: readonly V4FileFilter[] = ["all", "changed", "local-only", "remote-only", "synced"];

export function buildV4FileOverview(input: V4FileOverviewInput): V4FileOverview {
  const local = new Map(input.localFiles.map(file => [file.path, file]));
  const remote = new Map(input.remoteFiles.map(file => [file.path, file]));
  const baseline = new Map(input.baselineFiles.map(file => [file.path, file]));
  const uniqueIdentityPaths = (records: Array<{ path: string; fileId?: string }>) => {
    const byId = new Map<string, string | null>();
    for (const record of records) {
      if (!record.fileId) continue;
      // A duplicate identity is ambiguous; never invent a rename claim.
      if (byId.has(record.fileId)) byId.set(record.fileId, null);
      else byId.set(record.fileId, record.path);
    }
    return byId;
  };
  const remoteById = uniqueIdentityPaths(input.remoteFiles);
  const baselineById = uniqueIdentityPaths(input.baselineFiles);
  const entries: V4FileOverviewEntry[] = [];
  for (const path of new Set([...local.keys(), ...remote.keys()])) {
    const here = local.get(path);
    const there = remote.get(path);
    const base = baseline.get(path);
    let status: V4FileStatus;
    let reason: V4FileOverviewEntry["reason"];
    let relatedPath: string | undefined;
    if (!there) {
      status = base ? "changed" : "local-only";
      if (base) {
        const movedTo = base.fileId && remoteById.get(base.fileId);
        if (movedTo && movedTo !== path && baselineById.get(base.fileId!) === path) {
          reason = "remote-renamed-from";
          relatedPath = movedTo;
        } else reason = "remote-deleted";
      }
    } else if (!here) {
      const movedFrom = there.fileId && baselineById.get(there.fileId);
      if (!base && movedFrom && movedFrom !== path && remoteById.get(there.fileId!) === path) {
        status = "changed";
        reason = "remote-renamed-to";
        relatedPath = movedFrom;
      } else {
        status = base ? "changed" : "remote-only";
        if (base) reason = "local-deleted";
      }
    } else {
      status = base
        && base.remoteVersion === there.remoteVersion
        && base.size === here.size
        && base.mtime === here.mtime
        ? "synced" : "changed";
    }
    entries.push({ path, status, local: !!here, remote: !!there,
      ...(reason ? { reason } : {}), ...(relatedPath ? { relatedPath } : {}) });
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return { entries, remoteCommitSha: input.remoteCommitSha };
}

export function filterV4FileOverview(entries: readonly V4FileOverviewEntry[], filter: V4FileFilter, query: string): V4FileOverviewEntry[] {
  const needle = query.trim().toLocaleLowerCase();
  return entries.filter(entry => (filter === "all" || entry.status === filter)
    && (!needle || entry.path.toLocaleLowerCase().includes(needle)));
}

export function countV4FileOverview(entries: readonly V4FileOverviewEntry[]): Record<V4FileFilter, number> {
  const counts = { all: entries.length, changed: 0, "local-only": 0, "remote-only": 0, synced: 0 };
  for (const entry of entries) counts[entry.status]++;
  return counts;
}

export interface V4FileTreeNode {
  name: string;
  path: string;
  children: V4FileTreeNode[];
  entry?: V4FileOverviewEntry;
}

export function treeV4FileOverview(entries: readonly V4FileOverviewEntry[]): V4FileTreeNode[] {
  const root: V4FileTreeNode = { name: "", path: "", children: [] };
  // A wide folder can have tens of thousands of siblings. Index every path
  // once rather than linearly searching children (quadratic on flat vaults).
  const nodes = new Map<string, V4FileTreeNode>([["", root]]);
  for (const entry of entries) {
    const parts = entry.path.split("/");
    let parent = root;
    let path = "";
    for (let i = 0; i < parts.length; i++) {
      const segment = parts[i]!;
      path = path ? `${path}/${segment}` : segment;
      let node = nodes.get(path);
      if (!node) {
        node = { name: segment, path, children: [] };
        nodes.set(path, node);
        parent.children.push(node);
      }
      if (i === parts.length - 1) node.entry = entry;
      parent = node;
    }
  }
  const pending = [root];
  while (pending.length) {
    const node = pending.pop()!;
    node.children.sort((a, b) => Number(!!a.entry) - Number(!!b.entry) || a.name.localeCompare(b.name));
    for (const child of node.children) pending.push(child);
  }
  return root.children;
}
