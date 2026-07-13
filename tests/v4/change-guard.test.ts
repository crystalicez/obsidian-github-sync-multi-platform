import assert from "node:assert/strict";
import test from "node:test";
import { evaluateV4ChangeGuard } from "../../src/lib/v4/change-guard";

test("v4 change guard disables at zero and blocks only above the configured percent", () => {
  assert.equal(evaluateV4ChangeGuard({ thresholdPercent: 0, changedFiles: 100, baseFiles: 100, localFiles: 100, remoteFiles: 100 }).blocked, false);
  assert.deepEqual(evaluateV4ChangeGuard({ thresholdPercent: 10, changedFiles: 10, baseFiles: 100, localFiles: 100, remoteFiles: 100 }), { blocked: false, changePercent: 10, thresholdPercent: 10 });
  assert.deepEqual(evaluateV4ChangeGuard({ thresholdPercent: 10, changedFiles: 11, baseFiles: 100, localFiles: 100, remoteFiles: 100 }), { blocked: true, changePercent: 11, thresholdPercent: 10 });
});

test("v4 change guard handles initialization and caps percent at 100", () => {
  assert.equal(evaluateV4ChangeGuard({ thresholdPercent: 50, changedFiles: 20, baseFiles: 0, localFiles: 20, remoteFiles: 0 }).changePercent, 100);
  assert.equal(evaluateV4ChangeGuard({ thresholdPercent: 50, changedFiles: 300, baseFiles: 100, localFiles: 100, remoteFiles: 100 }).changePercent, 100);
});
