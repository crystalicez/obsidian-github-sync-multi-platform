/** Bounded-memory line diff using patience anchors and small local DP gaps. */
export type V4ReviewChoice = "local" | "remote" | "both" | "discard";
export type V4ReviewSection =
  | { kind: "common"; lines: string[] }
  | { kind: "difference"; localLines: string[]; remoteLines: string[] };
export type V4ReviewLineDecision = "keep" | "omit";
export type V4ReviewLineSide = "local" | "remote";

/** Per-side binary-memory safety budget, independent of number of lines. */
export const V4_REVIEW_MAX_BYTES = 16 * 1024 * 1024;
export const V4_REVIEW_MAX_RESULT_BYTES = 2 * V4_REVIEW_MAX_BYTES;
const GAP_CELLS = 160_000;

const V4_REVIEW_ESTIMATED_WORKING_SET_BYTES = 96 * 1024 * 1024;
const V4_REVIEW_ESTIMATED_BYTES_PER_LINE = 64;

/**
 * Bound text/line-array bookkeeping before calling split("\\n").
 * A 16 MiB note consisting only of newlines otherwise creates millions of
 * string slots and line controls' metadata, potentially exhausting Obsidian.
 * This is a working-set estimate, not a legacy fixed line-count cutoff.
 */
export function canPrepareV4ConflictReviewPair(local: string, remote: string): boolean {
  const remaining = V4_REVIEW_ESTIMATED_WORKING_SET_BYTES - (local.length + remote.length) * 2;
  if (remaining < 0) return false;
  const maxSlots = Math.floor(remaining / V4_REVIEW_ESTIMATED_BYTES_PER_LINE);
  let slots = 2;
  for (const text of [local, remote]) {
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10 && ++slots > maxSlots) return false;
    }
  }
  return slots <= maxSlots;
}


export function v4ReviewLineKey(sectionIndex: number, side: V4ReviewLineSide, lineIndex: number): string {
  return `${sectionIndex}:${side}:${lineIndex}`;
}
export function decodeV4ReviewText(bytes: Uint8Array): string | null {
  if (bytes.byteLength > V4_REVIEW_MAX_BYTES) return null;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text.includes("\0") ? null : text;
  } catch { return null; }
}

function* anchors(left: string[], right: string[], lo: number, hi: number, ro: number, rh: number): Generator<void, Array<{ i: number; j: number }>, void> {
  const counts = new Map<string, number>();
  const other = new Map<string, { count: number; pos: number }>();
  for (let i = lo; i < hi; i++) { const value = left[i]!; counts.set(value, (counts.get(value) ?? 0) + 1); if ((i & 4095) === 0) yield; }
  for (let j = ro; j < rh; j++) {
    const value = right[j]!;
    const old = other.get(value);
    other.set(value, old ? { count: old.count + 1, pos: old.pos } : { count: 1, pos: j });
    if ((j & 4095) === 0) yield;
  }
  const pairs: Array<{ i: number; j: number }> = [];
  for (let i = lo; i < hi; i++) {
    const value = left[i]!;
    if (counts.get(value) !== 1) continue;
    const o = other.get(value);
    if (o?.count === 1) pairs.push({ i, j: o.pos });
    if ((i & 4095) === 0) yield;
  }
  const previous = new Int32Array(pairs.length).fill(-1);
  const tails: number[] = [];
  for (let k = 0; k < pairs.length; k++) {
    let lo = 0, hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (pairs[tails[mid]!]!.j < pairs[k]!.j) lo = mid + 1;
      else hi = mid;
    }
    previous[k] = lo ? tails[lo - 1]! : -1;
    tails[lo] = k;
    if ((k & 4095) === 0) yield;
  }
  const ordered: Array<{ i: number; j: number }> = [];
  let at = tails.length ? tails[tails.length - 1]! : -1;
  while (at >= 0) { ordered.push(pairs[at]!); at = previous[at]!; }
  return ordered.reverse();
}

