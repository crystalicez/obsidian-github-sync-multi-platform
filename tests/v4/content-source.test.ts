import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  collectV4ContentSource,
  createV4ContentSource,
  type V4ContentHandle,
  type V4ContentSource,
} from "../../src/lib/v4/content-source";
import { V4BoundedIoUnavailableError } from "../../src/lib/v4/platform-io";

const bytes = (size: number) => Uint8Array.from({ length: size }, (_, index) => index & 0xff);

async function* boundedChunks(data: Uint8Array, chunkBytes: number): AsyncIterable<Uint8Array> {
  for (let offset = 0; offset < data.byteLength; offset += chunkBytes) yield data.slice(offset, offset + chunkBytes);
}

test("planner stays metadata-only and cannot import execution content or staging modules", async () => {
  const source = await readFile(path.join(process.cwd(), "src/lib/v4/planner.ts"), "utf8");
  assert.doesNotMatch(source, /content-source|staging-store|platform-io|local-io|runtime/u);
});

test("small vault content uses the compatibility whole-buffer reader below the safe ceiling", async () => {
  const data = bytes(10);
  const handle: V4ContentHandle = { kind: "vault", path: "a.bin", expectedHash: "hash", expectedSize: 10, expectedMtime: 7 };
  let wholeReads = 0;
  const source = await createV4ContentSource(handle, {
    wholeBufferCeilingBytes: 16,
    readVaultWhole: async () => { wholeReads++; return data; },
    openVaultBounded: async () => { throw new Error("bounded path must not run"); },
    openStage: async () => { throw new Error("stage path must not run"); },
  });
  assert.equal(wholeReads, 1);
  assert.deepEqual(await collectV4ContentSource(source, 16), data);
});

test("large vault content uses bounded source and never silently falls back to whole-buffer reads", async () => {
  const data = bytes(33);
  const handle: V4ContentHandle = { kind: "vault", path: "large.bin", expectedHash: "hash", expectedSize: data.byteLength, expectedMtime: 8 };
  let wholeReads = 0;
  let boundedOpens = 0;
  const source = await createV4ContentSource(handle, {
    wholeBufferCeilingBytes: 16,
    readVaultWhole: async () => { wholeReads++; return data; },
    openVaultBounded: async (_path, expectedSize): Promise<V4ContentSource> => {
      boundedOpens++;
      assert.equal(expectedSize, data.byteLength);
      return { size: data.byteLength, chunks: chunkBytes => boundedChunks(data, chunkBytes) };
    },
    openStage: async () => { throw new Error("stage path must not run"); },
  });
  assert.equal(wholeReads, 0);
  assert.equal(boundedOpens, 1);
  assert.deepEqual(await collectV4ContentSource(source, 64), data);
});

test("large vault content capability-fails when bounded read is unavailable", async () => {
  const handle: V4ContentHandle = { kind: "vault", path: "large.bin", expectedHash: "hash", expectedSize: 33, expectedMtime: 8 };
  await assert.rejects(
    createV4ContentSource(handle, {
      wholeBufferCeilingBytes: 16,
      readVaultWhole: async () => bytes(33),
      openVaultBounded: undefined,
      openStage: async () => { throw new Error("stage path must not run"); },
    }),
    error => error instanceof V4BoundedIoUnavailableError,
  );
});

test("stage handles are resolved without exposing a vault path", async () => {
  const data = bytes(12);
  const handle: V4ContentHandle = { kind: "stage", stageId: "opaque-stage", expectedHash: "hash", expectedSize: data.byteLength };
  const source = await createV4ContentSource(handle, {
    wholeBufferCeilingBytes: 16,
    readVaultWhole: async () => { throw new Error("vault read must not run"); },
    openStage: async stageId => {
      assert.equal(stageId, "opaque-stage");
      return { size: data.byteLength, chunks: chunkBytes => boundedChunks(data, chunkBytes) };
    },
  });
  assert.deepEqual(await collectV4ContentSource(source, 16), data);
});
