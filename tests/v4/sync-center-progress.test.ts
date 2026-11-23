import assert from "node:assert/strict";
import test from "node:test";

import { Notice, WorkspaceLeaf } from "obsidian";
import { createIdleV4Progress, V4ProgressStore, type V4SyncProgressSnapshot } from "../../src/lib/v4/progress";
import { V4SyncCenterView } from "../../src/views/sync-center";
import { V4HistoryNotInitializedError, V4HistoryPreviewLimitError, V4HistoryService } from "../../src/lib/v4/history-service";
import { V4_FORMAT_VERSION } from "../../src/lib/v4/protocol-types";
import { waitForCondition } from "../helpers/wait-for";

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
  return {
    app,
    settings: { githubToken: "test-token", githubOwner: "test-owner", githubRepo: "test-repo",
      githubBranch: "main", encryptionMode: "plaintext" as "plaintext" | "encrypted", encryptionPassphrase: "test-passphrase" },
    v4Runtime: runtime,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

test("D465 closing Current file during a delayed GitHub response stops further journal requests", async () => {
  const source = new FakeProgressSource();
  const plugin = createSyncCenterPluginFixture(source, () => undefined);
  const remotePage = deferred<Array<{ sha: string; message: string; authorName: string; authoredAt: string; parentShas: string[] }>>();
  let pageCalls = 0;
  let journalReads = 0;
  const github = {
    async listCommits() {
      pageCalls++;
      if (pageCalls === 1) return [];
      return remotePage.promise;
    },
    async getFileBytes() { journalReads++; throw new Error("stale History read must not occur"); },
    async getGitCommit() { throw new Error("unused"); },
    async getTreeAt() { throw new Error("unused"); },
    async getBlob() { throw new Error("unused"); },
  };
  const service = new V4HistoryService({ github, config: {
    formatVersion: V4_FORMAT_VERSION, mode: "plaintext", repoId: "o/r#main",
  } });
  plugin.v4Runtime.createHistoryService = async () => service;
  const view = new V4SyncCenterView(new WorkspaceLeaf(plugin.app), plugin as never);
  try {
    await view.onOpen();
    view.contentEl.findByText("Current file")?.onclick?.();
    await waitForCondition(() => pageCalls === 2, "Current file history is pending a remote page");
    await view.onClose();
    remotePage.resolve(Array.from({ length: 50 }, (_, i) => ({
      sha: `commit-${i}`, message: `obsidian-sync-v4:journal-${i}`,
      authorName: "A", authoredAt: "", parentShas: [],
    })));
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(journalReads, 0, "closed History view must not download old commit journals");
    assert.equal(pageCalls, 2, "closed History view must not advance to further GitHub pages");
  } finally {
    remotePage.resolve([]);
    await view.onClose();
  }
});

test("D464 double-click Next waits for page two, not three", async () => {
  const source = new FakeProgressSource();
  const plugin = createSyncCenterPluginFixture(source, () => undefined);
  const calls: number[] = [];
  const second = deferred<{items: Array<{sha: string; message: string; authoredAt: string; source: "plugin"}>; hasMore: boolean}>();
  plugin.v4Runtime.createHistoryService = async () => ({
    async listCommits(page: number) {
      calls.push(page);
      if (page === 2) return second.promise;
      return { items: [{ sha: String(page), message: "First page", authoredAt: "", source: "plugin" as const }], hasMore: true };
    },
    async getCommitChanges() { return []; },
    async getFileVersions() { return []; },
    async previewChange(): Promise<never> { throw Error("unused"); },
  });
  const view = new V4SyncCenterView(new WorkspaceLeaf(plugin.app), plugin as never);
  try {
    await view.onOpen();
    const next = view.contentEl.findByText("Next");
    assert.ok(next);
    next.onclick?.();
    next.onclick?.();
    await waitForCondition(() => calls.length >= 2, "page two request");
    assert.deepEqual(calls, [1, 2], "a double-click must not skip or duplicate pages");
    second.resolve({ items: [{ sha: "two", message: "Second page loaded", authoredAt: "", source: "plugin" }], hasMore: true });
    await waitForCondition(() => view.contentEl.flattenText().includes("Second page loaded"), "second page appears");
    assert.match(view.contentEl.flattenText(), /Page 2/u);
    const previous = view.contentEl.findByText("Previous");
    assert.ok(previous);
    previous.onclick?.();
    previous.onclick?.();
    await waitForCondition(() => view.contentEl.flattenText().includes("First page"), "first page returns");
    assert.match(view.contentEl.flattenText(), /Page 1/u);
    assert.deepEqual(calls, [1, 2, 1], "repeated Previous must never jump past page 1");
  } finally {
    second.resolve({ items: [], hasMore: false });
    await view.onClose();
  }
});

test("D464 Retry after a page two network failure stays on page two", async () => {
  const source = new FakeProgressSource();
  const plugin = createSyncCenterPluginFixture(source, () => undefined);
  const calls: number[] = [];
  plugin.v4Runtime.createHistoryService = async () => ({
    async listCommits(page: number) {
      calls.push(page);
      if (page === 2 && calls.filter(p => p === 2).length === 1) throw Error("private GitHub response");
      return { items: [{ sha: String(page), message: `History page ${page}`, authoredAt: "", source: "plugin" as const }], hasMore: true };
    },
    async getCommitChanges() { return []; },
    async getFileVersions() { return []; },
    async previewChange(): Promise<never> { throw Error("unused"); },
  });
  const view = new V4SyncCenterView(new WorkspaceLeaf(plugin.app), plugin as never);
  const notices = Notice.messages.length;
  try {
    await view.onOpen();
    view.contentEl.findByText("Next")?.onclick?.();
    await waitForCondition(() => view.contentEl.findByText("Retry history") !== undefined, "page two error");
    assert.doesNotMatch(view.contentEl.flattenText(), /private GitHub response/u);
    view.contentEl.findByText("Retry history")?.onclick?.();
    await waitForCondition(() => view.contentEl.flattenText().includes("History page 2"), "page two retry succeeds");
    assert.match(view.contentEl.flattenText(), /Page 2/u);
    assert.deepEqual(calls, [1, 2, 2]);
  } finally {
    await view.onClose();
    Notice.messages.length = notices;
  }
});

test("D464 old Next buttons cannot change an open Current file or closed view", async () => {
  const source = new FakeProgressSource();
  const plugin = createSyncCenterPluginFixture(source, () => undefined);
  const calls: number[] = [];
  plugin.v4Runtime.createHistoryService = async () => ({
    async listCommits(page: number) {
      calls.push(page);
      return { items: [{ sha: String(page), message: "History", authoredAt: "", source: "plugin" as const }], hasMore: true };
    },
    async getCommitChanges() { return []; },
    async getFileVersions() { return []; },
    async previewChange(): Promise<never> { throw Error("unused"); },
  });
  const view = new V4SyncCenterView(new WorkspaceLeaf(plugin.app), plugin as never);
  try {
    await view.onOpen();
    const oldNext = view.contentEl.findByText("Next");
    assert.ok(oldNext);
    view.contentEl.findByText("Current file")?.onclick?.();
    await waitForCondition(() => view.contentEl.flattenText().includes("Versions of Notes/project.md"), "Current file mode");
    oldNext.onclick?.();
    await Promise.resolve();
    assert.match(view.contentEl.flattenText(), /Versions of Notes\/project\.md/u);
    assert.deepEqual(calls, [1], "stale page control must not request commits");
    await view.onClose();
    oldNext.onclick?.();
    assert.deepEqual(calls, [1], "old controls cannot run after closing Sync Center");
  } finally {
    await view.onClose();
  }
});

test("D464 Refresh history remains usable while inspecting a commit and a file preview", async () => {
  const source = new FakeProgressSource();
  const plugin = createSyncCenterPluginFixture(source, () => undefined);
  let commitReads = 0;
  let versionReads = 0;
  let syncs = 0;
  plugin.v4Runtime.manualSync = async () => { syncs++; return {}; };
  const change = { kind: "modify" as const, path: "Notes/project.md", fileId: "file-id", source: "plugin" as const };
  const commit = { sha: "history-1", message: "History for project", authoredAt: "2026-11-23", source: "plugin" as const };
  plugin.v4Runtime.createHistoryService = async () => ({
    async listCommits() {
      commitReads++;
      return { items: [{ ...commit, message: `Remote commit load ${commitReads}` }], hasMore: false };
    },
    async getCommitChanges() { return [change]; },
    async getFileVersions() {
      versionReads++;
      return [{ commit: { ...commit, authoredAt: `Version load ${versionReads}` }, change }];
    },
    async previewChange() {
      return { kind: "text" as const, text: "# Preview stays selectable", bytes: new TextEncoder().encode("# Preview stays selectable") };
    },
  });
  const view = new V4SyncCenterView(new WorkspaceLeaf(plugin.app), plugin as never);
  try {
    await view.onOpen();
    view.contentEl.findByClass("github-sync-center__row")?.onclick?.();
    await waitForCondition(() => view.contentEl.flattenText().includes("Notes/project.md"),
      "commit details loaded");
    view.contentEl.findByText("Refresh history")?.onclick?.();
    await waitForCondition(() => view.contentEl.flattenText().includes("Remote commit load 2"),
      "refresh remains available after selecting commit details");
    view.contentEl.findByText("Current file")?.onclick?.();
    await waitForCondition(() => view.contentEl.flattenText().includes("Version load 1"),
      "file versions loaded");
    view.contentEl.findByClass("github-sync-center__row")?.onclick?.();
    await waitForCondition(() => view.contentEl.flattenText().includes("# Preview stays selectable"),
      "historical note preview loaded");
    view.contentEl.findByText("Refresh history")?.onclick?.();
    await waitForCondition(() => view.contentEl.flattenText().includes("Version load 2"),
      "file refresh remains available after selecting historical preview");
    assert.equal(commitReads, 2);
    assert.equal(versionReads, 2);
    assert.equal(syncs, 0);
  } finally {
    await view.onClose();
  }
});

test("D463 Commit history refresh loads another device's commits and resets paging without Sync", async () => {
  const source = new FakeProgressSource();
  const plugin = createSyncCenterPluginFixture(source, () => undefined);
  let requests: number[] = [];
  let changedRemotely = false;
  let manualSyncs = 0;
  plugin.v4Runtime.manualSync = async () => { manualSyncs++; return {}; };
  plugin.v4Runtime.createHistoryService = async () => ({
    async listCommits(page: number) {
      requests.push(page);
      const commit = (sha: string, message: string) => ({ sha, message, authoredAt: "", source: "plugin" as const });
      if (page === 2) return { items: [commit("old", "Older device history")], hasMore: false };
      return { items: [commit(changedRemotely ? "new" : "initial", changedRemotely ? "Other device latest commit" : "Original commit")], hasMore: true };
    },
    async getCommitChanges() { return []; },
    async getFileVersions() { return []; },
    async previewChange(): Promise<never> { throw Error("not used"); },
  });
  const view = new V4SyncCenterView(new WorkspaceLeaf(plugin.app), plugin as never);
  try {
    await view.onOpen();
    assert.ok(view.contentEl.findByText("Refresh history"));
    assert.match(view.contentEl.flattenText(), /Original commit/u);
    view.contentEl.findByText("Next")?.onclick?.();
    await waitForCondition(() => view.contentEl.flattenText().includes("Older device history"),
      "older page appears");
    changedRemotely = true;
    view.contentEl.findByText("Refresh history")?.onclick?.();
    await waitForCondition(() => view.contentEl.flattenText().includes("Other device latest commit"),
      "new remote commit appears after a manual refresh");
    assert.match(view.contentEl.flattenText(), /Page 1/u);
    assert.doesNotMatch(view.contentEl.flattenText(), /Older device history/u);
    assert.deepEqual(requests, [1, 2, 1]);
    assert.equal(manualSyncs, 0, "reading history must never invoke a manual Sync");
  } finally {
    await view.onClose();
  }
});

test("D463 Current file refreshes remote note versions without changing the active file or syncing", async () => {
  const source = new FakeProgressSource();
  const plugin = createSyncCenterPluginFixture(source, () => undefined);
  let remoteUpdated = false;
  let requests = 0;
  let syncs = 0;
  plugin.v4Runtime.manualSync = async () => { syncs++; return {}; };
  const commit = { sha: "new-sha", message: "remote", authoredAt: "2026-11-23", source: "plugin" as const };
  const change = { kind: "modify" as const, path: "Notes/project.md", fileId: "file-id", source: "plugin" as const };
  plugin.v4Runtime.createHistoryService = async () => ({
    async listCommits() { return { items: [], hasMore: false }; },
    async getCommitChanges() { return []; },
    async getFileVersions() { requests++; return remoteUpdated ? [{ commit, change }] : []; },
    async previewChange(): Promise<never> { throw Error("not used"); },
  });
  const view = new V4SyncCenterView(new WorkspaceLeaf(plugin.app), plugin as never);
  try {
    await view.onOpen();
    view.contentEl.findByText("Current file")?.onclick?.();
    await waitForCondition(() => view.contentEl.flattenText().includes("No versions found"),
      "current file has no recorded versions yet");
    assert.ok(view.contentEl.findByText("Refresh history"));
    remoteUpdated = true;
    view.contentEl.findByText("Refresh history")?.onclick?.();
    await waitForCondition(() => view.contentEl.flattenText().includes("MODIFY · Notes/project.md"),
      "history updated without running Sync");
    assert.equal(requests, 2);
    assert.equal(syncs, 0);
    assert.match(view.contentEl.flattenText(), /Versions of Notes\/project\.md/u);
  } finally {
    await view.onClose();
  }
});

test("D463 retry handles temporary History API failures and stale closed buttons are inert", async () => {
  const source = new FakeProgressSource();
  const plugin = createSyncCenterPluginFixture(source, () => undefined);
  let requests = 0;
  plugin.v4Runtime.createHistoryService = async () => ({
    async listCommits() {
      requests++;
      if (requests === 1) throw Error("a private GitHub credential appeared in an exception");
      return { items: [{ sha: "new", message: "Recovered history load", authoredAt: "", source: "plugin" as const }], hasMore: false };
    },
    async getCommitChanges() { return []; },
    async getFileVersions() { return []; },
    async previewChange(): Promise<never> { throw Error("not used"); },
  });
  const noticeStart = Notice.messages.length;
  const view = new V4SyncCenterView(new WorkspaceLeaf(plugin.app), plugin as never);
  try {
    await view.onOpen();
    assert.match(view.contentEl.flattenText(), /Could not load history/u);
    assert.doesNotMatch(view.contentEl.flattenText(), /private GitHub credential/u);
    const retry = view.contentEl.findByText("Retry history");
    assert.ok(retry);
    retry.onclick?.();
    await waitForCondition(() => view.contentEl.flattenText().includes("Recovered history load"),
      "retry after GitHub error works without restarting Obsidian");
    assert.equal(requests, 2);
    await view.onClose();
    retry.onclick?.();
    await Promise.resolve();
    assert.equal(requests, 2, "stale buttons cannot load history after view closes");
  } finally {
    await view.onClose();
    Notice.messages.length = noticeStart;
  }
});

test("D463 Current file Retry history restores versions after a transient GitHub failure", async () => {
  const source = new FakeProgressSource();
  const plugin = createSyncCenterPluginFixture(source, () => undefined);
  let requests = 0;
  plugin.v4Runtime.createHistoryService = async () => ({
    async listCommits() { return { items: [], hasMore: false }; },
    async getCommitChanges() { return []; },
    async getFileVersions() {
      requests++;
      if (requests === 1) throw Error("sensitive remote response");
      return [{ commit: { sha: "latest", message: "latest", authoredAt: "", source: "plugin" as const },
        change: { source: "plugin" as const, kind: "modify" as const, path: "Notes/project.md", fileId: "file-id" } }];
    },
    async previewChange(): Promise<never> { throw Error("not used"); },
  });
  const view = new V4SyncCenterView(new WorkspaceLeaf(plugin.app), plugin as never);
  const noticeStart = Notice.messages.length;
  try {
    await view.onOpen();
    view.contentEl.findByText("Current file")?.onclick?.();
    await waitForCondition(() => view.contentEl.findByText("Retry history") !== undefined,
      "a failed Current file lookup exposes retry");
    assert.doesNotMatch(view.contentEl.flattenText(), /sensitive remote response/u);
    view.contentEl.findByText("Retry history")?.onclick?.();
    await waitForCondition(() => view.contentEl.flattenText().includes("MODIFY · Notes/project.md"),
      "Current file versions recover after retry");
    assert.equal(requests, 2);
  } finally {
    await view.onClose();
    Notice.messages.length = noticeStart;
  }
});

test("D459 restored Markdown offers an explicit Open recovered note action after Vault.create succeeds", async () => {
  const source = new FakeProgressSource();
  const plugin = createSyncCenterPluginFixture(source, () => undefined) as any;
  const writes: string[] = [];
  const opened: Array<{ path: string; sourcePath: string; newLeaf: boolean }> = [];
  plugin.app.workspace.openLinkText = async (path: string, sourcePath: string, newLeaf: boolean) => {
    opened.push({ path, sourcePath, newLeaf });
  };
  plugin.app.vault = {
    on: () => ({}), offref: () => undefined,
    getAbstractFileByPath: () => null,
    async create(path: string, content: string) {
      assert.equal(content, "# Historical working copy");
      writes.push(path);
      return { path };
    },
  };
  const commit = { sha: "abc12345-more", message: "old", authoredAt: "2026-11-01", source: "plugin" as const };
  const change = { kind: "modify" as const, path: "Notes/project.md", fileId: "file-id", source: "plugin" as const };
  plugin.v4Runtime.createHistoryService = async () => ({
    async listCommits() { return { items: [], hasMore: false }; },
    async getCommitChanges() { return []; },
    async getFileVersions() { return [{ commit, change }]; },
    async previewChange() {
      const text = "# Historical working copy";
      return { kind: "text" as const, text, bytes: new TextEncoder().encode(text) };
    },
  });
  const view = new V4SyncCenterView(new WorkspaceLeaf(plugin.app), plugin);
  const noticeStart = Notice.messages.length;
  try {
    await view.onOpen();
    view.contentEl.findByText("Current file")?.onclick?.();
    await waitForCondition(() => view.contentEl.findByClass("github-sync-center__row") !== undefined,
      "historical version loaded");
    view.contentEl.findByClass("github-sync-center__row")?.onclick?.();
    await waitForCondition(() => view.contentEl.findByText("Restore as new note") !== undefined,
      "restore button loaded");
    assert.equal(view.contentEl.findByText("Open recovered note"), undefined,
      "cannot open a note that has not been created");
    view.contentEl.findByText("Restore as new note")?.onclick?.();
    await waitForCondition(() => view.contentEl.findByText("Open recovered note") !== undefined,
      "open button appears after successful create");
    assert.deepEqual(writes, ["Recovered-project-abc12345.md"]);
    assert.deepEqual(opened, [], "saving does not switch away from the active note");
    const open = view.contentEl.findByText("Open recovered note");
    assert.ok(open);
    open.onclick?.();
    await waitForCondition(() => opened.length === 1, "explicit open succeeds");
    assert.deepEqual(opened, [
      { path: "Recovered-project-abc12345.md", sourcePath: "", newLeaf: true },
    ]);
    assert.equal(writes.length, 1, "opening recovered note must not write again");
    assert.equal(open.disabled, true, "opening twice must not create duplicate tabs");
    open.onclick?.();
    await Promise.resolve();
    assert.equal(opened.length, 1, "double-clicking Open recovered note must not open two tabs");
    await view.onClose();
    open.onclick?.();
    await Promise.resolve();
    assert.equal(opened.length, 1, "opening a closed view must not act on stale recovery controls");
  } finally {
    await view.onClose();
    Notice.messages.length = noticeStart;
  }
});

test("D459 failed navigation keeps recovered file and hides private errors", async () => {
  const source = new FakeProgressSource();
  const plugin = createSyncCenterPluginFixture(source, () => undefined) as any;
  let attempts = 0;
  plugin.app.vault = {
    on: () => ({}), offref: () => undefined,
    getAbstractFileByPath: () => null,
    async create(path: string) { attempts++; return { path }; },
  };
  let shouldFailOpening = true;
  let openCalls = 0;
  plugin.app.workspace.openLinkText = async () => {
    openCalls++;
    if (shouldFailOpening) throw new Error("private note content and token must never enter a Notice");
  };
  const commit = { sha: "abc12345", message: "old", authoredAt: "2026-11-01", source: "plugin" as const };
  const change = { kind: "modify" as const, path: "Notes/project.md", fileId: "file-id", source: "plugin" as const };
  plugin.v4Runtime.createHistoryService = async () => ({
    async listCommits() { return { items: [], hasMore: false }; },
    async getCommitChanges() { return []; },
    async getFileVersions() { return [{ commit, change }]; },
    async previewChange() {
      return { kind: "text" as const, text: "historical", bytes: new TextEncoder().encode("historical") };
    },
  });
  const view = new V4SyncCenterView(new WorkspaceLeaf(plugin.app), plugin);
  const noticeStart = Notice.messages.length;
  try {
    await view.onOpen();
    view.contentEl.findByText("Current file")?.onclick?.();
    await waitForCondition(() => view.contentEl.findByClass("github-sync-center__row") !== undefined,
      "historical version loaded");
    view.contentEl.findByClass("github-sync-center__row")?.onclick?.();
    await waitForCondition(() => view.contentEl.findByText("Restore as new note") !== undefined,
      "restore button loaded");
    view.contentEl.findByText("Restore as new note")?.onclick?.();
    await waitForCondition(() => view.contentEl.findByText("Open recovered note") !== undefined,
      "open button added");
    const open = view.contentEl.findByText("Open recovered note");
    open?.onclick?.();
    await waitForCondition(() => Notice.messages.some((m, index) => index >= noticeStart && m.includes("Could not open")),
      "opening error reported");
    assert.ok(Notice.messages.slice(noticeStart).every(m => !m.includes("private note content")));
    assert.equal(attempts, 1, "navigation errors must not retry Vault.create");
    assert.equal(open?.disabled, false, "failed navigation may be retried without recovery");
    shouldFailOpening = false;
    open?.onclick?.();
    await waitForCondition(() => openCalls === 2, "navigation retry succeeded");
    assert.equal(attempts, 1);
  } finally {
    await view.onClose();
    Notice.messages.length = noticeStart;
  }
});

test("D458 malformed historical Markdown cannot be restored or copied as replacement text", async () => {
  const source = new FakeProgressSource();
  const plugin = createSyncCenterPluginFixture(source, () => undefined);
  const commit = { sha: "old", message: "old", authoredAt: "2026-11-01", source: "plugin" as const };
  const change = { kind: "modify" as const, path: "Notes/important.md", fileId: "file-id", source: "plugin" as const };
  let writes = 0;
  Object.assign(plugin.app, {
    vault: {
      on: () => ({}), offref: () => undefined,
      async create() { writes++; throw new Error("unexpected write"); },
    },
  });
  Object.assign(plugin.v4Runtime, {
    async createHistoryService() {
      return {
        async listCommits() { return { items: [], hasMore: false }; },
        async getCommitChanges() { return []; },
        async getFileVersions() { return [{ commit, change }]; },
        async previewChange() {
          return { kind: "binary" as const, bytes: new Uint8Array([0x23, 0x20, 0xff]) };
        },
      };
    },
  });
  const view = new V4SyncCenterView(new WorkspaceLeaf(plugin.app), plugin as never);
  try {
    await view.onOpen();
    view.contentEl.findByText("Current file")?.onclick?.();
    await waitForCondition(() => view.contentEl.findByClass("github-sync-center__row") !== undefined,
      "malformed historical Markdown version appears");
    view.contentEl.findByClass("github-sync-center__row")?.onclick?.();
    await waitForCondition(() => view.contentEl.flattenText().includes("not readable as UTF-8"),
      "unsupported Markdown encoding is explained");
    assert.equal(view.contentEl.findByText("Restore as new note"), undefined);
    assert.equal(view.contentEl.findByText("Copy version text"), undefined);
    assert.equal(writes, 0);
  } finally {
    await view.onClose();
  }
});

test("D456 oversized history preview explains the 5 MiB limit without suggesting a GitHub connection failure", async () => {
  const source = new FakeProgressSource();
  const plugin = createSyncCenterPluginFixture(source, () => undefined);
  const commit = { sha: "old", message: "old", authoredAt: "2026-11-01", source: "plugin" as const };
  const change = { kind: "modify" as const, path: "Notes/big.md", fileId: "file-id", source: "plugin" as const };
  Object.assign(plugin.v4Runtime, {
    async createHistoryService() {
      return {
        async listCommits() { return { items: [], hasMore: false }; },
        async getCommitChanges() { return []; },
        async getFileVersions() { return [{ commit, change }]; },
        async previewChange(): Promise<never> {
          throw new V4HistoryPreviewLimitError("private file data in an untrusted exception");
        },
      };
    },
  });
  const beforeNotices = Notice.messages.length;
  const view = new V4SyncCenterView(new WorkspaceLeaf(plugin.app), plugin as never);
  try {
    await view.onOpen();
    view.contentEl.findByText("Current file")?.onclick?.();
    await waitForCondition(() => view.contentEl.findByClass("github-sync-center__row") !== undefined,
      "historical version row");
    view.contentEl.findByClass("github-sync-center__row")?.onclick?.();
    await waitForCondition(() => view.contentEl.flattenText().includes("Could not load history")
      || view.contentEl.flattenText().includes("cannot be previewed"), "preview error appears");
    assert.match(view.contentEl.flattenText(), /cannot be previewed.*5 MiB.*8 MiB.*Vault/iu);
    assert.doesNotMatch(view.contentEl.flattenText(), /Check the GitHub connection/iu);
    assert.doesNotMatch(view.contentEl.flattenText(), /private file data/iu);
    assert.equal(Notice.messages.length, beforeNotices + 1);
  } finally {
    await view.onClose();
    Notice.messages.length = beforeNotices;
  }
});

test("D454 restoring a historical Markdown note creates one separate file without overwriting or directly syncing", async () => {
  const source = new FakeProgressSource();
  const plugin = createSyncCenterPluginFixture(source, () => undefined) as any;
  const files = new Map<string, string>([
    ["Notes/project.md", "# Current unsaved edits"],
    ["Recovered-project-abc12345.md", "# Existing recovery"],
  ]);
  const writes: string[] = [];
  const syncCalls: string[] = [];
  plugin.app.vault = {
    on: () => ({}), offref: () => undefined,
    getAbstractFileByPath: (path: string) => files.has(path) ? { path } : null,
    async create(path: string, content: string) {
      if (files.has(path)) throw new Error("Already exists");
      files.set(path, content);
      writes.push(path);
      return { path };
    },
  };
  plugin.runManualSyncFromUi = () => { syncCalls.push("sync"); };
  const commit = { sha: "abc12345-more", message: "old", authoredAt: "2026-11-01", source: "plugin" as const };
  const change = { kind: "modify" as const, path: "Notes/project.md", fileId: "file-id", source: "plugin" as const };
  plugin.v4Runtime.createHistoryService = async () => ({
    async listCommits() { return { items: [], hasMore: false }; },
    async getCommitChanges() { return []; },
    async getFileVersions() { return [{ commit, change }]; },
    async previewChange() { return { kind: "text" as const, text: "# Historical safe copy", bytes: new TextEncoder().encode("# Historical safe copy") }; },
  });
  const noticesBefore = Notice.messages.length;
  const view = new V4SyncCenterView(new WorkspaceLeaf(plugin.app), plugin);
  try {
    await view.onOpen();
    view.contentEl.findByText("Current file")?.onclick?.();
    await waitForCondition(() => view.contentEl.findByClass("github-sync-center__row") !== undefined, "historical markdown row");
    view.contentEl.findByClass("github-sync-center__row")?.onclick?.();
    await waitForCondition(() => view.contentEl.findByText("Restore as new note") !== undefined, "markdown recovery action");
    assert.deepEqual(writes, [], "opening and previewing history cannot write to Vault");
    const restore = view.contentEl.findByText("Restore as new note");
    assert.ok(restore);
    restore.onclick?.();
    restore.onclick?.();
    await waitForCondition(() => writes.length === 1, "one historical recovery copy is created");
    restore.onclick?.();
    await Promise.resolve();
    assert.deepEqual(writes, ["Recovered-project-abc12345-2.md"], "existing recovery file is not overwritten or duplicated");
    assert.equal(restore.disabled, true, "one preview authorizes at most one recovery creation");
    assert.equal(files.get("Recovered-project-abc12345-2.md"), "# Historical safe copy");
    assert.equal(files.get("Notes/project.md"), "# Current unsaved edits");
    assert.equal(files.get("Recovered-project-abc12345.md"), "# Existing recovery");
    assert.deepEqual(syncCalls, [], "recovery does not call manual or Force Sync");
    await waitForCondition(() => Notice.messages.length > noticesBefore, "recovery confirmation appears");
    assert.match(Notice.messages.at(-1) ?? "", /Recovered-project-abc12345-2\.md/u);
    assert.doesNotMatch(Notice.messages.at(-1) ?? "", /Historical safe copy/u);
  } finally {
    await view.onClose();
    Notice.messages.length = noticesBefore;
  }
});

test("D454 failed, stale, or non-Markdown history recovery cannot overwrite current notes", async () => {
  const source = new FakeProgressSource();
  const plugin = createSyncCenterPluginFixture(source, () => undefined) as any;
  let writes = 0;
  plugin.app.vault = {
    on: () => ({}), offref: () => undefined,
    getAbstractFileByPath: () => null,
    async create() { writes++; throw new Error("private note content must not be logged"); },
  };
  const commit = { sha: "abc12345", message: "old", authoredAt: "2026-11-01", source: "plugin" as const };
  const change = { kind: "modify" as const, path: "Notes/project.md", fileId: "file-id", source: "plugin" as const };
  plugin.v4Runtime.createHistoryService = async () => ({
    async listCommits() { return { items: [], hasMore: false }; },
    async getCommitChanges() { return []; },
    async getFileVersions() { return [{ commit, change }]; },
    async previewChange() { return { kind: "text" as const, text: "# Historical", bytes: new Uint8Array([1]) }; },
  });
  const noticesBefore = Notice.messages.length;
  const view = new V4SyncCenterView(new WorkspaceLeaf(plugin.app), plugin);
  try {
    await view.onOpen();
    view.contentEl.findByText("Current file")?.onclick?.();
    await waitForCondition(() => view.contentEl.findByClass("github-sync-center__row") !== undefined, "version available");
    view.contentEl.findByClass("github-sync-center__row")?.onclick?.();
    await waitForCondition(() => view.contentEl.findByText("Restore as new note") !== undefined, "recovery offered");
    const recovery = view.contentEl.findByText("Restore as new note");
    recovery?.onclick?.();
    await waitForCondition(() => Notice.messages.length > noticesBefore, "failure notice appears");
    assert.equal(writes, 1);
    assert.match(Notice.messages.at(-1) ?? "", /Could not confirm recovery/u);
    assert.equal(view.contentEl.findByText("Open recovered note"), undefined,
      "a failed file write cannot offer navigation to a nonexistent copy");
    assert.doesNotMatch(Notice.messages.at(-1) ?? "", /private note content/u);
    recovery?.onclick?.();
    await Promise.resolve();
    assert.equal(writes, 1, "ambiguous failed file creation must not be automatically retried");

    await view.onClose();
    recovery?.onclick?.();
    await Promise.resolve();
    assert.equal(writes, 1, "old view controls cannot write a file after closing");
    await view.onOpen();
    await (view as any).renderPreview(commit, { ...change, path: "Notes/settings.json" },
      view.contentEl.findByClass("github-sync-center__detail"));
    assert.equal(view.contentEl.findByText("Restore as new note"), undefined,
      "unsupported history text types cannot silently become Markdown notes");
  } finally {
    await view.onClose();
    Notice.messages.length = noticesBefore;
  }
});

test("D452 Current file lists newest versions first and copies historical note text only on click", async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const copied: string[] = [];
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { clipboard: { async writeText(value: string) { copied.push(value); } } },
  });
  const source = new FakeProgressSource();
  const plugin = createSyncCenterPluginFixture(source, () => undefined);
  const old = { commit: { sha: "old", message: "old", authoredAt: "2026-11-01", source: "plugin" as const },
    change: { kind: "modify" as const, path: "Notes/project.md", fileId: "file-id", source: "plugin" as const } };
  const latest = { commit: { sha: "latest", message: "latest", authoredAt: "2026-11-20", source: "plugin" as const },
    change: { kind: "modify" as const, path: "Notes/project.md", fileId: "file-id", source: "plugin" as const } };
  let previewReads = 0;
  Object.assign(plugin.v4Runtime, {
    async createHistoryService() {
      return {
        async listCommits() { return { items: [], hasMore: false }; },
        async getCommitChanges() { return []; },
        async getFileVersions() { return [old, latest]; },
        async previewChange(commit: typeof latest.commit) {
          previewReads++;
          const text = commit.sha === "latest" ? "# Latest private note" : "# Old private note";
          return { kind: "text" as const, text, bytes: new TextEncoder().encode(text) };
        },
      };
    },
  });
  const noticesBefore = Notice.messages.length;
  const view = new V4SyncCenterView(new WorkspaceLeaf(plugin.app), plugin as never);
  try {
    await view.onOpen();
    view.contentEl.findByText("Current file")?.onclick?.();
    await waitForCondition(() => view.contentEl.flattenText().includes("2026-11-20"),
      "two historical versions become visible");
    const firstRow = view.contentEl.findByClass("github-sync-center__master")?.findByClass("github-sync-center__row");
    assert.ok(firstRow);
    assert.match(firstRow.flattenText(), /2026-11-20/u, "the most recently synced version is first");
    assert.equal(previewReads, 0, "listing versions does not decrypt their contents");
    assert.deepEqual(copied, [], "opening history must never copy secrets to the clipboard");
    firstRow.onclick?.();
    await waitForCondition(() => view.contentEl.flattenText().includes("# Latest private note"),
      "latest historical note preview appears");
    const copy = view.contentEl.findByText("Copy version text");
    assert.ok(copy, "text preview provides a recovery action");
    assert.deepEqual(copied, [], "preview alone must not copy decrypted data");
    copy.onclick?.();
    await waitForCondition(() => copied.length === 1, "explicit copy action completes");
    assert.deepEqual(copied, ["# Latest private note"]);
    assert.equal(Notice.messages.length, noticesBefore + 1);
    assert.match(Notice.messages.at(-1) ?? "", /Version text copied/u);
  } finally {
    await view.onClose();
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else Reflect.deleteProperty(globalThis, "navigator");
    Notice.messages.length = noticesBefore;
  }
});

