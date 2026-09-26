import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { collectV4ContentSource } from "../../src/lib/v4/content-source";
import {
  createV4PlatformIo,
  V4BoundedIoUnavailableError,
} from "../../src/lib/v4/platform-io";

function desktopIo(root: string) {
  return createV4PlatformIo({
    platform: "desktop",
    resolveDesktopPath: value => value,
    desktopRootPath: root,
  });
}

test("desktop platform IO reads a generated file in bounded chunks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v4-platform-"));
  const filePath = path.join(root, "large.bin");
  const data = Uint8Array.from({ length: 1024 * 1024 + 19 }, (_, index) => index & 0xff);
  await writeFile(filePath, data);

  const io = desktopIo(root);
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
  const io = desktopIo(root);
  await io.commitStage(stagePath, targetPath, {
    expectedTarget: { exists: true, size: 3 },
    expectedStageSize: 4,
    expectedStageSha256: "63d987d1c6d69751c17297f410f5b3547a65d096a8993b35bcb4f9cad054f176",
  });
  assert.deepEqual(new Uint8Array(await readFile(targetPath)), new Uint8Array([9, 8, 7, 6]));
  await assert.rejects(readFile(stagePath));
});


test("desktop stage commit resumes after a crash between target backup and staged rename", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v4-stage-resume-"));
  const stagePath = path.join(root, "stage.bin");
  const targetPath = path.join(root, "target.bin");
  const backupPath = `${stagePath}.target-backup`;
  await writeFile(stagePath, new Uint8Array([9, 8, 7, 6]));
  await writeFile(backupPath, new Uint8Array([1, 2, 3]));

  const io = desktopIo(root);
  await io.commitStage(stagePath, targetPath, {
    expectedTarget: { exists: true, size: 3 },
    expectedStageSize: 4,
    expectedStageSha256: "63d987d1c6d69751c17297f410f5b3547a65d096a8993b35bcb4f9cad054f176",
  });

  assert.deepEqual(new Uint8Array(await readFile(targetPath)), new Uint8Array([9, 8, 7, 6]));
  await assert.rejects(readFile(stagePath));
  await assert.rejects(readFile(backupPath));
});

test("desktop stage cleanup removes an orphaned target backup after the staged file already became the target", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v4-stage-cleanup-"));
  const stagePath = path.join(root, "stage.bin");
  const targetPath = path.join(root, "target.bin");
  const backupPath = `${stagePath}.target-backup`;
  await writeFile(targetPath, new Uint8Array([9, 8, 7, 6]));
  await writeFile(backupPath, new Uint8Array([1, 2, 3]));

  const io = desktopIo(root);
  await io.removeStage(stagePath);

  assert.deepEqual(new Uint8Array(await readFile(targetPath)), new Uint8Array([9, 8, 7, 6]));
  await assert.rejects(readFile(backupPath));
});


test("desktop stage rollback restores the original target from a backup-only crash state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v4-stage-rollback-missing-"));
  const stagePath = path.join(root, "stage.bin");
  const targetPath = path.join(root, "target.bin");
  const backupPath = `${stagePath}.target-backup`;
  await writeFile(stagePath, new Uint8Array([9, 8, 7, 6]));
  await writeFile(backupPath, new Uint8Array([1, 2, 3]));

  const io = desktopIo(root);
  await io.rollbackStage(stagePath, targetPath, {
    expectedTarget: { exists: true, size: 3 },
    expectedStageSize: 4,
    expectedStageSha256: "63d987d1c6d69751c17297f410f5b3547a65d096a8993b35bcb4f9cad054f176",
  });

  assert.deepEqual(new Uint8Array(await readFile(targetPath)), new Uint8Array([1, 2, 3]));
  await assert.rejects(readFile(backupPath));
  assert.deepEqual(new Uint8Array(await readFile(stagePath)), new Uint8Array([9, 8, 7, 6]));
});

test("desktop stage rollback restores the original target when staged bytes reached target but receipt did not", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v4-stage-rollback-moved-"));
  const stagePath = path.join(root, "stage.bin");
  const targetPath = path.join(root, "target.bin");
  const backupPath = `${stagePath}.target-backup`;
  await writeFile(targetPath, new Uint8Array([9, 8, 7, 6]));
  await writeFile(backupPath, new Uint8Array([1, 2, 3]));

  const io = desktopIo(root);
  await io.rollbackStage(stagePath, targetPath, {
    expectedTarget: { exists: true, size: 3 },
    expectedStageSize: 4,
    expectedStageSha256: "63d987d1c6d69751c17297f410f5b3547a65d096a8993b35bcb4f9cad054f176",
  });

  assert.deepEqual(new Uint8Array(await readFile(targetPath)), new Uint8Array([1, 2, 3]));
  await assert.rejects(readFile(backupPath));
});

