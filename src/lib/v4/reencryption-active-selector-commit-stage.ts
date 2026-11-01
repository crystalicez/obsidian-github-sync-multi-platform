import { sha256Hex, utf8ToBytes } from "../bytes"
import { isV4LocalIndexCacheComplete, loadV4LocalIndex } from "./local-index"
import { expectedV4PathLayout } from "./protocol-types"
import { createV4FencedActivationSession } from "./reencryption-activation-decision-stage"
import { inspectV4ActivationSettingsSwitchPlan } from "./reencryption-activation-switch-plan-crypto"
import { inspectV4ActiveSelectorCommitPair, sealV4ActiveSelectorCommitPair } from "./reencryption-active-selector-commit-crypto"
import type { V4FencedPendingCommitPreflightInput } from "./reencryption-fenced-pending-commit-preflight"
import { planV4ReencryptionSeparatedRoots } from "./reencryption-separated-selector"

const RECEIPT = "/selector-commit-receipt.json"
const PLAN = "/settings-switch-plan.json"
const inFlight = new WeakMap<object, Set<string>>()
type Session = ReturnType<typeof createV4FencedActivationSession>

export interface V4ActiveSelectorCommitStageReport {
  readonly status: "destination-selector-written-settings-pending"
  readonly receiptPath: string
  readonly selectorPath: string
  readonly evidence: "best-effort-wal-readback-not-power-loss-durable"
  readonly commitDecisionAuthorized: false
  readonly localCutoverAuthorized: false
  readonly resumeSyncAuthorized: false
  readonly rollbackAuthorized: false
  readonly remoteWritesAuthorized: false
  readonly oldPassphraseCleanupAuthorized: false
}
export interface V4ActiveSelectorCommitRestartReport {
  readonly integrityScope: "read-only-physical-selector-settings-pending"
  readonly observation: "authenticated-selector-settings-pending" | "manual-recovery-required"
  readonly artifactWindow: "both-linked" | "both-absent" | "receipt-only" | "selector-only" | "foreign-or-torn"
  /** No complete post-selector Git proof; source Settings and Index stay selected. */
  readonly evidence: "best-effort-local-readback-no-post-switch-full-git-proof"
  readonly commitDecisionAuthorized: false
  readonly localCutoverAuthorized: false
  readonly resumeSyncAuthorized: false
  readonly rollbackAuthorized: false
  readonly remoteWritesAuthorized: false
  readonly oldPassphraseCleanupAuthorized: false
}
const BASE = Object.freeze({
  commitDecisionAuthorized: false as const, localCutoverAuthorized: false as const,
  resumeSyncAuthorized: false as const, rollbackAuthorized: false as const,
  remoteWritesAuthorized: false as const, oldPassphraseCleanupAuthorized: false as const,
})
const restartReport = (
  observation: V4ActiveSelectorCommitRestartReport["observation"],
  artifactWindow: V4ActiveSelectorCommitRestartReport["artifactWindow"],
): V4ActiveSelectorCommitRestartReport => Object.freeze({
  ...BASE,
  integrityScope: "read-only-physical-selector-settings-pending",
  evidence: "best-effort-local-readback-no-post-switch-full-git-proof",
  observation, artifactWindow,
})
const LINKED = restartReport("authenticated-selector-settings-pending", "both-linked")
const manual = (window: V4ActiveSelectorCommitRestartReport["artifactWindow"]) =>
  restartReport("manual-recovery-required", window)

async function indexDigest(
  session: Session, root: string, expectedRepo: string,
  expectedCommit: string, deviceId: string,
): Promise<string> {
  await session.check()
  const index = await loadV4LocalIndex(session.adapter, root)
  if (index.repoId !== expectedRepo || index.remoteCommitSha !== expectedCommit
    || index.deviceId !== deviceId || index.mode !== "encrypted"
    || index.pathLayout !== expectedV4PathLayout("encrypted")
    || !isV4LocalIndexCacheComplete(index)
    || Object.values(index.shards).some(shard =>
      Object.values(shard.records).some(record =>
        record.dirty === true || record.deleted === true))) {
    throw Error("D232 Source/Shadow Index changed or is incomplete.")
  }
  const digest = await sha256Hex(utf8ToBytes(JSON.stringify(index)))
  await session.check()
  return digest
}

