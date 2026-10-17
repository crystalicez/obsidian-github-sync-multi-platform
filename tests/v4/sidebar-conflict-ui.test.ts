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
  // Product decision: no per-file Remove or bulk Delete (N) action.
  // Status labels such as "Deleted remotely" are informational only.
  assert.equal(view.contentEl.findByText("Remove"), undefined);
  assert.equal(view.contentEl.findByText("Delete"), undefined);
  assert.equal(view.contentEl.findByText("Delete (2)"), undefined);
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


test("tracked deletions appear as Changed with explicit sync-risk warnings in the native sidebar", async () => {
  const plugin: any = {
    githubClient: {},
    app: { workspace: { getActiveFile: () => null, openLinkText: () => undefined } },
    settings: { githubOwner: "owner", githubRepo: "repo", githubBranch: "test" },
    v4Runtime: {
      settingsGeneration: 1, progressSnapshot: createIdleV4Progress(),
      subscribeProgress: () => () => undefined,
      async fileOverview() {
        return { remoteCommitSha: "f".repeat(40), entries: [
          { path: "tracked/local-deleted.md", status: "changed", reason: "local-deleted", local: false, remote: true },
          { path: "tracked/remote-deleted.md", status: "changed", reason: "remote-deleted", local: true, remote: false },
        ] };
      },
    },
  };
  const view = new V4SyncCenterView(new WorkspaceLeaf(plugin.app), plugin);
  await view.onOpen();
  assert.ok(view.contentEl.findByText("Changed 2"));
  assert.equal(view.contentEl.findByText("Local only 0")?.attributes["aria-pressed"], "false");
  const localMissing = view.contentEl.findByAttribute("aria-label", "tracked/local-deleted.md, Deleted locally");
  assert.ok(localMissing);
  localMissing.onclick?.();
  assert.match(view.contentEl.findByClass("github-sync-center__detail")!.flattenText(), /may propagate this deletion to GitHub/u);
  const remoteMissing = view.contentEl.findByAttribute("aria-label", "tracked/remote-deleted.md, Deleted remotely");
  assert.ok(remoteMissing);
  remoteMissing.onclick?.();
  assert.match(view.contentEl.findByClass("github-sync-center__detail")!.flattenText(), /may remove the local file/u);
  await view.onClose();
});

