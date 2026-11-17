import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";

// Deliberate allowlist: no credentials, Git internals, node_modules, .tmp,
// or developer handoff files. Includes docs because Fast tests check old
// documentation paths and read release metadata. Includes the built main.js
// because a Fast test reads that artifact directly.
export const OFFLINE_FAST_SOURCE_DIRS = Object.freeze(["src", "scripts", "tests", "docs"]);
export const OFFLINE_FAST_ROOT_FILES = Object.freeze([
  ".node-version",
  "esbuild.config.mjs",
  "main.js",
  "manifest.json",
  "package.json",
  "pnpm-lock.yaml",
  "styles.css",
  "tsconfig.json",
  "tsconfig.maximum-strict.json",
  "tsconfig.github-e2e-strict.json",
  "versions.json",
]);

function normalizedRelativeFilePath(value) {
  return value.split(path.sep).join("/");
}

/**
 * Content-based, fail-closed evidence of the *working-tree* inputs to Fast.
 *
 * Includes all files under src/scripts/tests/docs, not just selected test
 * cases, so additions, removals and changes to imported inputs invalidate
 * the qualification. No disk writes; only explicitly selected root files.
 * A sampled fingerprint is not an OS-wide lock or a proof against an edit
 * that is reverted entirely between checks.
 */
export async function snapshotOfflineFastSource({
  root,
  sourceDirs = OFFLINE_FAST_SOURCE_DIRS,
  rootFiles = OFFLINE_FAST_ROOT_FILES,
} = {}) {
  if (typeof root !== "string" || !path.isAbsolute(root)) {
    throw new TypeError("Offline Fast source root must be an absolute path.");
  }
  if (!Array.isArray(sourceDirs) || !Array.isArray(rootFiles)
    || sourceDirs.length === 0 || rootFiles.length === 0) {
    throw new TypeError("Offline Fast source inventory must be non-empty.");
  }
  const names = new Set();
  const digest = createHash("sha256");
  // Paths and per-file digests only: forensic mismatch diagnostics must never
  // include plaintext source bytes, private test values or credentials.
  const pathStates = Object.create(null);
  let fileCount = 0;

  async function fingerprintFile(relativePath) {
    const normalized = normalizedRelativeFilePath(relativePath);
    if (names.has(normalized)) throw new Error("Duplicate Offline Fast source path.");
    names.add(normalized);
    const absolute = path.join(root, relativePath);
    const stat = await lstat(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("Unsafe nonregular Offline Fast source path.");
    }
    const contents = await readFile(absolute);
    pathStates[normalized] = "file:" + createHash("sha256").update(contents).digest("hex");
    digest.update("file\0");
    digest.update(normalized, "utf8");
    digest.update("\0");
    digest.update(String(contents.length), "utf8");
    digest.update("\0");
    digest.update(contents);
    digest.update("\0");
    fileCount += 1;
  }

  async function fingerprintDirectory(relativeDir) {
    const stat = await lstat(path.join(root, relativeDir));
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("Unsafe Offline Fast source directory.");
    }
    const normalized = normalizedRelativeFilePath(relativeDir);
    if (names.has(normalized)) throw new Error("Duplicate Offline Fast source path.");
    names.add(normalized);
    pathStates[normalized] = "directory";
    // Empty folders affect legacy-path existence checks, even without files.
    digest.update("directory\0");
    digest.update(normalized, "utf8");
    digest.update("\0");
    const entries = await readdir(path.join(root, relativeDir), { withFileTypes: true });
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const child = path.join(relativeDir, entry.name);
      if (entry.isDirectory()) {
        await fingerprintDirectory(child);
      } else if (entry.isFile()) {
        await fingerprintFile(child);
      } else {
        throw new Error("Unsafe Offline Fast source entry.");
      }
    }
  }

  const selected = [...sourceDirs, ...rootFiles];
  if (new Set(selected).size !== selected.length
    || selected.some(item => typeof item !== "string" || !item
      || path.isAbsolute(item) || item.split(/[\\/]/u).includes(".."))) {
    throw new Error("Invalid Offline Fast source inventory.");
  }
  for (const dir of sourceDirs) await fingerprintDirectory(dir);
  for (const file of rootFiles) await fingerprintFile(file);
  if (fileCount === 0) throw new Error("Empty Offline Fast source inventory.");
  return Object.freeze({ digest: digest.digest("hex"), fileCount,
    pathStates: Object.freeze(pathStates) });
}

export async function requireOfflineFastSourceUnchanged(options, baseline) {
  if (typeof baseline?.digest !== "string" || !/^[0-9a-f]{64}$/u.test(baseline.digest)
    || !Number.isSafeInteger(baseline.fileCount)) {
    throw new Error("Invalid Offline Fast source baseline.");
  }
  const current = await snapshotOfflineFastSource(options);
  if (current.digest !== baseline.digest || current.fileCount !== baseline.fileCount) {
    // Preserve the strict source-integrity gate. Diagnostic output includes
    // only a bounded list of relative path names, never file bytes or hashes.
    const previousPaths = baseline.pathStates;
    const currentPaths = current.pathStates;
    const changedPaths = [];
    if (previousPaths && currentPaths) {
      for (const relative of new Set([...Object.keys(previousPaths), ...Object.keys(currentPaths)])) {
        if (previousPaths[relative] !== currentPaths[relative]) changedPaths.push(relative);
      }
    }
    changedPaths.sort();
    const details = changedPaths.length
      ? " Changed source paths: " + changedPaths.slice(0, 8).map(p => JSON.stringify(p)).join(", ")
        + (changedPaths.length > 8 ? " (and more)" : "") + "."
      : "";
    throw new Error("Offline Fast source changed during qualification; results are NOT qualified." + details);
  }
  return current;
}

/** Enforces both sides of each actual test invocation. */
export async function withUnchangedOfflineFastSource(options, baseline, runTask) {
  await requireOfflineFastSourceUnchanged(options, baseline);
  const result = await runTask();
  await requireOfflineFastSourceUnchanged(options, baseline);
  return result;
}
