import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { build } from "esbuild";

export const GITHUB_E2E_ENTRY_POINTS = Object.freeze([
  "tests/github-e2e/v4-real-github-e2e.test.ts",
  "tests/github-e2e/v4-copy-contract-github-e2e.test.ts",
  "tests/github-e2e/v4-encrypted-external-mutation.test.ts",
]);

export const GITHUB_E2E_BUNDLES = Object.freeze(
  GITHUB_E2E_ENTRY_POINTS.map(value => value.split("/").at(-1).replace(/\.ts$/u, ".mjs")),
);

function required(env, name, pattern) {
  const value = env[name] ?? "";
  if (!pattern.test(value)) throw new Error(`Invalid GitHub E2E producer field: ${name}`);
  return value;
}

function isWithin(parent, child) {
  const rel = relative(parent, child);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function lstatOrNull(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function assertOwnedTempAncestors(root, outDir) {
  const tempRoot = resolve(root, ".tmp");
  if (!isWithin(tempRoot, outDir)) return false;

  await mkdir(tempRoot, { recursive: true });
  const tempInfo = await lstat(tempRoot);
  if (tempInfo.isSymbolicLink() || !tempInfo.isDirectory()) {
    throw new Error("GitHub E2E repository temp root must be a real directory, not a symbolic link.");
  }

  const rel = relative(tempRoot, outDir);
  const parents = rel.split(sep).slice(0, -1);
  let cursor = tempRoot;
  for (const part of parents) {
    cursor = resolve(cursor, part);
    const info = await lstatOrNull(cursor);
    if (!info) break;
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`GitHub E2E output parent is not a real directory: ${cursor}`);
    }
  }
  return true;
}

export async function prepareGitHubE2EOutputDirectory({ root = process.cwd(), outDir }) {
  if (!outDir) throw new Error("GitHub E2E output directory is required.");
  const resolvedRoot = resolve(root);
  const resolvedOutDir = resolve(outDir);
  if (resolvedOutDir === resolvedRoot) {
    throw new Error("Refusing to use the repository root as the GitHub E2E output directory.");
  }

  if (await assertOwnedTempAncestors(resolvedRoot, resolvedOutDir)) {
    await rm(resolvedOutDir, { recursive: true, force: true });
    await mkdir(resolvedOutDir, { recursive: true });
    return resolvedOutDir;
  }

  const info = await lstatOrNull(resolvedOutDir);
  if (!info) {
    await mkdir(resolvedOutDir, { recursive: true });
    return resolvedOutDir;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error("Refusing to use a caller-owned GitHub E2E output path that is not a real directory.");
  }
  if ((await readdir(resolvedOutDir)).length > 0) {
    throw new Error("GitHub E2E output directory is non-empty; refusing to clear a caller-owned output directory.");
  }
  return resolvedOutDir;
}

export async function compileGitHubE2EBundles({ root = process.cwd(), outDir }) {
  const preparedOutDir = await prepareGitHubE2EOutputDirectory({ root, outDir });
  const outputs = [];
  for (let index = 0; index < GITHUB_E2E_ENTRY_POINTS.length; index++) {
    const outfile = resolve(preparedOutDir, GITHUB_E2E_BUNDLES[index]);
    await build({
      entryPoints: [resolve(root, GITHUB_E2E_ENTRY_POINTS[index])],
      outfile,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      alias: { obsidian: resolve(root, "tests/stubs/obsidian.ts") },
      logLevel: "silent",
    });
    outputs.push(outfile);
  }
  return outputs;
}

export async function writeGitHubE2EInputManifest({ outDir, env = process.env, nodeVersion = process.version }) {
  const repositoryId = required(env, "GITHUB_REPOSITORY_ID", /^[1-9][0-9]*$/u);
  const commitSha = required(env, "GITHUB_SHA", /^[0-9a-f]{40}$/u);
  const workflowRunId = required(env, "GITHUB_RUN_ID", /^[1-9][0-9]*$/u);
  const attemptText = required(env, "GITHUB_RUN_ATTEMPT", /^[1-9][0-9]*$/u);
  if (!/^v[0-9]+\.[0-9]+\.[0-9]+$/u.test(nodeVersion)) throw new Error("Invalid GitHub E2E producer Node version.");

  const actual = (await readdir(outDir)).sort();
  const expected = [...GITHUB_E2E_BUNDLES].sort();
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    throw new Error("GitHub E2E input directory contains unexpected entries before manifest creation.");
  }

  const bundles = [];
  for (const name of GITHUB_E2E_BUNDLES) {
    const file = resolve(outDir, name);
    const info = await lstat(file);
    if (info.isSymbolicLink()) throw new Error(`GitHub E2E bundle must not be a symbolic link: ${name}`);
    if (!info.isFile()) throw new Error(`GitHub E2E bundle is not a regular file: ${name}`);
    const bytes = await readFile(file);
    if (bytes.byteLength === 0) throw new Error(`GitHub E2E bundle is empty: ${name}`);
    bundles.push({
      name,
      size: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }

  const manifest = {
    schemaVersion: 1,
    repositoryId,
    commitSha,
    workflowRunId,
    workflowRunAttempt: Number(attemptText),
    nodeVersion,
    bundles,
  };
  await writeFile(resolve(outDir, "github-e2e-input.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