test("remote rename lineage uses a stable file ID and never shows a deletion or unrelated download badge", async () => {
  const plugin: any = {
    githubClient: {},
    app: { workspace: { getActiveFile: () => null, openLinkText: () => undefined } },
    settings: { githubOwner: "owner", githubRepo: "repo", githubBranch: "test" },
    v4Runtime: {
      settingsGeneration: 1, progressSnapshot: createIdleV4Progress(),
      subscribeProgress: () => () => undefined,
      async fileOverview() {
        return { remoteCommitSha: "a".repeat(40), entries: [
          { path: "Notes/old.md", status: "changed", reason: "remote-renamed-from", relatedPath: "Archive/new.md", local: true, remote: false },
          { path: "Archive/new.md", status: "changed", reason: "remote-renamed-to", relatedPath: "Notes/old.md", local: false, remote: true },
        ] };
      },
    },
  };
  const view = new V4SyncCenterView(new WorkspaceLeaf(plugin.app), plugin);
  await view.onOpen();
  assert.equal(view.contentEl.findByText("Changed 2")?.attributes["aria-pressed"], "false");
  assert.ok(view.contentEl.findByAttribute("aria-label", "Notes/old.md, Moved on GitHub"));
  assert.ok(view.contentEl.findByAttribute("aria-label", "Archive/new.md, Renamed on GitHub"));
  assert.match(view.contentEl.flattenText(), /Moved on GitHub/u);
  assert.doesNotMatch(view.contentEl.flattenText(), /Deleted locally|Deleted remotely|Remote only [1-9]/u);
  view.contentEl.findByAttribute("aria-label", "Notes/old.md, Moved on GitHub")?.onclick?.();
  assert.match(view.contentEl.findByClass("github-sync-center__detail")!.flattenText(), /moved this tracked file to Archive\/new.md/u);
  view.contentEl.findByAttribute("aria-label", "Archive/new.md, Renamed on GitHub")?.onclick?.();
  assert.match(view.contentEl.findByClass("github-sync-center__detail")!.flattenText(), /Previously synchronized as Notes\/old.md/u);
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


test("one changed block permits independent per-line decisions and an explicitly editable merge result", async () => {
  resetModalTestState();
  const runtime = Object.create(V4PluginRuntime.prototype) as any;
  runtime.plugin = { app: {} };
  const result = runtime.askConflict("same-hunk.md", new AbortController().signal,
    new TextEncoder().encode("shared\nlocal one\nlocal two\nend"),
    new TextEncoder().encode("shared\nremote one\nremote two\nend"));
  const modal = modalInstances.at(-1)!;
  const apply = modal.contentEl.findByText("Apply reviewed merge")!;
  const output = modal.contentEl.findByAttribute("aria-label", "Editable merged result")!;
  assert.equal(apply.disabled, true);
  assert.equal(output.disabled, true);
  for (const [label, value] of [
    ["Change 1 local line 1: keep", true],
    ["Change 1 local line 2: omit", true],
    ["Change 1 remote line 1: omit", true],
  ] as const) {
    const button = modal.contentEl.findByAttribute("aria-label", label)!;
    button.onclick?.();
    assert.equal(button.attributes["aria-pressed"], String(value));
    assert.equal(apply.disabled, true);
  }
  modal.contentEl.findByAttribute("aria-label", "Change 1 remote line 2: keep")!.onclick?.();
  assert.equal(apply.disabled, false);
  assert.equal(output.value, "shared\nlocal one\nremote two\nend");
  output.value = "shared\nmy own edited combination\nend";
  output.oninput?.();
  assert.equal(output.value, "shared\nmy own edited combination\nend");
  // Changing a line choice cannot silently erase manual text edits.
  modal.contentEl.findByAttribute("aria-label", "Change 1 remote line 1: keep")!.onclick?.();
  assert.equal(output.value, "shared\nmy own edited combination\nend");
  modal.contentEl.findByAttribute("aria-label", "Discard manual edits and restore selected lines")!.onclick?.();
  assert.equal(output.value, "shared\nlocal one\nremote one\nremote two\nend");
  output.value = "shared\nchosen text with ✨\nend";
  output.oninput?.();
  apply.onclick?.();
  const outcome = await result;
  assert.equal(outcome.action, "merged");
  assert.equal(new TextDecoder().decode(outcome.mergedBytes), "shared\nchosen text with ✨\nend");
});

test("an oversized hand-edited merge cannot be applied and cancellation leaves no writes", async () => {
  resetModalTestState();
  const runtime = Object.create(V4PluginRuntime.prototype) as any;
  runtime.plugin = { app: {} };
  const result = runtime.askConflict("oversize.md", new AbortController().signal,
    new TextEncoder().encode("a"), new TextEncoder().encode("b"));
  const modal = modalInstances.at(-1)!;
  modal.contentEl.findByAttribute("aria-label", "Change 1: remote")!.onclick?.();
  const apply = modal.contentEl.findByText("Apply reviewed merge")!;
  assert.equal(apply.disabled, false);
  const output = modal.contentEl.findByAttribute("aria-label", "Editable merged result")!;
  output.value = "🔐".repeat(8_500_000);
  output.oninput?.();
  assert.equal(apply.disabled, true);
  apply.onclick?.();
  modal.contentEl.findByText("Cancel")!.onclick?.();
  assert.deepEqual(await result, { action: "ask" });
});


test("large line review pages at most 48 lines per side and can select later pages", async () => {
  resetModalTestState();
  const runtime = Object.create(V4PluginRuntime.prototype) as any;
  runtime.plugin = { app: {} };
  const local = new TextEncoder().encode(Array.from({ length: 900 }, (_, i) => `old ${i}`).join("\n"));
  const remote = new TextEncoder().encode(Array.from({ length: 900 }, (_, i) => `new ${i}`).join("\n"));
  const result = runtime.askConflict("many-lines.md", new AbortController().signal, local, remote);
  const modal = modalInstances.at(-1)!;
  const rows = (root: any): number => Number(root.classes?.has("github-sync-conflict__line") ?? false)
    + (root.children ?? []).reduce((sum: number, child: any) => sum + rows(child), 0);
  assert.ok(rows(modal.contentEl) <= 96, "only one visible 48-line window per side may be mounted");
  assert.ok(modal.contentEl.findByText("Next lines"));
  assert.equal(modal.contentEl.findByText("Apply reviewed merge")?.disabled, true);
  modal.contentEl.findByText("Next lines")!.onclick?.();
  assert.ok(modal.contentEl.findByAttribute("aria-label", "Change 1 local line 49: keep"));
  assert.equal(modal.contentEl.findByAttribute("aria-label", "Change 1 local line 1: keep"), undefined);
  modal.contentEl.findByAttribute("aria-label", "Change 1: local")!.onclick?.();
  assert.equal(modal.contentEl.findByText("Apply reviewed merge")?.disabled, false);
  modal.contentEl.findByText("Cancel")!.onclick?.();
  assert.deepEqual(await result, { action: "ask" });
});

test("aborting during cooperatively prepared large review never opens a late modal", async () => {
  resetModalTestState();
  const runtime = Object.create(V4PluginRuntime.prototype) as any;
  runtime.plugin = { app: {} };
  const text = Array.from({ length: 14000 }, (_, i) => `long context paragraph ${i}`).join("\n");
  const abort = new AbortController();
  const waiting = runtime.askConflict("large.md", abort.signal,
    new TextEncoder().encode(text), new TextEncoder().encode(text + "\nremote change"));
  abort.abort();
  assert.deepEqual(await waiting, { action: "ask" });
  assert.equal(modalInstances.length, 0);
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
  assert.match(modal.contentEl.flattenText(), /supports UTF-8 text/u);
  controller.abort();
  assert.deepEqual(await result, { action: "ask" });
});
