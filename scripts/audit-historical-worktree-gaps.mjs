#!/usr/bin/env node
/**
 * Read-only source-path gap inventory across registered worktrees and audit refs.
 * This is a triage aid, NOT proof that historical implementations must be merged:
 * patches may have been rewritten, moved, rejected or superseded.
 * No filesystem scan outside Git objects, no Git mutation or network access.
 */
import { execFileSync } from "node:child_process";

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 12 * 1024 * 1024 }).trim();
}
function oldSourcePaths(sha) {
  return new Set(git("ls-tree", "-r", "--name-only", sha, "--", "src").split(/\r?\n/u).filter(Boolean));
}
const currentSha = git("rev-parse", "HEAD");
const currentPaths = oldSourcePaths(currentSha);
const auditRefs = git("for-each-ref", "--format=%(refname:short)%09%(objectname)", "refs/heads/audit")
  .split(/\r?\n/u).filter(Boolean).map(line => {
    const [label, sha] = line.split("\t");
    if (!label || !sha) throw new Error("Invalid local audit ref output");
    return { label, sha, kind: "audit-ref" };
  });
const worktrees = git("worktree", "list", "--porcelain").split(/\r?\n\r?\n/u).filter(Boolean)
  .map(entry => {
    const lines = entry.split(/\r?\n/u);
    const dir = lines.find(line => line.startsWith("worktree "))?.slice(9);
    const sha = lines.find(line => line.startsWith("HEAD "))?.slice(5);
    if (!dir || !sha) throw new Error("Invalid git worktree list output");
    const branch = lines.find(line => line.startsWith("branch "))?.slice(7) ?? "detached";
    return { label: `${branch}@${dir}`, sha, kind: "registered-worktree" };
  });
const bySha = new Map();
for (const entry of [...auditRefs, ...worktrees]) {
  if (!bySha.has(entry.sha)) bySha.set(entry.sha, { sha: entry.sha, labels: [], kinds: new Set() });
  const item = bySha.get(entry.sha);
  item.labels.push(entry.label);
  item.kinds.add(entry.kind);
}
const absent = new Map();
let examined = 0;
for (const ref of bySha.values()) {
  if (ref.sha === currentSha) continue;
  examined++;
  for (const path of oldSourcePaths(ref.sha)) {
    if (currentPaths.has(path)) continue;
    if (!absent.has(path)) absent.set(path, { path, snapshotCount: 0, examples: [] });
    const gap = absent.get(path);
    gap.snapshotCount++;
    if (gap.examples.length < 3) gap.examples.push(ref.labels[0]);
  }
}
const rows = [...absent.values()].sort((a, b) => b.snapshotCount - a.snapshotCount || a.path.localeCompare(b.path));
const summary = {
  candidateSha: currentSha,
  auditRefCount: auditRefs.length,
  registeredWorktreeCount: worktrees.length,
  distinctHistoricalTipsCompared: examined,
  historicalSourcePathsNotPresentAtHead: rows.length,
  warning: "Path-only presence analysis. Never merge branches blindly; identical paths may contain divergent behavior and absent paths may have replacements or intentionally discarded PoCs.",
  gaps: rows,
};
process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
