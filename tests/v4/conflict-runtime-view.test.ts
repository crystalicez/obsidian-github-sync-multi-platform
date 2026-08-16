import assert from "node:assert/strict";
import test from "node:test";

import FastSync from "../../src/main";
import { V4ConflictResolutionCoordinator, type V4ConflictCoordinatorSnapshot } from "../../src/lib/v4/conflict-coordinator";
import { V4CancelledError } from "../../src/lib/v4/cancellation";
import { V4PluginRuntime } from "../../src/lib/v4/runtime";
import type { V4ConflictBatchRequest, V4ConflictFileResolution, V4ConflictFileSummary, V4ConflictMaterializedFile } from "../../src/lib/v4/conflict-types";
import { createIdleV4Progress } from "../../src/lib/v4/progress";
import { formatV4ActiveSyncStatus } from "../../src/lib/v4/status";
import { DEFAULT_SETTINGS } from "../../src/setting";
import { V4ConflictResolutionView, V4_CONFLICT_RESOLUTION_VIEW, effectiveV4ConflictViewMode } from "../../src/views/conflict-resolution";
import { V4PreviewObjectUrlBag } from "../../src/views/v4-diff-preview";
import { ElementStub, Platform, WorkspaceLeaf } from "../stubs/obsidian";

const enc = (value: string) => new TextEncoder().encode(value);
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function summary(fileId = "f", textCandidate = true): V4ConflictFileSummary {
  const base = { exists: true as const, path: "note.md", hash: "a".repeat(64), size: 2, mtime: 1 };
  const local = { ...base, hash: "b".repeat(64), mtime: 2 };
  const remote = { ...base, hash: "c".repeat(64), mtime: 3 };
  return { fileId, displayPath: "note.md", fingerprint: `fp-${fileId}`, base, local, remote, textCandidate, requiresReview: true };
}

function activeSnapshot(file = summary(), generation = 1): V4ConflictCoordinatorSnapshot {
  return { active: true, runId: "run", generation, contextKey: "ctx", expectedRemoteHead: "head", pending: true, canContinue: false, files: [{ summary: file, reviewed: false }] };
}

function fakePlugin(materialized: V4ConflictMaterializedFile, initial = activeSnapshot(materialized.summary, materialized.generation)) {
  let snapshot = initial;
  const listeners = new Set<(value: V4ConflictCoordinatorSnapshot) => void>();
  const resolutions: V4ConflictFileResolution[] = [];
  const reviewed = new Map<string, boolean>();
  let cancelled = 0;
  let continued = 0;
  const runtime = {
    get conflictSnapshot() { return snapshot; },
    get hasPendingConflicts() { return snapshot.pending; },
    subscribeConflicts(listener: (value: V4ConflictCoordinatorSnapshot) => void) { listeners.add(listener); listener(snapshot); return () => listeners.delete(listener); },
    materializeConflict: async () => materialized,
    setConflictResolution(resolution: V4ConflictFileResolution) { resolutions.push(resolution); },
    markConflictReviewed(fileId: string, value = true) { reviewed.set(fileId, value); },
    continueConflictResolution() { continued++; },
    cancelConflictResolution() { cancelled++; },
  };
  const app = { workspace: { getActiveFile: () => null } };
  const plugin = { app, settings: { ...DEFAULT_SETTINGS, conflictViewMode: "auto" as const }, v4Runtime: runtime, persistData: async () => undefined };
  return {
    plugin, runtime, resolutions, reviewed,
    get cancelled() { return cancelled; }, get continued() { return continued; },
    publish(value: V4ConflictCoordinatorSnapshot) { snapshot = value; for (const listener of [...listeners]) listener(value); },
  };
}

test("auto conflict view mode is split on desktop and unified on mobile", () => {
  assert.equal(effectiveV4ConflictViewMode("auto", true), "split");
  assert.equal(effectiveV4ConflictViewMode("auto", false), "unified");
  assert.equal(effectiveV4ConflictViewMode("unified", true), "unified");
});

