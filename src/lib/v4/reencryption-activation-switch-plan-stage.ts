import { fitsV4LocalJsonSizeLimit } from "./local-index"
import type { V4LocalCutoverSettings } from "./reencryption-local-cutover-inspection"
import type { V4FencedPendingCommitPreflightInput } from "./reencryption-fenced-pending-commit-preflight"
import {
  createV4FencedActivationSession,
} from "./reencryption-activation-decision-stage"
import {
  inspectV4ActivationSettingsSwitchPlan, sealV4ActivationSettingsSwitchPlan,
} from "./reencryption-activation-switch-plan-crypto"

const PLAN = "/settings-switch-plan.json"
const MAX = 8 * 1024
const pending = new WeakMap<object, Set<string>>()

export interface V4ActivationSettingsSwitchPlanStageReport {
  readonly status: "settings-switch-plan-staged-not-applied"
  readonly planPath: string
  readonly evidence: "best-effort-wal-readback-not-power-loss-durable"
  readonly localCutoverAuthorized: false
  readonly commitDecisionAuthorized: false
  readonly resumeSyncAuthorized: false
  readonly rollbackAuthorized: false
  readonly remoteWritesAuthorized: false
  readonly oldPassphraseCleanupAuthorized: false
}
export interface V4ActivationSettingsSwitchPlanRestartReport {
  readonly integrityScope: "read-only-restarted-settings-switch-plan"
  readonly observation: "authenticated-settings-switch-plan-not-applied"
    | "manual-recovery-required"
  readonly evidence: "best-effort-wal-readback-not-power-loss-durable"
  readonly localCutoverAuthorized: false
  readonly commitDecisionAuthorized: false
  readonly resumeSyncAuthorized: false
  readonly rollbackAuthorized: false
  readonly remoteWritesAuthorized: false
  readonly oldPassphraseCleanupAuthorized: false
}
const BASE = Object.freeze({
  evidence: "best-effort-wal-readback-not-power-loss-durable" as const,
  localCutoverAuthorized: false as const, commitDecisionAuthorized: false as const,
  resumeSyncAuthorized: false as const,
  rollbackAuthorized: false as const, remoteWritesAuthorized: false as const,
  oldPassphraseCleanupAuthorized: false as const,
})
const MANUAL: V4ActivationSettingsSwitchPlanRestartReport = Object.freeze({
  ...BASE, integrityScope: "read-only-restarted-settings-switch-plan",
  observation: "manual-recovery-required",
})
const AUTHENTIC: V4ActivationSettingsSwitchPlanRestartReport = Object.freeze({
  ...BASE, integrityScope: "read-only-restarted-settings-switch-plan",
  observation: "authenticated-settings-switch-plan-not-applied",
})

type Session = ReturnType<typeof createV4FencedActivationSession>
async function persistedSource(session: Session): Promise<V4LocalCutoverSettings> {
  await session.check()
  const actual = await session.readPersistedSettings()
  if (!actual || JSON.stringify(actual) !== JSON.stringify(session.sourceSettings)) {
    throw Error("D231 persisted Source Settings changed during Switch Plan.")
  }
  await session.check()
  return actual
}

async function readPlan(session: Session, planPath: string) {
  const record = await session.readAuthenticated()
  const settings = await persistedSource(session)
  const ciphertext = await session.readOne(planPath)
  if (!fitsV4LocalJsonSizeLimit(ciphertext, MAX) || (await inspectV4ActivationSettingsSwitchPlan(
    record.contract, session.key, {
      ...record.sources, activationDecisionCiphertext: record.ciphertext,
    }, settings, ciphertext,
  )).observation !== "authenticated-settings-switch-plan-not-applied") {
    throw Error("D231 persisted Settings Switch Plan is torn or foreign.")
  }
  await session.check()
  return { record, ciphertext, settings: JSON.stringify(settings) }
}

/**
 * Persist the exact Source/Destination Settings and immutable separate Index
 * roots, after D230 decision. Never applies this plan to Obsidian Settings,
 * runtime active Index, SecretStorage or Git. Full D229 proof before/after
 * the only write; any ambiguous write leaves its forensic bytes in place.
 */