test("D452 rejected clipboard and stale preview actions do not leak or copy private history", async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  let writes = 0;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { clipboard: { async writeText(_text: string) {
      writes++;
      throw new Error("secret-history-text-not-for-notices");
    } } },
  });
  const source = new FakeProgressSource();
  const plugin = createSyncCenterPluginFixture(source, () => undefined);
  const commit = { sha: "latest", message: "latest", authoredAt: "2026-11-20", source: "plugin" as const };
  const change = { kind: "modify" as const, path: "Notes/private.md", fileId: "file-id", source: "plugin" as const };
  Object.assign(plugin.v4Runtime, {
    async createHistoryService() {
      return {
        async listCommits() { return { items: [], hasMore: false }; },
        async getCommitChanges() { return []; },
        async getFileVersions() { return [{ commit, change }]; },
        async previewChange() {
          return { kind: "text" as const, text: "private encrypted text", bytes: new Uint8Array([1]) };
        },
      };
    },
  });
  const noticesBefore = Notice.messages.length;
  const view = new V4SyncCenterView(new WorkspaceLeaf(plugin.app), plugin as never);
  try {
    await view.onOpen();
    view.contentEl.findByText("Current file")?.onclick?.();
    await waitForCondition(() => view.contentEl.findByClass("github-sync-center__row") !== undefined,
      "historical version appears");
    view.contentEl.findByClass("github-sync-center__row")?.onclick?.();
    await waitForCondition(() => view.contentEl.findByText("Copy version text") !== undefined,
      "historical text can be selected for copying");
    const copy = view.contentEl.findByText("Copy version text");
    copy?.onclick?.();
    await waitForCondition(() => Notice.messages.length > noticesBefore, "clipboard rejection is reported");
    assert.equal(writes, 1);
    assert.match(Notice.messages.at(-1) ?? "", /Could not copy version text/u);
    assert.ok(Notice.messages.slice(noticesBefore).every(value => !value.includes("secret-history")),
      "raw clipboard errors and private note content must stay out of Notices");
    await view.onClose();
    copy?.onclick?.();
    await Promise.resolve();
    assert.equal(writes, 1, "closing the history view retires old copy actions");
  } finally {
    await view.onClose();
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else Reflect.deleteProperty(globalThis, "navigator");
    Notice.messages.length = noticesBefore;
  }
});

