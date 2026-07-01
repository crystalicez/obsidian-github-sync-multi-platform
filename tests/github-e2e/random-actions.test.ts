import assert from "node:assert/strict";
import test from "node:test";
import { chooseRandomAction, chooseRandomSyncMode, formatTimingRecord, requiredChangedFileCounts, readRandomActionConfig, readRandomActionLimits } from "./random-actions";

test("github random e2e defaults to ten random actions instead of a duration loop", () => {
  const config = readRandomActionConfig({});
  assert.equal(config.actionCount, 10);
});

test("github random e2e action count is configurable and ignores duration as the loop bound", () => {
  const config = readRandomActionConfig({
    GITHUB_E2E_RANDOM_ACTIONS: "3",
    GITHUB_E2E_RANDOM_DURATION_MS: "600000",
  });
  assert.equal(config.actionCount, 3);
});

test("github random e2e only adds files when the vault is empty", () => {
  const action = chooseRandomAction(0, {
    int: () => 0,
    pick: items => items[items.length - 1],
  });
  assert.equal(action, "addFiles");
});

test("github random e2e uses event-style sync for small user-like file changes", () => {
  const mode = chooseRandomSyncMode("renameFiles", 1, {
    int: () => 0,
    pick: items => items[0],
  });
  assert.equal(mode, "event");
});

test("github random e2e keeps large multi-file actions bulk-synced", () => {
  const mode = chooseRandomSyncMode("editText", 2000, {
    int: () => 0,
    pick: items => items[0],
  });
  assert.equal(mode, "bulk");
});

test("github random e2e defaults to smoke-sized per-action batches", () => {
  const limits = readRandomActionLimits({});
  assert.equal(limits.loopMaxAddFiles, 10);
  assert.equal(limits.loopMaxEditFiles, 10);
  assert.equal(limits.loopMaxDeleteFiles, 10);
  assert.equal(limits.loopMaxRenameFiles, 5);
  assert.equal(limits.loopMaxMoveFiles, 5);
  assert.equal(limits.loopMaxImages, 2);
});

test("github random e2e stress batch sizes remain configurable", () => {
  const limits = readRandomActionLimits({
    GITHUB_E2E_RANDOM_LOOP_MAX_ADD_FILES: "5000",
    GITHUB_E2E_RANDOM_LOOP_MAX_EDIT_FILES: "2000",
    GITHUB_E2E_RANDOM_LOOP_MAX_DELETE_FILES: "2000",
  });
  assert.equal(limits.loopMaxAddFiles, 5000);
  assert.equal(limits.loopMaxEditFiles, 2000);
  assert.equal(limits.loopMaxDeleteFiles, 2000);
});
test("github random e2e keeps multi-file event-like actions bulk-synced", () => {
  const mode = chooseRandomSyncMode("deleteFiles", 2, {
    int: () => 0,
    pick: items => items[0],
  });
  assert.equal(mode, "bulk");
});
test("github e2e timing records include phase boundaries and per-file averages", () => {
  const record = formatTimingRecord("forcePush.smallVault", 1234.56, {
    operation: "forcePush",
    phase: "after-force-push",
    files: 10,
    changedFiles: 2,
    bytes: 4096,
  });

  assert.equal(record.operation, "forcePush");
  assert.equal(record.phase, "after-force-push");
  assert.equal(record.files, 10);
  assert.equal(record.changedFiles, 2);
  assert.equal(record.elapsedMs, 1234.56);
  assert.equal(record.msPerFile, 123.456);
  assert.equal(record.msPerChangedFile, 617.28);
});

test("github random e2e includes required changed-file batch counts", () => {
  assert.deepEqual(requiredChangedFileCounts(), [1, 2, 3, 4, 5, 6, 7, 8, 10, 2000]);
});