export async function stageV4FencedActivationSettingsSwitchPlan(
  input: V4FencedPendingCommitPreflightInput,
): Promise<V4ActivationSettingsSwitchPlanStageReport> {
  const session = createV4FencedActivationSession(input)
  const { root, holder, adapter, methods } = session
  const planPath = root + PLAN
  const claimed = pending.get(adapter) ?? new Set<string>()
  if (claimed.has(root)) throw Error("D231 concurrent Settings Switch Plan requires Manual Recovery.")
  claimed.add(root)
  pending.set(adapter, claimed)
  let calls = 0
  let committed: V4ActivationSettingsSwitchPlanStageReport | null = null
  try {
    const result = await holder(async () => {
      if (++calls !== 1) throw Error("D231 owner holder invoked twice.")
      await session.check()
      if (await methods.exists.call(adapter, planPath)) {
        throw Error("D231 existing Settings Switch Plan requires Manual Recovery.")
      }
      await session.prove()
      const before = await session.readAuthenticated()
      const settings = await persistedSource(session)
      const encoded = await sealV4ActivationSettingsSwitchPlan(
        before.contract, session.key, {
          ...before.sources, activationDecisionCiphertext: before.ciphertext,
        }, settings,
      )
      await session.check()
      if (await methods.exists.call(adapter, planPath)
        || JSON.stringify(await session.readAuthenticated()) !== JSON.stringify(before)
        || JSON.stringify(await persistedSource(session)) !== JSON.stringify(settings)) {
        throw Error("D231 prior decision or Source Settings changed before write.")
      }
      await methods.write.call(adapter, planPath, encoded)
      await session.check()
      const persisted = await readPlan(session, planPath)
      if (persisted.ciphertext !== encoded
        || JSON.stringify(persisted.record) !== JSON.stringify(before)
        || persisted.settings !== JSON.stringify(settings)) {
        throw Error("D231 Settings Switch Plan readback changed.")
      }
      await session.prove()
      const again = await readPlan(session, planPath)
      if (JSON.stringify(again) !== JSON.stringify(persisted) || !session.unchanged()) {
        throw Error("D231 Settings Switch Plan changed after full Git readback.")
      }
      await session.check()
      committed = Object.freeze({
        ...BASE, status: "settings-switch-plan-staged-not-applied",
        planPath,
      })
      return committed
    })
    if (calls !== 1 || committed === null || result !== committed
      || !session.unchanged()) {
      throw Error("D231 uncooperative owner holder cannot attest Switch Plan.")
    }
    return committed
  } finally {
    claimed.delete(root)
    if (!claimed.size) pending.delete(adapter)
  }
}

/** Independently authenticate the plan from disk after Restart. Read-only. */
export async function inspectV4FencedActivationSettingsSwitchPlanAfterRestart(
  input: V4FencedPendingCommitPreflightInput,
): Promise<V4ActivationSettingsSwitchPlanRestartReport> {
  let session: Session
  try { session = createV4FencedActivationSession(input) }
  catch { return MANUAL }
  const path = session.root + PLAN
  let calls = 0
  let completed: V4ActivationSettingsSwitchPlanRestartReport | null = null
  try {
    const returned = await session.holder(async () => {
      if (++calls !== 1) throw Error("D231 restart lease holder invoked repeatedly.")
      await session.check()
      const before = await readPlan(session, path)
      await session.prove()
      const after = await readPlan(session, path)
      if (JSON.stringify(after) !== JSON.stringify(before)) {
        throw Error("D231 Settings Switch Plan changed during current Git readback.")
      }
      await session.check()
      if (await session.readOne(path) !== before.ciphertext) {
        throw Error("D231 final Settings Switch Plan readback changed.")
      }
      await session.check()
      completed = AUTHENTIC
      return completed
    })
    return calls === 1 && returned === AUTHENTIC && completed === AUTHENTIC
      && session.unchanged() ? AUTHENTIC : MANUAL
  } catch { return MANUAL }
}
