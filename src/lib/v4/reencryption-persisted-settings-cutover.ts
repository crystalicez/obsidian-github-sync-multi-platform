import { sha256Hex, utf8ToBytes } from "../bytes"
import { loadV4LocalIndex } from "./local-index"
import { createV4FencedActivationSession } from "./reencryption-activation-decision-stage"
import { inspectV4ActivationSettingsSwitchPlan } from "./reencryption-activation-switch-plan-crypto"
import { inspectV4ActiveSelectorCommitPair } from "./reencryption-active-selector-commit-crypto"
import { inspectV4FencedActiveSelectorAfterRestart } from "./reencryption-active-selector-commit-stage"
import { inspectV4FencedFrozenBackupContentAfterRestart } from "./reencryption-fenced-backup-content"
import type { V4FencedPendingCommitPreflightInput } from "./reencryption-fenced-pending-commit-preflight"
import { verifyV4ReencryptionShadowAgainstDestination } from "./reencryption-shadow-remote-binding"
import { planV4ReencryptionSeparatedRoots } from "./reencryption-separated-selector"
import { V4_REENCRYPTION_RUNTIME_ROUTE_ROOT, V4_REENCRYPTION_RUNTIME_ROUTE_PATH, sealV4RuntimeIndexRouteIntent, authenticateV4RuntimeIndexRouteIntent } from "./reencryption-runtime-index-route"
import type { V4LocalCutoverSettings } from "./reencryption-local-cutover-inspection"

const INTENT = "/persisted-settings-write-intent.json"
const PLAN = "/settings-switch-plan.json"
const RECEIPT = "/selector-commit-receipt.json"
const DOMAIN = "v4-rekey-plugin-settings-write-intent-v1"
const SHA = /^[0-9a-f]{64}$/u
const MAX = 256 * 1024
const inFlight = new WeakMap<object, Set<string>>()
const digest = (value: string) => sha256Hex(utf8ToBytes(value))
type Session = ReturnType<typeof createV4FencedActivationSession>

