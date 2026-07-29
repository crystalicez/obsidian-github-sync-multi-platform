import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { collectV4ContentSource } from "../../src/lib/v4/content-source";
import {
  createV4PlatformIo,
  V4BoundedIoUnavailableError,
} from "../../src/lib/v4/platform-io";

test("desktop platform IO reads a generated file in bounded chunks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v4-platform-"));
  const filePath = path.join(root, "large.bin");
  const data = Uint8Array.from({ length: 1024 * 1024 + 19 }, (_, index) => index & 0xff);
  await writeFile(filePath, data);

  const io = createV4PlatformIo({ platform: "desktop", resolveDesktopPath: value => value });
  assert.equal(io.capabilities.boundedRead, true);
  const source = await io.openBoundedSource(filePath, data.byteLength);
  let largest = 0;
  const chunks: Uint8Array[] = [];
  for await (const chunk of source.chunks(64 * 1024)) { largest = Math.max(largest, chunk.byteLength); chunks.push(chunk); }
  assert.ok(largest <= 64 * 1024);
  assert.deepEqual(await collectV4ContentSource({ size: data.byteLength, async *chunks() { yield* chunks; } }, data.byteLength), data);
});

test("mobile without a proven bounded read path capability-fails instead of calling whole-buffer APIs", async () => {
  let wholeReadCalls = 0;
  const io = createV4PlatformIo({
    platform: "mobile",
    adapter: {
      async readBinary() { wholeReadCalls++; return new ArrayBuffer(1024); },
      async writeBinary() {},
    },
  });
  assert.equal(io.capabilities.boundedRead, false);
  await assert.rejects(io.openBoundedSource("large.bin", 1024), error => error instanceof V4BoundedIoUnavailableError);
  assert.equal(wholeReadCalls, 0);
});

test("mobile bounded append is feature-detected and never assumed by the declared minimum", async () => {
  const events: string[] = [];
  const io = createV4PlatformIo({
    platform: "mobile",
    adapter: {
      async writeBinary(path, data) { events.push(`write:${path}:${data.byteLength}`); },
      async appendBinary(path, data) { events.push(`append:${path}:${data.byteLength}`); },
    },
  });
  assert.equal(io.capabilities.boundedAppend, true);
  assert.equal(io.capabilities.requiresObsidian1123ForAppend, true);
  await io.writeStage("stage.bin", new Uint8Array([1, 2]));
  await io.appendStage("stage.bin", new Uint8Array([3]));
  assert.deepEqual(events, ["write:stage.bin:2", "append:stage.bin:1"]);
});

test("mobile without appendBinary rejects bounded append", async () => {
  const io = createV4PlatformIo({
    platform: "mobile",
    adapter: { async writeBinary() {} },
  });
  assert.equal(io.capabilities.boundedAppend, false);
  await assert.rejects(io.appendStage("stage.bin", new Uint8Array([1])), error => error instanceof V4BoundedIoUnavailableError);
});


test("desktop dynamic Node IO is externalized and mobile minimum stays feature-gated", async () => {
  const buildConfig = await readFile(path.join(process.cwd(), "esbuild.config.mjs"), "utf8");
  const manifest = JSON.parse(await readFile(path.join(process.cwd(), "manifest.json"), "utf8")) as { minAppVersion: string };
  assert.match(buildConfig, /"node:\*"/u);
  assert.equal(manifest.minAppVersion, "1.11.4");

  const io = createV4PlatformIo({ platform: "mobile", adapter: { async writeBinary() {} } });
  assert.equal(io.capabilities.requiresObsidian1123ForAppend, false);
  assert.equal(io.capabilities.boundedAppend, false);
});

test("desktop stage commit swaps through backup and verifies the final target", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v4-stage-commit-"));
  const stagePath = path.join(root, "stage.bin");
  const targetPath = path.join(root, "target.bin");
  await writeFile(stagePath, new Uint8Array([9, 8, 7, 6]));
  await writeFile(targetPath, new Uint8Array([1, 2, 3]));
  const io = createV4PlatformIo({ platform: "desktop", resolveDesktopPath: value => value });
  await io.commitStage(stagePath, targetPath, {
    expectedTarget: { exists: true, size: 3 },
    expectedStageSize: 4,
    expectedStageSha256: "63d987d1c6d69751c17297f410f5b3547a65d096a8993b35bcb4f9cad054f176",
  });
  assert.deepEqual(new Uint8Array(await readFile(targetPath)), new Uint8Array([9, 8, 7, 6]));
  await assert.rejects(readFile(stagePath));
});
