import { ENCRYPTED_CHUNK_PLAINTEXT_BYTES, ENCRYPTED_PACK_MAX_FILES, ENCRYPTED_PACK_PLAINTEXT_BYTES, GITHUB_RECOMMENDED_MAX_BYTES } from "./constants";

export type EncryptedSnapshotSyncMode = "loose-delta" | "pack-base" | "chunked-object" | "compact" | "noop";
export type EncryptedSnapshotSyncReason = "no-changes" | "small-change-set" | "initial-bulk" | "large-file" | "loose-object-budget" | "request-budget";

export interface SnapshotPlannerFile {
  path: string;
  size: number;
  mtime: number;
}

export interface SnapshotPlannerLayout {
  packedFileCount: number;
  looseObjectCount: number;
  looseBytes: number;
}

export interface SnapshotPlannerInput {
  currentLayout: SnapshotPlannerLayout;
  changedFiles: SnapshotPlannerFile[];
  totalFiles: number;
  totalBytes: number;
}

export interface SnapshotPlannerBudget {
  maxLooseObjectsBeforeCompact: number;
  maxLooseBytesBeforeCompact: number;
  maxLooseDeltaRequests: number;
  bulkFileCount: number;
  maxPackBytes: number;
  maxPackFiles: number;
  chunkBytes: number;
  githubRecommendedMaxBytes: number;
}

export interface SnapshotSyncPlan {
  mode: EncryptedSnapshotSyncMode;
  reason: EncryptedSnapshotSyncReason;
  estimatedRequests: number;
  packCount: number;
  chunkCount: number;
}

export const DEFAULT_SNAPSHOT_PLANNER_BUDGET: SnapshotPlannerBudget = {
  maxLooseObjectsBeforeCompact: 512,
  maxLooseBytesBeforeCompact: 64 * 1024 * 1024,
  maxLooseDeltaRequests: 128,
  bulkFileCount: 256,
  maxPackBytes: ENCRYPTED_PACK_PLAINTEXT_BYTES,
  maxPackFiles: ENCRYPTED_PACK_MAX_FILES,
  chunkBytes: ENCRYPTED_CHUNK_PLAINTEXT_BYTES,
  githubRecommendedMaxBytes: GITHUB_RECOMMENDED_MAX_BYTES,
};

function estimatePackCount(files: SnapshotPlannerFile[], budget: SnapshotPlannerBudget): number {
  let packs = 0;
  let bytes = 0;
  let count = 0;
  for (const file of files) {
    const startsNewPack = count > 0 && (count + 1 > budget.maxPackFiles || bytes + file.size > budget.maxPackBytes);
    if (startsNewPack) {
      packs += 1;
      bytes = 0;
      count = 0;
    }
    bytes += file.size;
    count += 1;
  }
  return count > 0 ? packs + 1 : packs;
}

function hasLargeFile(files: SnapshotPlannerFile[], budget: SnapshotPlannerBudget): SnapshotPlannerFile | undefined {
  return files.find(file => file.size > budget.githubRecommendedMaxBytes);
}

export function planEncryptedSnapshotSync(input: SnapshotPlannerInput, budgetOverrides: Partial<SnapshotPlannerBudget> = {}): SnapshotSyncPlan {
  const budget = { ...DEFAULT_SNAPSHOT_PLANNER_BUDGET, ...budgetOverrides };
  if (input.changedFiles.length === 0) {
    return { mode: "noop", reason: "no-changes", estimatedRequests: 0, packCount: 0, chunkCount: 0 };
  }

  const largeFile = hasLargeFile(input.changedFiles, budget);
  if (largeFile) {
    const chunkCount = Math.ceil(largeFile.size / budget.chunkBytes);
    return { mode: "chunked-object", reason: "large-file", estimatedRequests: chunkCount + 1, packCount: 0, chunkCount };
  }

  const projectedLooseObjects = input.currentLayout.looseObjectCount + input.changedFiles.length;
  const projectedLooseBytes = input.currentLayout.looseBytes + input.changedFiles.reduce((sum, file) => sum + file.size, 0);
  if (input.currentLayout.packedFileCount > 0 && (projectedLooseObjects > budget.maxLooseObjectsBeforeCompact || projectedLooseBytes > budget.maxLooseBytesBeforeCompact)) {
    const packCount = estimatePackCount(input.changedFiles, budget);
    return { mode: "compact", reason: "loose-object-budget", estimatedRequests: packCount + 1, packCount, chunkCount: 0 };
  }

  const isInitialBulk = input.currentLayout.packedFileCount === 0
    && input.currentLayout.looseObjectCount === 0
    && (input.changedFiles.length >= budget.bulkFileCount || input.totalFiles >= budget.bulkFileCount);
  if (isInitialBulk) {
    const packCount = estimatePackCount(input.changedFiles, budget);
    return { mode: "pack-base", reason: "initial-bulk", estimatedRequests: packCount + 1, packCount, chunkCount: 0 };
  }

  if (input.changedFiles.length > budget.maxLooseDeltaRequests) {
    const packCount = estimatePackCount(input.changedFiles, budget);
    return { mode: "pack-base", reason: "request-budget", estimatedRequests: packCount + 1, packCount, chunkCount: 0 };
  }

  return { mode: "loose-delta", reason: "small-change-set", estimatedRequests: input.changedFiles.length + 1, packCount: 0, chunkCount: 0 };
}