export type V4SyncOperation = "normal" | "forcePush" | "forcePull";
export type V4ChangeKind = "create" | "modify" | "delete" | "rename";

export interface V4LogicalFile {
  path: string;
  fileId: string;
  hash: string;
  size: number;
  mtime: number;
}

export interface V4PlannedChange {
  fileId: string;
  kind: V4ChangeKind;
  path: string;
  previousPath?: string;
  before?: V4LogicalFile;
  after?: V4LogicalFile;
}

export interface V4PlannedConflict {
  fileId: string;
  path: string;
  base?: V4LogicalFile;
  local?: V4LogicalFile;
  remote?: V4LogicalFile;
}

export interface V4SyncPlan {
  operation: V4SyncOperation;
  pulls: V4PlannedChange[];
  pushes: V4PlannedChange[];
  conflicts: V4PlannedConflict[];
  changedFiles: number;
}

function byFileId(files: V4LogicalFile[]): Map<string, V4LogicalFile> {
  return new Map(files.map(file => [file.fileId, file]));
}

function sameFile(left?: V4LogicalFile, right?: V4LogicalFile): boolean {
  if (!left || !right) return left === right;
  return left.path === right.path && left.hash === right.hash;
}

function changeFrom(before: V4LogicalFile | undefined, after: V4LogicalFile | undefined): V4PlannedChange | null {
  const fileId = after?.fileId ?? before?.fileId;
  if (!fileId || sameFile(before, after)) return null;
  if (!before && after) return { fileId, kind: "create", path: after.path, after };
  if (before && !after) return { fileId, kind: "delete", path: before.path, before };
  if (before && after && before.path !== after.path) {
    return { fileId, kind: "rename", path: after.path, previousPath: before.path, before, after };
  }
  return { fileId, kind: "modify", path: after!.path, before, after };
}

function v4NamespaceKey(path: string): string {
  return path.normalize("NFC").toLowerCase();
}

function byV4Namespace(files: V4LogicalFile[]): Map<string, V4LogicalFile> {
  const result = new Map<string, V4LogicalFile>();
  for (const file of files) {
    const key = v4NamespaceKey(file.path);
    const prior = result.get(key);
    if (prior && prior.fileId !== file.fileId) {
      throw new Error(`V4 path collision across local/remote state: ${prior.path} vs ${file.path}`);
    }
    if (!prior) result.set(key, file);
  }
  return result;
}

function isUnchangedBaseFile(file: V4LogicalFile, base: V4LogicalFile[]): boolean {
  return base.some(candidate => candidate.fileId === file.fileId && sameFile(candidate, file));
}

function assertCombinedV4NamespaceSafe(base: V4LogicalFile[], local: V4LogicalFile[], remote: V4LogicalFile[]): void {
  const localByNamespace = byV4Namespace(local);
  const remoteByNamespace = byV4Namespace(remote);

  for (const [key, localFile] of localByNamespace) {
    const remoteFile = remoteByNamespace.get(key);
    if (!remoteFile || remoteFile.fileId === localFile.fileId) continue;

    const localIsUnchangedBase = isUnchangedBaseFile(localFile, base);
    const remoteIsUnchangedBase = isUnchangedBaseFile(remoteFile, base);
    if (localIsUnchangedBase !== remoteIsUnchangedBase) continue;

    throw new Error(`V4 path collision across local/remote state: ${remoteFile.path} vs ${localFile.path}`);
  }
}

export function planV4Sync(input: {
  operation: V4SyncOperation;
  base: V4LogicalFile[];
  local: V4LogicalFile[];
  remote: V4LogicalFile[];
}): V4SyncPlan {
  if (input.operation === "normal") assertCombinedV4NamespaceSafe(input.base, input.local, input.remote);
  const base = byFileId(input.base);
  const local = byFileId(input.local);
  const remote = byFileId(input.remote);
  const ids = new Set([...base.keys(), ...local.keys(), ...remote.keys()]);
  const pulls: V4PlannedChange[] = [];
  const pushes: V4PlannedChange[] = [];
  const conflicts: V4PlannedConflict[] = [];

  for (const fileId of ids) {
    const baseFile = base.get(fileId);
    const localFile = local.get(fileId);
    const remoteFile = remote.get(fileId);
    if (input.operation === "forcePush") {
      const change = changeFrom(remoteFile, localFile);
      if (change) pushes.push(change);
      continue;
    }
    if (input.operation === "forcePull") {
      const change = changeFrom(localFile, remoteFile);
      if (change) pulls.push(change);
      continue;
    }
    const localChanged = !sameFile(baseFile, localFile);
    const remoteChanged = !sameFile(baseFile, remoteFile);
    if (!localChanged && !remoteChanged) continue;
    if (localChanged && remoteChanged) {
      if (sameFile(localFile, remoteFile)) continue;
      conflicts.push({ fileId, path: localFile?.path ?? remoteFile?.path ?? baseFile?.path ?? "", base: baseFile, local: localFile, remote: remoteFile });
      continue;
    }
    const change = localChanged ? changeFrom(baseFile, localFile) : changeFrom(baseFile, remoteFile);
    if (change) (localChanged ? pushes : pulls).push(change);
  }

  const order = (a: V4PlannedChange, b: V4PlannedChange) => a.path.localeCompare(b.path);
  pulls.sort(order);
  pushes.sort(order);
  conflicts.sort((a, b) => a.path.localeCompare(b.path));
  return { operation: input.operation, pulls, pushes, conflicts, changedFiles: pulls.length + pushes.length + conflicts.length };
}