test("text conflict action and manual edit update merged resolution", async () => {
  Platform.isDesktopApp = true;
  const file = summary();
  const fixture = fakePlugin({ generation: 1, summary: file, mode: "text", baseBytes: enc("x\n"), localBytes: enc("L\n"), remoteBytes: enc("R\n") });
  const view = new V4ConflictResolutionView(new WorkspaceLeaf(fixture.plugin.app), fixture.plugin as never);
  await view.onOpen();
  await flush();
  assert.ok(view.contentEl.findByClass("github-sync-conflicts__split"));
  view.contentEl.findByText("Local")?.onclick?.();
  const editor = view.contentEl.findByClass("github-sync-conflicts__merged-editor")!;
  assert.equal(editor.value, "L\n");
  assert.equal(fixture.resolutions.at(-1)?.kind, "merged");
  editor.value = "manual\n";
  editor.oninput?.();
  assert.equal(fixture.resolutions.at(-1)?.kind, "merged");
  const last = fixture.resolutions.at(-1);
  assert.equal(last?.kind === "merged" ? new TextDecoder().decode(last.bytes) : "", "manual\n");
  await view.onClose();
  assert.equal(fixture.cancelled, 0, "closing the pane must not cancel sync");
});

test("binary/file-level conflict keeps resolution actions enabled", async () => {
  const file = summary("bin", false);
  const fixture = fakePlugin({ generation: 1, summary: file, mode: "file", downgradeReason: "binary" }, activeSnapshot(file));
  const view = new V4ConflictResolutionView(new WorkspaceLeaf(fixture.plugin.app), fixture.plugin as never);
  await view.onOpen();
  await flush();
  assert.match(view.contentEl.flattenText(), /binary/u);
  view.contentEl.findByText("Use local")?.onclick?.();
  assert.equal(fixture.resolutions.at(-1)?.kind, "use-local");
  assert.equal(fixture.reviewed.get("bin"), true);
  view.contentEl.findByText("Cancel sync")?.onclick?.();
  assert.equal(fixture.cancelled, 1);
});

test("view renders harmless no-active-conflicts state", async () => {
  const file = summary();
  const fixture = fakePlugin({ generation: 1, summary: file, mode: "file" }, { active: false, pending: false, canContinue: false, files: [] });
  const view = new V4ConflictResolutionView(new WorkspaceLeaf(fixture.plugin.app), fixture.plugin as never);
  await view.onOpen();
  assert.match(view.contentEl.flattenText(), /No active conflicts/u);
});

test("stale materializer completion cannot overwrite a newer generation", async () => {
  const file = summary();
  let release!: (value: V4ConflictMaterializedFile) => void;
  const materialize = new Promise<V4ConflictMaterializedFile>(resolve => { release = resolve; });
  let snapshot = activeSnapshot(file, 1);
  const listeners = new Set<(value: V4ConflictCoordinatorSnapshot) => void>();
  const app = { workspace: { getActiveFile: () => null } };
  const plugin = {
    app, settings: { ...DEFAULT_SETTINGS, conflictViewMode: "auto" as const }, persistData: async () => undefined,
    v4Runtime: {
      get conflictSnapshot() { return snapshot; }, get hasPendingConflicts() { return snapshot.pending; },
      subscribeConflicts(listener: (value: V4ConflictCoordinatorSnapshot) => void) { listeners.add(listener); listener(snapshot); return () => listeners.delete(listener); },
      materializeConflict: async () => materialize,
      setConflictResolution() {}, markConflictReviewed() {}, continueConflictResolution() {}, cancelConflictResolution() {},
    },
  };
  const view = new V4ConflictResolutionView(new WorkspaceLeaf(app), plugin as never);
  await view.onOpen();
  snapshot = { active: false, pending: false, canContinue: false, files: [] };
  for (const listener of [...listeners]) listener(snapshot);
  release({ generation: 1, summary: file, mode: "text", baseBytes: enc("OLD"), localBytes: enc("OLD"), remoteBytes: enc("OLD") });
  await flush();
  assert.match(view.contentEl.flattenText(), /No active conflicts/u);
  assert.doesNotMatch(view.contentEl.flattenText(), /OLD/u);
});

