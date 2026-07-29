import assert from "node:assert/strict";
import test from "node:test";

import { sha256Hex } from "../../src/lib/bytes";
import { createV4WholeBufferContentSource, type V4ContentSource } from "../../src/lib/v4/content-source";
import { deriveV4Keyring } from "../../src/lib/v4/crypto";
import { V4SourceChangedError } from "../../src/lib/v4/object-stream";
import {
  estimateV4PackGroupResources,
  planV4PackGroups,
  type V4PackCandidateMeta,
} from "../../src/lib/v4/pack-planner";
import { V4StorageCodec } from "../../src/lib/v4/storage-codec";

const KiB = 1024;
const MiB = 1024 * KiB;
const enc = (value: string) => new TextEncoder().encode(value);

function candidate(index: number, size = 512 * KiB): V4PackCandidateMeta {
  return { fileId: `file-${index.toString().padStart(3, "0")}`, path: `Folder/file-${index}.bin`, size };
}

test("pack planner shrinks metadata groups to fit resident and Git transport budgets", () => {
  const candidates = Array.from({ length: 96 }, (_, index) => candidate(index));
  const maxResidentBytes = 18 * MiB;
  const maxTransportTransientBytes = 24 * MiB;
  const groups = planV4PackGroups(candidates, {
    maxPlaintextBytes: 32 * MiB,
    maxResidentBytes,
    maxTransportTransientBytes,
  });

  assert.ok(groups.length > 1);
  assert.equal(groups.flat().length, candidates.length);
  for (const group of groups) {
    const budget = estimateV4PackGroupResources(group);
    assert.ok(budget.residentBytes <= maxResidentBytes, `${budget.residentBytes} > ${maxResidentBytes}`);
    assert.ok(budget.transportBytes <= maxTransportTransientBytes, `${budget.transportBytes} > ${maxTransportTransientBytes}`);
  }
});

test("pack preparation opens one selected source at a time and reads every selected entry once", async () => {
  const keys = await deriveV4Keyring({ passphrase: "pass", repoId: "o/r#main", salt: enc("salt"), iterations: 10 });
  const codec = new V4StorageCodec({ mode: "encrypted", pathLayout: "opaque-stable-v1", keyring: keys });
  let active = 0;
  let peak = 0;
  const opens = new Map<string, number>();
  const inputs = [];

  for (let index = 0; index < 64; index++) {
    const fileId = `packed-${index}`;
    const plaintext = new Uint8Array(16 * KiB + index);
    plaintext.fill(index & 0xff);
    const source: V4ContentSource = {
      size: plaintext.byteLength,
      async *chunks() {
        opens.set(fileId, (opens.get(fileId) ?? 0) + 1);
        active++;
        peak = Math.max(peak, active);
        try { yield plaintext; }
        finally { active--; }
      },
    };
    inputs.push({
      logicalPath: `Folder/${index}.bin`, fileId, source,
      expectedHash: await sha256Hex(plaintext), version: "pack-v1", mtime: index,
    });
  }

  const packed = await codec.preparePackFromSources("pack-stream", inputs);
  assert.equal(peak, 1);
  assert.equal(opens.size, 64);
  assert.ok([...opens.values()].every(count => count === 1));
  assert.equal(packed.records.length, 64);
});

test("pack preparation rejects a changed source before returning publishable pack bytes", async () => {
  const keys = await deriveV4Keyring({ passphrase: "pass", repoId: "o/r#main", salt: enc("salt"), iterations: 10 });
  const codec = new V4StorageCodec({ mode: "encrypted", pathLayout: "opaque-stable-v1", keyring: keys });
  const original = enc("planned");
  const changed = enc("changed");

  await assert.rejects(codec.preparePackFromSources("pack-changed", [{
    logicalPath: "Folder/changed.md",
    fileId: "changed-file",
    source: createV4WholeBufferContentSource(changed),
    expectedHash: await sha256Hex(original),
    version: "pack-v2",
    mtime: 1,
  }]), error => error instanceof V4SourceChangedError);
});
