import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = process.cwd();

function runNode(cwd, args, env = {}) {
  return spawnSync(process.execPath, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function git(cwd, args) {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

async function readJson(cwd, file) {
  return JSON.parse(await readFile(path.join(cwd, file), "utf8"));
}

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ogs-release-meta-"));
  await mkdir(path.join(directory, "scripts"));
  await cp(path.join(root, "scripts/update-version.js"), path.join(directory, "scripts/update-version.js"));
  await cp(path.join(root, "scripts/validate-package.mjs"), path.join(directory, "scripts/validate-package.mjs"));
  await cp(path.join(root, "scripts/release-metadata.mjs"), path.join(directory, "scripts/release-metadata.mjs"));
  await writeFile(path.join(directory, "package.json"), JSON.stringify({ version: "1.2.3", packageManager: "pnpm@9.12.3" }, null, 2) + "\n");
  await writeFile(path.join(directory, "manifest.json"), JSON.stringify({ id: "fixture", version: "1.2.3", minAppVersion: "1.11.4" }, null, 2) + "\n");
  await writeFile(path.join(directory, "versions.json"), JSON.stringify({ "1.2.3": "1.11.4" }, null, 2) + "\n");
  await writeFile(path.join(directory, ".node-version"), "v22.11.0\n");
  await writeFile(path.join(directory, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await writeFile(path.join(directory, "main.js"), "fixture\n");
  await writeFile(path.join(directory, "styles.css"), "fixture\n");
  assert.equal(git(directory, ["init"]).status, 0);
  assert.equal(git(directory, ["add", "."]).status, 0);
  return directory;
}

test("version helper derives one target and updates all canonical metadata", async () => {
  const directory = await fixture();
  const result = runNode(directory, ["scripts/update-version.js", "patch"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal((await readJson(directory, "package.json")).version, "1.2.4");
  assert.equal((await readJson(directory, "manifest.json")).version, "1.2.4");
  assert.equal((await readJson(directory, "versions.json"))["1.2.4"], "1.11.4");
});

test("version helper rejects pre-existing drift before mutating files", async () => {
  const directory = await fixture();
  await writeFile(path.join(directory, "manifest.json"), JSON.stringify({ id: "fixture", version: "1.2.4", minAppVersion: "1.11.4" }, null, 2) + "\n");
  const files = ["package.json", "manifest.json", "versions.json"];
  const before = await Promise.all(files.map(file => readFile(path.join(directory, file), "utf8")));
  const result = runNode(directory, ["scripts/update-version.js", "patch"]);
  assert.notEqual(result.status, 0);
  const after = await Promise.all(files.map(file => readFile(path.join(directory, file), "utf8")));
  assert.deepEqual(after, before);
});

test("version helper rejects malformed non-increasing duplicate and implicit targets", async () => {
  for (const target of ["1.2", "1.2.3"]) {
    const directory = await fixture();
    assert.notEqual(runNode(directory, ["scripts/update-version.js", target]).status, 0);
  }

  const duplicateDirectory = await fixture();
  const versions = await readJson(duplicateDirectory, "versions.json");
  versions["1.2.4"] = "1.11.4";
  await writeFile(path.join(duplicateDirectory, "versions.json"), JSON.stringify(versions, null, 2) + "\n");
  assert.notEqual(runNode(duplicateDirectory, ["scripts/update-version.js", "1.2.4"]).status, 0);

  const implicitDirectory = await fixture();
  assert.notEqual(runNode(implicitDirectory, ["scripts/update-version.js"], { NEW_VERSION: "", npm_package_version: "" }).status, 0);
});

test("validator rejects compatibility metadata drift", async () => {
  const directory = await fixture();
  await writeFile(path.join(directory, "versions.json"), JSON.stringify({ "1.2.3": "1.6.5" }, null, 2) + "\n");
  assert.notEqual(runNode(directory, ["scripts/validate-package.mjs"]).status, 0);
});

test("validator rejects tracked alternate lockfiles", async () => {
  for (const lockfile of ["package-lock.json", "yarn.lock"]) {
    const directory = await fixture();
    await writeFile(path.join(directory, lockfile), "{}\n");
    assert.equal(git(directory, ["add", lockfile]).status, 0);
    assert.notEqual(runNode(directory, ["scripts/validate-package.mjs"]).status, 0);
  }
});

test("validator accepts canonical pnpm metadata after release artifacts exist", async () => {
  const directory = await fixture();
  const result = runNode(directory, ["scripts/validate-package.mjs"]);
  assert.equal(result.status, 0, result.stderr);
});
