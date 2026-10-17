import assert from "node:assert/strict";
import test from "node:test";
import { buildV4ConflictReview, buildV4ConflictReviewAsync, canPrepareV4ConflictReviewPair, decodeV4ReviewText, mergeV4ReviewedSections, mergeV4ReviewedLines, v4ReviewLineKey, V4_REVIEW_MAX_BYTES } from "../../src/lib/v4/conflict-review";

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


test("hunk-wide defaults can be overridden on a single line without materializing decisions for all lines", () => {
  const left = Array.from({ length: 100000 }, (_, i) => `local-${i}`);
  const right = Array.from({ length: 100000 }, (_, i) => `remote-${i}`);
  const sections = buildV4ConflictReview(left.join("\n"), right.join("\n"));
  assert.equal(sections.length, 1);
  const defaults = new Map([[0, "local" as const]]);
  const overrides = new Map([[v4ReviewLineKey(0, "remote", 12), "keep" as const]]);
  const merged = mergeV4ReviewedLines(sections, overrides, defaults);
  assert.equal(merged, left.join("\n") + "\nremote-12");
  assert.equal(overrides.size, 1, "hunk command must not require 200,000 per-line decisions");
  assert.equal(mergeV4ReviewedLines(sections, new Map(), defaults), left.join("\n"));
  assert.equal(mergeV4ReviewedLines(sections, new Map(), new Map()), null);
});

test("line-density working-set budget rejects pathological tiny-line input before splitting into huge arrays", () => {
  const dense = "\n".repeat(1_100_000);
  assert.equal(canPrepareV4ConflictReviewPair(dense, dense + "changed"), false);
  const manageable = Array.from({ length: 100000 }, (_, i) => `paragraph ${i}`).join("\n");
  assert.equal(canPrepareV4ConflictReviewPair(manageable, manageable + "\nchanged"), true);
  assert.equal(canPrepareV4ConflictReviewPair("one\ntwo", "one\nthree"), true);
});

test("binary, invalid UTF-8 and oversized input have no editable review", () => {
  assert.equal(decodeV4ReviewText(new Uint8Array([0xff])), null);
  assert.equal(decodeV4ReviewText(new Uint8Array([0])), null);
  assert.equal(decodeV4ReviewText(new Uint8Array(V4_REVIEW_MAX_BYTES + 1)), null);
  assert.equal(decodeV4ReviewText(new TextEncoder().encode("ok")), "ok");
});


test("diff finds separated edits across 20,000 context lines rather than collapsing entire file", () => {
  const context = Array.from({ length: 20000 }, (_, i) => `Stable shared paragraph ${i} unique`);
  const local = context.slice(); const remote = context.slice();
  local[200] = "local first"; remote[200] = "remote first";
  local[19800] = "local last"; remote[19800] = "remote last";
  const sections = buildV4ConflictReview(local.join("\n"), remote.join("\n"));
  assert.equal(sections.filter(section => section.kind === "difference").length, 2);
  assert.equal(sections.filter(section => section.kind === "common")
    .reduce((n, section) => n + section.lines.length, 0), 19998);
  assert.equal(sections.filter(section => section.kind === "difference")
    .reduce((n, section) => n + section.localLines.length + section.remoteLines.length, 0), 4);
  assert.equal(mergeV4ReviewedSections(sections, new Map([[0, "local"], [1, "local"]])), local.join("\n"));
  assert.equal(mergeV4ReviewedSections(sections, new Map([[0, "remote"], [1, "remote"]])), remote.join("\n"));
});

test("long totally different text remains individually selectable without quadratic matrix", () => {
  const local = Array.from({ length: 30000 }, (_, i) => `unique local line ${i}`).join("\n");
  const remote = Array.from({ length: 30000 }, (_, i) => `unique remote line ${i}`).join("\n");
  const sections = buildV4ConflictReview(local, remote);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].kind, "difference");
  assert.equal(sections[0].localLines.length, 30000);
  assert.equal(sections[0].remoteLines.length, 30000);
  assert.equal(mergeV4ReviewedSections(sections, new Map([[0, "remote"]])), remote);
});

test("16 MiB UTF-8 notes can be decoded for selective review but binary cannot", () => {
  assert.equal(decodeV4ReviewText(new TextEncoder().encode("🎵".repeat(350000))), "🎵".repeat(350000));
  const upper = new Uint8Array(V4_REVIEW_MAX_BYTES).fill(0x61);
  assert.equal(decodeV4ReviewText(upper)?.length, V4_REVIEW_MAX_BYTES);
  assert.equal(decodeV4ReviewText(new Uint8Array(V4_REVIEW_MAX_BYTES + 1)), null);
  assert.equal(decodeV4ReviewText(new Uint8Array([0xff, 0xfe])), null);
});


test("250,000 lines of common context round-trip with either choice without argument-spread overflow", () => {
  const source = Array.from({ length: 250000 }, (_, i) => `paragraph:${i}`);
  const left = source.slice(); const right = source.slice();
  left[3] = "edited local"; right[3] = "edited remote";
  const sections = buildV4ConflictReview(left.join("\n"), right.join("\n"));
  assert.equal(sections.filter(section => section.kind === "difference").length, 1);
  assert.equal(mergeV4ReviewedSections(sections, new Map([[0, "local"]])), left.join("\n"));
  assert.equal(mergeV4ReviewedSections(sections, new Map([[0, "remote"]])), right.join("\n"));
});

test("random small text pairs preserve both sides after selecting every hunk", () => {
  let state = 1234567;
  const random = (n: number) => ((state = (state * 16807) % 2147483647) % n);
  for (let iteration = 0; iteration < 120; iteration++) {
    const make = () => Array.from({ length: random(35) }, () => `line-${random(20)}`).join("\n");
    const left = make(), right = make();
    const sections = buildV4ConflictReview(left, right);
    const count = sections.filter(s => s.kind === "difference").length;
    const choose = (side: "local" | "remote") => new Map(Array.from({ length: count }, (_, i) => [i, side] as const));
    assert.equal(mergeV4ReviewedSections(sections, choose("local")), left);
    assert.equal(mergeV4ReviewedSections(sections, choose("remote")), right);
  }
});
test("cooperatively scheduled diff returns identical sections and respects cancellation", async () => {
  const shared = Array.from({ length: 18000 }, (_, i) => `shared line ${i}`);
  const left = shared.slice(), right = shared.slice();
  left[200] = "local"; right[200] = "remote";
  left[17200] = "local last"; right[17200] = "remote last";
  assert.deepEqual(await buildV4ConflictReviewAsync(left.join("\n"), right.join("\n")),
    buildV4ConflictReview(left.join("\n"), right.join("\n")));
  const abort = new AbortController();
  const running = buildV4ConflictReviewAsync(left.join("\n"), right.join("\n"), abort.signal);
  abort.abort();
  await assert.rejects(running, /cancelled/u);
});

test("large line matrices remain bounded and produce one all-or-nothing hunk", () => {
  const left = [...Array(700)].map((_, i) => `local ${i}`).join("\n");
  const right = [...Array(700)].map((_, i) => `remote ${i}`).join("\n");
  const sections = buildV4ConflictReview(left, right);
  assert.equal(sections.length, 1);
  assert.equal(mergeV4ReviewedSections(sections, new Map([[0, "remote"]])), right);
});
