export const V4_MAX_TEXT_DIFF_BYTES = 2 * 1024 * 1024;
export const V4_MAX_DIFF_LINES = 40_000;
export const V4_MAX_DIFF_SEGMENT_CELLS = 250_000;
export const V4_MAX_DIFF_TOTAL_CELLS = 2_000_000;

export type V4Eol = "\n" | "\r\n" | "\r" | "";

export interface V4LineToken {
  text: string;
  eol: V4Eol;
}

export interface V4TextDocument {
  bom: "" | "\uFEFF";
  lines: V4LineToken[];
}

export interface V4LineChange {
  baseStart: number;
  baseEnd: number;
  replacement: V4LineToken[];
}

export interface V4TextDiffOptions {
  maxLines?: number;
  maxSegmentCells?: number;
  maxTotalCells?: number;
}

export class V4DiffBudgetExceededError extends Error {
  constructor(message = "V4 text diff work budget exceeded.") {
    super(message);
    this.name = "V4DiffBudgetExceededError";
  }
}

function binaryLooking(message: string): Error {
  return new Error(`V4 text is binary-looking: ${message}`);
}

function tokenizeLines(text: string): V4LineToken[] {
  if (text.length === 0) return [];
  const lines: V4LineToken[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === 0x0d) {
      const crlf = index + 1 < text.length && text.charCodeAt(index + 1) === 0x0a;
      lines.push({ text: text.slice(start, index), eol: crlf ? "\r\n" : "\r" });
      if (crlf) index++;
      start = index + 1;
      continue;
    }
    if (code === 0x0a) {
      lines.push({ text: text.slice(start, index), eol: "\n" });
      start = index + 1;
    }
  }
  if (start < text.length) lines.push({ text: text.slice(start), eol: "" });
  return lines;
}

export function decodeV4TextDocument(bytes: Uint8Array): V4TextDocument {
  if (bytes.byteLength > V4_MAX_TEXT_DIFF_BYTES) {
    throw new V4DiffBudgetExceededError(`V4 text exceeds the ${V4_MAX_TEXT_DIFF_BYTES}-byte merge limit.`);
  }

  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error("V4 text is not valid UTF-8.");
  }

  const bom: "" | "\uFEFF" = decoded.startsWith("\uFEFF") ? "\uFEFF" : "";
  const text = bom ? decoded.slice(1) : decoded;
  let controls = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === 0) throw binaryLooking("contains NUL.");
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) controls++;
  }
  if (text.length > 0 && controls / text.length > 0.02) {
    throw binaryLooking("contains too many control characters.");
  }

  const lines = tokenizeLines(text);
  if (lines.length > V4_MAX_DIFF_LINES) {
    throw new V4DiffBudgetExceededError(`V4 text has ${lines.length} lines; maximum is ${V4_MAX_DIFF_LINES}.`);
  }
  return { bom, lines };
}

function tokenEqual(left: V4LineToken, right: V4LineToken): boolean {
  return left.text === right.text && left.eol === right.eol;
}

function tokenKey(token: V4LineToken): string {
  return JSON.stringify([token.text, token.eol]);
}

interface Anchor {
  base: number;
  next: number;
}

function patienceAnchors(
  base: readonly V4LineToken[],
  next: readonly V4LineToken[],
  baseStart: number,
  baseEnd: number,
  nextStart: number,
  nextEnd: number,
): Anchor[] {
  const baseCounts = new Map<string, { count: number; index: number }>();
  for (let index = baseStart; index < baseEnd; index++) {
    const key = tokenKey(base[index]);
    const current = baseCounts.get(key);
    if (current) current.count++;
    else baseCounts.set(key, { count: 1, index });
  }
  const nextCounts = new Map<string, { count: number; index: number }>();
  for (let index = nextStart; index < nextEnd; index++) {
    const key = tokenKey(next[index]);
    const current = nextCounts.get(key);
    if (current) current.count++;
    else nextCounts.set(key, { count: 1, index });
  }

  const candidates: Anchor[] = [];
  for (let index = baseStart; index < baseEnd; index++) {
    const key = tokenKey(base[index]);
    const baseEntry = baseCounts.get(key)!;
    const nextEntry = nextCounts.get(key);
    if (baseEntry.count === 1 && nextEntry?.count === 1) candidates.push({ base: index, next: nextEntry.index });
  }
  if (candidates.length === 0) return [];

  const tails: number[] = [];
  const previous = new Int32Array(candidates.length);
  previous.fill(-1);
  for (let index = 0; index < candidates.length; index++) {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (candidates[tails[middle]].next < candidates[index].next) low = middle + 1;
      else high = middle;
    }
    if (low > 0) previous[index] = tails[low - 1];
    tails[low] = index;
  }

  const anchors: Anchor[] = [];
  let cursor = tails[tails.length - 1];
  while (cursor !== undefined && cursor >= 0) {
    anchors.push(candidates[cursor]);
    cursor = previous[cursor];
  }
  anchors.reverse();
  return anchors;
}

