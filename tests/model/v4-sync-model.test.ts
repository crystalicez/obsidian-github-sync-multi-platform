import assert from "node:assert/strict"
import test from "node:test"

import {
  createV4TwoDeviceModel,
  type V4ModelConflictAction,
  type V4ModelFault,
} from "./v4-sync-model"

const conflictActions: V4ModelConflictAction[] = ["use-local", "use-remote", "keep-local-copy-remote", "merged", "ask"]
const faults: V4ModelFault[] = [
  "source-mutation",
  "lost-response",
  "rate-limit",
  "cancellation",
  "staging-failure",
  "disk-space-failure",
  "corrupt-recovery",
  "index-save-crash",
]

test("two-device model preserves identity across create modify rename folder-rename delete and recreate", () => {
  const model = createV4TwoDeviceModel()
  const firstId = model.create("A", "folder/note.md", "v1")
  model.sync("A", "normal")
  model.sync("B", "normal")
  model.modify("A", "folder/note.md", "v2")
  model.rename("A", "folder/note.md", "folder/renamed.md")
  model.renameFolder("A", "folder", "moved")
  model.sync("A", "normal")
  model.sync("B", "normal")
  assert.equal(model.file("B", "moved/renamed.md")?.fileId, firstId)
  model.delete("A", "moved/renamed.md")
  model.sync("A", "normal")
  const replacementId = model.recreate("A", "moved/renamed.md", "v3")
  assert.notEqual(replacementId, firstId)
  model.sync("A", "normal")
  model.sync("B", "normal")
  assert.equal(model.file("B", "moved/renamed.md")?.fileId, replacementId)
})

test("two-device model covers Force Push Pull stale head direct edit pack and chunked shapes", () => {
  const model = createV4TwoDeviceModel()
  model.create("A", "local.md", "a")
  model.sync("A", "forcePush")
  model.directRemoteEdit("local.md", "direct")
  model.create("B", "other.md", "b")
  const stale = model.sync("B", "normal")
  assert.equal(stale.staleHeadObserved, true)
  model.sync("B", "forcePull")
  assert.equal(model.file("B", "local.md")?.hash, "direct")
  assert.deepEqual(model.storageShape(65, 512 * 1024), { kind: "pack", entries: 65 })
  assert.deepEqual(model.storageShape(51 * 1024 * 1024, 1), { kind: "chunked", parts: 2 })
})

test("two-device model has deterministic outcomes for every V4 conflict action", () => {
  for (const action of conflictActions) {
    const model = createV4TwoDeviceModel()
    model.create("A", "note.md", "base")
    model.sync("A", "normal")
    model.sync("B", "normal")
    model.modify("A", "note.md", "local-a")
    model.modify("B", "note.md", "local-b")
    model.sync("A", "normal")
    const before = model.snapshot()
    const result = model.sync("B", "normal", action)
    if (action === "ask") {
      assert.equal(result.pendingConflict, true)
      assert.deepEqual(model.snapshot(), before)
    } else {
      assert.equal(result.pendingConflict, false)
      model.assertNoSilentDataLoss()
    }
  }
})

test("fault matrix never advances a verified base from unverified state", () => {
  for (const fault of faults) {
    const model = createV4TwoDeviceModel()
    model.create("A", "note.md", "base")
    model.sync("A", "normal")
    model.sync("B", "normal")
    model.modify("A", "note.md", "changed")
    const result = model.sync("A", "normal", "use-local", fault)
    model.assertNoSilentDataLoss()
    assert.equal(result.unverifiedIndexAdvanced, false, fault)
    assert.equal(result.recoveryRequired, true, fault)
  }
})
