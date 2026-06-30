export interface EncryptedV3FileChange {
  path: string;
  size: number;
  mtime: number;
}

export interface EncryptedV3Layout {
  basePackCount: number;
  looseDeltaCount: number;
  looseDeltaBytes: number;
}

export type EncryptedV3PlanMode = "noop" | "loose-delta" | "base-pack" | "chunked-object" | "compact";

export interface EncryptedV3SyncPlan {
  mode: EncryptedV3PlanMode;
  reason: string;
  estimatedRequests: number;
  estimatedCommits: number;
  packCount: number;
  chunkCount: number;
  rewritesBasePacks: boolean;
}