export interface V4FencedPluginSettingsCutoverInput extends V4FencedPendingCommitPreflightInput {
  /** Full native Obsidian loadData() wrapper, not just the six-field projection. */
  readonly readPersistedPluginData: () => Promise<unknown>
  /** Native Obsidian saveData(), never ordinary saveSettings() (which scrubs old SecretStorage). */
  readonly writePersistedPluginData: (data: unknown) => Promise<void>
  /** Caller holds a Settings-save lock, pins the current plugin instance and vault adapter. */
  readonly assertLivePluginOwner: () => void
}
export interface V4FencedPluginSettingsCutoverReport {
  readonly status: "destination-settings-written-selector-commit-pending"
  readonly intentPath: string
  readonly evidence: "best-effort-plugin-settings-readback-not-power-loss-durable"
  readonly commitDecisionAuthorized: false
  readonly localCutoverAuthorized: false
  readonly resumeSyncAuthorized: false
  readonly rollbackAuthorized: false
  readonly remoteWritesAuthorized: false
  readonly oldPassphraseCleanupAuthorized: false
}
export interface V4FencedPluginSettingsRestartReport {
  readonly observation: "destination-settings-observed-uncommitted" | "manual-recovery-required"
  readonly artifactWindow: "intent-missing" | "intent-only-source-settings"
    | "destination-settings" | "foreign-or-torn"
  readonly integrityScope: "authenticated-plugin-settings-and-physical-selector"
  readonly evidence: "best-effort-readback-not-power-loss-durable"
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
const report = (
  observation: V4FencedPluginSettingsRestartReport["observation"],
  artifactWindow: V4FencedPluginSettingsRestartReport["artifactWindow"],
): V4FencedPluginSettingsRestartReport => Object.freeze({
  ...BASE, integrityScope: "authenticated-plugin-settings-and-physical-selector",
  evidence: "best-effort-readback-not-power-loss-durable", observation, artifactWindow,
})
const COMPLETE = report("destination-settings-observed-uncommitted", "destination-settings")
const manual = (window: V4FencedPluginSettingsRestartReport["artifactWindow"]) =>
  report("manual-recovery-required", window)

type Plain = Record<string, unknown>
function object(value: unknown): value is Plain {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null)
}
function projection(settings: Plain): V4LocalCutoverSettings {
  const fields = ["githubOwner", "githubRepo", "githubBranch",
    "encryptionMode", "encryptionPassphraseSecretId", "vault"] as const
  for (const field of fields) if (typeof settings[field] !== "string") {
    throw Error("D233 plugin Settings identity is invalid.")
  }
  return {
    githubOwner: settings["githubOwner"] as string,
    githubRepo: settings["githubRepo"] as string,
    githubBranch: settings["githubBranch"] as string,
    encryptionMode: settings["encryptionMode"] as string,
    encryptionPassphraseSecretId: settings["encryptionPassphraseSecretId"] as string,
    vault: settings["vault"] as string,
  }
}
function sourceData(value: unknown): { wrapper: Plain; settings: Plain; serialized: string } {
  if (!object(value) || !object(value["settings"])
    || Object.hasOwn(value["settings"], "encryptionPassphrase")
    || Object.hasOwn(value["settings"], "githubToken")) {
    throw Error("D233 needs a wrapped, already sanitized native Obsidian Settings record.")
  }
  const serialized = JSON.stringify(value)
  if (typeof serialized !== "string" || utf8ToBytes(serialized).length > MAX
    || serialized !== JSON.stringify(JSON.parse(serialized))) {
    throw Error("D233 persisted plugin Settings are not stable bounded JSON.")
  }
  return { wrapper: value, settings: value["settings"] as Plain, serialized }
}
function destinationData(raw: ReturnType<typeof sourceData>, id: V4LocalCutoverSettings): string {
  return JSON.stringify({
    ...raw.wrapper,
    settings: {
      ...raw.settings, githubBranch: id.githubBranch,
      encryptionPassphraseSecretId: id.encryptionPassphraseSecretId,
    },
  })
}
async function hmac(key: Uint8Array, message: string): Promise<string> {
  const raw = new Uint8Array(new ArrayBuffer(key.byteLength))
  raw.set(key)
  const encoded = utf8ToBytes(DOMAIN + ":" + message)
  const bytes = new Uint8Array(new ArrayBuffer(encoded.length))
  bytes.set(encoded)
  try {
    const cryptoKey = await crypto.subtle.importKey(
      "raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
    )
    return Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, bytes)),
      b => b.toString(16).padStart(2, "0")).join("")
  } finally { raw.fill(0); bytes.fill(0) }
}
interface SettingsWriteIntent {
  readonly schemaVersion: 1
  readonly phase: "plugin-settings-write-intent-fence-held"
  readonly transactionId: string
  readonly sourceDataSha256: string
  readonly destinationDataSha256: string
  readonly selectorCiphertextSha256: string
  readonly receiptCiphertextSha256: string
  readonly mac: string
}
async function intentRecord(
  session: Session,
  source: string, destination: string,
  receipt: string, selector: string, transactionId: string,
): Promise<SettingsWriteIntent> {
  const fields = {
    schemaVersion: 1 as const, phase: "plugin-settings-write-intent-fence-held" as const,
    transactionId,
    sourceDataSha256: await digest(source),
    destinationDataSha256: await digest(destination),
    selectorCiphertextSha256: await digest(selector),
    receiptCiphertextSha256: await digest(receipt),
  }
  return { ...fields, mac: await hmac(session.key, JSON.stringify(fields)) }
}
async function parseIntent(session: Session, value: string): Promise<SettingsWriteIntent> {
  const parsed: unknown = JSON.parse(value)
  if (!object(parsed) || Object.keys(parsed).sort().join("|")
    !== "destinationDataSha256|mac|phase|receiptCiphertextSha256|schemaVersion|selectorCiphertextSha256|sourceDataSha256|transactionId"
    || parsed["schemaVersion"] !== 1
    || parsed["phase"] !== "plugin-settings-write-intent-fence-held"
    || typeof parsed["transactionId"] !== "string"
    || typeof parsed["mac"] !== "string"
    || !SHA.test(parsed["mac"])
    || ["sourceDataSha256", "destinationDataSha256", "selectorCiphertextSha256", "receiptCiphertextSha256"]
      .some(k => typeof parsed[k] !== "string" || !SHA.test(parsed[k] as string))) {
    throw Error("D233 persisted Settings Intent is malformed.")
  }
  const { mac, ...fields } = parsed
  if (await hmac(session.key, JSON.stringify(fields)) !== mac) {
    throw Error("D233 persisted Settings Intent MAC mismatch.")
  }
  return parsed as unknown as SettingsWriteIntent
}
async function material(session: Session) {
  await session.check()
  const decision = await session.readAuthenticated()
  const { contract } = decision
  const { identity: id } = contract
  const roots = planV4ReencryptionSeparatedRoots(id.indexRoot, id.runId)
  const settings = session.sourceSettings
  const sources = {
    ...decision.sources, activationDecisionCiphertext: decision.ciphertext,
    settingsSwitchPlanCiphertext: await session.readOne(session.root + PLAN),
  }
  if ((await inspectV4ActivationSettingsSwitchPlan(
    contract, session.key, sources, settings, sources.settingsSwitchPlanCiphertext,
  )).observation !== "authenticated-settings-switch-plan-not-applied") {
    throw Error("D233 wrong sealed D231 Settings Plan.")
  }
  const receipt = await session.readOne(session.root + RECEIPT)
  const selector = await session.readOne(roots.selectorPath)
  if ((await inspectV4ActiveSelectorCommitPair(
    contract, session.key, sources, settings, {
      receiptCiphertext: receipt, selectorCiphertext: selector,
    },
  )).observation !== "authenticated-destination-selector-settings-pending") {
    throw Error("D233 wrong physical Selector or Commit Receipt.")
  }
  // Independently check unchanged SOURCE and Shadow even once source Settings changed.
  const [original, shadow] = await Promise.all([
    loadV4LocalIndex(session.adapter, roots.sourceIndexRoot),
    loadV4LocalIndex(session.adapter, roots.shadowIndexRoot),
  ])
  if (await digest(JSON.stringify(original)) !== contract.sourceIndexSha256
    || await digest(JSON.stringify(shadow)) !== contract.destinationShadowSha256) {
    throw Error("D233 persisted Source/Shadow Index drifted.")
  }
  await session.check()
  const destination: V4LocalCutoverSettings = {
    ...settings, githubBranch: id.destinationRepoId.split("#")[1]!,
    encryptionPassphraseSecretId: id.destinationPassphraseSecretId,
  }
  return { receipt, selector, contract, settings, destination }
}

