#!/usr/bin/env node
// Real 100 MB Windows filesystem I/O check, NOT an Obsidian/GitHub sync result.
// All created files live in a freshly created, ignored repository .tmp directory.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, mkdtemp, open, stat, writeFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BYTES = 100_000_000;
const BLOCK_BYTES = 8 * 1024 * 1024;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = path.join(root, ".tmp");
await mkdir(tmp, { recursive: true });
const tmpStat = await lstat(tmp);
assert.ok(tmpStat.isDirectory() && !tmpStat.isSymbolicLink(), "Refuse linked .tmp directory");
const runDir = await mkdtemp(path.join(tmp, "windows-100mb-"));
const source = path.join(runDir, "qualification-100mb.bin");
const copied = path.join(runDir, "staged-copy-100mb.bin");
const report = path.join(runDir, "report.json");
const block = Buffer.allocUnsafe(BLOCK_BYTES);
for (let i = 0; i < block.length; i++) block[i] = (i * 31 + 17) & 255;

const started = performance.now();
const fh = await open(source, "wx");
try {
  for (let offset = 0; offset < BYTES;) {
    const wanted = Math.min(BLOCK_BYTES, BYTES - offset);
    const { bytesWritten } = await fh.write(block, 0, wanted, offset);
    assert.ok(bytesWritten > 0 && bytesWritten <= wanted, "Expected positive bounded write");
    offset += bytesWritten;
  }
} finally {
  await fh.close();
}
assert.equal((await stat(source)).size, BYTES, "Source file size");

const hash = async file => {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file, { highWaterMark: BLOCK_BYTES })) digest.update(chunk);
  return digest.digest("hex");
};
const sourceHash = await hash(source);
await pipeline(createReadStream(source, { highWaterMark: BLOCK_BYTES }),
  createWriteStream(copied, { flags: "wx", highWaterMark: BLOCK_BYTES }));
assert.equal((await stat(copied)).size, BYTES, "Staged copy file size");
const copiedHash = await hash(copied);
assert.equal(copiedHash, sourceHash, "Source and staged copy SHA-256 must match");
const evidence = {
  kind: "physical-windows-filesystem-only",
  sourceCommit: process.env.QUALIFICATION_SOURCE_SHA || null,
  logicalBytes: BYTES,
  source, copied,
  sourceSha256: sourceHash, copiedSha256: copiedHash,
  elapsedMs: Math.round(performance.now() - started),
  processRssBytesAtEnd: process.memoryUsage().rss,
  gitHubSyncVerified: false,
  obsidianSyncVerified: false,
};
await writeFile(report, JSON.stringify(evidence, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify({ status: "PASS", logicalBytes: BYTES, sha256: sourceHash,
  elapsedMs: evidence.elapsedMs, report, githubSync: "NOT_TESTED" }));
