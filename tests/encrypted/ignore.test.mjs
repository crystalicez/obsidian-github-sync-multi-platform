import assert from "node:assert/strict";
import test from "node:test";

function parseIgnorePathRegex(input) {
  return input
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith("#"))
    .map(line => new RegExp(line, "u"));
}

function ignored(path, patterns) {
  return patterns.some(pattern => pattern.test(path));
}

test("parseIgnorePathRegex skips blank lines and comments", () => {
  const patterns = parseIgnorePathRegex("\n# comment\n^Archive/\n\\.tmp$\n");
  assert.equal(patterns.length, 2);
  assert.equal(ignored("Archive/a.md", patterns), true);
  assert.equal(ignored("note.tmp", patterns), true);
  assert.equal(ignored("note.md", patterns), false);
});

test("parseIgnorePathRegex reports invalid regex", () => {
  assert.throws(() => parseIgnorePathRegex("["), /Invalid regular expression/u);
});
