import assert from "node:assert/strict";
import test from "node:test";
import { decodeV4TextDocument, diffV4TextLines, V4DiffBudgetExceededError } from "../../src/lib/v4/text-diff";

const enc = (s: string) => new TextEncoder().encode(s);

test("preserves BOM mixed EOL and no-final-newline", () => {
  const doc = decodeV4TextDocument(enc("\uFEFFa\r\nb\nc\rd"));
  assert.equal(doc.bom, "\uFEFF");
  assert.deepEqual(doc.lines.map(x => [x.text, x.eol]), [["a", "\r\n"], ["b", "\n"], ["c", "\r"], ["d", ""]]);
});

test("rejects NUL pseudo text", () => {
  assert.throws(() => decodeV4TextDocument(new Uint8Array([0x61, 0, 0x62])), /binary-looking/u);
});

test("fails closed when work budget is exceeded", () => {
  const base = { bom: "" as const, lines: Array.from({ length: 2000 }, () => ({ text: "x", eol: "\n" as const })) };
  const next = { bom: "" as const, lines: Array.from({ length: 2000 }, () => ({ text: "y", eol: "\n" as const })) };
  assert.throws(() => diffV4TextLines(base, next, { maxSegmentCells: 1000, maxTotalCells: 1000 }), V4DiffBudgetExceededError);
});

test("rejects malformed UTF-8", () => {
  assert.throws(() => decodeV4TextDocument(new Uint8Array([0xc3, 0x28])), /valid UTF-8/u);
});

test("rejects control-heavy pseudo text", () => {
  assert.throws(() => decodeV4TextDocument(enc("abc\u0001\u0002")), /binary-looking/u);
});

test("treats LF to CRLF conversion as an exact line replacement", () => {
  const changes = diffV4TextLines(decodeV4TextDocument(enc("a\nb\n")), decodeV4TextDocument(enc("a\r\nb\r\n")));
  assert.deepEqual(changes.map(change => ({
    baseStart: change.baseStart,
    baseEnd: change.baseEnd,
    replacement: change.replacement.map(token => [token.text, token.eol]),
  })), [{ baseStart: 0, baseEnd: 2, replacement: [["a", "\r\n"], ["b", "\r\n"]] }]);
});

test("preserves lone CR line endings", () => {
  const doc = decodeV4TextDocument(enc("a\rb\r"));
  assert.deepEqual(doc.lines.map(token => [token.text, token.eol]), [["a", "\r"], ["b", "\r"]]);
});

test("final newline change is represented exactly", () => {
  const changes = diffV4TextLines(decodeV4TextDocument(enc("a")), decodeV4TextDocument(enc("a\n")));
  assert.deepEqual(changes, [{ baseStart: 0, baseEnd: 1, replacement: [{ text: "a", eol: "\n" }] }]);
});

test("accepts a huge single line within byte limit", () => {
  const text = "x".repeat(1024 * 1024);
  const doc = decodeV4TextDocument(enc(text));
  assert.equal(doc.lines.length, 1);
  assert.equal(doc.lines[0].text.length, text.length);
});

test("repeated-line edits are deterministic", () => {
  const base = decodeV4TextDocument(enc("a\nx\na\n"));
  const next = decodeV4TextDocument(enc("a\ny\na\n"));
  const first = diffV4TextLines(base, next);
  const second = diffV4TextLines(base, next);
  assert.deepEqual(first, second);
  assert.deepEqual(first, [{ baseStart: 1, baseEnd: 2, replacement: [{ text: "y", eol: "\n" }] }]);
});

test("prefix and suffix trimming keeps a localized repeated-line edit cheap", () => {
  const base = { bom: "" as const, lines: Array.from({ length: 2000 }, () => ({ text: "x", eol: "\n" as const })) };
  const next = { bom: "" as const, lines: Array.from({ length: 2000 }, (_, index) => ({ text: index === 1000 ? "y" : "x", eol: "\n" as const })) };
  const changes = diffV4TextLines(base, next, { maxSegmentCells: 1000, maxTotalCells: 1000 });
  assert.deepEqual(changes, [{ baseStart: 1000, baseEnd: 1001, replacement: [{ text: "y", eol: "\n" }] }]);
});

test("handles insertions at file boundaries", () => {
  assert.deepEqual(
    diffV4TextLines(decodeV4TextDocument(enc("b\n")), decodeV4TextDocument(enc("a\nb\n"))),
    [{ baseStart: 0, baseEnd: 0, replacement: [{ text: "a", eol: "\n" }] }],
  );
  assert.deepEqual(
    diffV4TextLines(decodeV4TextDocument(enc("a\n")), decodeV4TextDocument(enc("a\nb\n"))),
    [{ baseStart: 1, baseEnd: 1, replacement: [{ text: "b", eol: "\n" }] }],
  );
});

test("preserves Unicode emoji", () => {
  const doc = decodeV4TextDocument(enc("😀 note\n"));
  assert.deepEqual(doc.lines, [{ text: "😀 note", eol: "\n" }]);
});

test("identical input has no line changes", () => {
  const doc = decodeV4TextDocument(enc("same\r\ntext"));
  assert.deepEqual(diffV4TextLines(doc, doc), []);
});

test("rejects more than 40000 logical lines", () => {
  assert.throws(() => decodeV4TextDocument(enc("x\n".repeat(40_001))), V4DiffBudgetExceededError);
});
