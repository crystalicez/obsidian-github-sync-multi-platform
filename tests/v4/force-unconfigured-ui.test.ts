import assert from "node:assert/strict";
import test from "node:test";

import FastSync from "../../src/main";
import { DEFAULT_SETTINGS } from "../../src/setting";
import { Notice, modalEvents, resetModalTestState } from "../stubs/obsidian";

test("Force operations cannot open destructive confirmation with an unconfigured saved target", async () => {
  for (const missing of ["githubOwner", "githubRepo", "githubToken"] as const) {
    for (const operation of ["forcePush", "forcePull"] as const) {
      resetModalTestState();
      Notice.messages.length = 0;
      let calls = 0;
      const plugin = new FastSync() as FastSync & Record<string, any>;
      plugin.settings = {
        ...DEFAULT_SETTINGS,
        githubOwner: "test-owner",
        githubRepo: "test-repo",
        githubToken: "test-token",
        [missing]: " ",
      };
      plugin.v4Runtime = {
        settingsGeneration: 1,
        forcePush() { calls++; },
        forcePull() { calls++; },
      };
      plugin.app = { vault: { getFiles: () => [] } };

      await plugin.showForceConfirm(operation);
      assert.equal(calls, 0, "cannot start force operation without saved credentials");
      assert.deepEqual(modalEvents, [], "unconfigured operation must not offer unlock slider or modal");
      assert.match(Notice.messages.at(-1) ?? "", /configure.*GitHub.*(before|first)/iu);
    }
  }
});
