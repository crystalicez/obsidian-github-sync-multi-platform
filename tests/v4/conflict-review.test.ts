import assert from "node:assert/strict";
import test from "node:test";
import { buildV4ConflictReview, decodeV4ReviewText, mergeV4ReviewedSections, mergeV4ReviewedLines, v4ReviewLineKey, V4_REVIEW_MAX_BYTES } from "../../src/lib/v4/conflict-review";

test("manual review isolates independent line hunks and merges only explicit selections", () => {
  const local = "A\nlocal first\nB\nlocal second\nC\n";
  const remote = "A\nremote first\nB\nremote second\nC\n";
  const sections = buildV4ConflictReview(local, remote);
  assert.equal(sections.filter(item => item.kind === "difference").length, 2);
  assert.equal(mergeV4ReviewedSections(sections, new Map()), null);
  assert.equal(mergeV4ReviewedSections(sections, new Map([[0, "remote"], [1, "local"]])),
    "A\nremote first\nB\nlocal second\nC\n");
  assert.equal(mergeV4ReviewedSections(sections, new Map([[0, "local"], [1, "local"]])), local);
  assert.equal(mergeV4ReviewedSections(sections, new Map([[0, "remote"], [1, "remote"]])), remote);
  assert.equal(mergeV4ReviewedSections(sections, new Map([[0, "both"], [1, "discard"]])),
    "A\nlocal first\nremote first\nB\nC\n");
});

test("manual review correctly handles insertions, deletions, Unicode and no-difference", () => {
  for (const [local, remote] of [
    ["A\nnew\nB", "A\nB"],
    ["A\nB", "A\nremote\nB"],
    ["🤖\nlocal\n", "🤖\nremote\n"],
    ["", "new"],
    ["x\n", "x"],
  ]) {
    const sections = buildV4ConflictReview(local, remote);
    const count = sections.filter(item => item.kind === "difference").length;
    assert.equal(mergeV4ReviewedSections(sections, new Map([...Array(count)].map((_, i) => [i, "local"]))), local);
    assert.equal(mergeV4ReviewedSections(sections, new Map([...Array(count)].map((_, i) => [i, "remote"]))), remote);
  }
  assert.equal(mergeV4ReviewedSections(buildV4ConflictReview("same", "same"), new Map()), "same");
});


test("line-level review can retain individual lines from each side within a single changed block", () => {
  const left = "header\nlocal 1\nlocal 2\nlocal 3\nfooter";
  const right = "header\nremote 1\nremote 2\nfooter";
  const sections = buildV4ConflictReview(left, right);
  const changes = sections.map((section, i) => ({section, i})).filter(item => item.section.kind === "difference");
  assert.equal(changes.length, 1);
  const index = changes[0].i;
  const decisions = new Map<string, "keep" | "omit">([
    [v4ReviewLineKey(index, "local", 0), "keep"],
    [v4ReviewLineKey(index, "local", 1), "omit"],
    [v4ReviewLineKey(index, "local", 2), "keep"],
    [v4ReviewLineKey(index, "remote", 0), "omit"],
    [v4ReviewLineKey(index, "remote", 1), "keep"],
  ]);
  assert.equal(mergeV4ReviewedLines(sections, new Map()), null);
  assert.equal(mergeV4ReviewedLines(sections, decisions), "header\nlocal 1\nlocal 3\nremote 2\nfooter");
  decisions.delete(v4ReviewLineKey(index, "local", 1));
  assert.equal(mergeV4ReviewedLines(sections, decisions), null);
});

test("line-level review retains newlines, unchanged context, and allows empty chosen output", () => {
  for (const [a, b] of [["one\ntwo\n", "one\nthree\n"], ["", "x"], ["x", ""], ["\n", "x\n"]]) {
    const sections = buildV4ConflictReview(a, b);
    const choices = new Map<string, "keep" | "omit">();
    sections.forEach((section, sectionIndex) => {
      if (section.kind !== "difference") return;
      section.localLines.forEach((_, i) => choices.set(v4ReviewLineKey(sectionIndex, "local", i), "keep"));
      section.remoteLines.forEach((_, i) => choices.set(v4ReviewLineKey(sectionIndex, "remote", i), "omit"));
    });
    assert.equal(mergeV4ReviewedLines(sections, choices), a);
  }
});

test("binary, invalid UTF-8 and oversized input have no editable review", () => {
  assert.equal(decodeV4ReviewText(new Uint8Array([0xff])), null);
  assert.equal(decodeV4ReviewText(new Uint8Array([0])), null);
  assert.equal(decodeV4ReviewText(new Uint8Array(V4_REVIEW_MAX_BYTES + 1)), null);
  assert.equal(decodeV4ReviewText(new TextEncoder().encode("ok")), "ok");
});

test("large line matrices remain bounded and produce one all-or-nothing hunk", () => {
  const left = [...Array(700)].map((_, i) => `local ${i}`).join("\n");
  const right = [...Array(700)].map((_, i) => `remote ${i}`).join("\n");
  const sections = buildV4ConflictReview(left, right);
  assert.equal(sections.length, 1);
  assert.equal(mergeV4ReviewedSections(sections, new Map([[0, "remote"]])), right);
});