test("D450 incomplete first-use connection shows setup guidance without GitHub reads, then recovers after Save", async () => {
  const source = new FakeProgressSource();
  const plugin = createSyncCenterPluginFixture(source, () => undefined);
  let historyRequests = 0;
  let fileLookups = 0;
  plugin.settings = { ...plugin.settings, githubToken: "" };
  plugin.v4Runtime.createHistoryService = async () => {
    historyRequests++;
    return {
      async listCommits() { return { items: [], hasMore: false }; },
      async getCommitChanges() { return []; },
      async getFileVersions() { return []; },
      async previewChange(): Promise<never> { throw new Error("not used"); },
    };
  };
  plugin.v4Runtime.fileIdForPath = async () => { fileLookups++; return "file-id"; };
  const noticesBefore = Notice.messages.length;
  const view = new V4SyncCenterView(new WorkspaceLeaf(plugin.app), plugin as never);
  try {
    await view.onOpen();
    assert.match(view.contentEl.flattenText(), /GitHub Sync is not configured.*Settings.*Encrypted GitHub Sync \(Multi-Platform\).*token.*Save changes/su);
    assert.equal(historyRequests, 0, "unconfigured Commit history must not contact GitHub");
    assert.equal(fileLookups, 0);

    view.contentEl.findByText("Current file")?.onclick?.();
    await waitForCondition(() => view.contentEl.flattenText().includes("GitHub Sync is not configured"),
      "Current file setup guidance");
    assert.equal(historyRequests, 0);
    assert.equal(fileLookups, 0, "unconfigured Current file history must not load a remote index");

    plugin.settings = { ...plugin.settings, githubToken: "test-token" };
    view.onSettingsSaved();
    await waitForCondition(() => view.contentEl.flattenText().includes("No versions found"),
      "Current file history becomes available after configuring the connection");
    assert.equal(fileLookups, 1);
    assert.equal(historyRequests, 1);
    assert.equal(Notice.messages.length, noticesBefore,
      "missing first-use configuration should not produce an error Notice");
  } finally {
    await view.onClose();
  }
});

