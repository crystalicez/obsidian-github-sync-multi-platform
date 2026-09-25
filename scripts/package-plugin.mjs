import { createHash } from "node:crypto";
import { readFile, lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { createStoredZip } from "./deterministic-zip.mjs";
import { readCommittedBlob } from "./local-release-git.mjs";
import { runCommand } from "./local-release-lib.mjs";
import { parseStableTriple } from "./release-metadata.mjs";

export const RELEASE_ARCHIVE_ROOT = "obsidian-github-sync-multi-platform";
export const RELEASE_FILES = Object.freeze(["main.js", "manifest.json", "styles.css"]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function lstatOrNull(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function requireRealDirectory(path, label) {
  const info = await lstatOrNull(path);
  if (!info) {
    await mkdir(path);
    const created = await lstat(path);
    if (!created.isDirectory() || created.isSymbolicLink()) throw new Error(`${label} must be a real directory`);
    return;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} must be a real directory`);
}

async function requireNonEmptyFile(path, label) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size === 0) throw new Error(`${label} must be a non-empty regular file`);
  return readFile(path);
}

function requireContainedPath(parent, child) {
  const normalizedParent = resolve(parent);
  const normalizedChild = resolve(child);
  if (normalizedChild !== normalizedParent && !normalizedChild.startsWith(`${normalizedParent}${sep}`)) {
    throw new Error("Release staging path escaped the release temp root");
  }
}

export async function packagePlugin({ cwd = process.cwd(), version, runner = runCommand } = {}) {
  if (!parseStableTriple(version)) throw new Error(`Release version must be x.y.z: ${version}`);

  const tempRoot = resolve(cwd, ".tmp");
  const releaseRoot = resolve(tempRoot, "release");
  const stagingDir = resolve(releaseRoot, version);
  requireContainedPath(releaseRoot, stagingDir);
  await requireRealDirectory(tempRoot, "Repository temp root");
  await requireRealDirectory(releaseRoot, "Release temp root");
  const existingStage = await lstatOrNull(stagingDir);
  if (existingStage?.isSymbolicLink()) throw new Error("Release staging directory must not be a symbolic link");
  if (existingStage && !existingStage.isDirectory()) throw new Error("Release staging path must be a directory");
  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(stagingDir);
  const stageInfo = await lstat(stagingDir);
  if (!stageInfo.isDirectory() || stageInfo.isSymbolicLink()) throw new Error("Release staging directory must be a real directory");

  const stagedBytes = new Map();
  const mainBytes = await requireNonEmptyFile(join(cwd, "main.js"), "main.js build output");
  stagedBytes.set("main.js", mainBytes);

  for (const name of ["manifest.json", "styles.css"]) {
    const bytes = readCommittedBlob({ runner, cwd, path: name, rev: "HEAD" });
    if (bytes.length === 0) throw new Error(`Committed release asset is empty: ${name}`);
    stagedBytes.set(name, bytes);
  }

  for (const name of RELEASE_FILES) {
    await writeFile(join(stagingDir, name), stagedBytes.get(name));
  }

  const zipBytes = createStoredZip(RELEASE_FILES.map(name => ({
    name: `${RELEASE_ARCHIVE_ROOT}/${name}`,
    bytes: stagedBytes.get(name),
  })));
  if (zipBytes.length === 0) throw new Error("Plugin ZIP is empty");

  const zipName = `${RELEASE_ARCHIVE_ROOT}-v${version}.zip`;
  const zipPath = join(stagingDir, zipName);
  await writeFile(zipPath, zipBytes);

  const assets = [];
  for (const name of [...RELEASE_FILES, zipName]) {
    const path = join(stagingDir, name);
    const bytes = await requireNonEmptyFile(path, `Staged release asset ${name}`);
    assets.push({ name, path, size: bytes.length, sha256: sha256(bytes) });
  }

  return { stagingDir, zipPath, assets };
}
