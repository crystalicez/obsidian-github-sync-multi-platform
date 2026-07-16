import assert from "node:assert/strict";
import test from "node:test";

import { WorkspaceLeaf } from "obsidian";
import { createIdleV4Progress, V4ProgressStore, type V4SyncProgressSnapshot } from "../../src/lib/v4/progress";
import { V4SyncCenterView } from "../../src/views/sync-center";

const uploadingFixture: V4SyncProgressSnapshot = {
  ...createIdleV4Progress(),
  lifecycle: "active",
  phase: "uploading",
  currentPath: "Notes/project.md",
  currentDirection: "push",
  pull: { completed: 10, total: 10 },
  push: { completed: 2, total: 7 },
  operation: "normal",
  trigger: "manual",
  attempt: 2,
  timings: [
    { phase: "checking-remote", elapsedMs: 2_400, occurrences: 2 },
    { phase: "encrypting", elapsedMs: 1_200, occurrences: 1 },
  ],
  totalElapsedMs: 8_900,
};

class FakeProgressSource {
  progressSnapshot = createIdleV4Progress();
  private listeners = new Set<(snapshot: V4SyncProgressSnapshot) => void>();
  unsubscribeCalls = 0;
  subscribeProgress(listener: (snapshot: V4SyncProgressSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.progressSnapshot);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.listeners.delete(listener);
      this.unsubscribeCalls++;
    };
  }
  publish(snapshot: V4SyncProgressSnapshot): void {
    this.progressSnapshot = snapshot;
    for (const listener of [...this.listeners]) listener(snapshot);
  }
}

function createSyncCenterPluginFixture(source: FakeProgressSource | { progressSnapshot: V4SyncProgressSnapshot; subscribeProgress(listener: (snapshot: V4SyncProgressSnapshot) => void): () => void }, onHistoryLoad: () => void) {
  const commit = { sha: "abc12345", message: "sync", authoredAt: "2026-07-16", source: "plugin" } as const;
  const service = {
    async listCommits() { onHistoryLoad(); return { items: [commit], hasMore: true }; },
    async getCommitChanges() { return []; },
    async getFileVersions() { return []; },
    async previewChange() { throw new Error("not used"); },
  };
  const app = { workspace: { getActiveFile: () => ({ path: "Notes/project.md" }) } };
  const runtime = Object.assign(source, {
    async createHistoryService() { return service; },
    async fileIdForPath() { return "file-id"; },
    async manualSync() { return {}; },
  });
  return { app, v4Runtime: runtime };
}

test("Sync Center progress card updates in isolation and unsubscribes on close", async () => {
  const source = new FakeProgressSource();
  let historyLoadCount = 0;
  const plugin = createSyncCenterPluginFixture(source, () => { historyLoadCount++; });
  const view = new V4SyncCenterView(new WorkspaceLeaf(plugin.app), plugin as never);
  await view.onOpen();
  source.publish(uploadingFixture);
  assert.match(view.contentEl.flattenText(), /Uploading.*Pull 10\/10.*Push 2\/7.*Notes\/project\.md.*Total 8\.9s.*Checking remote 2\.4s · 2 attempts.*Encryption 1\.2s/su);
  assert.match(view.contentEl.flattenText(), /Normal.*Manual.*Attempt 2/su);
  assert.equal(historyLoadCount, 1);

  const state = view as unknown as { page: number; selected?: unknown };
  state.page = 3;
  state.selected = { sha: "selected" };
  view.contentEl.findByText("Current file")?.onclick?.();
  await Promise.resolve();
  source.publish({ ...uploadingFixture, phase: "committing", currentPath: undefined });
  assert.equal(state.page, 3);
  assert.deepEqual(state.selected, { sha: "selected" });
  assert.equal(historyLoadCount, 1);

  const rendersBeforeClose = view.contentEl.mutationCount;
  await view.onClose();
  source.publish({ ...uploadingFixture, phase: "committing", currentPath: undefined });
  assert.equal(view.contentEl.mutationCount, rendersBeforeClose);
  assert.equal(source.unsubscribeCalls, 1);
});

test("Sync Center shows failure context and does not duplicate subscriptions", async () => {
  const source = new FakeProgressSource();
  const plugin = createSyncCenterPluginFixture(source, () => undefined);
  const view = new V4SyncCenterView(new WorkspaceLeaf(plugin.app), plugin as never);
  await view.onOpen();
  await view.onOpen();
  source.publish({
    ...uploadingFixture,
    lifecycle: "failed",
    failurePhase: "uploading",
    failurePath: "Notes/project.md",
    errorMessage: "network down",
    lastSyncTime: Date.UTC(2026, 6, 16, 12, 0, 0),
  });
  assert.match(view.contentEl.flattenText(), /Failed.*Uploading.*Notes\/project\.md.*network down/su);
  await view.onClose();
  assert.equal(source.unsubscribeCalls, 2);
});

test("store timing ticks update only the live card and stop after close", async () => {
  let now = 0;
  let nextId = 1;
  const scheduled = new Map<number, { callback: () => void; delay: number }>();
  const store = new V4ProgressStore({
    monotonicNow: () => now,
    schedule(callback, delay) { const id = nextId++; scheduled.set(id, { callback, delay }); return id; },
    cancel(handle) { scheduled.delete(handle as number); },
  });
  const source = {
    get progressSnapshot() { return store.snapshot; },
    subscribeProgress(listener: (snapshot: V4SyncProgressSnapshot) => void) { return store.subscribe(listener); },
  };
  let historyLoadCount = 0;
  const plugin = createSyncCenterPluginFixture(source, () => { historyLoadCount++; });
  const view = new V4SyncCenterView(new WorkspaceLeaf(plugin.app), plugin as never);
  await view.onOpen();
  store.beginRun({ phase: "checking-remote", operation: "normal", trigger: "manual", attempt: 1 });
  const mutationsBeforeTick = view.contentEl.mutationCount;
  const timer = [...scheduled.entries()].find(([, item]) => item.delay === 1_000);
  assert.ok(timer);
  scheduled.delete(timer[0]);
  now = 1_000;
  timer[1].callback();
  assert.ok(view.contentEl.mutationCount > mutationsBeforeTick);
  assert.equal(historyLoadCount, 1);
  assert.match(view.contentEl.flattenText(), /Checking remote 1\.0s/u);

  await view.onClose();
  const mutationsAfterClose = view.contentEl.mutationCount;
  const nextTimer = [...scheduled.entries()].find(([, item]) => item.delay === 1_000);
  assert.ok(nextTimer);
  scheduled.delete(nextTimer[0]);
  now = 2_000;
  nextTimer[1].callback();
  assert.equal(view.contentEl.mutationCount, mutationsAfterClose);
  assert.equal(historyLoadCount, 1);
  store.dispose();
});
