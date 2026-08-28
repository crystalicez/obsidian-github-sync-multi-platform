import assert from "node:assert/strict";
import test from "node:test";
import { crc32, createStoredZip } from "../../scripts/deterministic-zip.mjs";

function readStoredZipEntries(zip) {
  assert.ok(Buffer.isBuffer(zip));
  assert.ok(zip.length >= 22);
  const endOffset = zip.length - 22;
  assert.equal(zip.readUInt32LE(endOffset), 0x06054b50);
  const count = zip.readUInt16LE(endOffset + 10);
  const centralOffset = zip.readUInt32LE(endOffset + 16);
  const result = Object.create(null);
  let cursor = centralOffset;

  for (let index = 0; index < count; index += 1) {
    assert.equal(zip.readUInt32LE(cursor), 0x02014b50);
    assert.equal(zip.readUInt16LE(cursor + 10), 0, "entries must use store/no-compression");
    const expectedCrc = zip.readUInt32LE(cursor + 16);
    const size = zip.readUInt32LE(cursor + 24);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const extraLength = zip.readUInt16LE(cursor + 30);
    const commentLength = zip.readUInt16LE(cursor + 32);
    const localOffset = zip.readUInt32LE(cursor + 42);
    const name = zip.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");

    assert.equal(zip.readUInt32LE(localOffset), 0x04034b50);
    assert.equal(zip.readUInt16LE(localOffset + 8), 0);
    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const localExtraLength = zip.readUInt16LE(localOffset + 28);
    const localName = zip.subarray(localOffset + 30, localOffset + 30 + localNameLength).toString("utf8");
    assert.equal(localName, name);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const data = zip.subarray(dataStart, dataStart + size);
    assert.equal(crc32(data), expectedCrc);
    result[name] = Buffer.from(data);

    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return result;
}

test("crc32 matches the standard check vector", () => {
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
});

test("stored ZIP has exact ordered entries and bytes", () => {
  const zip = createStoredZip([
    { name: "root/a.txt", bytes: Buffer.from("alpha") },
    { name: "root/b.txt", bytes: Buffer.from("beta") },
  ]);
  const entries = readStoredZipEntries(zip);
  assert.deepEqual(Object.keys(entries), ["root/a.txt", "root/b.txt"]);
  assert.deepEqual(entries["root/a.txt"], Buffer.from("alpha"));
  assert.deepEqual(entries["root/b.txt"], Buffer.from("beta"));
});

test("stored ZIP output is byte-identical for identical inputs", () => {
  const input = [
    { name: "root/main.js", bytes: Buffer.from("console.log(1);\n") },
    { name: "root/styles.css", bytes: Buffer.from("body{}\n") },
  ];
  assert.deepEqual(createStoredZip(input), createStoredZip(input));
});

test("stored ZIP rejects duplicate and unsafe entry names", () => {
  assert.throws(() => createStoredZip([
    { name: "same", bytes: Buffer.from("a") },
    { name: "same", bytes: Buffer.from("b") },
  ]), /duplicate/i);
  assert.throws(() => createStoredZip([{ name: "bad\\name", bytes: Buffer.from("a") }]), /invalid/i);
  assert.throws(() => createStoredZip([{ name: "/absolute", bytes: Buffer.from("a") }]), /invalid/i);
});
