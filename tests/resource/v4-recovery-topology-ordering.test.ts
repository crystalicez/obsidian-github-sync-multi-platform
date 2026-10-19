import assert from "node:assert/strict"
import test from "node:test"

import type { V4RecoveryLocalMutation } from "../../src/lib/v4/recovery-types"
import { orderRecoveryMutationsForFileTopology } from "../../src/lib/v4/sync-session"

function stageWrite(index: number): V4RecoveryLocalMutation {
  return {
    id: `write:${index}`,
    kind: "stage-write",
    path: `write/${index.toString().padStart(5, "0")}.md`,
    stage: { stageId: `stage-${index}`, hash: "a".repeat(64), size: 1, mtime: 1 },
    precondition: { path: `write/${index.toString().padStart(5, "0")}.md`, exists: false },
  }
}

function trash(index: number): V4RecoveryLocalMutation {
  return {
    id: `trash:${index}`,
    kind: "trash",
    path: `trash/${index.toString().padStart(5, "0")}.md`,
    precondition: { path: `trash/${index.toString().padStart(5, "0")}.md`, exists: true, size: 1, mtime: 1 },
  }
}

test("recovery topology ordering scales without pairwise trash/write scans", () => {
  const count = 10_000
  const mutations: V4RecoveryLocalMutation[] = []
  for (let index = 0; index < count; index++) mutations.push(stageWrite(index))
  for (let index = 0; index < count; index++) mutations.push(trash(index))

  const started = process.cpuUsage()
  const ordered = orderRecoveryMutationsForFileTopology(mutations)
  const elapsed = process.cpuUsage(started)

  assert.equal(ordered.length, mutations.length)
  assert.equal(ordered[0].id, mutations[0].id)
  assert.ok(
    elapsed.user + elapsed.system < 750_000,
    `topology ordering used ${elapsed.user + elapsed.system}µs CPU for ${mutations.length} mutations`,
  )
})
