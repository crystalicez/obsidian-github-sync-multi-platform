import { createHash } from "node:crypto";
import { readFile, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { zipSync } from "fflate";
import { readCommittedBlob } from "./local-release-git.mjs";
import { runCommand } from "./local-release-lib.mjs";
import { parseStableTriple } from "./release-metadata.mjs";

export const RELEASE_ARCHIVE_ROOT = "obsidian-github-sync-multi-platform";
export const RELEASE_FILES = Object.freeze(["main.js", "manifest.json", "styles.css"]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function requireNonEmptyFile(path, label) {
  const info = await stat(path);
  if (!info.isFile() || info.size === 0) throw new Error(`${label} must be a non-empty file`);
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

  const releaseRoot = resolve(cwd, ".tmp", "release");
  const stagingDir = resolve(releaseRoot, version);
  requireContainedPath(releaseRoot, stagingDir);
  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(stagingDir, { recursive: true });

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

  const fixed = Object.freeze({
    level: 9,
    mtime: new Date(1980, 0, 1, 0, 0, 0),
    os: 0,
    attrs: 0,
  });
  const archive = Object.create(null);
  for (const name of RELEASE_FILES) {
    archive[`${RELEASE_ARCHIVE_ROOT}/${name}`] = [stagedBytes.get(name), fixed];
  }
  const zipBytes = Buffer.from(zipSync(archive, fixed));
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
