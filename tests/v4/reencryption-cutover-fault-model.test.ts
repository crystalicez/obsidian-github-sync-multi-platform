import assert from "node:assert/strict"
import test from "node:test"
import { classifyV4ReencryptionLocalRecovery } from "../../src/lib/v4/reencryption-local-transaction-recovery"
import {
  V4_REENCRYPTION_FAULT_MODEL_ACTIONS,
  enumerateV4ReencryptionCutoverCrashCases,
  enumerateV4ReencryptionHypotheticalWriteOrders,
  type V4ReencryptionFaultModelAction,
  type V4ReencryptionFaultModelCase,
} from "../../src/lib/v4/reencryption-cutover-fault-model"

const denied = {
  localCutoverAuthorized: false,
  resumeSyncAuthorized: false,
  rollbackAuthorized: false,
  remoteWritesAuthorized: false,
  oldPassphraseCleanupAuthorized: false,
} as const

function assertNoAuthority(observation: V4ReencryptionFaultModelCase): void {
  for (const [key, value] of Object.entries(denied)) {
    assert.equal(observation[key as keyof typeof denied], value)
  }
  assert.equal(observation.integrityScope, "pure-untrusted-cross-store-crash-model")
  assert.equal(observation.sourceRemoteBranchPreserved, true)
  assert.equal(observation.shadowIndexPreserved, true)
  assert.equal(observation.newSecretAvailable, true)
  assert.ok(Object.isFrozen(observation))
  assert.ok(Object.isFrozen(observation.hazards))
}

test("D141 all 120 hypothetical cutover write orders and 7,560 crash/durability outcomes deny all mutations", () => {
  const orders = enumerateV4ReencryptionHypotheticalWriteOrders()
  assert.equal(orders.length, 120)
  assert.equal(new Set(orders.map(order => order.join("|"))).size, 120)
  const observations = { total: 0, mixed: 0, oldSecretMissing: 0, receiptWrong: 0, bothDestination: 0 }
  for (const order of orders) {
    assert.deepEqual([...order].sort(), [...V4_REENCRYPTION_FAULT_MODEL_ACTIONS].sort())
    const cases = enumerateV4ReencryptionCutoverCrashCases(order)
    assert.equal(cases.length, 63) // sum 2^k, k = 0...5
    const cutCounts = new Map<number, number>()
    for (const value of cases) {
      observations.total++
      cutCounts.set(value.acknowledgedWrites, (cutCounts.get(value.acknowledgedWrites) ?? 0) + 1)
      assert.ok(value.persistedMask < 2 ** value.acknowledgedWrites)
      assertNoAuthority(value)
      if (value.settings === "mixed") {
        observations.mixed++
        assert.ok(value.hazards.includes("settings-branch-secret-id-mismatch"))
      } else {
        assert.equal(value.hazards.includes("settings-branch-secret-id-mismatch"), false)
      }
      if (value.settings !== value.activeIndex) {
        assert.ok(value.hazards.includes("settings-active-index-mismatch"))
      } else {
        assert.equal(value.hazards.includes("settings-active-index-mismatch"), false)
      }
      if (!value.oldSecretAvailable) {
        observations.oldSecretMissing++
        assert.ok(value.hazards.includes("old-secret-cleared-without-authenticated-durable-commit"))
      } else {
        assert.equal(value.hazards.includes("old-secret-cleared-without-authenticated-durable-commit"), false)
      }
      if (value.hypotheticalReceiptPresent
        && (value.settings !== "destination" || value.activeIndex !== "destination")) {
        observations.receiptWrong++
        assert.ok(value.hazards.includes("claimed-receipt-without-matching-destination"))
      } else {
        assert.equal(value.hazards.includes("claimed-receipt-without-matching-destination"), false)
      }
      assert.equal(value.hazards.includes("original-active-index-may-be-overwritten"),
        value.activeIndex === "destination")
      if (value.settings === "destination" && value.activeIndex === "destination") {
        observations.bothDestination++
        assert.ok(value.hazards.includes("destination-without-authenticated-durable-commit"))
      } else {
        assert.equal(value.hazards.includes("destination-without-authenticated-durable-commit"), false)
      }
    }
    for (let cut = 0; cut <= 5; cut++) assert.equal(cutCounts.get(cut), 2 ** cut)
    assert.equal(cases[0]?.settings, "source")
    assert.equal(cases[0]?.activeIndex, "source")
    assert.equal(cases[0]?.hypotheticalReceiptPresent, false)
  }
  assert.equal(observations.total, 120 * 63)
  assert.ok(observations.mixed > 0)
  assert.ok(observations.oldSecretMissing > 0)
  assert.ok(observations.receiptWrong > 0)
  assert.ok(observations.bothDestination > 0)
})

test("D141 all fault outcomes agree with D139 local restart classification without trusting a synthetic receipt", () => {
  let checked = 0
  for (const order of enumerateV4ReencryptionHypotheticalWriteOrders()) {
    for (const observed of enumerateV4ReencryptionCutoverCrashCases(order)) {
      const restart = classifyV4ReencryptionLocalRecovery({
        settings: observed.settings,
        activeIndex: observed.activeIndex,
        shadowComplete: true,
        oldSecretAvailable: observed.oldSecretAvailable,
        newSecretAvailable: observed.newSecretAvailable,
        authenticatedSourceIntentAndWal: true,
      })
      const expected = !observed.oldSecretAvailable
        ? "manual-recovery-required"
        : observed.settings === "source" && observed.activeIndex === "source"
          ? "source-prepared-uncommitted"
          : observed.settings === "destination" && observed.activeIndex === "destination"
            ? "destination-observed-without-commit-proof"
            : "manual-recovery-required"
      assert.equal(restart.observation, expected)
      assert.equal(restart.resumeSyncAuthorized, false)
      assert.equal(restart.rollbackAuthorized, false)
      assert.equal(restart.oldPassphraseCleanupAuthorized, false)
      checked++
    }
  }
  assert.equal(checked, 7560)
})

