import assert from "node:assert/strict"
import test from "node:test"

import {
  V4GitMutationOutcomeUnknownError,
  canRetryV4MutationAfterUnknownOutcome,
  classifyV4MutationFailure,
} from "../../src/lib/v4/git-mutation-policy"

test("immutable blob and tree mutations may retry an unknown outcome", () => {
  assert.equal(canRetryV4MutationAfterUnknownOutcome("immutable-idempotent"), true)
  assert.equal(classifyV4MutationFailure(new Error("socket closed")), "unknown-outcome")
  assert.equal(classifyV4MutationFailure(Object.assign(new Error("gateway"), { status: 502 })), "unknown-outcome")
})

test("commit recreation is orphan-safe only when reachability is impossible", () => {
  assert.equal(canRetryV4MutationAfterUnknownOutcome("orphan-safe-commit"), false)
  assert.equal(canRetryV4MutationAfterUnknownOutcome("orphan-safe-commit", { originalCannotBeReachable: true }), true)
})

test("reachable ref mutations are never blindly retried after an unknown outcome", () => {
  assert.equal(canRetryV4MutationAfterUnknownOutcome("reachable-ref"), false)
  const error = new V4GitMutationOutcomeUnknownError("reachable-ref", new Error("connection reset"))
  assert.equal(error.retryClass, "reachable-ref")
  assert.match(error.message, /unknown outcome/u)
})

test("definitive client errors and rate limits are not classified as unknown mutation outcomes", () => {
  assert.equal(classifyV4MutationFailure(Object.assign(new Error("unprocessable"), { status: 422 })), "definitive")
  assert.equal(classifyV4MutationFailure(Object.assign(new Error("limited"), { status: 429 })), "definitive")
})
