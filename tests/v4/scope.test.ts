import assert from "node:assert/strict";
import test from "node:test";

import { isPathInV4SyncScope, type V4ScopeSettings } from "../../src/lib/v4/scope";

const base: V4ScopeSettings = {
  configDir: ".obsidian",
  pluginId: "encrypted-github-sync-multi-platform",
  ignorePathRegex: "",
  syncObsidianConfig: false,
  syncBookmarks: false,
  syncPlugins: false,
};

test("v4 scope syncs every ordinary vault file type", () => {
  assert.equal(isPathInV4SyncScope("Notes/a.md", base), true);
  assert.equal(isPathInV4SyncScope("Attachments/archive.zip", base), true);
  assert.equal(isPathInV4SyncScope("Media/movie.mp4", base), true);
});

test("v4 .obsidian settings are independent and hard exclusions always win", () => {
  assert.equal(isPathInV4SyncScope(".obsidian/app.json", base), false);
  assert.equal(isPathInV4SyncScope(".obsidian/bookmarks.json", { ...base, syncBookmarks: true }), true);
  assert.equal(isPathInV4SyncScope(".obsidian/plugins/example/main.js", { ...base, syncPlugins: true }), true);
  assert.equal(isPathInV4SyncScope(".obsidian/community-plugins.json", { ...base, syncPlugins: true }), true);
  assert.equal(isPathInV4SyncScope(".obsidian/app.json", { ...base, syncObsidianConfig: true }), true);
  assert.equal(isPathInV4SyncScope(".obsidian/bookmarks.json", { ...base, syncObsidianConfig: true }), false);
  assert.equal(isPathInV4SyncScope(".obsidian/community-plugins.json", { ...base, syncObsidianConfig: true }), false);
  assert.equal(isPathInV4SyncScope(".obsidian/workspace.json", { ...base, syncObsidianConfig: true }), false);
  assert.equal(isPathInV4SyncScope(".obsidian/workspace-mobile.json", { ...base, syncObsidianConfig: true }), false);
  assert.equal(isPathInV4SyncScope(".obsidian/plugins/encrypted-github-sync-multi-platform/data.json", { ...base, syncPlugins: true }), false);
  assert.equal(isPathInV4SyncScope(".obsidian/plugins/encrypted-github-sync-multi-platform/github-sync-v4-stage/opaque.bin", { ...base, syncPlugins: true, syncObsidianConfig: true }), false);
  assert.equal(isPathInV4SyncScope(".obsidian-github-sync-v4/head", { ...base, syncObsidianConfig: true, syncPlugins: true }), false);
});

test("v4 scope applies ignore regex to normalized plaintext paths", () => {
  const settings = { ...base, ignorePathRegex: "^Archive/\n\\.tmp$" };
  assert.equal(isPathInV4SyncScope("Archive/a.md", settings), false);
  assert.equal(isPathInV4SyncScope("Notes/a.tmp", settings), false);
  assert.equal(isPathInV4SyncScope("Notes/a.md", settings), true);
});