function* reviewSteps(local: string, remote: string): Generator<void, V4ReviewSection[], void> {
  const left = local.split("\n"), right = remote.split("\n");
  if (local === remote) return [{ kind: "common", lines: left }];
  const result: V4ReviewSection[] = [];
  const common = (line: string) => {
    const last = result[result.length - 1];
    if (last?.kind === "common") last.lines.push(line);
    else result.push({ kind: "common", lines: [line] });
  };
  const difference = (a: string[], b: string[]) => {
    if (!a.length && !b.length) return;
    const last = result[result.length - 1];
    if (last?.kind === "difference") { for (const line of a) last.localLines.push(line); for (const line of b) last.remoteLines.push(line); }
    else result.push({ kind: "difference", localLines: a, remoteLines: b });
  };
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) { common(left[prefix++]!); if ((prefix & 4095) === 0) yield; }
  let le = left.length, re = right.length;
  while (le > prefix && re > prefix && left[le - 1] === right[re - 1]) { le--; re--; if ((le & 4095) === 0) yield; }

  const gap = function* (lo: number, hi: number, ro: number, rh: number): Generator<void, void, void> {
    const ln = hi - lo, rn = rh - ro;
    if (!ln || !rn || (ln + 1) * (rn + 1) > GAP_CELLS) {
      difference(left.slice(lo, hi), right.slice(ro, rh));
      return;
    }
    const width = rn + 1;
    const matrix = new Uint16Array((ln + 1) * width);
    for (let i = ln - 1; i >= 0; i--) for (let j = rn - 1; j >= 0; j--) {
      matrix[i * width + j] = left[lo + i] === right[ro + j]
        ? matrix[(i + 1) * width + j + 1]! + 1
        : Math.max(matrix[(i + 1) * width + j]!, matrix[i * width + j + 1]!);
      if ((i * width + j & 4095) === 0) yield;
    }
    let i = 0, j = 0, a: string[] = [], b: string[] = [];
    const flush = () => { difference(a, b); a = []; b = []; };
    while (i < ln || j < rn) {
      if (i < ln && j < rn && left[lo + i] === right[ro + j]) {
        flush(); common(left[lo + i]!); i++; j++;
      } else if (i < ln && (j === rn || matrix[(i + 1) * width + j]! >= matrix[i * width + j + 1]!)) {
        a.push(left[lo + i++]!);
      } else b.push(right[ro + j++]!);
    }
    flush();
  };

  let li = prefix, ri = prefix;
  for (const anchor of yield* anchors(left, right, prefix, le, prefix, re)) {
    yield* gap(li, anchor.i, ri, anchor.j);
    common(left[anchor.i]!);
    li = anchor.i + 1; ri = anchor.j + 1;
  }
  yield* gap(li, le, ri, re);
  for (let i = le; i < left.length; i++) { common(left[i]!); if ((i & 4095) === 0) yield; }
  return result;
}

/** Deterministic synchronous entrypoint for planners/tests and small reviews. */
export function buildV4ConflictReview(local: string, remote: string): V4ReviewSection[] {
  const steps = reviewSteps(local, remote);
  let state = steps.next();
  while (!state.done) state = steps.next();
  return state.value;
}

/**
 * Cooperatively yield to Obsidian's UI between bounded units of diff work.
 * Never publish a partial plan; cancellation stops before a result is used.
 */
export async function buildV4ConflictReviewAsync(
  local: string, remote: string, signal?: AbortSignal,
): Promise<V4ReviewSection[]> {
  const steps = reviewSteps(local, remote);
  let state = steps.next();
  while (!state.done) {
    if (signal?.aborted) throw new Error("Conflict review cancelled");
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    state = steps.next();
  }
  if (signal?.aborted) throw new Error("Conflict review cancelled");
  return state.value;
}

export function mergeV4ReviewedLines(
  sections: readonly V4ReviewSection[], choices: ReadonlyMap<string, V4ReviewLineDecision>,
  defaults: ReadonlyMap<number, V4ReviewChoice> = new Map(),
): string | null {
  const lines: string[] = [];
  for (let index = 0; index < sections.length; index++) {
    const section = sections[index]!;
    if (section.kind === "common") { for (const line of section.lines) lines.push(line); continue; }
    for (const side of ["local", "remote"] as const) {
      const source = side === "local" ? section.localLines : section.remoteLines;
      const fallback = defaults.get(index);
      for (let i = 0; i < source.length; i++) {
        const decision = choices.get(v4ReviewLineKey(index, side, i))
          ?? (fallback === undefined ? undefined
            : fallback === "both" || fallback === side ? "keep" : "omit");
        if (!decision) return null;
        if (decision === "keep") lines.push(source[i]!);
      }
    }
  }
  return lines.join("\n");
}

export function mergeV4ReviewedSections(sections: readonly V4ReviewSection[], choices: ReadonlyMap<number, V4ReviewChoice>): string | null {
  const lines: string[] = [];
  let differenceIndex = 0;
  for (const section of sections) {
    if (section.kind === "common") { for (const line of section.lines) lines.push(line); }
    else {
      const choice = choices.get(differenceIndex++);
      if (!choice) return null;
      if (choice === "local" || choice === "both") for (const line of section.localLines) lines.push(line);
      if (choice === "remote" || choice === "both") for (const line of section.remoteLines) lines.push(line);
    }
  }
  return lines.join("\n");
}
