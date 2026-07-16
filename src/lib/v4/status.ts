import {
  formatV4PhaseLabel,
  remainingV4Progress,
  type V4DirectionalProgress,
  type V4SyncProgressSnapshot,
} from "./progress";

export interface V4StatusDisplay {
  text: string;
  title: string;
}

function formatCounter(progress: V4DirectionalProgress): string | undefined {
  if (progress.total === undefined) return progress.completed > 0 ? `${progress.completed}/?` : undefined;
  if (progress.total === 0 && progress.completed === 0) return undefined;
  return `${progress.completed}/${progress.total}`;
}

function formatCounterTitle(label: string, progress: V4DirectionalProgress): string | undefined {
  const counter = formatCounter(progress);
  if (!counter) return undefined;
  const remaining = remainingV4Progress(progress);
  return remaining === undefined ? `${label}: ${counter}` : `${label}: ${counter} · remaining ${remaining}`;
}

export function formatV4ActiveSyncStatus(snapshot: V4SyncProgressSnapshot): V4StatusDisplay {
  const phase = snapshot.phase ? formatV4PhaseLabel(snapshot.phase) : "Syncing";
  const pull = formatCounter(snapshot.pull);
  const push = formatCounter(snapshot.push);
  const counters = [pull && `↓${pull}`, push && `↑${push}`].filter((value): value is string => Boolean(value));
  const detailLines = [
    snapshot.currentPath && `Path: ${snapshot.currentPath}`,
    formatCounterTitle("Pull", snapshot.pull),
    formatCounterTitle("Push", snapshot.push),
  ].filter((value): value is string => Boolean(value));

  if (snapshot.lifecycle === "failed") {
    const failurePhase = snapshot.failurePhase ? formatV4PhaseLabel(snapshot.failurePhase) : phase;
    const failurePath = snapshot.failurePath ?? snapshot.currentPath;
    const title = [
      `Failed during ${failurePhase}`,
      failurePath && `Path: ${failurePath}`,
      formatCounterTitle("Pull", snapshot.pull),
      formatCounterTitle("Push", snapshot.push),
      snapshot.errorMessage && `Error: ${snapshot.errorMessage}`,
    ].filter((value): value is string => Boolean(value)).join("\n");
    return { text: "❌ GH Sync: Failed", title };
  }
  if (snapshot.lifecycle === "success") return { text: "✅ GH Sync: Success", title: ["Success", ...detailLines].join("\n") };
  if (snapshot.lifecycle === "no-change") return { text: "GH Sync: No changes", title: ["No changes", ...detailLines].join("\n") };
  if (snapshot.lifecycle === "idle") return { text: "GH Sync: Idle", title: "Idle" };

  const suffix = counters.length > 0 ? ` · ${counters.join(" ")}` : "…";
  return { text: `⏳ GH Sync: ${phase}${suffix}`, title: [phase, ...detailLines].join("\n") };
}