function appendChange(changes: V4LineChange[], change: V4LineChange): void {
  const previous = changes.at(-1);
  if (previous && previous.baseEnd === change.baseStart) {
    previous.baseEnd = change.baseEnd;
    previous.replacement.push(...change.replacement);
    return;
  }
  changes.push(change);
}

function solveGap(
  base: readonly V4LineToken[],
  next: readonly V4LineToken[],
  baseStart: number,
  baseEnd: number,
  nextStart: number,
  nextEnd: number,
  changes: V4LineChange[],
  budget: { used: number; maxSegmentCells: number; maxTotalCells: number },
): void {
  const baseLength = baseEnd - baseStart;
  const nextLength = nextEnd - nextStart;
  if (baseLength === 0 && nextLength === 0) return;
  if (baseLength === 0 || nextLength === 0) {
    appendChange(changes, { baseStart, baseEnd, replacement: next.slice(nextStart, nextEnd) });
    return;
  }

  const cells = baseLength * nextLength;
  if (!Number.isSafeInteger(cells) || cells > budget.maxSegmentCells || budget.used + cells > budget.maxTotalCells) {
    throw new V4DiffBudgetExceededError();
  }
  budget.used += cells;

  const width = nextLength + 1;
  const directions = new Uint8Array((baseLength + 1) * width);
  let previous = new Uint32Array(width);
  let current = new Uint32Array(width);
  for (let baseIndex = 1; baseIndex <= baseLength; baseIndex++) {
    for (let nextIndex = 1; nextIndex <= nextLength; nextIndex++) {
      const directionIndex = baseIndex * width + nextIndex;
      if (tokenEqual(base[baseStart + baseIndex - 1], next[nextStart + nextIndex - 1])) {
        current[nextIndex] = previous[nextIndex - 1] + 1;
        directions[directionIndex] = 1;
      } else if (previous[nextIndex] >= current[nextIndex - 1]) {
        current[nextIndex] = previous[nextIndex];
        directions[directionIndex] = 2;
      } else {
        current[nextIndex] = current[nextIndex - 1];
        directions[directionIndex] = 3;
      }
    }
    [previous, current] = [current, previous];
    current.fill(0);
  }

  const matches: Array<{ base: number; next: number }> = [];
  let baseIndex = baseLength;
  let nextIndex = nextLength;
  while (baseIndex > 0 && nextIndex > 0) {
    const direction = directions[baseIndex * width + nextIndex];
    if (direction === 1) {
      matches.push({ base: baseStart + baseIndex - 1, next: nextStart + nextIndex - 1 });
      baseIndex--;
      nextIndex--;
    } else if (direction === 2) {
      baseIndex--;
    } else {
      nextIndex--;
    }
  }
  matches.reverse();

  let baseCursor = baseStart;
  let nextCursor = nextStart;
  for (const match of matches) {
    if (baseCursor !== match.base || nextCursor !== match.next) {
      appendChange(changes, {
        baseStart: baseCursor,
        baseEnd: match.base,
        replacement: next.slice(nextCursor, match.next),
      });
    }
    baseCursor = match.base + 1;
    nextCursor = match.next + 1;
  }
  if (baseCursor !== baseEnd || nextCursor !== nextEnd) {
    appendChange(changes, { baseStart: baseCursor, baseEnd, replacement: next.slice(nextCursor, nextEnd) });
  }
}

export function diffV4TextLines(
  base: V4TextDocument,
  next: V4TextDocument,
  options: V4TextDiffOptions = {},
): V4LineChange[] {
  const maxLines = options.maxLines ?? V4_MAX_DIFF_LINES;
  if (base.lines.length > maxLines || next.lines.length > maxLines) {
    throw new V4DiffBudgetExceededError(`V4 text diff exceeds the ${maxLines}-line limit.`);
  }

  let prefix = 0;
  while (prefix < base.lines.length && prefix < next.lines.length && tokenEqual(base.lines[prefix], next.lines[prefix])) prefix++;

  let baseEnd = base.lines.length;
  let nextEnd = next.lines.length;
  while (baseEnd > prefix && nextEnd > prefix && tokenEqual(base.lines[baseEnd - 1], next.lines[nextEnd - 1])) {
    baseEnd--;
    nextEnd--;
  }
  if (prefix === baseEnd && prefix === nextEnd) return [];

  const budget = {
    used: 0,
    maxSegmentCells: options.maxSegmentCells ?? V4_MAX_DIFF_SEGMENT_CELLS,
    maxTotalCells: options.maxTotalCells ?? V4_MAX_DIFF_TOTAL_CELLS,
  };
  const changes: V4LineChange[] = [];
  const anchors = patienceAnchors(base.lines, next.lines, prefix, baseEnd, prefix, nextEnd);
  let baseCursor = prefix;
  let nextCursor = prefix;
  for (const anchor of anchors) {
    solveGap(base.lines, next.lines, baseCursor, anchor.base, nextCursor, anchor.next, changes, budget);
    baseCursor = anchor.base + 1;
    nextCursor = anchor.next + 1;
  }
  solveGap(base.lines, next.lines, baseCursor, baseEnd, nextCursor, nextEnd, changes, budget);
  return changes;
}
