import assert from "node:assert/strict";
import test from "node:test";

import { createEmptyV4LocalIndex } from "../../src/lib/v4/local-index";
import { V4_FORMAT_VERSION, type V4RemoteConfig } from "../../src/lib/v4/protocol-types";
import { V4SyncSession, type V4SyncRunState } from "../../src/lib/v4/sync-session";
import type { V4StageRef } from "../../src/lib/v4/staging-store";

const config: V4RemoteConfig = {
  formatVersion: V4_FORMAT_VERSION,
  mode: "plaintext",
  repoId: "o/r#main",
};

test("cleaning an owned conflict-copy stage invalidates only the carried stage, not its reserved identity", async () => {
  const stage: V4StageRef = { stageId: "conflict-stage", hash: "a".repeat(64), size: 4, mtime: 1 };
  const runState: V4SyncRunState = {
    conflictCopies: new Map([["source-file", { path: "remote.conflict-remote-device-1.md", fileId: "copy-file", includeInSync: true }]]),
    conflictCopyStages: new Map([["copy-file", {
      path: "remote.conflict-remote-device-1.md",
      fileId: "copy-file",
      includeInSync: true,
      stage,
    }]]),
  };
  const removed: string[] = [];
  const index = createEmptyV4LocalIndex({ repoId: config.repoId, deviceId: "device", mode: "plaintext" });
  const session = new V4SyncSession({
    github: {} as never,
    vault: {
      async listFiles() { return []; },
      async read() { throw new Error("unexpected read"); },
      async write() { throw new Error("unexpected write"); },
      async trash() { throw new Error("unexpected trash"); },
      staging: {
        async remove(ownedStage) { removed.push(ownedStage.stageId); },
      } as never,
    },
    index,
    config,
    conflictPolicy: "copy",
    abortChangePercent: 0,
    runState,
  });

  await (session as unknown as { cleanupStages(stages: readonly V4StageRef[]): Promise<void> }).cleanupStages([stage]);

  assert.deepEqual(removed, [stage.stageId]);
  assert.equal(runState.conflictCopyStages?.has("copy-file"), false, "retry must not carry a stage that cleanup already removed");
  assert.deepEqual(runState.conflictCopies.get("source-file"), {
    path: "remote.conflict-remote-device-1.md",
    fileId: "copy-file",
    includeInSync: true,
  }, "retry must preserve the reserved conflict-copy path and fileId");
});
