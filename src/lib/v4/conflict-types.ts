import { sha256Hex, utf8ToBytes } from "../bytes";
import { normalizeV4VaultPath } from "./paths";

export type V4ConflictSideSnapshot =
  | { exists: false }
  | { exists: true; path: string; hash: string; size: number; mtime: number };

function canonicalSide(side: V4ConflictSideSnapshot): object {
  return side.exists
    ? { exists: true, path: normalizeV4VaultPath(side.path).normalize("NFC"), hash: side.hash }
    : { exists: false };
}

export async function fingerprintV4ConflictFile(input: {
  fileId: string;
  base: V4ConflictSideSnapshot;
  local: V4ConflictSideSnapshot;
  remote: V4ConflictSideSnapshot;
}): Promise<string> {
  return sha256Hex(utf8ToBytes(JSON.stringify({
    fileId: input.fileId,
    base: canonicalSide(input.base),
    local: canonicalSide(input.local),
    remote: canonicalSide(input.remote),
  })));
}

export async function buildV4ConflictContextKey(input: {
  repoId: string;
  mode: string;
  pathLayout: string;
  settingsGeneration: number;
  scopeSignature: string;
}): Promise<string> {
  return sha256Hex(utf8ToBytes(JSON.stringify(input)));
}

export interface V4ConflictFileSummary {
  fileId: string;
  displayPath: string;
  fingerprint: string;
  base: V4ConflictSideSnapshot;
  local: V4ConflictSideSnapshot;
  remote: V4ConflictSideSnapshot;
  textCandidate: boolean;
  requiresReview: boolean;
}

export interface V4ConflictMaterializedFile {
  generation: number;
  summary: V4ConflictFileSummary;
  mode: "text" | "file";
  downgradeReason?: string;
  baseBytes?: Uint8Array;
  localBytes?: Uint8Array;
  remoteBytes?: Uint8Array;
}

export type V4ConflictFileResolution =
  | { fileId: string; fingerprint: string; kind: "use-local" }
  | { fileId: string; fingerprint: string; kind: "use-remote" }
  | { fileId: string; fingerprint: string; kind: "keep-both" }
  | { fileId: string; fingerprint: string; kind: "merged"; path: string; bytes: Uint8Array };

export interface V4ConflictBatchRequest {
  runId: string;
  generation: number;
  contextKey: string;
  expectedRemoteHead: string | null;
  files: readonly V4ConflictFileSummary[];
  materialize(fileId: string, generation: number): Promise<V4ConflictMaterializedFile>;
}

export interface V4ConflictBatchResolution {
  runId: string;
  generation: number;
  files: readonly V4ConflictFileResolution[];
}
