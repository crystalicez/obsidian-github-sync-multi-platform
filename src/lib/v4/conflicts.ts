export type V4ConflictPolicy = "copy" | "newer" | "merge" | "ask";
export type V4ConflictAction = "keep-local-copy-remote" | "use-local" | "use-remote" | "merged" | "ask";

export interface V4ConflictResolution {
  action: V4ConflictAction;
  mergedBytes?: Uint8Array;
}

const TEXT_EXTENSIONS = new Set(["md", "txt", "json", "canvas", "yaml", "yml", "csv", "css", "scss", "js", "ts", "tsx", "jsx", "html", "xml"]);
export const V4_MAX_MERGE_BYTES = 2 * 1024 * 1024;

export function canAttemptV4TextMerge(path: string, sizes: readonly number[]): boolean {
  const extension = path.split(".").at(-1)?.toLowerCase() ?? "";
  return TEXT_EXTENSIONS.has(extension) && sizes.every(size => Number.isSafeInteger(size) && size >= 0 && size <= V4_MAX_MERGE_BYTES);
}

interface LineChange { start: number; end: number; replacement: string[]; }

function lineChange(base: string[], variant: string[]): LineChange | null {
  let start = 0;
  while (start < base.length && start < variant.length && base[start] === variant[start]) start++;
  let baseEnd = base.length;
  let variantEnd = variant.length;
  while (baseEnd > start && variantEnd > start && base[baseEnd - 1] === variant[variantEnd - 1]) {
    baseEnd--;
    variantEnd--;
  }
  if (start === baseEnd && start === variantEnd) return null;
  return { start, end: baseEnd, replacement: variant.slice(start, variantEnd) };
}

function cleanThreeWayMerge(baseText: string, localText: string, remoteText: string): string | null {
  if (localText === remoteText) return localText;
  if (localText === baseText) return remoteText;
  if (remoteText === baseText) return localText;
  const base = baseText.split("\n");
  const local = lineChange(base, localText.split("\n"));
  const remote = lineChange(base, remoteText.split("\n"));
  if (!local) return remoteText;
  if (!remote) return localText;
  const disjoint = local.end <= remote.start || remote.end <= local.start;
  if (!disjoint) return null;
  const merged = [...base];
  for (const change of [local, remote].sort((a, b) => b.start - a.start)) {
    merged.splice(change.start, change.end - change.start, ...change.replacement);
  }
  return merged.join("\n");
}

function decodeText(bytes: Uint8Array): string | null {
  if (bytes.byteLength > V4_MAX_MERGE_BYTES) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function resolveV4Conflict(input: {
  policy: V4ConflictPolicy;
  path: string;
  localMtime: number;
  remoteMtime: number;
  baseBytes?: Uint8Array;
  localBytes?: Uint8Array;
  remoteBytes?: Uint8Array;
}): V4ConflictResolution {
  if (input.policy === "ask") return { action: "ask" };
  if (input.policy === "newer") {
    if (input.localMtime > input.remoteMtime) return { action: "use-local" };
    if (input.remoteMtime > input.localMtime) return { action: "use-remote" };
    return { action: "keep-local-copy-remote" };
  }
  if (input.policy === "merge") {
    if (input.baseBytes && input.localBytes && input.remoteBytes
      && canAttemptV4TextMerge(input.path, [input.baseBytes.byteLength, input.localBytes.byteLength, input.remoteBytes.byteLength])) {
      const base = decodeText(input.baseBytes);
      const local = decodeText(input.localBytes);
      const remote = decodeText(input.remoteBytes);
      if (base !== null && local !== null && remote !== null) {
        const merged = cleanThreeWayMerge(base, local, remote);
        if (merged !== null) return { action: "merged", mergedBytes: new TextEncoder().encode(merged) };
      }
    }
  }
  return { action: "keep-local-copy-remote" };
}
