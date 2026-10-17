/** Independent, bounded line-level manual conflict review; no third-party diff code. */
export type V4ReviewChoice = "local" | "remote" | "both" | "discard";
export type V4ReviewSection =
  | { kind: "common"; lines: string[] }
  | { kind: "difference"; localLines: string[]; remoteLines: string[] };


/** Each divergent line must be explicitly kept or omitted before Apply. */
export type V4ReviewLineDecision = "keep" | "omit";
export type V4ReviewLineSide = "local" | "remote";

/** Section indices are stable within the immutable side-by-side review. */
export function v4ReviewLineKey(sectionIndex: number, side: V4ReviewLineSide, lineIndex: number): string {
  return `${sectionIndex}:${side}:${lineIndex}`;
}

export function mergeV4ReviewedLines(
  sections: readonly V4ReviewSection[],
  choices: ReadonlyMap<string, V4ReviewLineDecision>,
): string | null {
  const lines: string[] = [];
  for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex++) {
    const section = sections[sectionIndex];
    if (section.kind === "common") {
      lines.push(...section.lines);
      continue;
    }
    // Preserves source order within each side; for arbitrary interleaving use
    // the explicitly editable final merge result before confirmation.
    for (const side of ["local", "remote"] as const) {
      const source = side === "local" ? section.localLines : section.remoteLines;
      for (let i = 0; i < source.length; i++) {
        const decision = choices.get(v4ReviewLineKey(sectionIndex, side, i));
        if (!decision) return null;
        if (decision === "keep") lines.push(source[i]);
      }
    }
  }
  return lines.join("\n");
}

export const V4_REVIEW_MAX_BYTES = 256 * 1024;
const MAX_LINES = 600;
const MAX_CELLS = 180_000;

/** Rendering individual line controls is bounded independently of file bytes. */
export function canReviewV4Lines(local: string, remote: string): boolean {
  const left = local.split("\n").length;
  const right = remote.split("\n").length;
  return left <= MAX_LINES && right <= MAX_LINES && left * right <= MAX_CELLS;
}

export function decodeV4ReviewText(bytes: Uint8Array): string | null {
  if (bytes.byteLength > V4_REVIEW_MAX_BYTES) return null;
  try {
    const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return value.includes("\0") ? null : value;
  } catch {
    return null;
  }
}

export function buildV4ConflictReview(local: string, remote: string): V4ReviewSection[] {
  const left = local.split("\n"), right = remote.split("\n");
  if (local === remote) return [{ kind: "common", lines: left }];
  if (left.length > MAX_LINES || right.length > MAX_LINES || left.length * right.length > MAX_CELLS) {
    return [{ kind: "difference", localLines: left, remoteLines: right }];
  }
  const width = right.length + 1;
  const dp = new Uint16Array((left.length + 1) * width);
  for (let i = left.length - 1; i >= 0; i--) for (let j = right.length - 1; j >= 0; j--) {
    dp[i * width + j] = left[i] === right[j]
      ? dp[(i + 1) * width + j + 1] + 1
      : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
  }
  const sections: V4ReviewSection[] = [];
  let i = 0, j = 0;
  const append = (kind: "common" | "difference", side: "local" | "remote", line: string) => {
    const previous = sections.at(-1);
    if (kind === "common") {
      if (previous?.kind === "common") previous.lines.push(line);
      else sections.push({ kind, lines: [line] });
    } else {
      if (previous?.kind === "difference") (side === "local" ? previous.localLines : previous.remoteLines).push(line);
      else sections.push({ kind, localLines: side === "local" ? [line] : [], remoteLines: side === "remote" ? [line] : [] });
    }
  };
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      append("common", "local", left[i++]);j++;
    } else if (i < left.length && (j === right.length || dp[(i + 1) * width + j] >= dp[i * width + j + 1])) {
      append("difference", "local", left[i++]);
    } else {
      append("difference", "remote", right[j++]);
    }
  }
  return sections;
}

export function mergeV4ReviewedSections(sections: readonly V4ReviewSection[], choices: ReadonlyMap<number, V4ReviewChoice>): string | null {
  const lines: string[] = [];
  let differenceIndex = 0;
  for (const section of sections) {
    if (section.kind === "common") lines.push(...section.lines);
    else {
      const choice = choices.get(differenceIndex++);
      if (!choice) return null;
      if (choice === "local" || choice === "both") lines.push(...section.localLines);
      if (choice === "remote" || choice === "both") lines.push(...section.remoteLines);
    }
  }
  return lines.join("\n");
}
