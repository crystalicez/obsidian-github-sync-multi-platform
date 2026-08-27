import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  compareStableTriples,
  parseStableTriple,
  readReleaseMetadata,
  validateReleaseMetadata,
} from "../../scripts/release-metadata.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const updateVersionScript = resolve(here, "../../scripts/update-version.js");

test("stable syntax preserves the repository digits.digits.digits contract", () => {
  assert.deepEqual(parseStableTriple("1.0.8"), [1n, 0n, 8n]);
  assert.deepEqual(parseStableTriple("01.0.8"), [1n, 0n, 8n]);
  assert.equal(parseStableTriple("v1.0.8"), null);
  assert.equal(parseStableTriple("1.0.8-beta.1"), null);
});

test("stable comparison is exact beyond Number.MAX_SAFE_INTEGER", () => {
  assert.equal(compareStableTriples("9007199254740993.0.0", "9007199254740992.999.999"), 1);
  assert.equal(compareStableTriples("01.0.8", "1.0.8"), 0);
});

test("metadata exposes exact committed toolchain versions", () => {
  const result = validateReleaseMetadata({
    packageJson: { version: "1.0.8", packageManager: "pnpm@9.12.3+sha512.deadbeef" },
    manifest: { id: "encrypted-github-sync-multi-platform", version: "1.0.8", minAppVersion: "1.11.4" },
    versions: { "1.0.8": "1.11.4" },
    nodeVersion: "v22.11.0",
    pnpmVersion: "9.12.3",
  });
  assert.equal(result.version, "1.0.8");
  assert.equal(result.pnpmVersion, "9.12.3");
  assert.equal(result.nodeVersion, "v22.11.0");
});

test("metadata rejects mismatches and malformed authority fields", () => {
  const base = {
    packageJson: { version: "1.0.8", packageManager: "pnpm@9.12.3" },
    manifest: { id: "plugin", version: "1.0.8", minAppVersion: "1.11.4" },
    versions: { "1.0.8": "1.11.4" },
    nodeVersion: "v22.11.0",
    pnpmVersion: "9.12.3",
  };
  assert.throws(() => validateReleaseMetadata({ ...base, manifest: { ...base.manifest, version: "1.0.9" } }), /version mismatch/i);
  assert.throws(() => validateReleaseMetadata({ ...base, versions: {} }), /versions\.json mismatch/i);
  assert.throws(() => validateReleaseMetadata({ ...base, manifest: { ...base.manifest, minAppVersion: "v1.11.4" } }), /minAppVersion/i);
  assert.throws(() => validateReleaseMetadata({ ...base, packageJson: { ...base.packageJson, packageManager: "npm@10.0.0" } }), /packageManager/i);
  assert.throws(() => validateReleaseMetadata({ ...base, manifest: { ...base.manifest, id: "" } }), /plugin id/i);
  assert.throws(() => validateReleaseMetadata({ ...base, nodeVersion: "22.11.0" }), /\.node-version/i);
  assert.throws(() => validateReleaseMetadata(base, { requestedVersion: "1.0.9" }), /requested version mismatch/i);
});

test("readReleaseMetadata trims node version and extracts pnpm version", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "release-metadata-read-"));
  await Promise.all([
    writeFile(join(cwd, "package.json"), JSON.stringify({ version: "1.0.8", packageManager: "pnpm@9.12.3+sha512.deadbeef" })),
    writeFile(join(cwd, "manifest.json"), JSON.stringify({ id: "plugin", version: "1.0.8", minAppVersion: "1.11.4" })),
    writeFile(join(cwd, "versions.json"), JSON.stringify({ "1.0.8": "1.11.4" })),
    writeFile(join(cwd, ".node-version"), "v22.11.0\n"),
  ]);
  const result = await readReleaseMetadata(cwd);
  assert.equal(result.nodeVersion, "v22.11.0");
  assert.equal(result.pnpmVersion, "9.12.3");
});

async function makeVersionWorkspace(version = "1.0.8") {
  const cwd = await mkdtemp(join(tmpdir(), "update-version-exact-"));
  await writeFile(join(cwd, "package.json"), JSON.stringify({ version }, null, 2));
  await writeFile(join(cwd, "manifest.json"), JSON.stringify({ version, minAppVersion: "1.11.4" }, null, 2));
  await writeFile(join(cwd, "versions.json"), JSON.stringify({ [version]: "1.11.4" }, null, 2));
  return cwd;
}

test("update-version accepts a target beyond Number.MAX_SAFE_INTEGER without rounding", async () => {
  const cwd = await makeVersionWorkspace();
  const target = "9007199254740993.0.0";
  const result = spawnSync(process.execPath, [updateVersionScript, target], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(JSON.parse(await readFile(join(cwd, "package.json"), "utf8")).version, target);
  assert.equal(JSON.parse(await readFile(join(cwd, "manifest.json"), "utf8")).version, target);
  assert.equal(JSON.parse(await readFile(join(cwd, "versions.json"), "utf8"))[target], "1.11.4");
});

test("update-version preserves accepted syntax and rejects non-stable forms", async () => {
  const leadingZero = await makeVersionWorkspace("01.0.8");
  const ok = spawnSync(process.execPath, [updateVersionScript, "01.0.9"], { cwd: leadingZero, encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr || ok.stdout);

  for (const target of ["v1.0.9", "1.0.9-beta.1"]) {
    const cwd = await makeVersionWorkspace();
    const result = spawnSync(process.execPath, [updateVersionScript, target], { cwd, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}\n${result.stdout}`, /invalid target version/i);
  }
});
