import {
  decodeV4TextDocument,
  diffV4TextLines,
  type V4LineChange,
  type V4LineToken,
  type V4TextDocument,
} from "./text-diff";

export type V4MergeResolution =
  | "unresolved"
  | "accepted-local"
  | "accepted-remote"
  | "accepted-both"
  | "discarded-both"
  | "manually-resolved"
  | "auto";

export type V4MergeHunkAction = Extract<
  V4MergeResolution,
  "accepted-local" | "accepted-remote" | "accepted-both" | "discarded-both"
>;

export interface V4MergeHunk {
  id: string;
  kind: "auto" | "conflict";
  baseStart: number;
  baseEnd: number;
  baseText: string;
  localText: string;
  remoteText: string;
  from: number;
  to: number;
  resolution: V4MergeResolution;
}

export interface V4ConflictMergeModel {
  readonly text: string;
  readonly hunks: readonly V4MergeHunk[];
  readonly unresolvedCount: number;
  applyHunkAction(id: string, action: V4MergeHunkAction): void;
  applyManualText(text: string): void;
  reset(): void;
  toBytes(): Uint8Array;
}

type Side = "local" | "remote";
interface TaggedChange { side: Side; change: V4LineChange; }
interface ChangeGroup { baseStart: number; baseEnd: number; entries: TaggedChange[]; }

function renderTokens(tokens: readonly V4LineToken[]): string {
  let value = "";
  for (const token of tokens) value += token.text + token.eol;
  return value;
}

