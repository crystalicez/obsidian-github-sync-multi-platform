import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const legacyPaths = [
  "src/lib/fs.ts",
  "src/lib/encrypted",
  "src/lib/encrypted-v3",
  "src/lib/v3",
  "src/lang",
  "src/views/settings-view.tsx",
  "tests/encrypted",
  "tests/encrypted-v3",
  "tests/v3",
  "tests/github-e2e/random-actions.ts",
  "tests/github-e2e/random-actions.test.ts",
  "docs/IMPLEMENTATION_PLAN.md",
  "docs/GITHUB_CONTENTS_API_SPEC.md",
];

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(absolute);
    return entry.isFile() && /\.(?:ts|tsx|mjs)$/u.test(entry.name) ? [absolute] : [];
  }));
  return nested.flat();
}

test("V4 is the only sync implementation left in source and tests", async () => {
  const presentLegacyPaths = legacyPaths.filter(relative => existsSync(path.join(root, relative)));
  assert.deepEqual(presentLegacyPaths, [], `Legacy paths still exist: ${presentLegacyPaths.join(", ")}`);

  const files = await sourceFiles(path.join(root, "src"));
  const legacyImports = [];
  for (const file of files) {
    const content = await readFile(file, "utf8");
    if (/from\s+["'][^"']*(?:encrypted-v3|\/encrypted|\/v3\/|\.\/fs)[^"']*["']/u.test(content)) {
      legacyImports.push(path.relative(root, file));
    }
  }
  assert.deepEqual(legacyImports, [], `Production files still import legacy modules: ${legacyImports.join(", ")}`);

  const mainSource = await readFile(path.join(root, "src/main.ts"), "utf8");
  const legacyMainSymbols = [
    "SyncSkipFiles",
    "EditorChangeTimeout",
    "syncSkipFiles",
    "syncSkipDelFiles",
    "syncSkipModifyFiles",
    "debounceTimers",
    "editorChangeTimeout",
    "ribbonIconStatus",
    "syncData",
    "updateStats",
  ].filter(symbol => mainSource.includes(symbol));
  assert.deepEqual(legacyMainSymbols, [], `Legacy main.ts state still exists: ${legacyMainSymbols.join(", ")}`);

  const helpersSource = await readFile(path.join(root, "src/lib/helps.ts"), "utf8");
  const unusedLegacyHelpers = [
    "timestampToDate",
    "stringToDate",
    "hashContent",
    "showErrorDialog",
    "calculateWordCount",
    "calculateCleanWords",
    "isHttpUrl",
    "isWsUrl",
  ].filter(symbol => helpersSource.includes(symbol));
  assert.deepEqual(unusedLegacyHelpers, [], `Unused legacy helpers still exist: ${unusedLegacyHelpers.join(", ")}`);

  const githubApiSource = await readFile(path.join(root, "src/lib/github-api.ts"), "utf8");
  const legacyPerFileApi = [
    "getFile(",
    "putFileCas(",
    "putFile(",
    "deleteFile(",
    "getRemoteHeadSha(",
    "getLatestCommit(",
    "readGitHubFileBytes(",
    "readGitHubBlobOrFileBytes(",
  ].filter(symbol => githubApiSource.includes(symbol));
  assert.deepEqual(legacyPerFileApi, [], `Legacy per-file GitHub API still exists: ${legacyPerFileApi.join(", ")}`);
});
