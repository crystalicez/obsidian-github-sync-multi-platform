import assert from "node:assert/strict"
import test from "node:test"

import { V4PublicationRaceError } from "../../src/lib/v4/publication-race"
import { observeV4PrePublishHeadNull, type V4HeadNullEvidence } from "../github-e2e/support/pre-publish-head-null-evidence"

const EXPECTED = "1".repeat(40)
const LATEST = "2".repeat(40)
const TREE = "3".repeat(40)

function headNullError() {
  return new V4PublicationRaceError({
    phase: "pre-publish",
    expectedHeadSha: EXPECTED,
    observedHeadSha: null,
    publicationOutcome: "not-published",
    evidence: "pre-publish-head-mismatch",
  })
}

test("failure-only head-null observer records independent exact SHA evidence without altering error", async () => {
  const original = headNullError()
  const observed: V4HeadNullEvidence[] = []
  const calls: string[] = []
  await assert.rejects(async () => {
    try { throw original }
    catch (error) {
      await observeV4PrePublishHeadNull(error, {
        device: "device-a",
        localIndexCommitSha: EXPECTED,
        readBranch: async () => { calls.push("ref"); return { status: 200, sha: LATEST } },
        readExpectedCommit: async sha => { calls.push(sha); return { status: 200, sha: EXPECTED, treeSha: TREE } },
        report: evidence => { observed.push(evidence) },
      })
      throw error
    }
  }, error => error === original)
  assert.deepEqual(calls, ["ref", EXPECTED])
  assert.deepEqual(observed, [{
    kind: "pre-publish-head-null-read-only-evidence",
    device: "device-a",
    expectedHeadSha: EXPECTED,
    localIndexCommitSha: EXPECTED,
    branch: { status: 200, sha: LATEST },
    expectedCommit: { status: 200, sha: EXPECTED, treeSha: TREE },
  }])
})

test("head-null observer makes no requests for success, unrelated race phases, or observed non-null refs", async () => {
  const errors: unknown[] = [
    undefined,
    new Error("unrelated"),
    new V4PublicationRaceError({ phase: "pre-publish", expectedHeadSha: EXPECTED, observedHeadSha: LATEST, publicationOutcome: "not-published" }),
    new V4PublicationRaceError({ phase: "post-publish", expectedHeadSha: EXPECTED, observedHeadSha: null, publicationOutcome: "unknown" }),
    new V4PublicationRaceError({ phase: "pre-publish", expectedHeadSha: null, observedHeadSha: null, publicationOutcome: "not-published" }),
    new V4PublicationRaceError({ phase: "pre-publish", expectedHeadSha: EXPECTED, observedHeadSha: null, publicationOutcome: "unknown" }),
  ]
  let calls = 0
  for (const error of errors) {
    await observeV4PrePublishHeadNull(error, {
      device: "device-a",
      localIndexCommitSha: undefined,
      readBranch: async () => { calls++; return { status: 200 } },
      readExpectedCommit: async () => { calls++; return { status: 200 } },
      report: () => { calls++ },
    })
  }
  assert.equal(calls, 0)
})

test("forensic request/report failures cannot replace a fail-closed publication error or expose invalid SHA", async () => {
  const original = headNullError()
  const evidence: V4HeadNullEvidence[] = []
  await assert.rejects(async () => {
    try { throw original }
    catch (error) {
      await observeV4PrePublishHeadNull(error, {
        device: "device-b",
        localIndexCommitSha: "invalid",
        readBranch: async () => { throw new Error("contains a secret; must not print") },
        readExpectedCommit: async () => ({ status: 200, sha: "wrong", treeSha: "bad" }),
        report: item => { evidence.push(item); throw new Error("logger failure") },
      })
      throw error
    }
  }, error => error === original)
  assert.deepEqual(evidence, [{
    kind: "pre-publish-head-null-read-only-evidence",
    device: "device-b",
    expectedHeadSha: EXPECTED,
    localIndexCommitSha: null,
    branch: { error: "read-only-observation-failed" },
    expectedCommit: { status: 200 },
  }])
})
