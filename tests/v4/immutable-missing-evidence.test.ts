import assert from "node:assert/strict"
import test from "node:test"
import { inspectImmutableMissingObject } from "../github-e2e/support/immutable-missing-evidence"

const COMMIT = "1".repeat(40)
const ROOT = "2".repeat(40)
const NOTES = "3".repeat(40)
const BLOB = "4".repeat(40)

function fixture(extra?: {
  getCommit?: (sha: string) => Promise<{ status: number; json?: unknown }>
  getTree?: (sha: string) => Promise<{ status: number; json?: unknown }>
}) {
  const calls: string[] = []
  return {
    calls,
    adapter: {
      getCommit: async (sha: string) => {
        calls.push("commit:" + sha)
        return extra?.getCommit ? extra.getCommit(sha)
          : { status: 200, json: { sha: COMMIT, tree: { sha: ROOT } } }
      },
      getTree: async (sha: string) => {
        calls.push("tree:" + sha)
        return extra?.getTree ? extra.getTree(sha)
          : sha === ROOT
            ? { status: 200, json: { sha: ROOT, truncated: false, tree: [{ path: "Notes", mode: "040000", type: "tree", sha: NOTES }] } }
            : { status: 200, json: { sha: NOTES, truncated: false, tree: [{ path: "reborn.md", mode: "100644", type: "blob", sha: BLOB }] } }
      },
    },
  }
}

test("inspect exact immutable commit and both nonrecursive tree levels without downloading the blob", async () => {
  const f = fixture()
  const evidence = await inspectImmutableMissingObject("Notes/reborn.md", COMMIT, f.adapter)
  assert.equal(evidence.outcome, "blob-present-in-tree")
  assert.deepEqual(f.calls, ["commit:" + COMMIT, "tree:" + ROOT, "tree:" + NOTES])
  assert.deepEqual(evidence.observations.map(x => ({
    kind: x.kind, requestedSha: x.requestedSha, status: x.httpStatus, receivedSha: x.receivedSha,
    nodeSha: x.nodeSha,
  })), [
    { kind: "commit", requestedSha: COMMIT, status: 200, receivedSha: COMMIT, nodeSha: undefined },
    { kind: "tree", requestedSha: ROOT, status: 200, receivedSha: ROOT, nodeSha: NOTES },
    { kind: "tree", requestedSha: NOTES, status: 200, receivedSha: NOTES, nodeSha: BLOB },
  ])
  assert.ok(!JSON.stringify(evidence).includes("Bearer"))
})

test("complete absence is different from unknown/truncated tree and missing HTTP ref", async () => {
  for (const [truncated, expected] of [
    [false, "absent-in-complete-tree"],
    [true, "incomplete-tree"],
    [null, "incomplete-tree"],
  ] as const) {
    const f = fixture({ getTree: async sha => ({ status: 200, json: {
      sha, ...(truncated === null ? {} : { truncated }), tree: [],
    } }) })
    const result = await inspectImmutableMissingObject("Notes/reborn.md", COMMIT, f.adapter)
    assert.equal(result.outcome, expected)
    assert.deepEqual(f.calls, ["commit:" + COMMIT, "tree:" + ROOT])
  }
  const f = fixture({ getCommit: async () => ({ status: 404 }) })
  assert.equal((await inspectImmutableMissingObject("Notes/reborn.md", COMMIT, f.adapter)).outcome, "http-unavailable")
  assert.equal(f.calls.length, 1)
})

test("mismatched immutable identities and duplicate nodes cannot prove absence", async () => {
  const wrongCommit = fixture({ getCommit: async () => ({ status: 200, json: { sha: "9".repeat(40), tree: { sha: ROOT } } }) })
  assert.equal((await inspectImmutableMissingObject("Notes/reborn.md", COMMIT, wrongCommit.adapter)).outcome, "identity-mismatch")
  assert.equal(wrongCommit.calls.length, 1)
  const wrongTree = fixture({ getTree: async () => ({ status: 200, json: { sha: "9".repeat(40), tree: [], truncated: false } }) })
  assert.equal((await inspectImmutableMissingObject("Notes/reborn.md", COMMIT, wrongTree.adapter)).outcome, "identity-mismatch")
  const dup = fixture({ getTree: async sha => ({ status: 200, json: {
    sha, truncated: false, tree: Array.from({ length: 2 }, () => ({ path: "Notes", type: "tree", mode: "040000", sha: NOTES })),
  } }) })
  assert.equal((await inspectImmutableMissingObject("Notes/reborn.md", COMMIT, dup.adapter)).outcome, "malformed-response")
})

test("malformed inputs and observer errors are bounded, non-throwing and scrub errors", async () => {
  const f = fixture()
  const invalid = await inspectImmutableMissingObject("Notes/reborn.md", "wrong-ref", f.adapter)
  assert.equal(invalid.outcome, "invalid-ref")
  assert.deepEqual(f.calls, [])
  const traversal = await inspectImmutableMissingObject("../secret", COMMIT, f.adapter)
  assert.equal(traversal.outcome, "invalid-path")
  assert.deepEqual(f.calls, [])
  const throws = fixture({ getCommit: async () => { throw Error("Bearer user-secret-token") } })
  const reported = await inspectImmutableMissingObject("Notes/reborn.md", COMMIT, throws.adapter)
  assert.equal(reported.outcome, "observation-failed")
  assert.ok(!JSON.stringify(reported).includes("user-secret-token"))
})