/** Full after-Selector Git scan independent from pre-Selector D229. */
async function fullGitAfterSelector(session: Session, input: V4FencedPendingCommitPreflightInput) {
  await session.check()
  const backup = await inspectV4FencedFrozenBackupContentAfterRestart(
    session.borrowedPreflight.backup,
  )
  if (!backup.completeBackupContentReverified
    || backup.observation !== "complete-frozen-backup-reverified-uncommitted") {
    throw Error("D233 current complete frozen Backup Git proof failed.")
  }
  const shadow = input.readiness.full.shadow
  const remote = await verifyV4ReencryptionShadowAgainstDestination({
    ...shadow, assertCrashDurable: session.check,
  })
  // Re-encryption verifies each independently pinned Git tree. The
  // historical Source Backup and the newly encrypted Destination can have
  // different entry inventories; an equal file-count test is not a proof of
  // equal content and is not part of either verifier's contract.
  if (remote.observation !== "shadow-matches-verified-destination-uncommitted"
    || remote.destinationCommitSha !== input.readiness.prepared.identity.destinationCommitSha) {
    throw Error("D233 current complete Destination Git proof failed.")
  }
  await session.check()
  return { files: remote.verifiedFileCount, bytes: remote.verifiedPlaintextBytes }
}
async function verifySourceShape(session: Session, raw: ReturnType<typeof sourceData>) {
  const projected = projection(raw.settings)
  if (JSON.stringify(projected) !== JSON.stringify(session.sourceSettings)) {
    throw Error("D233 persisted native Settings no longer select Source.")
  }
}
function pluginScope(input: V4FencedPluginSettingsCutoverInput) {
  const read = input.readPersistedPluginData
  const write = input.writePersistedPluginData
  const assert = input.assertLivePluginOwner
  if (typeof read !== "function" || typeof write !== "function"
    || typeof assert !== "function") throw Error("D233 requires native Settings I/O and owner.")
  const check = () => {
    if (input.readPersistedPluginData !== read
      || input.writePersistedPluginData !== write
      || input.assertLivePluginOwner !== assert) throw Error("D233 native Settings I/O changed.")
    assert()
  }
  return { read, write, check }
}
export async function persistV4FencedDestinationSettings(
  input: V4FencedPluginSettingsCutoverInput,
): Promise<V4FencedPluginSettingsCutoverReport> {
  const session = createV4FencedActivationSession(input)
  const { read, write, check } = pluginScope(input)
  const path = session.root + INTENT
  const active = inFlight.get(session.adapter) ?? new Set<string>()
  if (active.has(path)) throw Error("D233 concurrent Settings cutover requires Manual Recovery.")
  active.add(path)
  inFlight.set(session.adapter, active)
  let calls = 0
  let done: V4FencedPluginSettingsCutoverReport | null = null
  try {
    const returned = await session.holder(async () => {
      if (++calls !== 1) throw Error("D233 owner holder called twice.")
      check()
      await session.check()
      if (await session.methods.exists.call(session.adapter, path)) {
        throw Error("D233 prior Settings write Intent needs Manual Recovery.")
      }
      if ((await inspectV4FencedActiveSelectorAfterRestart(session.borrowedPreflight))
        .observation !== "authenticated-selector-settings-pending") {
        throw Error("D233 does not have a verified physical Selector.")
      }
      const state = await material(session)
      const original = sourceData(await read())
      await verifySourceShape(session, original)
      const target = destinationData(original, state.destination)
      const targetRaw = sourceData(JSON.parse(target))
      if (JSON.stringify(projection(targetRaw.settings)) !== JSON.stringify(state.destination)) {
        throw Error("D233 invalid destination Settings projection.")
      }
      if ((await fullGitAfterSelector(session, input)).files < 0) {
        throw Error("D233 complete Git content proof inconsistent.")
      }
      check()
      await session.check()
      if (await session.methods.exists.call(session.adapter, path)
        || sourceData(await read()).serialized !== original.serialized) {
        throw Error("D233 plugin Settings drifted before write-ahead Intent.")
      }
      const intent = await intentRecord(
        session, original.serialized, target,
        state.receipt, state.selector, state.contract.transactionId,
      )
      const sealed = JSON.stringify(intent)
      await session.methods.write.call(session.adapter, path, sealed)
      await session.check()
      check()
      if (await session.readOne(path) !== sealed
        || JSON.stringify(await parseIntent(session, await session.readOne(path))) !== sealed
        || sourceData(await read()).serialized !== original.serialized) {
        throw Error("D233 write-ahead Settings Intent is torn.")
      }
      // The stable Runtime route hint outlives the primary Sync Fence and
      // blocks Sync even if that directory is accidentally removed.
      if (await session.methods.exists.call(session.adapter, V4_REENCRYPTION_RUNTIME_ROUTE_ROOT)
        || await session.methods.exists.call(session.adapter, V4_REENCRYPTION_RUNTIME_ROUTE_PATH)) {
        throw Error("D234 previous Runtime route marker needs Manual Recovery.")
      }
      const contractText = await session.readOne(session.root + "/contract.json")
      const routeText = await sealV4RuntimeIndexRouteIntent(
        state.contract, session.key, state.selector, sealed, contractText,
      )
      await session.adapter.mkdir(V4_REENCRYPTION_RUNTIME_ROUTE_ROOT)
      await session.check()
      await session.adapter.write(V4_REENCRYPTION_RUNTIME_ROUTE_PATH, routeText)
      await session.check()
      check()
      if (await session.readOne(V4_REENCRYPTION_RUNTIME_ROUTE_PATH) !== routeText
        || JSON.stringify(await authenticateV4RuntimeIndexRouteIntent(
          routeText, session.key,
        )) !== routeText
        || sourceData(await read()).serialized !== original.serialized) {
        throw Error("D234 Runtime route marker is torn or Settings changed before native save.")
      }
      // No automatic rollback or cleanup after this boundary. Obsidian may
      // persist a complete new data.json even if saveData() throws.
      await write(JSON.parse(target))
      check()
      await session.check()
      if (sourceData(await read()).serialized !== target
        || await session.readOne(path) !== sealed
        || await session.readOne(V4_REENCRYPTION_RUNTIME_ROUTE_PATH) !== routeText) {
        throw Error("D233 Settings/Runtime route disk readback changed or is incomplete; Manual Recovery.")
      }
      if (JSON.stringify(await material(session)) !== JSON.stringify(state)) {
        throw Error("D233 physical Selector changed during Settings write.")
      }
      await fullGitAfterSelector(session, input)
      if (sourceData(await read()).serialized !== target
        || await session.readOne(path) !== sealed
        || await session.readOne(V4_REENCRYPTION_RUNTIME_ROUTE_PATH) !== routeText) {
        throw Error("D233 final Settings/Runtime route write readback drifted.")
      }
      check()
      await session.check()
      done = Object.freeze({
        ...BASE, status: "destination-settings-written-selector-commit-pending",
        intentPath: path, evidence: "best-effort-plugin-settings-readback-not-power-loss-durable",
      })
      return done
    })
    if (calls !== 1 || done === null || returned !== done || !session.unchanged()) {
      throw Error("D233 owner holder did not attest Settings cutover.")
    }
    return done
  } finally {
    active.delete(path)
    if (!active.size) inFlight.delete(session.adapter)
  }
}

