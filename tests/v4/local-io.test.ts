import assert from "node:assert/strict";
import test from "node:test";

import { createV4LocalIo, type V4SessionVault } from "../../src/lib/v4/local-io";

const bytes = (value: string) => new TextEncoder().encode(value);

test("local IO seam preserves list stat read write and trash calls", async () => {
  const events: string[] = [];
  const vault: V4SessionVault = {
    async listFiles() { events.push("list"); return [{ path: "A.md", size: 1, mtime: 2 }]; },
    async stat(path) { events.push(`stat:${path}`); return { path, size: 1, mtime: 2 }; },
    async read(path) { events.push(`read:${path}`); return bytes("a"); },
    async write(path, data, mtime) { events.push(`write:${path}:${new TextDecoder().decode(data)}:${mtime}`); },
    async trash(path) { events.push(`trash:${path}`); },
  };
  const io = createV4LocalIo(vault);

  assert.deepEqual(await io.listFiles(), [{ path: "A.md", size: 1, mtime: 2 }]);
  assert.deepEqual(await io.stat?.("A.md"), { path: "A.md", size: 1, mtime: 2 });
  assert.equal(new TextDecoder().decode(await io.read("A.md")), "a");
  await io.write("A.md", bytes("b"), 7);
  await io.trash("A.md");

  assert.deepEqual(events, ["list", "stat:A.md", "read:A.md", "write:A.md:b:7", "trash:A.md"]);
});

test("local IO seam preserves an adapter without stat support", async () => {
  const vault: V4SessionVault = {
    async listFiles() { return []; },
    async read() { return new Uint8Array(); },
    async write() {},
    async trash() {},
  };
  const io = createV4LocalIo(vault);
  assert.equal(io.stat, undefined);
});


test("local IO seam forwards optional execution content and staging surfaces", async () => {
  const stage = {
    async stageSource() { throw new Error("not used"); },
    async open() { throw new Error("not used"); },
    async remove() {},
    pathFor(stageId: string) { return `private/${stageId}.bin`; },
  };
  const vault: V4SessionVault = {
    async listFiles() { return []; },
    async read() { return new Uint8Array(); },
    async write() {},
    async trash() {},
    async openContentSource(handle) {
      assert.equal(handle.kind, "vault");
      return { size: 0, async *chunks() {} };
    },
    staging: stage,
  };
  const io = createV4LocalIo(vault);
  assert.equal(io.staging, stage);
  const source = await io.openContentSource?.({ kind: "vault", path: "A.md", expectedHash: "h", expectedSize: 0, expectedMtime: 1 });
  assert.equal(source?.size, 0);
});