function sameTokens(left: readonly V4LineToken[], right: readonly V4LineToken[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((token, index) => token.text === right[index].text && token.eol === right[index].eol);
}

function resolvedBom(base: V4TextDocument, local: V4TextDocument, remote: V4TextDocument): "" | "\uFEFF" {
  if (local.bom === remote.bom) return local.bom;
  if (local.bom === base.bom) return remote.bom;
  if (remote.bom === base.bom) return local.bom;
  return base.bom;
}

function rangesOverlap(group: ChangeGroup, change: V4LineChange): boolean {
  const groupEmpty = group.baseStart === group.baseEnd;
  const changeEmpty = change.baseStart === change.baseEnd;
  if (groupEmpty && changeEmpty) return group.baseStart === change.baseStart;
  if (groupEmpty) return change.baseStart < group.baseStart && group.baseStart < change.baseEnd;
  if (changeEmpty) return group.baseStart < change.baseStart && change.baseStart < group.baseEnd;
  return change.baseStart < group.baseEnd && change.baseEnd > group.baseStart;
}

function buildGroups(local: readonly V4LineChange[], remote: readonly V4LineChange[]): ChangeGroup[] {
  const entries: TaggedChange[] = [
    ...local.map(change => ({ side: "local" as const, change })),
    ...remote.map(change => ({ side: "remote" as const, change })),
  ].sort((left, right) => {
    if (left.change.baseStart !== right.change.baseStart) return left.change.baseStart - right.change.baseStart;
    const leftWidth = left.change.baseEnd - left.change.baseStart;
    const rightWidth = right.change.baseEnd - right.change.baseStart;
    if (leftWidth !== rightWidth) return leftWidth - rightWidth;
    return left.side.localeCompare(right.side);
  });

  const groups: ChangeGroup[] = [];
  for (const entry of entries) {
    const current = groups.at(-1);
    if (current && rangesOverlap(current, entry.change)) {
      current.baseStart = Math.min(current.baseStart, entry.change.baseStart);
      current.baseEnd = Math.max(current.baseEnd, entry.change.baseEnd);
      current.entries.push(entry);
    } else {
      groups.push({ baseStart: entry.change.baseStart, baseEnd: entry.change.baseEnd, entries: [entry] });
    }
  }
  return groups;
}

function sideResult(base: readonly V4LineToken[], group: ChangeGroup, side: Side): V4LineToken[] {
  const changes = group.entries
    .filter(entry => entry.side === side)
    .map(entry => entry.change)
    .sort((a, b) => a.baseStart - b.baseStart || a.baseEnd - b.baseEnd);
  if (changes.length === 0) return base.slice(group.baseStart, group.baseEnd);

  const result: V4LineToken[] = [];
  let cursor = group.baseStart;
  for (const change of changes) {
    if (cursor < change.baseStart) result.push(...base.slice(cursor, change.baseStart));
    result.push(...change.replacement);
    cursor = Math.max(cursor, change.baseEnd);
  }
  if (cursor < group.baseEnd) result.push(...base.slice(cursor, group.baseEnd));
  return result;
}

function cloneHunk(hunk: V4MergeHunk): V4MergeHunk { return { ...hunk }; }

function editTouchesHunk(hunk: V4MergeHunk, start: number, end: number): boolean {
  if (hunk.from === hunk.to) return start === end ? start === hunk.from : start <= hunk.from && hunk.from <= end;
  if (start === end) return hunk.from <= start && start < hunk.to;
  return start < hunk.to && end > hunk.from;
}

class MergeModel implements V4ConflictMergeModel {
  private value: string;
  private state: V4MergeHunk[];
  private readonly originalValue: string;
  private readonly originalState: V4MergeHunk[];

  constructor(input: { baseBytes: Uint8Array; localBytes: Uint8Array; remoteBytes: Uint8Array }) {
    const base = decodeV4TextDocument(input.baseBytes);
    const local = decodeV4TextDocument(input.localBytes);
    const remote = decodeV4TextDocument(input.remoteBytes);
    const groups = buildGroups(diffV4TextLines(base, local), diffV4TextLines(base, remote));

    let output = resolvedBom(base, local, remote);
    let baseCursor = 0;
    const hunks: V4MergeHunk[] = [];
    for (let index = 0; index < groups.length; index++) {
      const group = groups[index];
      output += renderTokens(base.lines.slice(baseCursor, group.baseStart));

      const baseTokens = base.lines.slice(group.baseStart, group.baseEnd);
      const localTokens = sideResult(base.lines, group, "local");
      const remoteTokens = sideResult(base.lines, group, "remote");
      const localChanged = group.entries.some(entry => entry.side === "local");
      const remoteChanged = group.entries.some(entry => entry.side === "remote");
      const conflict = localChanged && remoteChanged && !sameTokens(localTokens, remoteTokens);
      const selected = conflict ? baseTokens : localChanged ? localTokens : remoteTokens;
      const from = output.length;
      output += renderTokens(selected);

      hunks.push({
        id: `h${index}:${group.baseStart}:${group.baseEnd}`,
        kind: conflict ? "conflict" : "auto",
        baseStart: group.baseStart,
        baseEnd: group.baseEnd,
        baseText: renderTokens(baseTokens),
        localText: renderTokens(localTokens),
        remoteText: renderTokens(remoteTokens),
        from,
        to: output.length,
        resolution: conflict ? "unresolved" : "auto",
      });
      baseCursor = group.baseEnd;
    }
    output += renderTokens(base.lines.slice(baseCursor));

    this.value = output;
    this.state = hunks;
    this.originalValue = output;
    this.originalState = hunks.map(cloneHunk);
  }

  get text(): string { return this.value; }
  get hunks(): readonly V4MergeHunk[] { return this.state.map(cloneHunk); }
  get unresolvedCount(): number {
    return this.state.reduce((count, hunk) => count + (hunk.kind === "conflict" && hunk.resolution === "unresolved" ? 1 : 0), 0);
  }

  applyHunkAction(id: string, action: V4MergeHunkAction): void {
    const target = this.state.find(hunk => hunk.id === id);
    if (!target || target.kind !== "conflict") throw new Error(`Unknown V4 conflict hunk: ${id}`);
    const replacement = action === "accepted-local"
      ? target.localText
      : action === "accepted-remote"
        ? target.remoteText
        : action === "accepted-both"
          ? target.localText + target.remoteText
          : target.baseText;

    const start = target.from;
    const end = target.to;
    const delta = replacement.length - (end - start);
    this.value = this.value.slice(0, start) + replacement + this.value.slice(end);
    target.to = start + replacement.length;
    target.resolution = action;

    for (const hunk of this.state) {
      if (hunk === target) continue;
      if (hunk.from >= end) {
        hunk.from += delta;
        hunk.to += delta;
      }
    }
  }

  applyManualText(next: string): void {
    if (next === this.value) return;
    const previous = this.value;
    let start = 0;
    while (start < previous.length && start < next.length && previous.charCodeAt(start) === next.charCodeAt(start)) start++;
    let oldEnd = previous.length;
    let newEnd = next.length;
    while (oldEnd > start && newEnd > start && previous.charCodeAt(oldEnd - 1) === next.charCodeAt(newEnd - 1)) {
      oldEnd--;
      newEnd--;
    }

    const oldLength = oldEnd - start;
    const newLength = newEnd - start;
    const delta = newLength - oldLength;
    for (const hunk of this.state) {
      if (hunk.kind === "conflict" && hunk.resolution === "unresolved" && editTouchesHunk(hunk, start, oldEnd)) {
        hunk.resolution = "manually-resolved";
      }

      if (oldLength === 0) {
        const insertionInside = (hunk.from === hunk.to && hunk.from === start)
          || (hunk.from <= start && start < hunk.to);
        if (insertionInside) {
          hunk.to += newLength;
        } else if (hunk.from >= start) {
          hunk.from += newLength;
          hunk.to += newLength;
        }
        continue;
      }

      const mapBoundary = (position: number, right: boolean): number => {
        if (position <= start) return position;
        if (position >= oldEnd) return position + delta;
        const offset = ((position - start) * newLength) / oldLength;
        return start + (right ? Math.ceil(offset) : Math.floor(offset));
      };
      hunk.from = mapBoundary(hunk.from, false);
      hunk.to = Math.max(hunk.from, mapBoundary(hunk.to, true));
    }
    this.value = next;
  }

  reset(): void {
    this.value = this.originalValue;
    this.state = this.originalState.map(cloneHunk);
  }

  toBytes(): Uint8Array { return new TextEncoder().encode(this.value); }
}

export function createV4ConflictMergeModel(input: {
  baseBytes: Uint8Array;
  localBytes: Uint8Array;
  remoteBytes: Uint8Array;
}): V4ConflictMergeModel {
  return new MergeModel(input);
}
