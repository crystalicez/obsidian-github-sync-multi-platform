import assert from "node:assert/strict";
import test from "node:test";
import { TFile } from "obsidian";

import type { GitHubCreateTreeEntry } from "../../src/lib/github-git-types";
import { V4PluginRuntime } from "../../src/lib/v4/runtime";

class MemoryGitHub {
  ref: { ref: string; sha: string; type: string } | null = null;
  files = new Map<string, Uint8Array>();
  blobs = new Map<string, Uint8Array>();
  trees = new Map<string, Map<string, Uint8Array>>();
  commits = new Map<string, { treeSha: string; parents: string[]; message: string }>();
  updateAttempts = 0;
  raceArmed = false;
  raceFired = false;

  async getFileBytes(path: string, ref?: string) {
    const commit = ref ? this.commits.get(ref) : undefined;
    const value = commit ? this.trees.get(commit.treeSha)?.get(path) : this.files.get(path);
    return value ? { bytes: new Uint8Array(value), sha: `sha-${path}` } : null;
  }
  async getGitRefOrNull() { return this.ref; }
  async ensureGitRepositoryInitialized() { return null; }
  async getGitCommit(sha: string) {
    const value = this.commits.get(sha);
    if (!value) throw new Error(`Missing commit ${sha}`);
    return { sha, treeSha: value.treeSha, parentShas: value.parents, message: value.message };
  }
  async getTreeAt(treeSha: string) {
    const tree = this.trees.get(treeSha) ?? new Map<string, Uint8Array>();
    return {
      sha: treeSha,
      url: "",
      truncated: false,
      tree: [...tree.entries()].map(([path, bytes], index) => ({
        path,
        mode: "100644",
        type: "blob" as const,
        sha: `tree-blob-${index}`,
        size: bytes.byteLength,
        url: "",
      })),
    };
  }
  async createGitBlob(bytes: Uint8Array) {
    const sha = `blob-${this.blobs.size + 1}`;
    this.blobs.set(sha, new Uint8Array(bytes));
    return sha;
  }
  async createGitTree(entries: GitHubCreateTreeEntry[], baseTree?: string) {
    const tree = new Map(baseTree ? this.trees.get(baseTree) : undefined);
    for (const entry of entries) {
      if (entry.sha === null) tree.delete(entry.path);
      else tree.set(entry.path, new Uint8Array(this.blobs.get(entry.sha)!));
    }
    const sha = `tree-${this.trees.size + 1}`;
    this.trees.set(sha, tree);
    return sha;
  }
  async createGitCommit(message: string, treeSha: string, parents: string[]) {
    const sha = `commit-${this.commits.size + 1}`;
    this.commits.set(sha, { treeSha, parents, message });
    return sha;
  }
  async createGitRef(sha: string) {
    this.ref = { ref: "refs/heads/main", sha, type: "commit" };
    this.files = new Map(this.trees.get(this.commits.get(sha)!.treeSha));
  }
  async updateGitRef(sha: string, expected?: string) {
    this.updateAttempts++;
    if (expected && this.ref?.sha !== expected) throw new Error("stale ref");
    if (this.raceArmed && !this.raceFired && this.ref) {
      this.raceFired = true;
      const current = this.ref.sha;
      const currentCommit = this.commits.get(current)!;
      const externalSha = await this.createGitCommit("external-runtime-race", currentCommit.treeSha, [current]);
      await this.createGitRef(externalSha);
      throw new Error("stale ref");
    }
    await this.createGitRef(sha);
  }
}

class MemoryObsidianVault {
  configDir = ".obsidian";
  readonly bytes = new Map<string, Uint8Array>();
  readonly files = new Map<string, TFile>();

  set(path: string, bytes: Uint8Array, mtime: number): void {
    this.bytes.set(path, new Uint8Array(bytes));
    let file = this.files.get(path);
    if (!file) {
      file = new TFile(path, bytes);
      this.files.set(path, file);
    }
    file.stat = { size: bytes.byteLength, mtime };
  }

  getFiles() { return [...this.files.values()]; }
  getAbstractFileByPath(path: string) { return this.files.get(path) ?? null; }
  async readBinary(file: TFile) { return new Uint8Array(this.bytes.get(file.path) ?? new Uint8Array()).buffer; }
  async modifyBinary(file: TFile, buffer: ArrayBuffer) { this.set(file.path, new Uint8Array(buffer), Date.now()); }
  async createBinary(path: string, buffer: ArrayBuffer) { this.set(path, new Uint8Array(buffer), Date.now()); return this.files.get(path)!; }
  async createFolder(_path: string) {}
}

function pluginFixture() {
  const githubClient = new MemoryGitHub();
  const vault = new MemoryObsidianVault();
  const ignoredFiles = new Set<string>();
  const plugin = {
    settings: {
      syncEnabled: true,
      syncOnLocalChange: true,
      githubOwner: "o",
      githubRepo: "r",
      githubBranch: "main",
      encryptionMode: "plaintext",
      encryptionPassphrase: "",
      ignorePathRegex: "",
      syncObsidianConfig: false,
      syncBookmarks: false,
      syncPlugins: false,
      conflictPolicy: "copy",
      abortChangePercent: 0,
      vault: "runtime-retry-device",
      consoleLoggingEnabled: false,
    },
    manifest: { id: "runtime-retry-test" },
    app: {
      vault,
      fileManager: {
        async trashFile(file: TFile) {
          vault.bytes.delete(file.path);
          vault.files.delete(file.path);
        },
      },
    },
    githubClient,
    ignoredFiles,
    isWatchEnabled: true,
    isSyncInProgress: false,
    addIgnoredFile(path: string) { ignoredFiles.add(path); },
    removeIgnoredFile(path: string) { ignoredFiles.delete(path); },
    enableWatch() { this.isWatchEnabled = true; },
  };
  return { plugin, githubClient, vault };
}

test("one manual sync automatically retries a recoverable stale-ref publication race", async () => {
  const { plugin, githubClient, vault } = pluginFixture();
  vault.set("note.md", new TextEncoder().encode("base\n"), 1);
  const runtime = new V4PluginRuntime(plugin as never);

  const initialized = await runtime.forcePush();
  assert.equal((initialized as { status?: string }).status, "completed");
  assert.ok(githubClient.ref?.sha);

  vault.set("note.md", new TextEncoder().encode("local-after-race\n"), 2);
  githubClient.raceArmed = true;
  const observedAttempts: number[] = [];
  const unsubscribe = runtime.subscribeProgress(snapshot => observedAttempts.push(snapshot.attempt));

  const result = await runtime.manualSync();
  unsubscribe();

  assert.equal((result as { status?: string }).status, "completed");
  assert.equal(githubClient.raceFired, true);
  assert.equal(githubClient.updateAttempts >= 2, true);
  assert.equal(Math.max(...observedAttempts), 2);
  assert.equal(runtime.progressSnapshot.lifecycle, "success");
  assert.equal(runtime.progressSnapshot.attempt, 2);
  assert.equal([...vault.files.keys()].some(path => path.includes(".conflict-remote-")), false);

  runtime.dispose();
});