test("D480 History identifies the actual missing saved field in Commit and Current file modes", async () => {
  for (const scenario of [
    { patch: { githubBranch: "" }, corrected: { githubBranch: "notes-v4" }, field: "GitHub branch" },
    { patch: { vault: " \t " }, corrected: { vault: "device-restored" }, field: "Device ID" },
    { patch: { githubToken: " \t " }, corrected: { githubToken: "test-token" }, field: "GitHub token" },
  ]) {
    const source = new FakeProgressSource();
    const plugin = createSyncCenterPluginFixture(source, () => undefined);
    const secret = "secret-never-show-in-history-guidance";
    plugin.settings = { ...plugin.settings, githubToken: secret, vault: "valid-device", ...scenario.patch };
    let historyReads = 0;
    let fileLookups = 0;
    plugin.v4Runtime.createHistoryService = async () => {
      historyReads++;
      return {
        async listCommits() { return { items: [], hasMore: false }; },
        async getCommitChanges() { return []; },
        async getFileVersions() { return []; },
        async previewChange(): Promise<never> { throw new Error("not used"); },
      };
    };
    plugin.v4Runtime.fileIdForPath = async () => { fileLookups++; return "file-id"; };
    const view = new V4SyncCenterView(new WorkspaceLeaf(plugin.app), plugin as never);
    try {
      await view.onOpen();
      const commitMessage = view.contentEl.flattenText();
      assert.match(commitMessage, /GitHub Sync is not configured/u);
      assert.ok(commitMessage.includes(scenario.field),
        `Commit History must identify the missing ${scenario.field}`);
      assert.doesNotMatch(commitMessage, /secret-never-show-in-history-guidance/u);
      assert.equal(historyReads, 0, "missing configuration must never read remote history");

      view.contentEl.findByText("Current file")?.onclick?.();
      await waitForCondition(() => view.contentEl.flattenText().includes("GitHub Sync is not configured"),
        "Current file missing-field guidance");
      const fileMessage = view.contentEl.flattenText();
      assert.ok(fileMessage.includes(scenario.field),
        `File History must identify the missing ${scenario.field}`);
      assert.doesNotMatch(fileMessage, /secret-never-show-in-history-guidance/u);
      assert.equal(fileLookups, 0, "missing configuration must not read the remote index");
      assert.equal(historyReads, 0);

      plugin.settings = { ...plugin.settings, ...scenario.corrected };
      view.onSettingsSaved();
      await waitForCondition(() => view.contentEl.flattenText().includes("No versions found"),
        "corrected Settings should restore History without a restart");
      assert.equal(fileLookups, 1);
      assert.equal(historyReads, 1);
    } finally {
      await view.onClose();
    }
  }
});