/** Authenticate the exact D231 plan and original Source/Shadow state without mutating it. */
async function currentLocal(session: Session) {
  const decision = await session.readAuthenticated()
  const contract = decision.contract
  const id = contract.identity
  const roots = planV4ReencryptionSeparatedRoots(id.indexRoot, id.runId)
  await session.check()
  const settings = await session.readPersistedSettings()
  if (!settings || JSON.stringify(settings) !== JSON.stringify(session.sourceSettings)) {
    throw Error("D232 persisted Source Settings changed.")
  }
  const planCiphertext = await session.readOne(session.root + PLAN)
  const sources = {
    ...decision.sources,
    activationDecisionCiphertext: decision.ciphertext,
    settingsSwitchPlanCiphertext: planCiphertext,
  }
  if ((await inspectV4ActivationSettingsSwitchPlan(
    contract, session.key, sources, settings, planCiphertext,
  )).observation !== "authenticated-settings-switch-plan-not-applied") {
    throw Error("D232 authentic D231 Settings Switch Plan missing.")
  }
  const sourceDigest = await indexDigest(session, roots.sourceIndexRoot,
    id.sourceRepoId, id.sourceCommitSha, id.deviceId)
  const shadowDigest = await indexDigest(session, roots.shadowIndexRoot,
    id.destinationRepoId, id.destinationCommitSha, id.deviceId)
  if (sourceDigest !== contract.sourceIndexSha256
    || shadowDigest !== contract.destinationShadowSha256) {
    throw Error("D232 Source/Shadow Index no longer match D183 contract.")
  }
  await session.check()
  return { contract, sources, settings, roots,
    evidence: JSON.stringify({ contract, sources, settings, sourceDigest, shadowDigest }) }
}

async function confirmPinnedHeads(
  session: Session, input: V4FencedPendingCommitPreflightInput,
): Promise<void> {
  const id = input.readiness.prepared.identity
  await session.check()
  const backup = await input.backup.backup.github.getGitRef()
  const destination = await input.readiness.full.shadow.remote.github.getGitRef()
  if (backup?.sha !== id.sourceCommitSha || destination?.sha !== id.destinationCommitSha) {
    throw Error("D232 frozen Backup or Destination Git ref moved during Selector transition.")
  }
  await session.check()
}

async function inspectLocalPair(
  session: Session, receiptPath: string, selectorPath: string,
): Promise<{ observation: V4ActiveSelectorCommitRestartReport; evidence?: string | undefined;
  receiptCiphertext?: string | undefined; selectorCiphertext?: string | undefined }> {
  await session.check()
  const receiptExists = await session.methods.exists.call(session.adapter, receiptPath)
  const selectorExists = await session.methods.exists.call(session.adapter, selectorPath)
  if (!receiptExists && !selectorExists) return { observation: manual("both-absent") }
  if (!receiptExists) return { observation: manual("selector-only") }
  if (!selectorExists) return { observation: manual("receipt-only") }
  const state = await currentLocal(session)
  const receiptCiphertext = await session.readOne(receiptPath)
  const selectorCiphertext = await session.readOne(selectorPath)
  const result = await inspectV4ActiveSelectorCommitPair(
    state.contract, session.key, state.sources, state.settings, {
      receiptCiphertext, selectorCiphertext,
    },
  )
  await session.check()
  if (result.observation !== "authenticated-destination-selector-settings-pending") {
    return { observation: manual("foreign-or-torn") }
  }
  return { observation: LINKED, receiptCiphertext, selectorCiphertext,
    evidence: JSON.stringify({ state: state.evidence, receiptCiphertext, selectorCiphertext }) }
}

/**
 * D232 first real local Selector write. The *first* write stores an authenticated
 * Receipt alongside D230/D231 candidates, allowing another full D229 source
 * Git proof. Only then write the physical destination Selector at D134's
 * separated-selector path. D229 intentionally rejects that newly installed
 * Selector, so AFTER the write we verify local data + WAL + fence only.
 *
 * The old Source Settings and runtime Index are deliberately unchanged and
 * the durable Sync Fence remains armed. This is NOT a complete Cutover.
 */
