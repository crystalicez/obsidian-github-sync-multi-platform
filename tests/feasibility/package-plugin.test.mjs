import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { crc32 } from "../../scripts/deterministic-zip.mjs";
import { packagePlugin, RELEASE_ARCHIVE_ROOT } from "../../scripts/package-plugin.mjs";

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "package-plugin-"));
  git(cwd, ["init", "-q", "-b", "master"]);
  git(cwd, ["config", "user.name", "Test"]);
  git(cwd, ["config", "user.email", "test@example.invalid"]);
  const committedManifest = Buffer.from('{\n  "id": "plugin",\n  "version": "1.0.8"\n}\n');
  const committedStyles = Buffer.from("body {\n  color: red;\n}\n");
  await writeFile(join(cwd, "manifest.json"), committedManifest);
  await writeFile(join(cwd, "styles.css"), committedStyles);
  await writeFile(join(cwd, "marker.txt"), "must-not-enter-zip\n");
  git(cwd, ["add", "."]);
  git(cwd, ["commit", "-qm", "fixture"]);

  const transformedManifest = Buffer.from(committedManifest.toString("utf8").replaceAll("\n", "\r\n"));
  const transformedStyles = Buffer.from(committedStyles.toString("utf8").replaceAll("\n", "\r\n"));
  await writeFile(join(cwd, "manifest.json"), transformedManifest);
  await writeFile(join(cwd, "styles.css"), transformedStyles);
  const mainBytes = Buffer.from("console.log('built-current-main');\n");
  await writeFile(join(cwd, "main.js"), mainBytes);
  return { cwd, committedManifest, committedStyles, transformedManifest, transformedStyles, mainBytes };
}

function asset(result, name) {
  const value = result.assets.find(item => item.name === name);
  assert.ok(value, `missing asset ${name}`);
  return value;
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function readStoredZipEntries(zip) {
  const endOffset = zip.length - 22;
  assert.equal(zip.readUInt32LE(endOffset), 0x06054b50);
  const count = zip.readUInt16LE(endOffset + 10);
  let cursor = zip.readUInt32LE(endOffset + 16);
  const entries = Object.create(null);
  for (let index = 0; index < count; index += 1) {
    assert.equal(zip.readUInt32LE(cursor), 0x02014b50);
    assert.equal(zip.readUInt16LE(cursor + 10), 0);
    const expectedCrc = zip.readUInt32LE(cursor + 16);
    const size = zip.readUInt32LE(cursor + 24);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const extraLength = zip.readUInt16LE(cursor + 30);
    const commentLength = zip.readUInt16LE(cursor + 32);
    const localOffset = zip.readUInt32LE(cursor + 42);
    const name = zip.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    assert.equal(zip.readUInt32LE(localOffset), 0x04034b50);
    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const localExtraLength = zip.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const data = Buffer.from(zip.subarray(dataStart, dataStart + size));
    assert.equal(crc32(data), expectedCrc);
    entries[name] = data;
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

test("stages tracked static assets from exact HEAD blobs and main.js from current build output", async () => {
  const f = await fixture();
  const result = await packagePlugin({ cwd: f.cwd, version: "1.0.8" });
  assert.deepEqual(await readFile(asset(result, "manifest.json").path), f.committedManifest);
  assert.deepEqual(await readFile(asset(result, "styles.css").path), f.committedStyles);
  assert.deepEqual(await readFile(asset(result, "main.js").path), f.mainBytes);
  assert.notDeepEqual(await readFile(asset(result, "manifest.json").path), f.transformedManifest);
  assert.notDeepEqual(await readFile(asset(result, "styles.css").path), f.transformedStyles);
});

test("ZIP and upload asset contract is exact", async () => {
  const f = await fixture();
  const result = await packagePlugin({ cwd: f.cwd, version: "1.0.8" });
  const zipName = `${RELEASE_ARCHIVE_ROOT}-v1.0.8.zip`;
  assert.deepEqual(result.assets.map(item => item.name), ["main.js", "manifest.json", "styles.css", zipName]);
  assert.equal(resolve(result.stagingDir), resolve(f.cwd, ".tmp", "release", "1.0.8"));
  const entries = readStoredZipEntries(await readFile(result.zipPath));
  assert.deepEqual(Object.keys(entries), [
    `${RELEASE_ARCHIVE_ROOT}/main.js`,
    `${RELEASE_ARCHIVE_ROOT}/manifest.json`,
    `${RELEASE_ARCHIVE_ROOT}/styles.css`,
  ]);
  assert.deepEqual(entries[`${RELEASE_ARCHIVE_ROOT}/main.js`], f.mainBytes);
  assert.deepEqual(entries[`${RELEASE_ARCHIVE_ROOT}/manifest.json`], f.committedManifest);
  assert.deepEqual(entries[`${RELEASE_ARCHIVE_ROOT}/styles.css`], f.committedStyles);
  assert.equal(Object.hasOwn(entries, `${RELEASE_ARCHIVE_ROOT}/marker.txt`), false);
  for (const item of result.assets) {
    const bytes = await readFile(item.path);
    assert.equal(item.size, bytes.length);
    assert.equal(item.sha256, digest(bytes));
    assert.match(item.sha256, /^[0-9a-f]{64}$/u);
  }
});

test("repeated packaging is byte-identical across time zones", async () => {
  const f = await fixture();
  const modulePath = resolve("scripts/package-plugin.mjs");
  const code = `import { createHash } from 'node:crypto'; import { readFile } from 'node:fs/promises'; import { packagePlugin } from ${JSON.stringify(`file://${modulePath}`)}; const r=await packagePlugin({cwd:${JSON.stringify(f.cwd)},version:'1.0.8'}); console.log(createHash('sha256').update(await readFile(r.zipPath)).digest('hex'));`;
  const hashes = [];
  for (const TZ of ["UTC", "Asia/Bangkok"]) {
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
      cwd: resolve("."),
      encoding: "utf8",
      env: { ...process.env, TZ },
    });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    hashes.push(run.stdout.trim());
  }
  assert.equal(hashes[0], hashes[1]);
});

test("rejects invalid versions before deriving a staging target", async () => {
  const f = await fixture();
  await assert.rejects(() => packagePlugin({ cwd: f.cwd, version: "../escape" }), /version/i);
});
