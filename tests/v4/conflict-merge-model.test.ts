import assert from "node:assert/strict";
import test from "node:test";
import { createV4ConflictMergeModel } from "../../src/lib/v4/conflict-merge-model";

const enc = (s: string) => new TextEncoder().encode(s);

test("disjoint remote edit auto-applies while overlap stays BASE", () => {
  const m = createV4ConflictMergeModel({
    baseBytes: enc("one\ntwo\nthree"),
    localBytes: enc("LOCAL\ntwo\nthree"),
    remoteBytes: enc("REMOTE\ntwo\nTHREE"),
  });
  assert.equal(m.unresolvedCount, 1);
  assert.equal(m.text, "one\ntwo\nTHREE");
});

test("Accept both is literal local then remote", () => {
  const m = createV4ConflictMergeModel({
    baseBytes: enc("x\n"),
    localBytes: enc("L\n"),
    remoteBytes: enc("R\n"),
  });
  const h = m.hunks.find(x => x.kind === "conflict")!;
  m.applyHunkAction(h.id, "accepted-both");
  assert.equal(m.text, "L\nR\n");
});

test("competing insertion is one conflict and Base discards both insertions", () => {
  const m = createV4ConflictMergeModel({
    baseBytes: enc("a\n"),
    localBytes: enc("L\na\n"),
    remoteBytes: enc("R\na\n"),
  });
  assert.equal(m.unresolvedCount, 1);
  assert.equal(m.text, "a\n");
  const h = m.hunks.find(x => x.kind === "conflict")!;
  assert.equal(h.baseText, "");
  m.applyHunkAction(h.id, "discarded-both");
  assert.equal(m.text, "a\n");
  assert.equal(m.unresolvedCount, 0);
});

test("delete versus edit is a content conflict", () => {
  const m = createV4ConflictMergeModel({
    baseBytes: enc("one\ntwo\n"),
    localBytes: enc("two\n"),
    remoteBytes: enc("ONE\ntwo\n"),
  });
  assert.equal(m.unresolvedCount, 1);
  assert.equal(m.text, "one\ntwo\n");
});

test("identical insertion auto-resolves once", () => {
  const m = createV4ConflictMergeModel({
    baseBytes: enc("a\n"),
    localBytes: enc("x\na\n"),
    remoteBytes: enc("x\na\n"),
  });
  assert.equal(m.unresolvedCount, 0);
  assert.equal(m.text, "x\na\n");
  assert.equal(m.hunks.filter(h => h.kind === "auto").length, 1);
});

test("adjacent non-overlapping changes auto-merge", () => {
  const m = createV4ConflictMergeModel({
    baseBytes: enc("a\nb\nc\n"),
    localBytes: enc("A\nb\nc\n"),
    remoteBytes: enc("a\nB\nc\n"),
  });
  assert.equal(m.unresolvedCount, 0);
  assert.equal(m.text, "A\nB\nc\n");
});

test("preserves BOM CRLF and final-newline decisions", () => {
  const m = createV4ConflictMergeModel({
    baseBytes: enc("\uFEFFa\r\nb"),
    localBytes: enc("\uFEFFA\r\nb"),
    remoteBytes: enc("\uFEFFa\r\nB"),
  });
  assert.equal(m.unresolvedCount, 0);
  assert.equal(m.text, "\uFEFFA\r\nB");
  assert.equal(new TextDecoder("utf-8", { ignoreBOM: true }).decode(m.toBytes()), "\uFEFFA\r\nB");
});

test("one-sided BOM removal auto-resolves without creating a hunk", () => {
  const m = createV4ConflictMergeModel({
    baseBytes: enc("\uFEFFa\n"),
    localBytes: enc("a\n"),
    remoteBytes: enc("\uFEFFa\n"),
  });
  assert.equal(m.text, "a\n");
  assert.equal(m.unresolvedCount, 0);
});

test("empty BASE can represent a competing insertion conflict", () => {
  const m = createV4ConflictMergeModel({ baseBytes: enc(""), localBytes: enc("L"), remoteBytes: enc("R") });
  assert.equal(m.text, "");
  assert.equal(m.unresolvedCount, 1);
});

test("preserves emoji through accepted side", () => {
  const m = createV4ConflictMergeModel({ baseBytes: enc("x\n"), localBytes: enc("😀\n"), remoteBytes: enc("🙂\n") });
  const h = m.hunks.find(x => x.kind === "conflict")!;
  m.applyHunkAction(h.id, "accepted-local");
  assert.equal(m.text, "😀\n");
});

