import assert from "node:assert/strict";
import test from "node:test";
import { WorkspaceLeaf, modalInstances, resetModalTestState } from "obsidian";
import { V4PluginRuntime } from "../../src/lib/v4/runtime";
import { V4SyncCenterView } from "../../src/views/sync-center";
import { createIdleV4Progress } from "../../src/lib/v4/progress";

test("Files sidebar displays authenticated inventory filters, tree and read-only safety copy", async () => {
  const plugin: any = {
    app: { workspace: { getActiveFile: () => null, openLinkText: () => undefined } },
    settings: { githubOwner: "owner", githubRepo: "repo", githubBranch: "test" },
    v4Runtime: {
      settingsGeneration: 1, progressSnapshot: createIdleV4Progress(),
      subscribeProgress: () => () => undefined,
      async fileOverview() {
        return { remoteCommitSha: "f".repeat(40), entries: [
          { path: "A/changed.md", status: "changed", local: true, remote: true },
          { path: "A/local.md", status: "local-only", local: true, remote: false },
          { path: "B/remote.md", status: "remote-only", local: false, remote: true },
          { path: "C/synced.md", status: "synced", local: true, remote: true },
        ] };
      },
      async manualSync() { throw new Error("File overview must never initiate sync"); },
    },
  };
  const view = new V4SyncCenterView(new WorkspaceLeaf(plugin.app), plugin);
  await view.onOpen();
  await (view as any).renderFilesMode();
  const tree = view.contentEl.findByClass("github-sync-center__file-list");
  assert.ok(tree);
  assert.match(tree.flattenText(), /4 files.*changed\.md.*local\.md.*remote\.md.*synced\.md/su);
  assert.equal(view.contentEl.findByText("All 4")?.attributes["aria-pressed"], "true");
  assert.equal(view.contentEl.findByText("Changed 1")?.attributes["aria-pressed"], "false");
  assert.match(view.contentEl.flattenText(), /Read-only overview/su);
  view.contentEl.findByText("Changed 1")?.onclick?.();
  assert.match(tree.flattenText(), /changed\.md/su);
  assert.doesNotMatch(tree.flattenText(), /local\.md|remote\.md|synced\.md/su);
  assert.equal(view.contentEl.findByText("Changed 1")?.attributes["aria-pressed"], "true");
  const toggle = view.contentEl.findByText("Tree view");
  assert.equal(toggle?.attributes["aria-pressed"], "true");
  toggle?.onclick?.();
  assert.equal(toggle?.attributes["aria-pressed"], "false");
  assert.match(tree.flattenText(), /A\/changed\.md/su);
  await view.onClose();
});

test("manual review requires every hunk choice and cancellation preserves no merged bytes", async () => {
  resetModalTestState();
  const runtime = Object.create(V4PluginRuntime.prototype) as any;
  runtime.plugin = { app: {} };
  const abort = new AbortController();
  const result = runtime.askConflict("notes.md", abort.signal,
    new TextEncoder().encode("common\nlocal A\nshared\nlocal B\nend"),
    new TextEncoder().encode("common\nremote A\nshared\nremote B\nend"));
  const modal = modalInstances.at(-1)!;
  const apply = modal.contentEl.findByText("Apply reviewed merge")!;
  assert.equal(apply.disabled, true);
  modal.contentEl.findByAttribute("aria-label", "Change 1: remote")?.onclick?.();
  assert.equal(apply.disabled, true);
  modal.contentEl.findByAttribute("aria-label", "Change 2: local")?.onclick?.();
  assert.equal(apply.disabled, false);
  apply.onclick?.();
  const merged = await result;
  assert.equal(merged.action, "merged");
  assert.equal(new TextDecoder().decode(merged.mergedBytes), "common\nremote A\nshared\nlocal B\nend");

  const cancelled = runtime.askConflict("notes.md", new AbortController().signal,
    new TextEncoder().encode("a"), new TextEncoder().encode("b"));
  modalInstances.at(-1)!.contentEl.findByText("Cancel")?.onclick?.();
  assert.deepEqual(await cancelled, { action: "ask" });
});

test("manual review remains safe when content is missing/binary, and abort closes modal", async () => {
  resetModalTestState();
  const runtime = Object.create(V4PluginRuntime.prototype) as any;
  runtime.plugin = { app: {} };
  const controller = new AbortController();
  const result = runtime.askConflict("binary.dat", controller.signal,
    new Uint8Array([0]), new Uint8Array([1]));
  const modal = modalInstances.at(-1)!;
  assert.equal(modal.contentEl.findByText("Apply reviewed merge"), undefined);
  assert.match(modal.contentEl.flattenText(), /available for small UTF-8 text files/u);
  controller.abort();
  assert.deepEqual(await result, { action: "ask" });
});