export async function writeV4FencedActiveSelectorFirstPhase(
  input: V4FencedPendingCommitPreflightInput,
): Promise<V4ActiveSelectorCommitStageReport> {
  const session = createV4FencedActivationSession(input)
  const { adapter, holder, methods } = session
  const roots = planV4ReencryptionSeparatedRoots(
    input.readiness.prepared.identity.indexRoot, input.readiness.prepared.identity.runId,
  )
  const receiptPath = session.root + RECEIPT
  const selectorPath = roots.selectorPath
  const claimed = inFlight.get(adapter) ?? new Set<string>()
  if (claimed.has(selectorPath)) throw Error("D232 concurrent active Selector write requires Manual Recovery.")
  claimed.add(selectorPath)
  inFlight.set(adapter, claimed)
  let calls = 0
  let completed: V4ActiveSelectorCommitStageReport | null = null
  try {
    const returned = await holder(async () => {
      if (++calls !== 1) throw Error("D232 owner lease holder executed more than once.")
      await session.check()
      if (await methods.exists.call(adapter, receiptPath)
        || await methods.exists.call(adapter, selectorPath)) {
        throw Error("D232 existing Selector or Receipt requires Manual Recovery; never overwrite.")
      }
      await session.prove()
      const before = await currentLocal(session)
      const sealed = await sealV4ActiveSelectorCommitPair(
        before.contract, session.key, before.sources, before.settings,
      )
      await session.check()
      if (await methods.exists.call(adapter, receiptPath)
        || await methods.exists.call(adapter, selectorPath)
        || (await currentLocal(session)).evidence !== before.evidence) {
        throw Error("D232 active Selector prerequisites changed before Receipt write.")
      }
      await methods.write.call(adapter, receiptPath, sealed.receiptCiphertext)
      await session.check()
      const persistedReceipt = await session.readOne(receiptPath)
      if (persistedReceipt !== sealed.receiptCiphertext
        || (await inspectV4ActiveSelectorCommitPair(
          before.contract, session.key, before.sources, before.settings, {
            receiptCiphertext: persistedReceipt, selectorCiphertext: sealed.selectorCiphertext,
          },
        )).observation !== "authenticated-destination-selector-settings-pending") {
        throw Error("D232 Receipt readback is ambiguous.")
      }
      // Second complete frozen Backup and Destination Git proof occurs while
      // the active selector path is STILL absent.
      await session.prove()
      if (await methods.exists.call(adapter, selectorPath)
        || (await currentLocal(session)).evidence !== before.evidence
        || await session.readOne(receiptPath) !== persistedReceipt) {
        throw Error("D232 Selector prerequisites drifted after complete Git proof.")
      }
      await methods.write.call(adapter, selectorPath, sealed.selectorCiphertext)
      await session.check()
      const current = await inspectLocalPair(session, receiptPath, selectorPath)
      if (current.observation !== LINKED
        || current.selectorCiphertext !== sealed.selectorCiphertext
        || current.receiptCiphertext !== sealed.receiptCiphertext
        || await session.readOne(selectorPath) !== sealed.selectorCiphertext
        || await session.readOne(receiptPath) !== persistedReceipt
        || !session.unchanged()) {
        throw Error("D232 Selector write did not survive exact local readback.")
      }
      await confirmPinnedHeads(session, input)
      if (await session.readOne(selectorPath) !== sealed.selectorCiphertext
        || await session.readOne(receiptPath) !== sealed.receiptCiphertext) {
        throw Error("D232 Selector/Receipt changed during post-write Git HEAD checks.")
      }
      await session.check()
      completed = Object.freeze({
        ...BASE, evidence: "best-effort-wal-readback-not-power-loss-durable",
        status: "destination-selector-written-settings-pending",
        receiptPath, selectorPath,
      })
      return completed
    })
    if (calls !== 1 || completed === null || returned !== completed
      || !session.unchanged()) throw Error("D232 owner holder cannot certify Selector write.")
    return completed
  } finally {
    claimed.delete(selectorPath)
    if (!claimed.size) inFlight.delete(adapter)
  }
}

/** Crypto+local Restart readback; does NOT claim full current Git verification. */
export async function inspectV4FencedActiveSelectorAfterRestart(
  input: V4FencedPendingCommitPreflightInput,
): Promise<V4ActiveSelectorCommitRestartReport> {
  let session: Session
  try { session = createV4FencedActivationSession(input) }
  catch { return manual("foreign-or-torn") }
  const roots = planV4ReencryptionSeparatedRoots(
    input.readiness.prepared.identity.indexRoot, input.readiness.prepared.identity.runId,
  )
  const receiptPath = session.root + RECEIPT
  const selectorPath = roots.selectorPath
  let calls = 0
  let completed: V4ActiveSelectorCommitRestartReport | null = null
  try {
    const returned = await session.holder(async () => {
      if (++calls !== 1) throw Error("D232 Restart Owner Lease invoked more than once.")
      await session.check()
      const first = await inspectLocalPair(session, receiptPath, selectorPath)
      const second = await inspectLocalPair(session, receiptPath, selectorPath)
      if (first.observation.artifactWindow !== second.observation.artifactWindow
        || first.observation.observation !== second.observation.observation
        || first.evidence !== second.evidence) {
        completed = manual("foreign-or-torn")
      } else if (first.observation === LINKED) {
        await confirmPinnedHeads(session, input)
        if (await session.readOne(selectorPath) !== first.selectorCiphertext
          || await session.readOne(receiptPath) !== first.receiptCiphertext) {
          completed = manual("foreign-or-torn")
        } else {
          completed = LINKED
        }
      } else {
        completed = first.observation
      }
      await session.check()
      return completed
    })
    return calls === 1 && completed !== null && returned === completed
      && session.unchanged() ? completed : manual("foreign-or-torn")
  } catch { return manual("foreign-or-torn") }
}