test("desktop stage rollback refuses to overwrite an unrelated target edit and preserves the backup", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v4-stage-rollback-changed-"));
  const stagePath = path.join(root, "stage.bin");
  const targetPath = path.join(root, "target.bin");
  const backupPath = `${stagePath}.target-backup`;
  await writeFile(targetPath, new Uint8Array([4, 4, 4, 4, 4]));
  await writeFile(backupPath, new Uint8Array([1, 2, 3]));

  const io = desktopIo(root);
  await assert.rejects(
    io.rollbackStage(stagePath, targetPath, {
      expectedTarget: { exists: true, size: 3 },
      expectedStageSize: 4,
      expectedStageSha256: "63d987d1c6d69751c17297f410f5b3547a65d096a8993b35bcb4f9cad054f176",
    }),
    /target changed|rollback.*unsafe/iu,
  );

  assert.deepEqual(new Uint8Array(await readFile(targetPath)), new Uint8Array([4, 4, 4, 4, 4]));
  assert.deepEqual(new Uint8Array(await readFile(backupPath)), new Uint8Array([1, 2, 3]));
});


test("mobile staged rollback is a no-op because mobile never creates desktop target backups", async () => {
  const io = createV4PlatformIo({
    platform: "mobile",
    adapter: { async writeBinary() {}, async appendBinary() {} },
  });

  await assert.doesNotReject(() => io.rollbackStage("stage.bin", "target.bin", {
    expectedTarget: { exists: true, size: 3 },
    expectedStageSize: 4,
    expectedStageSha256: "f".repeat(64),
  }));
});


async function createExternalDirectoryLink(t: { skip(message?: string): void }, root: string, outside: string): Promise<string | null> {
  const link = path.join(root, "linked-outside");
  try {
    await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOSYS"].includes((error as { code?: string }).code ?? "")) {
      t.skip(`directory link creation unavailable: ${(error as { code?: string }).code}`);
      return null;
    }
    throw error;
  }
  return link;
}

test("desktop bounded reads reject a vault directory link that escapes the vault root", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v4-vault-root-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "v4-vault-outside-"));
  try {
    await writeFile(path.join(outside, "secret.bin"), new Uint8Array([7, 7, 7]));
    const link = await createExternalDirectoryLink(t, root, outside);
    if (!link) return;

    const io = createV4PlatformIo({
      platform: "desktop",
      resolveDesktopPath: value => path.join(root, value),
      desktopRootPath: root,
    });

    const source = await io.openBoundedSource("linked-outside/secret.bin", 3);
    await assert.rejects(
      () => collectV4ContentSource(source, 3),
      /symlink|junction|vault root|outside|unsafe/iu,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("desktop staged commit refuses a target beneath a vault directory link", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v4-stage-vault-root-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "v4-stage-vault-outside-"));
  try {
    await mkdir(path.join(root, ".obsidian"), { recursive: true });
    const stagePath = path.join(root, ".obsidian", "stage.bin");
    await writeFile(stagePath, new Uint8Array([9, 8, 7, 6]));
    await writeFile(path.join(outside, "target.bin"), new Uint8Array([1, 2, 3]));
    const link = await createExternalDirectoryLink(t, root, outside);
    if (!link) return;

    const io = createV4PlatformIo({
      platform: "desktop",
      resolveDesktopPath: value => path.join(root, value),
      desktopRootPath: root,
    });

    await assert.rejects(
      () => io.commitStage(".obsidian/stage.bin", "linked-outside/target.bin", {
        expectedTarget: { exists: true, size: 3 },
        expectedStageSize: 4,
        expectedStageSha256: "63d987d1c6d69751c17297f410f5b3547a65d096a8993b35bcb4f9cad054f176",
      }),
      /symlink|junction|vault root|outside|unsafe/iu,
    );
    assert.deepEqual(new Uint8Array(await readFile(path.join(outside, "target.bin"))), new Uint8Array([1, 2, 3]));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});


test("desktop Node IO capability-fails when the vault root cannot be proven", async () => {
  const io = createV4PlatformIo({
    platform: "desktop",
    resolveDesktopPath: value => value,
  });
  assert.equal(io.capabilities.boundedRead, false);
  await assert.rejects(
    () => io.assertVaultPathSafe("note.md"),
    error => error instanceof V4BoundedIoUnavailableError,
  );
});