test("D450 encrypted history without a saved passphrase shows setup guidance offline", async () => {
  const source = new FakeProgressSource();
  const plugin = createSyncCenterPluginFixture(source, () => undefined);
  plugin.settings = { ...plugin.settings, encryptionMode: "encrypted", encryptionPassphrase: "" };
  let historyRequests = 0;
  plugin.v4Runtime.createHistoryService = async () => {
    historyRequests++;
    throw new Error("History must not be loaded without the encryption passphrase");
  };
  const view = new V4SyncCenterView(new WorkspaceLeaf(plugin.app), plugin as never);
  try {
    await view.onOpen();
    assert.match(view.contentEl.flattenText(), /GitHub Sync is not configured.*passphrase.*Save changes/su);
    assert.equal(historyRequests, 0);
  } finally {
    await view.onClose();
  }
});

test("D436 first-use empty V4 branch shows safe Sync-now guidance and refreshes after initial Sync", async () => {
  const source = new FakeProgressSource();
  let initialized = false;
  let historyReads = 0;
  let manualCalls = 0;
  const plugin = createSyncCenterPluginFixture(source, () => undefined);
  plugin.runManualSyncFromUi = () => { manualCalls++; };
  plugin.v4Runtime.createHistoryService = async () => {
    historyReads++;
    if (!initialized) throw new V4HistoryNotInitializedError();
    return {
      async listCommits() {
        return { items: [{ sha: "initial-sha", message: "My first Sync", authoredAt: "", source: "plugin" as const }], hasMore: false };
      },
      async getCommitChanges() { return []; },
      async getFileVersions() { return []; },
      async previewChange(): Promise<never> { throw new Error("not used"); },
    };
  };
  const noticesBefore = Notice.messages.length;
  const view = new V4SyncCenterView(new WorkspaceLeaf(plugin.app), plugin as never);
  try {
    await view.onOpen();
    const initialText = view.contentEl.flattenText();
    assert.match(initialText, /No V4 Sync history on this branch yet/u);
    assert.match(initialText, /empty branch.*Sync now/u);
    assert.match(initialText, /existing.*use a new empty branch/u);
    assert.doesNotMatch(initialText, /Force Push first|Could not load history/u);
    assert.equal(Notice.messages.length, noticesBefore, "missing first-use history is not a connection failure");
    assert.equal(manualCalls, 0, "opening history must never automatically trigger a write");
    assert.equal(historyReads, 1);

    initialized = true;
    source.publish(uploadingFixture);
    source.publish({ ...uploadingFixture, lifecycle: "success", phase: undefined, currentPath: undefined });
    await waitForCondition(() => view.contentEl.flattenText().includes("My first Sync"),
      "first published history appears automatically");
    assert.doesNotMatch(view.contentEl.flattenText(), /No V4 Sync history on this branch yet/u);
    assert.equal(historyReads, 2);
    assert.equal(manualCalls, 0);
  } finally {
    await view.onClose();
  }
});

test("D436 missing first-use V4 history in Current file is guidance, not a GitHub connection error", async () => {
  const source = new FakeProgressSource();
  const plugin = createSyncCenterPluginFixture(source, () => undefined);
  plugin.v4Runtime.createHistoryService = async () => { throw new V4HistoryNotInitializedError(); };
  plugin.v4Runtime.fileIdForPath = async () => { throw new V4HistoryNotInitializedError(); };
  const noticesBefore = Notice.messages.length;
  const view = new V4SyncCenterView(new WorkspaceLeaf(plugin.app), plugin as never);
  try {
    await view.onOpen();
    view.contentEl.findByText("Current file")?.onclick?.();
    await waitForCondition(() => view.contentEl.flattenText().includes("No V4 Sync history on this branch yet"),
      "first-use guidance in Current file mode");
    assert.match(view.contentEl.flattenText(), /empty branch.*Sync now/u);
    assert.doesNotMatch(view.contentEl.flattenText(), /Force Push first|Could not load history/u);
    assert.equal(Notice.messages.length, noticesBefore);
  } finally {
    await view.onClose();
  }
});

test("D435 changing commit pages clears the old selected commit and loads only the chosen page", async () => {
  const source = new FakeProgressSource();
  const plugin = createSyncCenterPluginFixture(source, () => undefined);
  const first = { sha: "first-page-sha", message: "First page commit", authoredAt: "", source: "plugin" as const };
  const second = { sha: "second-page-sha", message: "Second page commit", authoredAt: "", source: "plugin" as const };
  const pages: number[] = [];
  const inspected: string[] = [];
  plugin.v4Runtime.createHistoryService = async () => ({
    async listCommits(page: number) {
      pages.push(page);
      return { items: [page === 1 ? first : second], hasMore: page === 1 };
    },
    async getCommitChanges(commit: typeof first) {
      inspected.push(commit.sha);
      return [{ kind: "modify" as const, path: `Notes/${commit.sha}.md` }];
    },
    async getFileVersions() { return []; },
    async previewChange(): Promise<never> { throw new Error("not used"); },
  });
  const view = new V4SyncCenterView(new WorkspaceLeaf(plugin.app), plugin as never);
  try {
    await view.onOpen();
    view.contentEl.findByClass("github-sync-center__row")?.onclick?.();
    await waitForCondition(() => view.contentEl.flattenText().includes("Notes/first-page-sha.md"),
      "first page commit details are shown");

    view.contentEl.findByText("Next")?.onclick?.();
    await waitForCondition(() => view.contentEl.flattenText().includes("Second page commit"),
      "second page is shown");
    assert.match(view.contentEl.flattenText(), /Page 2/u);
    assert.match(view.contentEl.flattenText(), /Select a commit to inspect its changes/u);
    assert.doesNotMatch(view.contentEl.flattenText(), /Notes\/first-page-sha\.md/u,
      "details from a different page must not be displayed");
    assert.deepEqual(inspected, ["first-page-sha"],
      "changing pages must not load a previous page's selected commit again");

    view.contentEl.findByClass("github-sync-center__row")?.onclick?.();
    await waitForCondition(() => view.contentEl.flattenText().includes("Notes/second-page-sha.md"),
      "second page commit details are shown");
    view.contentEl.findByText("Previous")?.onclick?.();
    await waitForCondition(() => view.contentEl.flattenText().includes("First page commit"),
      "first page is restored");
    assert.match(view.contentEl.flattenText(), /Page 1/u);
    assert.match(view.contentEl.flattenText(), /Select a commit to inspect its changes/u);
    assert.doesNotMatch(view.contentEl.flattenText(), /Notes\/second-page-sha\.md/u);
    assert.deepEqual(inspected, ["first-page-sha", "second-page-sha"]);
    assert.deepEqual(pages, [1, 2, 1]);
  } finally {
    await view.onClose();
  }
});

test("D430 first successful Sync reloads visible Commit history without polling on progress ticks", async () => {
  const source = new FakeProgressSource();
  const plugin = createSyncCenterPluginFixture(source, () => undefined);
  const commit = { sha: "new-commit-sha", message: "First synced notes", authoredAt: "2026-11-19", source: "plugin" as const };
  let committed = false;
  let requests = 0;
  plugin.v4Runtime.createHistoryService = async () => ({
    async listCommits() {
      requests++;
      return { items: committed ? [commit] : [], hasMore: false };
    },
    async getCommitChanges() { return []; },
    async getFileVersions() { return []; },
    async previewChange(): Promise<never> { throw new Error("not used"); },
  });
  const view = new V4SyncCenterView(new WorkspaceLeaf(plugin.app), plugin as never);
  try {
    await view.onOpen();
    assert.match(view.contentEl.flattenText(), /No commits found/u);
    assert.equal(requests, 1);
    source.publish(uploadingFixture);
    committed = true;
    source.publish({ ...uploadingFixture, lifecycle: "success", phase: undefined, currentPath: undefined });
    await waitForCondition(() => view.contentEl.flattenText().includes("First synced notes"),
      "new GitHub commit appears after successful Sync");
    assert.equal(requests, 2);
    source.publish({ ...uploadingFixture, lifecycle: "success", phase: undefined,
      currentPath: undefined, totalElapsedMs: uploadingFixture.totalElapsedMs + 2000 });
    await Promise.resolve();
    assert.equal(requests, 2, "completed-run progress ticks must not refetch GitHub history");
  } finally {
    await view.onClose();
  }
  source.publish(uploadingFixture);
  source.publish({ ...uploadingFixture, lifecycle: "no-change", phase: undefined, currentPath: undefined });
  assert.equal(requests, 2, "closing the view stops history refresh");
});