test("manual edit spanning multiple unresolved hunks resolves each", () => {
  const m = createV4ConflictMergeModel({
    baseBytes: enc("a\nmid\nb\n"),
    localBytes: enc("A\nmid\nB\n"),
    remoteBytes: enc("R\nmid\nS\n"),
  });
  assert.equal(m.unresolvedCount, 2);
  m.applyManualText("manual replacement\n");
  assert.equal(m.unresolvedCount, 0);
  assert.equal(m.hunks.filter(h => h.kind === "conflict").every(h => h.resolution === "manually-resolved"), true);
});

test("manual edit outside unresolved hunk does not resolve it", () => {
  const m = createV4ConflictMergeModel({ baseBytes: enc("x\nkeep\n"), localBytes: enc("L\nkeep\n"), remoteBytes: enc("R\nkeep\n") });
  m.applyManualText(`${m.text}tail`);
  assert.equal(m.unresolvedCount, 1);
});

test("hunk action after manual edit replaces only mapped hunk result", () => {
  const m = createV4ConflictMergeModel({ baseBytes: enc("x\n"), localBytes: enc("L\n"), remoteBytes: enc("R\n") });
  const id = m.hunks.find(h => h.kind === "conflict")!.id;
  m.applyManualText("M\n");
  assert.equal(m.hunks.find(h => h.id === id)!.resolution, "manually-resolved");
  m.applyHunkAction(id, "accepted-remote");
  assert.equal(m.text, "R\n");
});

test("manual insertion before a hunk shifts its mapped action range", () => {
  const m = createV4ConflictMergeModel({ baseBytes: enc("head\nx\n"), localBytes: enc("head\nL\n"), remoteBytes: enc("head\nR\n") });
  const id = m.hunks.find(h => h.kind === "conflict")!.id;
  m.applyManualText(`prefix\n${m.text}`);
  assert.equal(m.unresolvedCount, 1);
  m.applyHunkAction(id, "accepted-remote");
  assert.equal(m.text, "prefix\nhead\nR\n");
});

test("manual insertion at a zero-width hunk can later be replaced by an action", () => {
  const m = createV4ConflictMergeModel({ baseBytes: enc("a\n"), localBytes: enc("L\na\n"), remoteBytes: enc("R\na\n") });
  const id = m.hunks.find(h => h.kind === "conflict")!.id;
  m.applyManualText("M\na\n");
  assert.equal(m.unresolvedCount, 0);
  m.applyHunkAction(id, "accepted-local");
  assert.equal(m.text, "L\na\n");
});

test("Reset restores initial auto-merge and unresolved ranges", () => {
  const m = createV4ConflictMergeModel({
    baseBytes: enc("x\nkeep\n"),
    localBytes: enc("L\nkeep\n"),
    remoteBytes: enc("R\nKEEP\n"),
  });
  const initial = m.text;
  const id = m.hunks.find(h => h.kind === "conflict")!.id;
  m.applyHunkAction(id, "accepted-local");
  m.applyManualText(`${m.text}extra`);
  m.reset();
  assert.equal(m.text, initial);
  assert.equal(m.unresolvedCount, 1);
});

test("paste-equivalent whole-text replacement updates final bytes", () => {
  const m = createV4ConflictMergeModel({ baseBytes: enc("x\n"), localBytes: enc("L\n"), remoteBytes: enc("R\n") });
  m.applyManualText("pasted 😀\r\n");
  assert.equal(m.unresolvedCount, 0);
  assert.deepEqual(m.toBytes(), enc("pasted 😀\r\n"));
});

test("hunk action length changes keep later hunk ranges aligned", () => {
  const m = createV4ConflictMergeModel({
    baseBytes: enc("a\nmid\nb\n"),
    localBytes: enc("LONG-LOCAL\nmid\nB-LOCAL\n"),
    remoteBytes: enc("R\nmid\nR2\n"),
  });
  const conflicts = m.hunks.filter(h => h.kind === "conflict");
  assert.equal(conflicts.length, 2);
  m.applyHunkAction(conflicts[0].id, "accepted-local");
  m.applyHunkAction(conflicts[1].id, "accepted-remote");
  assert.equal(m.text, "LONG-LOCAL\nmid\nR2\n");
});