/**
 * Restart reads only, using D230/231/232 authenticated artifacts and D233
 * HMAC. Source and Destination outcomes are both non-authorizing while Fence
 * remains. This reader needs the historical pinned Source proof input.
 */
export async function inspectV4FencedDestinationSettingsAfterRestart(
  input: V4FencedPluginSettingsCutoverInput,
): Promise<V4FencedPluginSettingsRestartReport> {
  let session: Session
  let scope: ReturnType<typeof pluginScope>
  try {
    session = createV4FencedActivationSession(input)
    scope = pluginScope(input)
  } catch { return manual("foreign-or-torn") }
  const path = session.root + INTENT
  let calls = 0
  let completed: V4FencedPluginSettingsRestartReport | null = null
  try {
    const returned = await session.holder(async () => {
      if (++calls !== 1) throw Error("D233 restart holder called twice.")
      scope.check()
      await session.check()
      if (!await session.methods.exists.call(session.adapter, path)) {
        completed = manual("intent-missing")
        return completed
      }
      const state = await material(session)
      const persistedIntent = await session.readOne(path)
      const record = await parseIntent(session, persistedIntent)
      const manifest = await session.readOne(session.root + "/contract.json")
      const expectedRoute = await sealV4RuntimeIndexRouteIntent(
        state.contract, session.key, state.selector, persistedIntent, manifest,
      )
      if (await session.readOne(V4_REENCRYPTION_RUNTIME_ROUTE_PATH) !== expectedRoute
        || !await session.methods.exists.call(session.adapter, V4_REENCRYPTION_RUNTIME_ROUTE_ROOT)
        || record.transactionId !== state.contract.transactionId
        || record.receiptCiphertextSha256 !== await digest(state.receipt)
        || record.selectorCiphertextSha256 !== await digest(state.selector)) {
        throw Error("D233 Settings Intent not linked to physical Selector.")
      }
      const check = async () => {
        scope.check()
        await session.check()
        const content = sourceData(await scope.read()).serialized
        const hash = await digest(content)
        if (hash !== record.sourceDataSha256 && hash !== record.destinationDataSha256) {
          throw Error("D233 persisted Settings neither original Source nor target.")
        }
        return { content, hash }
      }
      const first = await check()
      const second = await check()
      if (first.content !== second.content || first.hash !== second.hash
        || await session.readOne(path) !== JSON.stringify(record)) {
        throw Error("D233 Settings Intent or data changed between reads.")
      }
      if (first.hash === record.destinationDataSha256) {
        if (JSON.stringify(projection(sourceData(JSON.parse(first.content)).settings))
          !== JSON.stringify(state.destination)) {
          throw Error("D233 Destination Settings projection differs.")
        }
        await fullGitAfterSelector(session, input)
        if ((await check()).content !== first.content
          || await session.readOne(V4_REENCRYPTION_RUNTIME_ROUTE_PATH) !== expectedRoute) {
          throw Error("D233 Git proof observed Settings or Runtime routing marker drift.")
        }
        completed = COMPLETE
      } else {
        if (JSON.stringify(projection(sourceData(JSON.parse(first.content)).settings))
          !== JSON.stringify(session.sourceSettings)) {
          throw Error("D233 Source Settings projection differs.")
        }
        completed = manual("intent-only-source-settings")
      }
      return completed
    })
    return calls === 1 && completed !== null && returned === completed && session.unchanged()
      ? completed : manual("foreign-or-torn")
  } catch { return manual("foreign-or-torn") }
}