test("D430 successful first Sync refreshes Current file versions without switching modes", async () => {
  const source = new FakeProgressSource();
  const plugin = createSyncCenterPluginFixture(source, () => undefined);
  const commit = { sha: "new-commit-sha", message: "first upload", authoredAt: "2026-11-19", source: "plugin" as const };
  const change = { kind: "add" as const, path: "Notes/project.md", source: "plugin" as const, fileId: "file-id" };
  let committed = false;
  let versionRequests = 0;
  plugin.v4Runtime.fileIdForPath = async () => committed ? "file-id" : undefined;
  plugin.v4Runtime.createHistoryService = async () => ({
    async listCommits() { return { items: [], hasMore: false }; },
    async getCommitChanges() { return []; },
    async getFileVersions() {
      versionRequests++;
      return committed ? [{ commit, change }] : [];
    },
    async previewChange(): Promise<never> { throw new Error("not used"); },
  });
  const view = new V4SyncCenterView(new WorkspaceLeaf(plugin.app), plugin as never);
  try {
    await view.onOpen();
    view.contentEl.findByText("Current file")?.onclick?.();
    await waitForCondition(() => view.contentEl.flattenText().includes("not been synced by V4 yet"),
      "new local file is initially unsynced");
    source.publish(uploadingFixture);
    committed = true;
    source.publish({ ...uploadingFixture, lifecycle: "no-change", phase: undefined, currentPath: undefined });
    await waitForCondition(() => view.contentEl.flattenText().includes("ADD · Notes/project.md"),
      "new file version displayed after successful no-change sync");
    assert.match(view.contentEl.flattenText(), /Versions of Notes\/project\.md/u);
    assert.equal(versionRequests, 1);
  } finally {
    await view.onClose();
  }
});

test("D430 stale history response cannot repaint the Sync Center after a successful Sync", async () => {
  const source = new FakeProgressSource();
  const plugin = createSyncCenterPluginFixture(source, () => undefined);
  const stale = deferred<{ items: Array<{ sha: string; message: string; authoredAt: string; source: "plugin" }>; hasMore: boolean }>();
  let requests = 0;
  plugin.v4Runtime.createHistoryService = async () => ({
    async listCommits() {
      requests++;
      if (requests === 1) return stale.promise;
      return { items: [{ sha: "new", message: "Current synced content", authoredAt: "", source: "plugin" as const }], hasMore: false };
    },
    async getCommitChanges() { return []; },
    async getFileVersions() { return []; },
    async previewChange(): Promise<never> { throw new Error("not used"); },
  });
  const view = new V4SyncCenterView(new WorkspaceLeaf(plugin.app), plugin as never);
  const opening = view.onOpen();
  try {
    await waitForCondition(() => requests === 1, "initial old commit request");
    source.publish(uploadingFixture);
    source.publish({ ...uploadingFixture, lifecycle: "success", phase: undefined, currentPath: undefined });
    await waitForCondition(() => view.contentEl.flattenText().includes("Current synced content"),
      "new commit history painted after Sync");
    stale.resolve({ items: [{ sha: "old", message: "Superseded cached history", authoredAt: "", source: "plugin" }], hasMore: false });
    await opening;
    assert.match(view.contentEl.flattenText(), /Current synced content/u);
    assert.doesNotMatch(view.contentEl.flattenText(), /Superseded cached history/u);
    assert.equal(requests, 2);
  } finally {
    stale.resolve({ items: [], hasMore: false });
    await view.onClose();
  }
});

test("D434 renaming the active note refreshes Current file versions without a file-open event", async () => {
  const source = new FakeProgressSource();
  const plugin = createSyncCenterPluginFixture(source, () => undefined);
  const active = { path: "Notes/starting.md" };
  const renameListeners = new Set<(file: { path: string }, oldPath: string) => void>();
  Object.assign(plugin.app.workspace, { getActiveFile: () => active });
  Object.assign(plugin.app, {
    vault: {
      on(event: string, listener: (file: { path: string }, oldPath: string) => void) {
        assert.equal(event, "rename");
        renameListeners.add(listener);
        return { listener };
      },
      offref(ref: { listener: (file: { path: string }, oldPath: string) => void }) {
        renameListeners.delete(ref.listener);
      },
    },
  });
  const reads: string[] = [];
  const oldVersions = deferred<Array<{
    commit: { sha: string; message: string; authoredAt: string; source: "plugin" };
    change: { kind: "add"; path: string; source: "plugin"; fileId: string };
  }>>();
  plugin.v4Runtime.fileIdForPath = async path => path;
  plugin.v4Runtime.createHistoryService = async () => ({
    async listCommits() { return { items: [], hasMore: false }; },
    async getCommitChanges() { return []; },
    async getFileVersions(fileId: string) {
      reads.push(fileId);
      if (fileId === "Notes/starting.md") return oldVersions.promise;
      return [{ commit: { sha: "new", message: "renamed", authoredAt: "", source: "plugin" as const },
        change: { kind: "add" as const, path: fileId, source: "plugin" as const, fileId } }];
    },
    async previewChange(): Promise<never> { throw new Error("not used"); },
  });
  const view = new V4SyncCenterView(new WorkspaceLeaf(plugin.app), plugin as never);
  const fireRename = (file: { path: string }, oldPath: string) => {
    for (const listener of [...renameListeners]) listener(file, oldPath);
  };
  try {
    await view.onOpen();
    assert.equal(renameListeners.size, 1, "Sync Center listens for Obsidian note renames");
    await view.onOpen();
    assert.equal(renameListeners.size, 1, "reopening a view does not retain duplicate vault listeners");
    view.contentEl.findByText("Current file")?.onclick?.();
    await waitForCondition(() => reads.length === 1, "initial file history request starts");
    fireRename({ path: "Notes/unrelated.md" }, "Notes/another.md");
    await Promise.resolve();
    assert.deepEqual(reads, ["Notes/starting.md"], "an unrelated rename must not refetch history");

    active.path = "Archive/starting.md";
    fireRename(active, "Notes/starting.md");
    await waitForCondition(() => view.contentEl.flattenText().includes("ADD · Archive/starting.md"),
      "renamed note versions appear without file-open");
    oldVersions.resolve([{ commit: { sha: "old", message: "old path", authoredAt: "", source: "plugin" },
      change: { kind: "add", path: "Notes/starting.md", source: "plugin", fileId: "Notes/starting.md" } }]);
    await Promise.resolve();
    await Promise.resolve();
    assert.match(view.contentEl.flattenText(), /Versions of Archive\/starting\.md/u);
    assert.doesNotMatch(view.contentEl.flattenText(), /ADD · Notes\/starting\.md/u);
    assert.deepEqual(reads, ["Notes/starting.md", "Archive/starting.md"]);
  } finally {
    oldVersions.resolve([]);
    await view.onClose();
  }
  assert.equal(renameListeners.size, 0, "closing Sync Center removes the rename listener");
  fireRename(active, "Notes/starting.md");
  assert.deepEqual(reads, ["Notes/starting.md", "Archive/starting.md"],
    "closed view must not fetch file history");
});

test("D433 Current file history follows opened notes, ignores duplicate opens and unsubscribes on close", async () => {
  const source = new FakeProgressSource();
  const plugin = createSyncCenterPluginFixture(source, () => undefined);
  let activePath: string | null = "Notes/one.md";
  const fileOpenListeners = new Set<() => void>();
  Object.assign(plugin.app.workspace, {
    getActiveFile: () => activePath ? { path: activePath } : null,
    on(event: string, listener: () => void) {
      assert.equal(event, "file-open");
      fileOpenListeners.add(listener);
      return { listener };
    },
    offref(ref: { listener: () => void }) { fileOpenListeners.delete(ref.listener); },
  });
  const reads: string[] = [];
  plugin.v4Runtime.fileIdForPath = async path => path;
  plugin.v4Runtime.createHistoryService = async () => ({
    async listCommits() { return { items: [], hasMore: false }; },
    async getCommitChanges() { return []; },
    async getFileVersions(fileId: string) {
      reads.push(fileId);
      return [{ commit: { sha: fileId, message: "version", authoredAt: "", source: "plugin" as const },
        change: { kind: "add" as const, path: fileId, source: "plugin" as const, fileId } }];
    },
    async previewChange(): Promise<never> { throw new Error("not used"); },
  });
  const view = new V4SyncCenterView(new WorkspaceLeaf(plugin.app), plugin as never);
  const fireFileOpen = () => { for (const listener of [...fileOpenListeners]) listener(); };
  try {
    await view.onOpen();
    assert.equal(fileOpenListeners.size, 1, "an open Sync Center subscribes to Obsidian file changes");
    await view.onOpen();
    assert.equal(fileOpenListeners.size, 1, "reopening a view must not duplicate active-file listeners");
    view.contentEl.findByText("Current file")?.onclick?.();
    await waitForCondition(() => view.contentEl.flattenText().includes("ADD · Notes/one.md"),
      "first note versions");
    activePath = "Notes/two.md";
    fireFileOpen();
    await waitForCondition(() => view.contentEl.flattenText().includes("ADD · Notes/two.md"),
      "second note versions appear automatically");
    assert.doesNotMatch(view.contentEl.flattenText(), /Notes\/one\.md/u);
    const readCount = reads.length;
    fireFileOpen();
    await Promise.resolve();
    assert.equal(reads.length, readCount, "reopening the same note does not refetch versions");
    activePath = null;
    fireFileOpen();
    assert.match(view.contentEl.flattenText(), /Open a file to view its versions/u);
    assert.equal(reads.length, readCount, "no active note requires no GitHub call");
    view.contentEl.findByText("Commits")?.onclick?.();
    activePath = "Notes/three.md";
    fireFileOpen();
    assert.match(view.contentEl.flattenText(), /Commit history/u);
    assert.equal(reads.length, readCount, "file-open must not replace the user's Commits view");
  } finally {
    await view.onClose();
  }
  assert.equal(fileOpenListeners.size, 0, "closing the view unregisters the file-open listener");
  const readsAfterClose = reads.length;
  fireFileOpen();
  assert.equal(reads.length, readsAfterClose);
});

