import assert from "node:assert/strict"
import test from "node:test"
import {
  classifyV4ReencryptionSeparatedSelector, planV4ReencryptionSeparatedRoots,
  type V4ReencryptionSeparatedSelectorSnapshot,
} from "../../src/lib/v4/reencryption-separated-selector"

const source: V4ReencryptionSeparatedSelectorSnapshot = {
  selector: "absent", settings: "source", sourceIndex: "matching", shadowIndex: "matching",
  oldSecretAvailable: true, newSecretAvailable: true, authenticatedPreparedWal: true,
}

function assertNoAuthority(state: V4ReencryptionSeparatedSelectorSnapshot): void {
  const report = classifyV4ReencryptionSeparatedSelector(state)
  assert.deepEqual({
    cutover: report.localCutoverAuthorized,
    resume: report.resumeSyncAuthorized,
    rollback: report.rollbackAuthorized,
    remote: report.remoteWritesAuthorized,
    cleanup: report.oldPassphraseCleanupAuthorized,
  }, { cutover: false, resume: false, rollback: false, remote: false, cleanup: false })
  assert.equal(report.integrityScope, "pure-option-a-selector-diagnostic-uncommitted")
  assert.ok(Object.isFrozen(report))
  assert.deepEqual(classifyV4ReencryptionSeparatedSelector(state), report)
}

test("D145 plan keeps immutable Source, independent Shadow and separate selector paths", () => {
  const roots = planV4ReencryptionSeparatedRoots("private/v4-index", "run_d145_123")
  assert.deepEqual(roots, {
    sourceIndexRoot: "private/v4-index",
    shadowIndexRoot: "private/v4-index-rekey-run_d145_123",
    selectorPath: "private/v4-index-rekey-selector-run_d145_123/selector.json",
  })
  assert.equal(new Set(Object.values(roots)).size, 3)
  assert.ok(Object.isFrozen(roots))
  for (const root of ["../index", "private//index", "private/../index", "private/index/", "index", "private/.", "private/⚠"]) {
    assert.throws(() => planV4ReencryptionSeparatedRoots(root, "run_d145_123"), /Invalid immutable/)
  }
  for (const run of ["", "x", "../oops", "rekey/other", "x".repeat(129)]) {
    assert.throws(() => planV4ReencryptionSeparatedRoots("private/v4-index", run), /Invalid immutable/)
  }
})

test("D145 prepared Source and observed Destination are diagnostics, never cutover proof", () => {
  const first = classifyV4ReencryptionSeparatedSelector(source)
  assert.equal(first.observation, "source-prepared-uncommitted")
  const withSourceSelector = classifyV4ReencryptionSeparatedSelector({ ...source, selector: "source" })
  assert.equal(withSourceSelector.observation, "source-prepared-uncommitted")
  const switched = classifyV4ReencryptionSeparatedSelector({
    ...source, selector: "destination", settings: "destination",
  })
  assert.equal(switched.observation, "destination-observed-uncommitted")
  for (const state of [source, { ...source, selector: "source" } as const,
    { ...source, selector: "destination", settings: "destination" } as const]) {
    assertNoAuthority(state)
  }
})

test("D145 mismatched, torn or unsupported selector and Settings combinations always require manual recovery", () => {
  const cases: V4ReencryptionSeparatedSelectorSnapshot[] = [
    { ...source, selector: "torn" },
    { ...source, selector: "destination" },
    { ...source, selector: "source", settings: "destination" },
    { ...source, selector: "absent", settings: "destination" },
    { ...source, selector: "destination", settings: "mixed" },
    { ...source, sourceIndex: "missing-or-changed" },
    { ...source, shadowIndex: "missing-or-changed" },
    { ...source, oldSecretAvailable: false },
    { ...source, newSecretAvailable: false },
    { ...source, authenticatedPreparedWal: false },
    { ...source, selector: "bogus" as "source" },
    { ...source, settings: "bogus" as "source" },
  ]
  for (const state of cases) {
    assert.equal(classifyV4ReencryptionSeparatedSelector(state).observation, "manual-recovery-required")
    assertNoAuthority(state)
  }
})

test("D145 exhaustive Option A crash windows preserve Source/Shadow with no authorized operation", () => {
  const actions = ["selector-destination", "settings-branch-destination",
    "settings-secret-destination", "old-secret-clear"] as const
  type Action = (typeof actions)[number]
  function permutations(prefix: Action[], remaining: readonly Action[]): Action[][] {
    return remaining.length === 0 ? [prefix] : remaining.flatMap((action, i) =>
      permutations([...prefix, action], remaining.filter((_, n) => n !== i)))
  }
  const orders = permutations([], actions)
  assert.equal(orders.length, 24)
  let cases = 0
  let mixed = 0
  let destination = 0
  let missingOld = 0
  for (const order of orders) {
    for (let acknowledged = 0; acknowledged <= order.length; acknowledged++) {
      for (let mask = 0; mask < 2 ** acknowledged; mask++) {
        const survived = new Set<Action>()
        for (let i = 0; i < acknowledged; i++) {
          if (mask & (1 << i)) survived.add(order[i]!)
        }
        const branchNew = survived.has("settings-branch-destination")
        const keyNew = survived.has("settings-secret-destination")
        const state: V4ReencryptionSeparatedSelectorSnapshot = {
          ...source,
          selector: survived.has("selector-destination") ? "destination" : "absent",
          settings: branchNew !== keyNew ? "mixed" : branchNew ? "destination" : "source",
          oldSecretAvailable: !survived.has("old-secret-clear"),
        }
        assertNoAuthority(state)
        const report = classifyV4ReencryptionSeparatedSelector(state)
        const expected = !state.oldSecretAvailable ? "manual-recovery-required"
          : state.selector === "destination" && state.settings === "destination"
            ? "destination-observed-uncommitted"
            : state.selector === "absent" && state.settings === "source"
              ? "source-prepared-uncommitted" : "manual-recovery-required"
        assert.equal(report.observation, expected)
        assert.equal(state.sourceIndex, "matching")
        assert.equal(state.shadowIndex, "matching")
        if (state.settings === "mixed") mixed++
        if (report.observation === "destination-observed-uncommitted") destination++
        if (!state.oldSecretAvailable) missingOld++
        cases++
      }
    }
  }
  assert.equal(cases, 24 * 31)
  assert.ok(mixed > 0)
  assert.ok(destination > 0)
  assert.ok(missingOld > 0)
})

test("D145 classifier reads a snapshot without mutating it or touching any external service", () => {
  const frozen = Object.freeze({ ...source })
  const before = JSON.stringify(frozen)
  assertNoAuthority(frozen)
  assert.equal(JSON.stringify(frozen), before)
  assert.equal(classifyV4ReencryptionSeparatedSelector(null as unknown as V4ReencryptionSeparatedSelectorSnapshot).observation,
    "manual-recovery-required")
})
