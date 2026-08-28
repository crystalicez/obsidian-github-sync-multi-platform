import { spawnSync } from "node:child_process";
import { CANONICAL_REPOSITORY } from "./github-repo.mjs";
import { parseStableTriple } from "./release-metadata.mjs";

export const QUALIFICATION_SCHEMA_VERSION = 1;
export const QUALIFICATION_KIND = "obsidian-sync-local-qualification";
export const QUALIFICATION_E2E_SUITE = "github-e2e-quick";
export const QUALIFICATION_GATES = Object.freeze([
  "metadata-validation",
  "install-frozen",
  "build",
  "package-validation",
  "fast-tests",
  "repeat-tests",
  "recovery-tests",
  "resource-tests",
  "feasibility-tests",
  "github-e2e-compile",
  "github-e2e-live",
  "github-e2e-cleanup-verified",
]);

export const PNPM_GATE_COMMANDS = Object.freeze({
  "install-frozen": Object.freeze({ argv: ["pnpm", "install", "--frozen-lockfile"], windows: "corepack pnpm install --frozen-lockfile" }),
  build: Object.freeze({ argv: ["pnpm", "build"], windows: "corepack pnpm build" }),
  "package-validation": Object.freeze({ argv: ["pnpm", "validate:package"], windows: "corepack pnpm validate:package" }),
  "fast-tests": Object.freeze({ argv: ["pnpm", "test"], windows: "corepack pnpm test" }),
  "repeat-tests": Object.freeze({ argv: ["pnpm", "test:repeat"], windows: "corepack pnpm test:repeat" }),
  "recovery-tests": Object.freeze({ argv: ["pnpm", "test:recovery"], windows: "corepack pnpm test:recovery" }),
  "resource-tests": Object.freeze({ argv: ["pnpm", "test:resource"], windows: "corepack pnpm test:resource" }),
  "feasibility-tests": Object.freeze({ argv: ["pnpm", "test:feasibility"], windows: "corepack pnpm test:feasibility" }),
  "github-e2e-compile": Object.freeze({ argv: ["pnpm", "test:github-e2e:compile"], windows: "corepack pnpm test:github-e2e:compile" }),
  "github-e2e-live": Object.freeze({ argv: ["pnpm", "test:github-e2e:quick"], windows: "corepack pnpm test:github-e2e:quick" }),
});

const SHA_RE = /^[0-9a-f]{40}$/u;
const PLATFORM_RE = /^[A-Za-z0-9._-]{1,100}$/u;
const RECEIPT_KEYS = Object.freeze([
  "schemaVersion", "kind", "repository", "commitSha", "version", "result",
  "qualifiedAt", "durationMs", "platform", "nodeVersion", "pnpmVersion", "e2eSuite", "gates",
]);

export function qualificationTagName(version, sha) {
  if (!parseStableTriple(version)) throw new Error(`Invalid qualification version: ${version}`);
  if (!SHA_RE.test(sha ?? "")) throw new Error("Qualification requires a full lowercase 40-hex commit SHA");
  return `qualification/local/v1/${version}/${sha}`;
}

export function qualificationRefName(version, sha) {
  return `refs/tags/${qualificationTagName(version, sha)}`;
}

export function createQualificationReceipt({
  sha,
  version,
  qualifiedAt,
  durationMs,
  platform,
  nodeVersion,
  pnpmVersion,
}) {
  return {
    schemaVersion: QUALIFICATION_SCHEMA_VERSION,
    kind: QUALIFICATION_KIND,
    repository: CANONICAL_REPOSITORY,
    commitSha: sha,
    version,
    result: "success",
    qualifiedAt,
    durationMs,
    platform,
    nodeVersion,
    pnpmVersion,
    e2eSuite: QUALIFICATION_E2E_SUITE,
    gates: [...QUALIFICATION_GATES],
  };
}

export function serializeQualificationReceipt(receipt) {
  return `${JSON.stringify(receipt, null, 2)}\n`;
}

function arraysEqual(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => value === right[index]);
}

export function validateQualificationReceipt(receipt, expected) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) throw new Error("Qualification receipt must be a JSON object");
  const keys = Object.keys(receipt).sort();
  const expectedKeys = [...RECEIPT_KEYS].sort();
  if (!arraysEqual(keys, expectedKeys)) throw new Error("Qualification receipt fields do not match schema v1");
  if (receipt.schemaVersion !== QUALIFICATION_SCHEMA_VERSION) throw new Error("Qualification receipt schemaVersion mismatch");
  if (receipt.kind !== QUALIFICATION_KIND) throw new Error("Qualification receipt kind mismatch");
  if (receipt.repository !== CANONICAL_REPOSITORY) throw new Error("Qualification receipt repository mismatch");
  if (!SHA_RE.test(receipt.commitSha ?? "") || receipt.commitSha !== expected.sha) throw new Error("Qualification receipt commit SHA mismatch");
  if (!parseStableTriple(receipt.version) || receipt.version !== expected.version) throw new Error("Qualification receipt version mismatch");
  if (receipt.result !== "success") throw new Error("Qualification receipt result must be success");
  if (receipt.e2eSuite !== QUALIFICATION_E2E_SUITE) throw new Error("Qualification receipt E2E suite mismatch");
  if (receipt.nodeVersion !== expected.nodeVersion) throw new Error("Qualification receipt Node version mismatch");
  if (receipt.pnpmVersion !== expected.pnpmVersion) throw new Error("Qualification receipt pnpm version mismatch");
  if (!arraysEqual(receipt.gates, QUALIFICATION_GATES)) throw new Error("Qualification receipt gates do not match exact v1 order");

  if (typeof receipt.qualifiedAt !== "string") throw new Error("Qualification receipt qualifiedAt is invalid");
  const qualified = new Date(receipt.qualifiedAt);
  if (!Number.isFinite(qualified.getTime()) || qualified.toISOString() !== receipt.qualifiedAt) throw new Error("Qualification receipt qualifiedAt is invalid");
  if (!Number.isSafeInteger(receipt.durationMs) || receipt.durationMs < 0) throw new Error("Qualification receipt durationMs is invalid");
  if (typeof receipt.platform !== "string" || !PLATFORM_RE.test(receipt.platform)) throw new Error("Qualification receipt platform is invalid");

  return receipt;
}

export function withoutGitHubE2EToken(env = {}) {
  const next = { ...env };
  delete next.GITHUB_E2E_TOKEN;
  return next;
}

export function runCommand(command, args = [], options = {}) {
  const { encoding = "utf8", shell: _ignoredShell, ...rest } = options;
  return spawnSync(command, args, { ...rest, shell: false, encoding });
}

export function runPnpmGate(gate, {
  cwd,
  env = process.env,
  platform = process.platform,
  comspec = process.env.ComSpec || process.env.COMSPEC || "cmd.exe",
  runner = runCommand,
} = {}) {
  const spec = PNPM_GATE_COMMANDS[gate];
  if (!spec) throw new Error(`Unknown pnpm gate: ${gate}`);
  if (platform === "win32") {
    return runner(comspec, ["/d", "/s", "/c", spec.windows], { cwd, env, encoding: "utf8" });
  }
  return runner("corepack", spec.argv, { cwd, env, encoding: "utf8" });
}
