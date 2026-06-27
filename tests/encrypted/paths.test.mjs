import assert from "node:assert/strict";
import test from "node:test";

function normalizeVaultPath(path) {
  return path.replace(/\\/g, "/").replace(/^\/+/u, "").split("/").filter(Boolean).join("/");
}

function detectCaseInsensitiveCollisions(paths) {
  const seen = new Map();
  const collisions = [];
  for (const path of paths) {
    const normalized = normalizeVaultPath(path);
    const key = normalized.toLocaleLowerCase("en-US");
    const first = seen.get(key);
    if (first && first !== normalized) collisions.push([first, normalized]);
    else seen.set(key, normalized);
  }
  return collisions;
}

test("normalization preserves Thai and emoji path text", () => {
  assert.equal(normalizeVaultPath("\\โฟลเดอร์//บันทึก 🚀.md"), "โฟลเดอร์/บันทึก 🚀.md");
});

test("case-insensitive collisions are detected", () => {
  assert.deepEqual(detectCaseInsensitiveCollisions(["Note.md", "folder/ok.md", "note.md"]), [["Note.md", "note.md"]]);
});
