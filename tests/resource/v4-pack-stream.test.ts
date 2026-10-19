import assert from "node:assert/strict";
import test from "node:test";

import { sha256Hex, toBase64, utf8ToBytes } from "../../src/lib/bytes";
import { createV4WholeBufferContentSource, type V4ContentSource } from "../../src/lib/v4/content-source";
import { deriveV4Keyring, encryptV4Payload } from "../../src/lib/v4/crypto";
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

test("direct encrypted pack writer rejects >8 MiB GitHub REST blob before reading sources", async () => {
  const keys = await deriveV4Keyring({
    passphrase: "pass", repoId: "o/r#main", salt: enc("salt"), iterations: 10,
  });
  const codec = new V4StorageCodec({ mode: "encrypted", pathLayout: "opaque-stable-v1", keyring: keys });
  const payload = new Uint8Array(MiB);
  let sourceReads = 0;
  const entries = Array.from({ length: 8 }, (_, index) => ({
    logicalPath: `Folder/oversize-${index}.bin`, fileId: `oversize-${index}`,
    source: { size: payload.byteLength, async *chunks() {
      sourceReads++;
      yield payload;
    } },
    expectedHash: "a".repeat(64), version: "v1", mtime: 1,
  }));
  await assert.rejects(
    () => codec.preparePackFromSources("oversized-pack", entries),
    /REST-safe.*pack.*8 MiB|pack.*REST-safe.*8 MiB/iu,
  );
  assert.equal(sourceReads, 0, "Fail sizing before reading or staging source content");

  const directEntries = entries.map(entry => ({
    record: {
      pathId: entry.fileId, fileId: entry.fileId, plaintextSha256: "a".repeat(64),
      size: payload.byteLength, mtime: 1, remoteVersion: "v1",
      remotePath: entry.logicalPath, storage: "single" as const,
    },
    plaintext: payload,
  }));
  await assert.rejects(() => codec.preparePack("oversized-direct", directEntries),
    /REST-safe.*pack.*8 MiB|pack.*REST-safe.*8 MiB/iu);
});

test("96 medium-sized notes totaling under 100 MB pack into REST-safe blobs and decrypt correctly", {
  timeout: 120_000,
}, async () => {
  const input = Array.from({ length: 96 }, (_, index) => candidate(index, 512 * KiB));
  const groups = planV4PackGroups(input, {
    maxTransportTransientBytes: 256 * MiB,
    maxResidentBytes: 256 * MiB,
  });
  assert.ok(groups.length >= 6);
  assert.deepEqual(groups.flat(), input);
  const keys = await deriveV4Keyring({
    passphrase: "pack-8m-rest-test", repoId: "o/r#main", salt: enc("salt"), iterations: 10,
  });
  const codec = new V4StorageCodec({ mode: "encrypted", pathLayout: "opaque-stable-v1", keyring: keys });
  let totalBytes = 0;
  for (const [index, group] of groups.entries()) {
    const expected = new Map<string, Uint8Array>();
    const entries = await Promise.all(group.map(async item => {
      const payload = new Uint8Array(item.size);
      payload.fill(Number(item.fileId.replace("file-", "")) % 251);
      expected.set(item.fileId, payload);
      totalBytes += payload.byteLength;
      return {
        logicalPath: item.path, fileId: item.fileId,
        source: createV4WholeBufferContentSource(payload),
        expectedHash: await sha256Hex(payload), version: "v1", mtime: 1,
      };
    }));
    const packed = await codec.preparePackFromSources(`rest-pack-${index}`, entries);
    assert.equal(packed.records.length, group.length);
    assert.ok(packed.file.bytes.byteLength <= 8 * MiB,
      `Encrypted pack ${index} created an oversized Git blob`);
    const decoded = await codec.readPackRecords(packed.records, async remotePath => {
      assert.equal(remotePath, packed.file.path);
      return packed.file.bytes;
    });
    assert.equal(decoded.size, expected.size);
    for (const record of packed.records) {
      assert.deepEqual(decoded.get(record.fileId), expected.get(record.fileId));
    }
  }
  assert.equal(totalBytes, 96 * 512 * KiB);
  assert.ok(totalBytes < 100_000_000, "All generated file test inputs remain under the permanent 100 MB cap");
});

test("old >8 MiB encrypted pack remains readable despite new REST-safe writer cap", {
  timeout: 120_000,
}, async () => {
  const packId = "historical-large-pack";
  const repoId = "o/r#main";
  const keys = await deriveV4Keyring({
    passphrase: "legacy-large-pack", repoId, salt: enc("salt"), iterations: 10,
  });
  const codec = new V4StorageCodec({ mode: "encrypted", pathLayout: "opaque-stable-v1", keyring: keys });
  const entryList = await Promise.all(Array.from({ length: 8 }, async (_, index) => {
    const fileId = `legacy-entry-${index}`;
    const payload = new Uint8Array(MiB);
    payload.fill(index + 1);
    return { fileId, payload, hash: await sha256Hex(payload) };
  }));
  const entries = Object.fromEntries(entryList.map(item => [item.fileId, toBase64(item.payload)]));
  const archive = utf8ToBytes(JSON.stringify({ version: 1, entries }));
  const encrypted = await encryptV4Payload(keys.contentKey, archive, {
    kind: "pack", aad: packId,
  });
  assert.ok(encrypted.byteLength > 8 * MiB, "Historical pack must exceed the new REST write cap");
  const records = entryList.map(item => ({
    pathId: item.fileId, fileId: item.fileId, plaintextSha256: item.hash,
    size: item.payload.byteLength, mtime: 1, remoteVersion: "v1",
    remotePath: "synthetic/legacy-pack.enc", storage: "pack" as const,
    packId,
  }));
  const decoded = await codec.readPackRecords(records, async () => encrypted);
  assert.equal(decoded.size, records.length);
  for (const entry of entryList) assert.deepEqual(decoded.get(entry.fileId), entry.payload);
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