test("preview URL bag revokes every tracked URL", () => {
  const original = URL.revokeObjectURL;
  const revoked: string[] = [];
  URL.revokeObjectURL = (value: string) => { revoked.push(value); };
  try {
    const bag = new V4PreviewObjectUrlBag();
    bag.track("blob:a"); bag.track("blob:b"); bag.clear();
    assert.deepEqual(revoked.sort(), ["blob:a", "blob:b"]);
  } finally { URL.revokeObjectURL = original; }
});

test("cancelled lifecycle has truthful status", () => {
  assert.equal(formatV4ActiveSyncStatus({ ...createIdleV4Progress(), lifecycle: "cancelled" }).text, "GH Sync: Cancelled");
});

test("default settings include auto conflict view mode", () => {
  assert.equal(DEFAULT_SETTINGS.conflictViewMode, "auto");
});

test("openConflictResolution reuses an existing resolver leaf", async () => {
  const plugin = new FastSync() as FastSync & Record<string, any>;
  const leaf = new WorkspaceLeaf();
  await leaf.setViewState({ type: V4_CONFLICT_RESOLUTION_VIEW, active: true });
  let rightLeafCalls = 0;
  let revealed = 0;
  plugin.app = { workspace: {
    getLeavesOfType: (type: string) => type === V4_CONFLICT_RESOLUTION_VIEW ? [leaf] : [],
    getRightLeaf: () => { rightLeafCalls++; return new WorkspaceLeaf(); },
    revealLeaf: async (value: WorkspaceLeaf) => { assert.equal(value, leaf); revealed++; },
  } };
  await plugin.openConflictResolution();
  assert.equal(rightLeafCalls, 0);
  assert.equal(revealed, 1);
});

test("status click prefers pending conflict workspace over starting another sync", () => {
  const plugin = new FastSync() as FastSync & Record<string, any>;
  const root = new ElementStub();
  let opened = 0;
  let manual = 0;
  plugin.settings = { ...DEFAULT_SETTINGS, statusBarStatusEnabled: true };
  plugin.addStatusBarItem = () => root;
  plugin.openConflictResolution = async () => { opened++; };
  plugin.v4Runtime = {
    progressSnapshot: { ...createIdleV4Progress(), lifecycle: "active", phase: "resolving-conflicts" },
    hasPendingConflicts: true,
    isSyncing: true,
    manualSync: () => { manual++; },
  };
  plugin.updateStatusBar();
  root.children[0]?.onclick?.();
  assert.equal(opened, 1);
  assert.equal(manual, 0);
});

test("coordinator remains the pending batch authority when a view unsubscribes", async () => {
  const coordinator = new V4ConflictResolutionCoordinator();
  const file = summary();
  const request: V4ConflictBatchRequest = { runId: "r", generation: 1, contextKey: "c", expectedRemoteHead: "h", files: [file], materialize: async () => ({ generation: 1, summary: file, mode: "file" }) };
  const pending = coordinator.resolveBatch(request);
  const unsubscribe = coordinator.subscribe(() => undefined);
  unsubscribe();
  assert.equal(coordinator.snapshot.pending, true);
  coordinator.cancel("test");
  await assert.rejects(pending);
});


test("saved sync-target settings cancel a pending runtime conflict batch", async () => {
  const coordinator = new V4ConflictResolutionCoordinator();
  const file = summary("settings");
  const request: V4ConflictBatchRequest = {
    runId: "settings-run", generation: 1, contextKey: "settings-context", expectedRemoteHead: "head", files: [file],
    materialize: async () => ({ generation: 1, summary: file, mode: "file" }),
  };
  const pending = coordinator.resolveBatch(request);
  const runtime = Object.create(V4PluginRuntime.prototype) as V4PluginRuntime & Record<string, any>;
  runtime.disposed = false;
  runtime.credentialGeneration = 1;
  runtime.conflictCoordinator = coordinator;
  runtime.keyringCache = { invalidate() {} };
  runtime.credentialsChanged();
  await assert.rejects(pending, V4CancelledError);
  assert.equal(coordinator.snapshot.active, false);
  assert.equal(runtime.credentialGeneration, 2);
});
