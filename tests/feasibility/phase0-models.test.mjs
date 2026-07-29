import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  compareVersions,
  estimateGitBlobTransportMemory,
  modelV4LargeFileRevision,
} from "../../scripts/v4-phase0-models.mjs";

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;

test("Obsidian appendBinary requires a newer app than the current manifest minimum", async () => {
  const manifest = JSON.parse(await readFile(new URL("../../manifest.json", import.meta.url), "utf8"));
  assert.equal(manifest.minAppVersion, "1.11.4");
  assert.equal(compareVersions(manifest.minAppVersion, "1.12.3") < 0, true);
  assert.equal(compareVersions("1.12.3", "1.12.3"), 0);
});

test("Git blob transport memory accounts for raw, ciphertext, base64, and JSON bodies", () => {
  const model = estimateGitBlobTransportMemory(48 * MiB, { encrypted: true });
  assert.equal(model.base64Bytes, 64 * MiB + 24); // AES-GCM adds 16 bytes before base64.
  assert.ok(model.estimatedPeakBytes > 200 * MiB);
  assert.ok(model.estimatedPeakBytes > model.rawBytes * 4);
});

test("5 GiB V4 revision request count exposes the memory-vs-request tradeoff", () => {
  const model48 = modelV4LargeFileRevision(5 * GiB, 48 * MiB);
  const model32 = modelV4LargeFileRevision(5 * GiB, 32 * MiB);
  const model16 = modelV4LargeFileRevision(5 * GiB, 16 * MiB);
  assert.equal(model48.partCount, 107);
  assert.equal(model32.partCount, 160);
  assert.equal(model16.partCount, 320);
  assert.equal(model48.contentMutations, 114);
  assert.equal(model16.contentMutations, 327);
  assert.ok(model48.contentMutations < model32.contentMutations);
  assert.ok(model32.contentMutations < model16.contentMutations);
});