test("D433 pending old file versions cannot repaint a newly opened note", async () => {
  const source = new FakeProgressSource();
  const plugin = createSyncCenterPluginFixture(source, () => undefined);
  let activePath = "Notes/old.md";
  const listeners = new Set<() => void>();
  Object.assign(plugin.app.workspace, {
    getActiveFile: () => ({ path: activePath }),
    on(_event: string, listener: () => void) {
      listeners.add(listener);
      return { listener };
    },
    offref(ref: { listener: () => void }) { listeners.delete(ref.listener); },
  });
  const oldVersions = deferred<Array<{
    commit: { sha: string; message: string; authoredAt: string; source: "plugin" };
    change: { kind: "add"; path: string; source: "plugin"; fileId: string };
  }>>();
  let oldReadStarted = false;
  plugin.v4Runtime.fileIdForPath = async path => path;
  plugin.v4Runtime.createHistoryService = async () => ({
    async listCommits() { return { items: [], hasMore: false }; },
    async getCommitChanges() { return []; },
    async getFileVersions(fileId: string) {
      if (fileId === "Notes/old.md") { oldReadStarted = true; return oldVersions.promise; }
      return [{ commit: { sha: "new", message: "current", authoredAt: "", source: "plugin" as const },
        change: { kind: "add" as const, path: fileId, source: "plugin" as const, fileId } }];
    },
    async previewChange(): Promise<never> { throw new Error("not used"); },
  });
  const view = new V4SyncCenterView(new WorkspaceLeaf(plugin.app), plugin as never);
  try {
    await view.onOpen();
    view.contentEl.findByText("Current file")?.onclick?.();
    await waitForCondition(() => oldReadStarted, "old note's slow history request");
    activePath = "Notes/new.md";
    for (const listener of [...listeners]) listener();
    await waitForCondition(() => view.contentEl.flattenText().includes("ADD · Notes/new.md"),
      "new note versions shown without waiting on old request");
    oldVersions.resolve([{ commit: { sha: "old", message: "stale", authoredAt: "", source: "plugin" },
      change: { kind: "add", path: "Notes/old.md", source: "plugin", fileId: "Notes/old.md" } }]);
    await Promise.resolve();
    await Promise.resolve();
    assert.match(view.contentEl.flattenText(), /Versions of Notes\/new\.md/u);
    assert.doesNotMatch(view.contentEl.flattenText(), /Notes\/old\.md/u);
  } finally {
    oldVersions.resolve([]);
    await view.onClose();
  }
});

test("D432 saving a different GitHub branch keeps Current file open and loads the saved branch versions", async () => {
  const source = new FakeProgressSource();
  const plugin = Object.assign(createSyncCenterPluginFixture(source, () => undefined), {
    settings: { githubToken: "test-token", githubOwner: "test-owner", githubRepo: "test-repo",
      githubBranch: "old-branch", encryptionMode: "plaintext" as const },
    githubClient: { branch: "old-branch" },
  });
  let commitReads = 0;
  const versionsByBranch: string[] = [];
  plugin.v4Runtime.createHistoryService = async () => {
    const branch = plugin.settings.githubBranch;
    return {
      async listCommits() { commitReads++; return { items: [], hasMore: false }; },
      async getCommitChanges() { return []; },
      async getFileVersions() {
        versionsByBranch.push(branch);
        return [{ commit: { sha: branch, message: "sync", authoredAt: "", source: "plugin" as const },
          change: { kind: "add" as const, path: `Notes/${branch}.md`, source: "plugin" as const, fileId: "file-id" } }];
      },
      async previewChange(): Promise<never> { throw new Error("not used"); },
    };
  };
  const view = new V4SyncCenterView(new WorkspaceLeaf(plugin.app), plugin as never);
  try {
    await view.onOpen();
    view.contentEl.findByText("Current file")?.onclick?.();
    await waitForCondition(() => view.contentEl.flattenText().includes("Notes/old-branch.md"),
      "old branch's current file history");
    const priorCommitReads = commitReads;
    plugin.settings = { ...plugin.settings, githubBranch: "new-branch" };
    plugin.githubClient = { branch: "new-branch" };
    view.onSettingsSaved();
    await waitForCondition(() => view.contentEl.flattenText().includes("Notes/new-branch.md"),
      "new saved branch's current file history");
    const visible = view.contentEl.flattenText();
    assert.match(visible, /Versions of Notes\/project\.md/u);
    assert.doesNotMatch(visible, /Notes\/old-branch\.md/u);
    assert.equal(commitReads, priorCommitReads,
      "saving Settings must not unexpectedly switch the user's Current file view to Commits");
    assert.deepEqual(versionsByBranch, ["old-branch", "new-branch"]);
  } finally {
    await view.onClose();
  }
});

test("D432 late old branch file versions cannot overwrite the saved branch's Current file view", async () => {
  const source = new FakeProgressSource();
  const plugin = Object.assign(createSyncCenterPluginFixture(source, () => undefined), {
    settings: { githubToken: "test-token", githubOwner: "test-owner", githubRepo: "test-repo",
      githubBranch: "old-branch", encryptionMode: "plaintext" as const },
    githubClient: { branch: "old-branch" },
  });
  const oldVersions = deferred<Array<{ commit: { sha: string; message: string; authoredAt: string; source: "plugin" }; change: { kind: "add"; path: string; source: "plugin"; fileId: string } }>>();
  let requestedOld = false;
  plugin.v4Runtime.createHistoryService = async () => {
    const branch = plugin.settings.githubBranch;
    return {
      async listCommits() { return { items: [], hasMore: false }; },
      async getCommitChanges() { return []; },
      async getFileVersions() {
        if (branch === "old-branch") { requestedOld = true; return oldVersions.promise; }
        return [{ commit: { sha: "new", message: "new version", authoredAt: "", source: "plugin" as const },
          change: { kind: "add" as const, path: "Notes/new-saved-branch.md", source: "plugin" as const, fileId: "file-id" } }];
      },
      async previewChange(): Promise<never> { throw new Error("not used"); },
    };
  };
  const view = new V4SyncCenterView(new WorkspaceLeaf(plugin.app), plugin as never);
  try {
    await view.onOpen();
    view.contentEl.findByText("Current file")?.onclick?.();
    await waitForCondition(() => requestedOld, "old branch file versions request starts");
    plugin.settings = { ...plugin.settings, githubBranch: "new-branch" };
    plugin.githubClient = { branch: "new-branch" };
    view.onSettingsSaved();
    await waitForCondition(() => view.contentEl.flattenText().includes("Notes/new-saved-branch.md"),
      "new branch versions appear without changing Current file mode");
    oldVersions.resolve([{ commit: { sha: "old", message: "stale version", authoredAt: "", source: "plugin" },
      change: { kind: "add", path: "Notes/stale-old-branch.md", source: "plugin", fileId: "file-id" } }]);
    await Promise.resolve();
    await Promise.resolve();
    assert.match(view.contentEl.flattenText(), /Notes\/new-saved-branch\.md/u);
    assert.doesNotMatch(view.contentEl.flattenText(), /Notes\/stale-old-branch\.md/u);
    assert.match(view.contentEl.flattenText(), /Versions of Notes\/project\.md/u);
  } finally {
    oldVersions.resolve([]);
    await view.onClose();
  }
});

test("D427 switching saved GitHub repositories refreshes Sync Center history instead of reusing old service", async () => {
  const source = new FakeProgressSource();
  const plugin = Object.assign(createSyncCenterPluginFixture(source, () => undefined), {
    settings: { githubToken: "test-token", githubOwner: "test-owner", githubRepo: "old-repo",
      githubBranch: "main", encryptionMode: "plaintext" as const },
    githubClient: { id: "old" },
  });
  let created = 0;
  plugin.v4Runtime.createHistoryService = async () => {
    const repo = plugin.settings.githubRepo;
    created++;
    return {
      async listCommits() {
        return { items: [{ sha: "abc12345", message: `History for ${repo}`, authoredAt: "2026-11-19", source: "plugin" as const }], hasMore: false };
      },
      async getCommitChanges() { return []; },
      async getFileVersions() { return []; },
      async previewChange(): Promise<never> { throw new Error("not used"); },
    };
  };
  const view = new V4SyncCenterView(new WorkspaceLeaf(plugin.app), plugin as never);
  try {
    await view.onOpen();
    assert.match(view.contentEl.flattenText(), /History for old-repo/u);
    plugin.settings = { ...plugin.settings, githubRepo: "new-repo" };
    plugin.githubClient = { id: "new" };
    view.contentEl.findByText("Commits")?.onclick?.();
    await waitForCondition(() => view.contentEl.flattenText().includes("History for new-repo"),
      "history from newly saved repository");
    assert.doesNotMatch(view.contentEl.flattenText(), /History for old-repo/u);
    assert.equal(created, 2, "the old repository history service must not be reused");
  } finally {
    await view.onClose();
  }
});

test("D427 a late old GitHub history result cannot overwrite the saved repository's current history", async () => {
  const source = new FakeProgressSource();
  const plugin = Object.assign(createSyncCenterPluginFixture(source, () => undefined), {
    settings: { githubToken: "test-token", githubOwner: "test-owner", githubRepo: "old-repo",
      githubBranch: "main", encryptionMode: "plaintext" as const },
    githubClient: { id: "old" },
  });
  const oldRequest = deferred<{ items: Array<{ sha: string; message: string; authoredAt: string; source: "plugin" }>; hasMore: boolean }>();
  let requestedOld = false;
  plugin.v4Runtime.createHistoryService = async () => {
    const repo = plugin.settings.githubRepo;
    return {
      async listCommits() {
        if (repo === "old-repo") { requestedOld = true; return oldRequest.promise; }
        return { items: [{ sha: "bbbbbbbb", message: "Current new-repo history", authoredAt: "2026-11-19", source: "plugin" as const }], hasMore: false };
      },
      async getCommitChanges() { return []; },
      async getFileVersions() { return []; },
      async previewChange(): Promise<never> { throw new Error("not used"); },
    };
  };
  const view = new V4SyncCenterView(new WorkspaceLeaf(plugin.app), plugin as never);
  const opening = view.onOpen();
  try {
    await waitForCondition(() => requestedOld, "old GitHub history request starts");
    plugin.settings = { ...plugin.settings, githubRepo: "new-repo" };
    plugin.githubClient = { id: "new" };
    (view as unknown as { onSettingsSaved(): void }).onSettingsSaved();
    await waitForCondition(() => view.contentEl.flattenText().includes("Current new-repo history"),
      "new repository history refreshed automatically after Save");
    oldRequest.resolve({ items: [{ sha: "aaaaaaaa", message: "Old repository private history", authoredAt: "2026-11-19", source: "plugin" }], hasMore: false });
    await opening;
    assert.match(view.contentEl.flattenText(), /Current new-repo history/u);
    assert.doesNotMatch(view.contentEl.flattenText(), /Old repository private history/u);
  } finally {
    oldRequest.resolve({ items: [], hasMore: false });
    await view.onClose();
  }
});

