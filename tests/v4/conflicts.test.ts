import assert from "node:assert/strict";
import test from "node:test";
import { resolveV4Conflict } from "../../src/lib/v4/conflicts";

const enc = (value: string) => new TextEncoder().encode(value);

test("v4 copy and newer policies are deterministic", () => {
  assert.equal(resolveV4Conflict({ policy: "copy", path: "a.bin", localMtime: 2, remoteMtime: 3 }).action, "keep-local-copy-remote");
  assert.equal(resolveV4Conflict({ policy: "newer", path: "a.bin", localMtime: 4, remoteMtime: 3 }).action, "use-local");
  assert.equal(resolveV4Conflict({ policy: "newer", path: "a.bin", localMtime: 2, remoteMtime: 3 }).action, "use-remote");
  assert.equal(resolveV4Conflict({ policy: "newer", path: "a.bin", localMtime: 3, remoteMtime: 3 }).action, "keep-local-copy-remote");
});

test("v4 merge combines non-overlapping text edits and falls back for overlap", () => {
  const clean = resolveV4Conflict({
    policy: "merge",
    path: "note.md",
    localMtime: 2,
    remoteMtime: 3,
    baseBytes: enc("one\ntwo\nthree"),
    localBytes: enc("ONE\ntwo\nthree"),
    remoteBytes: enc("one\ntwo\nTHREE"),
  });
  assert.equal(clean.action, "merged");
  assert.equal(new TextDecoder().decode(clean.mergedBytes), "ONE\ntwo\nTHREE");

  const overlap = resolveV4Conflict({
    policy: "merge",
    path: "note.md",
    localMtime: 2,
    remoteMtime: 3,
    baseBytes: enc("one\ntwo"),
    localBytes: enc("LOCAL\ntwo"),
    remoteBytes: enc("REMOTE\ntwo"),
  });
  assert.equal(overlap.action, "keep-local-copy-remote");
});
