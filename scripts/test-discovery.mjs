import { readdir } from "node:fs/promises";
import path from "node:path";

const TEST_FILE_RE = /\.test\.(?:ts|mjs)$/u;
const TIER_SEGMENTS = new Map([
  ["github-e2e", "github-e2e"],
  ["feasibility", "feasibility"],
  ["resource", "resource"],
  ["recovery", "recovery"],
  ["soak", "soak"],
  ["device", "device"],
]);

export function normalizeTestPath(value) {
  return value.split(path.sep).join("/").replace(/^\.\//u, "");
}

export function classifyTestPath(value) {
  const normalized = normalizeTestPath(value);
  const segments = normalized.split("/");
  for (const segment of segments) {
    const tier = TIER_SEGMENTS.get(segment);
    if (tier) return tier;
  }
  return "fast";
}

async function walk(directory, root, output) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(absolute, root, output);
      continue;
    }
    if (!entry.isFile() || !TEST_FILE_RE.test(entry.name)) continue;
    const relative = normalizeTestPath(path.relative(root, absolute));
    output.push({ path: relative, tier: classifyTestPath(relative) });
  }
}

export async function discoverTests(root) {
  const output = [];
  await walk(path.join(root, "tests"), root, output);
  output.sort((a, b) => a.path.localeCompare(b.path));
  return output;
}

/**
 * Deterministic one-based file partitions after tier/filter selection.
 * Across 1..total, every selected file appears exactly once. This never
 * filters individual tests from a file and keeps unsharded runs unchanged.
 */
export function shardSelectedTests(selected, shard = "") {
  if (!shard) return selected;
  const match = /^([1-9]\d*)\/([1-9]\d*)$/u.exec(shard);
  if (!match) throw new RangeError("Invalid --shard: expected INDEX/TOTAL, starting at 1.");
  const index = Number(match[1]);
  const total = Number(match[2]);
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(total)
    || total > 128 || index > total || total > selected.length) {
    throw new RangeError("Invalid --shard: require 1 <= INDEX <= TOTAL <= selected file count and TOTAL <= 128.");
  }
  return selected.filter((_, position) => position % total === index - 1);
}

export function selectTests(discovered, { tier = "fast", filter = "" } = {}) {
  const normalizedFilter = normalizeTestPath(filter).toLowerCase();
  return discovered.filter(item => {
    if (item.tier !== tier) return false;
    if (!normalizedFilter) return true;
    return item.path.toLowerCase().includes(normalizedFilter);
  });
}
