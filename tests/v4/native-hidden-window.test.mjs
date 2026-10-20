import assert from "node:assert/strict";
import test from "node:test";
import { parseNativeHiddenIdleMs, hideOwnedObsidianWindow } from "../../scripts/native-hidden-window.mjs";

test("native hidden option is disabled by default and requires bounded bulk-note run", () => {
  assert.equal(parseNativeHiddenIdleMs(undefined, 1000), 0);
  assert.equal(parseNativeHiddenIdleMs("5000", 100), 5000);
  assert.equal(parseNativeHiddenIdleMs("310000", 100), 310000);
  for (const value of ["0", "1", "4999", "360001", "-1", "nan", "Infinity", "1.5"]) {
    assert.throws(() => parseNativeHiddenIdleMs(value, 100), /hidden idle/iu);
  }
  assert.throws(() => parseNativeHiddenIdleMs("5000", 0), /bulk notes/iu);
});

test("native hidden qualification never targets unrelated or ambiguous Obsidian processes", () => {
  const spawned = [];
  const spawn = (command, args) => {
    spawned.push({ command, args });
    return { status: 1, stdout: "", stderr: "Multiple matching windows" };
  };
  assert.throws(() => hideOwnedObsidianWindow({
    runId: "0123456789abcdef", expectedProfile: "C:\\personal\\Obsidian", spawn, platform: "win32",
  }), /non-synthetic/iu);
  assert.throws(() => hideOwnedObsidianWindow({
    runId: "not-random", expectedProfile: "C:\\tmp\\obsidian-live-github-e2e\\not-random\\profile", spawn, platform: "win32",
  }), /identifier/iu);
  assert.equal(spawned.length, 0);
  const expectedProfile = "C:\\tmp\\obsidian-live-github-e2e\\0123456789abcdef\\profile";
  assert.throws(() => hideOwnedObsidianWindow({
    runId: "0123456789abcdef", expectedProfile, spawn, platform: "win32",
  }), /uniquely identified synthetic/iu);
  assert.equal(spawned.length, 1);
  assert.match(spawned[0].args[2], /handles\.Count -ne 1/u);
  assert.match(spawned[0].args[2], /ShowWindowAsync\(\$handles\[0\],0\)/u);
  hideOwnedObsidianWindow({
    runId: "0123456789abcdef", expectedProfile, platform: "win32",
    spawn: () => ({ status: 0, stdout: "SYNTHETIC_OBSIDIAN_MINIMIZED", stderr: "" }),
  });
});
