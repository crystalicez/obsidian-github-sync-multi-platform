import assert from "node:assert/strict";
import test from "node:test";

import FastSync from "../../src/main";
import { createIdleV4Progress, type V4SyncProgressSnapshot } from "../../src/lib/v4/progress";
import { DEFAULT_SETTINGS } from "../../src/setting";
import { ElementStub } from "../stubs/obsidian";

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
  attempt: 1,
};

function createMainProgressFixture() {
  let snapshot = createIdleV4Progress();
  const listeners = new Set<(value: V4SyncProgressSnapshot) => void>();
  const unsubscribeCalls = { value: 0 };
  let disposed = false;
  let manualSyncCalls = 0;
  let busy = false;
  const runtime = {
    get progressSnapshot() { return snapshot; },
    get isSyncing() { return busy; },
    publishProgressForTest(value: V4SyncProgressSnapshot) {
      snapshot = value;
      for (const listener of [...listeners]) listener(value);
    },
    subscribeProgress(listener: (value: V4SyncProgressSnapshot) => void) {
      listeners.add(listener);
      listener(snapshot);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        listeners.delete(listener);
        unsubscribeCalls.value++;
      };
    },
    subscribeConflicts(listener: () => void) {
      listener();
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        unsubscribeCalls.value++;
      };
    },
    get hasPendingConflicts() { return false; },
    manualSync() { manualSyncCalls++; return Promise.resolve({}); },
    dispose() { disposed = true; },
    enqueueModify() {}, enqueueDelete() {}, enqueueFolderDelete() {}, enqueueRename() {}, enqueueFolderRename() {},
  };

  const plugin = new FastSync() as FastSync & Record<string, any>;
  const statusRoot = new ElementStub();
  const registered: Array<() => void> = [];
  plugin.app = {
    secretStorage: {},
    vault: { configDir: ".obsidian", getFiles: () => [], on: () => ({}) },
    workspace: { onLayoutReady: (callback: () => void) => callback() },
  };
  plugin.manifest = { id: "test" };
  plugin.loadSettings = async () => { plugin.settings = { ...DEFAULT_SETTINGS, statusBarStatusEnabled: true }; };
  plugin.persistData = async () => undefined;
  plugin.initGitHubClient = () => undefined;
  plugin.registerScheduledSync = () => undefined;
  plugin.updateRibbonIcon = () => undefined;
  plugin.addSettingTab = () => undefined;
  plugin.registerView = () => undefined;
  plugin.addCommand = () => undefined;
  plugin.registerEvent = () => undefined;
  plugin.register = (callback: () => void) => { registered.push(callback); return callback; };
  plugin.addStatusBarItem = () => statusRoot;
  plugin.addRibbonIcon = () => new ElementStub();
  plugin.createV4Runtime = () => runtime;
  const productionUnload = plugin.onunload.bind(plugin);
  plugin.onunload = () => { productionUnload(); for (const cleanup of registered.splice(0)) cleanup(); };

  const statusSpan = {
    get text() { return statusRoot.children[0]?.text ?? ""; },
    get title() { return statusRoot.children[0]?.title ?? ""; },
    click() { statusRoot.children[0]?.onclick?.(); },
  };
  return {
    plugin, runtime, statusSpan, unsubscribeCalls,
    get manualSyncCalls() { return manualSyncCalls; },
    setBusy(value: boolean) { busy = value; },
    get disposed() { return disposed; },
  };
}

test("status bar subscribes to detailed progress and cleans up once", async () => {
  const fixture = createMainProgressFixture();
  await fixture.plugin.onload();
  fixture.runtime.publishProgressForTest(uploadingFixture);
  assert.equal(fixture.statusSpan.text, "⏳ GH Sync: Uploading · ↓10/10 ↑2/7");
  assert.match(fixture.statusSpan.title, /Path: Notes\/project\.md/u);

  fixture.setBusy(true);
  fixture.statusSpan.click();
  assert.equal(fixture.manualSyncCalls, 0);
  fixture.setBusy(false);
  fixture.statusSpan.click();
  assert.equal(fixture.manualSyncCalls, 1);

  fixture.plugin.onunload();
  assert.equal(fixture.unsubscribeCalls.value, 2);
  assert.equal(fixture.disposed, true);
  fixture.statusSpan.click();
  assert.equal(fixture.manualSyncCalls, 1);
});

test("status bar skips timing-only and duplicate lifecycle DOM updates", async () => {
  const fixture = createMainProgressFixture();
  await fixture.plugin.onload();

  fixture.runtime.publishProgressForTest(uploadingFixture);
  const afterUploading = (fixture.plugin.statusBarItem as unknown as ElementStub).mutationCount;
  fixture.runtime.publishProgressForTest({
    ...uploadingFixture,
    timings: [{ phase: "uploading", elapsedMs: 1_000, occurrences: 1 }],
    totalElapsedMs: 1_000,
  });
  assert.equal((fixture.plugin.statusBarItem as unknown as ElementStub).mutationCount, afterUploading);

  for (const snapshot of [
    { ...createIdleV4Progress(), lifecycle: "waiting" as const, phase: "debouncing" as const },
    { ...createIdleV4Progress(), lifecycle: "active" as const, phase: "checking-remote" as const },
    { ...createIdleV4Progress(), lifecycle: "success" as const, lastSyncTime: 1 },
  ]) {
    fixture.runtime.publishProgressForTest(snapshot);
    const afterFirst = (fixture.plugin.statusBarItem as unknown as ElementStub).mutationCount;
    fixture.runtime.publishProgressForTest(structuredClone(snapshot));
    assert.equal((fixture.plugin.statusBarItem as unknown as ElementStub).mutationCount, afterFirst);
  }

  fixture.plugin.onunload();
});
