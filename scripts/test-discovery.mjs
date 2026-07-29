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

export function selectTests(discovered, { tier = "fast", filter = "" } = {}) {
  const normalizedFilter = normalizeTestPath(filter).toLowerCase();
  return discovered.filter(item => {
    if (item.tier !== tier) return false;
    if (!normalizedFilter) return true;
    return item.path.toLowerCase().includes(normalizedFilter);
  });
}