test("D141 receipt-before-selector crash can leave claimed commit with old branch and old index", () => {
  const order: readonly V4ReencryptionFaultModelAction[] = [
    "hypothetical-commit-receipt", "settings-branch-destination",
    "settings-secret-id-destination", "active-index-destination", "old-secret-clear",
  ]
  const cases = enumerateV4ReencryptionCutoverCrashCases(order)
  const receiptOnly = cases.find(row => row.acknowledgedWrites === 1 && row.persistedMask === 1)
  assert.ok(receiptOnly)
  assert.equal(receiptOnly.settings, "source")
  assert.equal(receiptOnly.activeIndex, "source")
  assert.equal(receiptOnly.hypotheticalReceiptPresent, true)
  assert.deepEqual(receiptOnly.hazards, ["claimed-receipt-without-matching-destination"])
  assertNoAuthority(receiptOnly)
})

test("D141 ordinary settings-first sequence still admits mixed Settings and lost acknowledged writes", () => {
  const order: readonly V4ReencryptionFaultModelAction[] = [
    "settings-branch-destination", "settings-secret-id-destination",
    "active-index-destination", "hypothetical-commit-receipt", "old-secret-clear",
  ]
  const cases = enumerateV4ReencryptionCutoverCrashCases(order)
  const tornSettings = cases.find(row => row.acknowledgedWrites === 1 && row.persistedMask === 1)
  assert.ok(tornSettings)
  assert.equal(tornSettings.settings, "mixed")
  assert.ok(tornSettings.hazards.includes("settings-branch-secret-id-mismatch"))
  const acknowledgedAllButLostAll = cases.find(row => row.acknowledgedWrites === 5 && row.persistedMask === 0)
  assert.ok(acknowledgedAllButLostAll)
  assert.equal(acknowledgedAllButLostAll.settings, "source")
  assert.equal(acknowledgedAllButLostAll.activeIndex, "source")
  assert.equal(acknowledgedAllButLostAll.oldSecretAvailable, true)
  const allPhysicallyPersistedButUntrusted = cases.find(row =>
    row.acknowledgedWrites === 5 && row.persistedMask === 31)
  assert.ok(allPhysicallyPersistedButUntrusted)
  assert.equal(allPhysicallyPersistedButUntrusted.settings, "destination")
  assert.equal(allPhysicallyPersistedButUntrusted.activeIndex, "destination")
  assert.equal(allPhysicallyPersistedButUntrusted.hypotheticalReceiptPresent, true)
  assert.equal(allPhysicallyPersistedButUntrusted.oldSecretAvailable, false)
  assertNoAuthority(allPhysicallyPersistedButUntrusted)
})

test("D141 clearing old secret first is unsafe even if both indices and settings look untouched", () => {
  const order: readonly V4ReencryptionFaultModelAction[] = [
    "old-secret-clear", "hypothetical-commit-receipt",
    "active-index-destination", "settings-secret-id-destination", "settings-branch-destination",
  ]
  const first = enumerateV4ReencryptionCutoverCrashCases(order).find(row =>
    row.acknowledgedWrites === 1 && row.persistedMask === 1)
  assert.ok(first)
  assert.equal(first.oldSecretAvailable, false)
  assert.equal(first.settings, "source")
  assert.equal(first.activeIndex, "source")
  assert.deepEqual(first.hazards, ["old-secret-cleared-without-authenticated-durable-commit"])
  assertNoAuthority(first)
})

test("D141 invalid/duplicate or fabricated actions cannot be normalized into a plausible plan", () => {
  const duplicate = V4_REENCRYPTION_FAULT_MODEL_ACTIONS.map(() => "old-secret-clear")
  const missing = V4_REENCRYPTION_FAULT_MODEL_ACTIONS.slice(0, 4)
  const fake = [...V4_REENCRYPTION_FAULT_MODEL_ACTIONS.slice(0, 4), "flush-means-committed"]
  const inputs = [duplicate, missing, fake, [], null, "settings-branch-destination"]
  for (const plan of inputs) {
    assert.throws(() => enumerateV4ReencryptionCutoverCrashCases(
      plan as readonly V4ReencryptionFaultModelAction[],
    ), /each known hypothetical cutover write exactly once/)
  }
})

test("D141 scenario outputs never contain secret values, vault paths, Git clients, or runnable callbacks", () => {
  const input = [...V4_REENCRYPTION_FAULT_MODEL_ACTIONS]
  const outcome = enumerateV4ReencryptionCutoverCrashCases(input)
  input.reverse()
  assert.equal(outcome.length, 63)
  const output = JSON.stringify(outcome)
  assert.doesNotMatch(output, /passphraseValue|vaultPath|secretValue|callback|token|node:fs/)
  assert.deepEqual(outcome[0]?.hazards, [])
})
