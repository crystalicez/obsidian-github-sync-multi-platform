export type RandomActionKind = "addFiles" | "editText" | "addImages" | "deleteFiles" | "renameFiles" | "moveFiles";
export type RandomSyncMode = "bulk" | "event";

export interface RandomActionPlanStep {
  kind: RandomActionKind;
  syncMode: RandomSyncMode;
}

export interface RandomActionConfig {
  actionCount: number;
  verifyEvery: number;
}

export interface RandomActionLimits {
  maxAddFiles: number;
  maxEditFiles: number;
  maxEditChars: number;
  maxDeleteFiles: number;
  maxRenameFiles: number;
  maxMoveFiles: number;
  maxImages: number;
  loopMaxAddFiles: number;
  loopMaxEditFiles: number;
  loopMaxDeleteFiles: number;
  loopMaxRenameFiles: number;
  loopMaxMoveFiles: number;
  loopMaxImages: number;
}

export interface RandomLike {
  int(min: number, max: number): number;
  pick<T>(items: T[]): T;
}

function envNumber(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function readRandomActionConfig(env: Record<string, string | undefined>): RandomActionConfig {
  return {
    actionCount: Math.max(1, Math.floor(envNumber(env, "GITHUB_E2E_RANDOM_ACTIONS", 10))),
    verifyEvery: Math.floor(envNumber(env, "GITHUB_E2E_RANDOM_VERIFY_EVERY", 0)),
  };
}


export function readRandomActionLimits(env: Record<string, string | undefined>): RandomActionLimits {
  const maxAddFiles = envNumber(env, "GITHUB_E2E_RANDOM_MAX_ADD_FILES", 5000);
  const maxEditFiles = envNumber(env, "GITHUB_E2E_RANDOM_MAX_EDIT_FILES", 2000);
  const maxEditChars = envNumber(env, "GITHUB_E2E_RANDOM_MAX_EDIT_CHARS", 100);
  const maxDeleteFiles = envNumber(env, "GITHUB_E2E_RANDOM_MAX_DELETE_FILES", 2000);
  const maxRenameFiles = envNumber(env, "GITHUB_E2E_RANDOM_MAX_RENAME_FILES", 1000);
  const maxMoveFiles = envNumber(env, "GITHUB_E2E_RANDOM_MAX_MOVE_FILES", 1000);
  const maxImages = envNumber(env, "GITHUB_E2E_RANDOM_MAX_IMAGES", 25);
  return {
    maxAddFiles,
    maxEditFiles,
    maxEditChars,
    maxDeleteFiles,
    maxRenameFiles,
    maxMoveFiles,
    maxImages,
    loopMaxAddFiles: envNumber(env, "GITHUB_E2E_RANDOM_LOOP_MAX_ADD_FILES", Math.min(maxAddFiles, 10)),
    loopMaxEditFiles: envNumber(env, "GITHUB_E2E_RANDOM_LOOP_MAX_EDIT_FILES", Math.min(maxEditFiles, 10)),
    loopMaxDeleteFiles: envNumber(env, "GITHUB_E2E_RANDOM_LOOP_MAX_DELETE_FILES", Math.min(maxDeleteFiles, 10)),
    loopMaxRenameFiles: envNumber(env, "GITHUB_E2E_RANDOM_LOOP_MAX_RENAME_FILES", Math.min(maxRenameFiles, 5)),
    loopMaxMoveFiles: envNumber(env, "GITHUB_E2E_RANDOM_LOOP_MAX_MOVE_FILES", Math.min(maxMoveFiles, 5)),
    loopMaxImages: envNumber(env, "GITHUB_E2E_RANDOM_LOOP_MAX_IMAGES", Math.min(maxImages, 2)),
  };
}
export function chooseRandomAction(existingFiles: number, random: RandomLike): RandomActionKind {
  const pool: RandomActionKind[] = existingFiles === 0
    ? ["addFiles"]
    : ["addFiles", "editText", "addImages", "deleteFiles", "renameFiles", "moveFiles"];
  return random.pick(pool);
}

export function chooseRandomSyncMode(kind: RandomActionKind, changedCount: number, random: RandomLike): RandomSyncMode {
  if (changedCount !== 1) return "bulk";
  if (kind === "addFiles" || kind === "editText" || kind === "deleteFiles" || kind === "renameFiles" || kind === "moveFiles") {
    return random.int(0, 1) === 0 ? "event" : "bulk";
  }
  return "bulk";
}
