import assert from "node:assert/strict";
import test from "node:test";
import { buildV4ConflictContextKey, fingerprintV4ConflictFile } from "../../src/lib/v4/conflict-types";

const present = (path: string, hash = "a".repeat(64)) => ({ exists: true as const, path, hash, size: 10, mtime: 1 });
const absent = { exists: false as const };

test("rename changes fingerprint even when bytes are identical", async () => {
  const a = await fingerprintV4ConflictFile({ fileId: "f", base: present("a.md"), local: present("a.md"), remote: present("r.md") });
  const b = await fingerprintV4ConflictFile({ fileId: "f", base: present("a.md"), local: present("l.md"), remote: present("r.md") });
  assert.notEqual(a, b);
});

test("absence is not empty content", async () => {
  const a = await fingerprintV4ConflictFile({ fileId: "f", base: present("a.md"), local: absent, remote: present("a.md") });
  const b = await fingerprintV4ConflictFile({ fileId: "f", base: present("a.md"), local: present("a.md", "e".repeat(64)), remote: present("a.md") });
  assert.notEqual(a, b);
});

test("context key changes when saved target/scope generation changes", async () => {
  const a = await buildV4ConflictContextKey({ repoId: "o/r#main", mode: "plaintext", pathLayout: "logical-v1", settingsGeneration: 1, scopeSignature: "scope-a" });
  const b = await buildV4ConflictContextKey({ repoId: "o/r#main", mode: "plaintext", pathLayout: "logical-v1", settingsGeneration: 2, scopeSignature: "scope-a" });
  assert.notEqual(a, b);
});
