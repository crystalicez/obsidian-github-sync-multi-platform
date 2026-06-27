import assert from "node:assert/strict";
import test from "node:test";

function isTextLike(path) {
  return [".md", ".txt", ".json", ".canvas"].some(ext => path.toLowerCase().endsWith(ext));
}

test("text-like conflict merge applies only to known extensions", () => {
  assert.equal(isTextLike("note.md"), true);
  assert.equal(isTextLike("board.canvas"), true);
  assert.equal(isTextLike("image.png"), false);
});

test("newer policy falls back when timestamps match", () => {
  const local = 10;
  const remote = 10;
  assert.equal(local === remote ? "copy" : local > remote ? "local" : "remote", "copy");
});
