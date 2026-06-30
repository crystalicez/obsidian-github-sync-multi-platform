import { ENCRYPTED_CHUNK_PLAINTEXT_BYTES, ENCRYPTED_PACK_MAX_FILES, ENCRYPTED_PACK_PLAINTEXT_BYTES, GITHUB_RECOMMENDED_MAX_BYTES } from "./constants";
import type { EncryptedV3FileChange, EncryptedV3Layout, EncryptedV3SyncPlan } from "./v3-types";

export interface EncryptedV3PlannerInput {
  layout: EncryptedV3Layout;
  changedFiles: EncryptedV3FileChange[];
  totalFiles: number;
  totalBytes: number;
}

export interface EncryptedV3PlannerBudget {
  initialPackFileCount: number;
  maxLooseDeltaCount: number;
  maxLooseDeltaBytes: number;
  maxLooseDeltaRequestCount: number;
  maxPackBytes: number;
  maxPackFiles: number;
  chunkBytes: number;
  githubHardMaxBytes: number;
}

export const DEFAULT_ENCRYPTED_V3_PLANNER_BUDGET: EncryptedV3PlannerBudget = {
  initialPackFileCount: 256,
  maxLooseDeltaCount: 512,
  maxLooseDeltaBytes: 64 * 1024 * 1024,
  maxLooseDeltaRequestCount: 256,
  maxPackBytes: ENCRYPTED_PACK_PLAINTEXT_BYTES,
  maxPackFiles: ENCRYPTED_PACK_MAX_FILES,
  chunkBytes: ENCRYPTED_CHUNK_PLAINTEXT_BYTES,
  githubHardMaxBytes: GITHUB_RECOMMENDED_MAX_BYTES,
};

function estimatePackCount(files: EncryptedV3FileChange[], budget: EncryptedV3PlannerBudget): number {
  let packs = 0;
  let bytes = 0;
  let count = 0;
  for (const file of files) {
    if (count > 0 && (count + 1 > budget.maxPackFiles || bytes + file.size > budget.maxPackBytes)) {
      packs += 1;
      bytes = 0;
      count = 0;
    }
    bytes += file.size;
    count += 1;
  }
  return count > 0 ? packs + 1 : packs;
}

export function planEncryptedV3Sync(input: EncryptedV3PlannerInput, overrides: Partial<EncryptedV3PlannerBudget> = {}): EncryptedV3SyncPlan {
  const budget = { ...DEFAULT_ENCRYPTED_V3_PLANNER_BUDGET, ...overrides };
  if (input.changedFiles.length === 0) {
    return { mode: "noop", reason: "no-changes", estimatedRequests: 0, estimatedCommits: 0, packCount: 0, chunkCount: 0, rewritesBasePacks: false };
  }

  const largeFile = input.changedFiles.find(file => file.size > budget.githubHardMaxBytes);
  if (largeFile) {
    const chunkCount = Math.ceil(largeFile.size / budget.chunkBytes);
    return { mode: "chunked-object", reason: "github-file-size-limit", estimatedRequests: chunkCount + 2, estimatedCommits: 1, packCount: 0, chunkCount, rewritesBasePacks: false };
  }

  const projectedLooseCount = input.layout.looseDeltaCount + input.changedFiles.length;
  const projectedLooseBytes = input.layout.looseDeltaBytes + input.changedFiles.reduce((sum, file) => sum + file.size, 0);
  if (input.layout.basePackCount > 0 && (projectedLooseCount > budget.maxLooseDeltaCount || projectedLooseBytes > budget.maxLooseDeltaBytes)) {
    const packCount = estimatePackCount(input.changedFiles, budget);
    return { mode: "compact", reason: "loose-delta-budget", estimatedRequests: packCount + 2, estimatedCommits: 1, packCount, chunkCount: 0, rewritesBasePacks: true };
  }

  const isInitialBulk = input.layout.basePackCount === 0 && input.layout.looseDeltaCount === 0 && input.totalFiles >= budget.initialPackFileCount;
  if (isInitialBulk || input.changedFiles.length > budget.maxLooseDeltaRequestCount) {
    const packCount = estimatePackCount(input.changedFiles, budget);
    return { mode: "base-pack", reason: isInitialBulk ? "initial-bulk" : "request-budget", estimatedRequests: packCount + 2, estimatedCommits: 1, packCount, chunkCount: 0, rewritesBasePacks: true };
  }

  return { mode: "loose-delta", reason: "small-change-set", estimatedRequests: input.changedFiles.length + 2, estimatedCommits: 1, packCount: 0, chunkCount: 0, rewritesBasePacks: false };
}