test("D426 Sync Center shows a safe history failure and allows retry after malformed adapter errors", async () => {
  const source = new FakeProgressSource();
  const secret = "github_pat_private-credential-must-not-be-displayed";
  let attempts = 0;
  const plugin = createSyncCenterPluginFixture(source, () => {
    attempts++;
    if (attempts === 1) throw null;
    if (attempts === 2) throw new Error(`History read failed: ${secret}`);
  });
  const noticesBefore = Notice.messages.length;
  const view = new V4SyncCenterView(new WorkspaceLeaf(plugin.app), plugin);
  try {
    await view.onOpen();
    const first = view.contentEl.flattenText();
    assert.match(first, /Could not load history/u, "a malformed rejection must not strand the loading spinner");
    assert.doesNotMatch(first, /Loading commits/u);
    assert.ok(view.contentEl.findByText("Commits"), "retry action must remain visible");

    view.contentEl.findByText("Commits")?.onclick?.();
    await waitForCondition(() => attempts === 2 && view.contentEl.flattenText().includes("Could not load history"),
      "second failed history request");
    assert.doesNotMatch(view.contentEl.flattenText(), /github_pat_private-credential-must-not-be-displayed/u);
    assert.ok(Notice.messages.slice(noticesBefore).every(message => !message.includes(secret)),
      "history errors must not leak access credentials through Obsidian Notices");

    view.contentEl.findByText("Commits")?.onclick?.();
    await waitForCondition(() => attempts === 3 && view.contentEl.flattenText().includes("Page 1"), "history retry success");
    assert.equal(attempts, 3);
    assert.doesNotMatch(view.contentEl.flattenText(), /Could not load history/u);
  } finally {
    await view.onClose();
  }
});

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


test("Sync Center shows measured HTTP request and RSS diagnostics without inventing hashing times", async () => {
  const source = new FakeProgressSource();
  const plugin = createSyncCenterPluginFixture(source, () => undefined);
  const view = new V4SyncCenterView(new WorkspaceLeaf(plugin.app), plugin as never);
  await view.onOpen();
  source.publish({ ...uploadingFixture, diagnostics: {
    apiRequests: 7, apiFailures: 0, uploadBytes: 2048, downloadBytes: 4096,
    apiLatencyMs: 750, inFlightApiRequests: 1, oldestInFlightApiMs: 55,
    peakRendererRssBytes: 104857600,
  } });
  const shown = view.contentEl.flattenText();
  assert.match(shown, /Upload API.*Download API.*GitHub API.*GitHub in flight.*Peak renderer RAM/su);
  assert.match(shown, /7 requests/su);
  assert.match(shown, /100\.0 MiB/su);
  assert.match(shown, /Decryption not measured/su);
  source.publish({ ...uploadingFixture, diagnostics: {
    apiRequests: 7, apiFailures: 0, uploadBytes: 2048, downloadBytes: 4096,
    apiLatencyMs: 750, inFlightApiRequests: 0, oldestInFlightApiMs: 0,
    decryptionMs: 1250,
  } });
  assert.match(view.contentEl.flattenText(), /Decryption 1\.3s/u);
  await view.onClose();
});

test("Sync Center recomputes measured run-average rates as time advances without new bytes", async () => {
  const source = new FakeProgressSource();
  const plugin = createSyncCenterPluginFixture(source, () => undefined);
  const view = new V4SyncCenterView(new WorkspaceLeaf(plugin.app), plugin as never);
  await view.onOpen();
  const diagnostics = {
    apiRequests: 1, apiFailures: 0, uploadBytes: 2048, downloadBytes: 0,
    apiLatencyMs: 100, inFlightApiRequests: 0, oldestInFlightApiMs: 0,
  };
  source.publish({ ...uploadingFixture, totalElapsedMs: 1000, diagnostics });
  assert.match(view.contentEl.flattenText(), /run avg 2\.0 KiB\/s/u);
  source.publish({ ...uploadingFixture, totalElapsedMs: 2000, diagnostics });
  assert.match(view.contentEl.flattenText(), /run avg 1\.0 KiB\/s/u);
  await view.onClose();
});

test("elapsed ticks do not repaint diagnostics when no measured data is available", async () => {
  const source = new FakeProgressSource();
  const plugin = createSyncCenterPluginFixture(source, () => undefined);
  const view = new V4SyncCenterView(new WorkspaceLeaf(plugin.app), plugin as never);
  await view.onOpen();
  const diagnosticsRegion = (view as unknown as {
    progressDiagnostics: { ownMutationCount: number };
  }).progressDiagnostics;
  source.publish({ ...uploadingFixture, totalElapsedMs: 1000 });
  const mutations = diagnosticsRegion.ownMutationCount;
  source.publish({ ...uploadingFixture, totalElapsedMs: 2000 });
  assert.equal(diagnosticsRegion.ownMutationCount, mutations);
  await view.onClose();
});

test("D469 failed Sync Center shows automatic pause and safe manual recovery guidance", async () => {
  const source = new FakeProgressSource();
  const plugin = createSyncCenterPluginFixture(source, () => undefined);
  const view = new V4SyncCenterView(new WorkspaceLeaf(plugin.app), plugin as never);
  try {
    await view.onOpen();
    source.publish({
      ...uploadingFixture, lifecycle: "failed",
      errorMessage: "GitHub write result unknown",
    });
    const message = view.contentEl.flattenText();
    assert.match(message, /Auto-Sync paused/u);
    assert.match(message, /Sync now/u);
    assert.match(message, /inspect.*GitHub|review.*GitHub/iu);
    source.publish({ ...createIdleV4Progress(), lifecycle: "success", lastSyncTime: Date.now() });
    assert.doesNotMatch(view.contentEl.flattenText(), /Auto-Sync paused/u);
  } finally {
    await view.onClose();
  }
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

test("timing ticks leave the concise live region untouched while phase and lifecycle changes announce", async () => {
  const source = new FakeProgressSource();
  const plugin = createSyncCenterPluginFixture(source, () => undefined);
  const view = new V4SyncCenterView(new WorkspaceLeaf(plugin.app), plugin as never);
  await view.onOpen();
  source.publish(uploadingFixture);

  const live = view.contentEl.findByAttribute("role", "status");
  assert.ok(live);
  const liveMutations = live.ownMutationCount;
  const text = live.flattenText();
  const rootMutations = view.contentEl.mutationCount;
  source.publish({
    ...uploadingFixture,
    timings: uploadingFixture.timings.map(timing => ({ ...timing, elapsedMs: timing.elapsedMs + 1_000 })),
    totalElapsedMs: uploadingFixture.totalElapsedMs + 1_000,
  });
  assert.equal(view.contentEl.findByAttribute("role", "status"), live);
  assert.equal(live.flattenText(), text);
  assert.equal(live.ownMutationCount, liveMutations);
  assert.ok(view.contentEl.mutationCount > rootMutations);
  assert.match(view.contentEl.flattenText(), /Total 9\.9s/u);

  source.publish({ ...uploadingFixture, phase: "committing", currentPath: undefined });
  assert.equal(view.contentEl.findByAttribute("role", "status"), live);
  assert.equal(live.flattenText(), "Committing");
  assert.ok(live.ownMutationCount > liveMutations);
  source.publish({ ...uploadingFixture, lifecycle: "success", phase: undefined, currentPath: undefined });
  assert.equal(live.flattenText(), "Success");
  await view.onClose();
});

test("idle progress card omits run context and direction rows", async () => {
  const source = new FakeProgressSource();
  const plugin = createSyncCenterPluginFixture(source, () => undefined);
  const view = new V4SyncCenterView(new WorkspaceLeaf(plugin.app), plugin as never);
  await view.onOpen();
  const text = view.contentEl.flattenText();
  assert.match(text, /Idle/u);
  assert.doesNotMatch(text, /Pull 0\/\?|Push 0\/\?|Normal|Attempt/u);
  await view.onClose();
});

test("stale image preview completion cannot revoke or replace a reopened view URL", async () => {
  const source = new FakeProgressSource();
  const previews = [deferred<any>(), deferred<any>()];
  let previewIndex = 0;
  const commit = { sha: "abc12345", message: "sync", authoredAt: "2026-07-16", source: "plugin" } as const;
  const change = { kind: "modify", path: "image.png" } as const;
  const service = {
    async listCommits() { return { items: [commit], hasMore: false }; },
    async getCommitChanges() { return [change]; },
    async getFileVersions() { return []; },
    previewChange() { return previews[previewIndex++].promise; },
  };
  const plugin = createSyncCenterPluginFixture(source, () => undefined) as any;
  plugin.v4Runtime.createHistoryService = async () => service;
  const created: string[] = [];
  const revoked: string[] = [];
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  URL.createObjectURL = () => { const value = `blob:test-${created.length + 1}`; created.push(value); return value; };
  URL.revokeObjectURL = value => { revoked.push(value); };
  try {
    const view = new V4SyncCenterView(new WorkspaceLeaf(plugin.app), plugin);
    await view.onOpen();
    const stalePreview = (view as any).renderPreview(
      commit,
      change,
      view.contentEl.findByClass("github-sync-center__detail"),
    ) as Promise<void>;
    await Promise.resolve();
    assert.equal(previewIndex, 1);

    await view.onClose();
    await view.onOpen();
    const currentPreview = (view as any).renderPreview(
      commit,
      change,
      view.contentEl.findByClass("github-sync-center__detail"),
    ) as Promise<void>;
    await Promise.resolve();
    assert.equal(previewIndex, 2);

    previews[1].resolve({ kind: "image", bytes: new Uint8Array([2]), mime: "image/png" });
    await currentPreview;
    assert.deepEqual(created, ["blob:test-1"]);
    assert.deepEqual(revoked, []);

    previews[0].resolve({ kind: "image", bytes: new Uint8Array([1]), mime: "image/png" });
    await stalePreview;
    assert.deepEqual(created, ["blob:test-1"]);
    assert.deepEqual(revoked, []);
    assert.equal(view.contentEl.findByAttribute("src", "blob:test-1") !== undefined, true);

    await view.onClose();
    assert.deepEqual(revoked, ["blob:test-1"]);
  } finally {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  }
});
