import { bytesToUtf8, fromBase64, sha256Hex, toBase64, utf8ToBytes } from "../bytes"
import { collectV4ContentSource, DEFAULT_V4_WHOLE_BUFFER_CEILING_BYTES } from "./content-source"
import { decryptV4Payload, encryptV4Payload } from "./crypto"
import type { V4LocalIndexAdapter } from "./local-index"
import { assertV4LocalTargetPrecondition, V4LocalTargetChangedError, type V4LocalIo } from "./local-io"
import { hashV4StableContentSource } from "./object-stream"
import type { V4StageRef } from "./staging-store"
import type { V4RecoveryHeader, V4RecoveryPayload, V4RecoveryPhase, V4RecoverySnapshot } from "./recovery-types"
import { reconcileV4CandidatePublication, type V4PublishReconcileResult, type V4PublishReconcilerGithub } from "./publish-reconciler"

import { throwIfV4Aborted } from "./cancellation"
const V4_RECOVERY_SCHEMA_VERSION = 1 as const
const VALID_PHASES = new Set<V4RecoveryPhase>([
  "publish-intent",
  "remote-verified",
  "local-committing",
  "replan-required",
  "index-committed",
])

export class V4RecoveryRequiredError extends Error {
  constructor(message = "V4 recovery state is unreadable and requires recovery.") {
    super(message)
    this.name = "V4RecoveryRequiredError"
  }
}

export interface V4RecoveryStore {
  load(): Promise<V4RecoverySnapshot | null>
  save(input: Omit<V4RecoveryHeader, "schemaVersion" | "generation" | "payloadCiphertext" | "integrity"> & { payload?: V4RecoveryPayload }): Promise<V4RecoverySnapshot>
}

function join(root: string, child: string): string {
  return `${root.replace(/\/+$/u, "")}/${child.replace(/^\/+/, "")}`
}

function slotPath(root: string, slot: number): string {
  return join(root, `slot-${slot}.json`)
}

async function ensureDirectoryChain(adapter: V4LocalIndexAdapter, path: string): Promise<void> {
  let current = ""
  for (const segment of path.split("/").filter(Boolean)) {
    current = current ? `${current}/${segment}` : segment
    try { await adapter.mkdir(current) } catch (error) { if (!/exist/iu.test((error as Error).message)) throw error }
  }
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string"
}

function isHeader(value: unknown): value is V4RecoveryHeader {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const header = value as Partial<V4RecoveryHeader>
  return header.schemaVersion === V4_RECOVERY_SCHEMA_VERSION
    && Number.isSafeInteger(header.generation) && (header.generation ?? 0) > 0
    && typeof header.runId === "string" && header.runId.length > 0
    && typeof header.phase === "string" && VALID_PHASES.has(header.phase as V4RecoveryPhase)
    && (header.expectedRemoteHead === null || typeof header.expectedRemoteHead === "string")
    && isOptionalString(header.journalId)
    && isOptionalString(header.candidateCommitSha)
    && isOptionalString(header.verifiedRemoteHead)
    && isOptionalString(header.payloadCiphertext)
    && typeof header.integrity === "string" && /^[0-9a-f]{64}$/u.test(header.integrity)
}

function integrityView(header: Omit<V4RecoveryHeader, "integrity">): object {
  return {
    schemaVersion: header.schemaVersion,
    generation: header.generation,
    runId: header.runId,
    journalId: header.journalId,
    phase: header.phase,
    expectedRemoteHead: header.expectedRemoteHead,
    candidateCommitSha: header.candidateCommitSha,
    verifiedRemoteHead: header.verifiedRemoteHead,
    payloadCiphertext: header.payloadCiphertext,
  }
}

async function integrityFor(header: Omit<V4RecoveryHeader, "integrity">): Promise<string> {
  return sha256Hex(utf8ToBytes(JSON.stringify(integrityView(header))))
}

function isPayload(value: unknown): value is V4RecoveryPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const payload = value as Partial<V4RecoveryPayload>
  if (!Array.isArray(payload.mutations) || !Array.isArray(payload.completedMutationIds)) return false
  if (!payload.completedMutationIds.every(id => typeof id === "string")) return false
  return payload.mutations.every(mutation => {
    if (!mutation || typeof mutation !== "object" || Array.isArray(mutation)) return false
    const candidate = mutation as V4RecoveryPayload["mutations"][number]
    if (typeof candidate.id !== "string" || typeof candidate.path !== "string") return false
    if (!candidate.precondition || candidate.precondition.path !== candidate.path || typeof candidate.precondition.exists !== "boolean") return false
    if (candidate.kind === "trash") return true
    return candidate.kind === "stage-write"
      && !!candidate.stage
      && typeof candidate.stage.stageId === "string"
      && typeof candidate.stage.hash === "string"
      && Number.isSafeInteger(candidate.stage.size)
      && Number.isFinite(candidate.stage.mtime)
  })
}

export function createV4RecoveryStore(options: {
  adapter: V4LocalIndexAdapter
  root: string
  repoId: string
  payloadKey?: Uint8Array
}): V4RecoveryStore {
  const root = options.root.replace(/\/+$/u, "")
  if (!root) throw new Error("V4 recovery root is required.")
  if (!options.repoId) throw new Error("V4 recovery repository id is required.")

  const decodePayload = async (header: V4RecoveryHeader): Promise<V4RecoveryPayload | undefined> => {
    if (!header.payloadCiphertext) return undefined
    let bytes = fromBase64(header.payloadCiphertext)
    if (options.payloadKey) {
      bytes = await decryptV4Payload(options.payloadKey, bytes, {
        kind: "journal",
        aad: `local-recovery:${options.repoId}:${header.runId}:${header.generation}`,
      })
    }
    let parsed: unknown
    try { parsed = JSON.parse(bytesToUtf8(bytes)) } catch { throw new V4RecoveryRequiredError("V4 recovery payload is invalid.") }
    if (!isPayload(parsed)) throw new V4RecoveryRequiredError("V4 recovery payload shape is invalid.")
    return parsed
  }

  const readSlot = async (slot: number): Promise<{ present: boolean; snapshot?: V4RecoverySnapshot }> => {
    const path = slotPath(root, slot)
    if (!(await options.adapter.exists(path))) return { present: false }
    let parsed: unknown
    try { parsed = JSON.parse(await options.adapter.read(path)) } catch { return { present: true } }
    if (!isHeader(parsed)) return { present: true }
    const header = parsed
    const { integrity, ...withoutIntegrity } = header
    if (await integrityFor(withoutIntegrity) !== integrity) return { present: true }
    try {
      const payload = await decodePayload(header)
      return { present: true, snapshot: { header, payload } }
    } catch {
      return { present: true }
    }
  }

  const load = async (): Promise<V4RecoverySnapshot | null> => {
    const slots = await Promise.all([readSlot(0), readSlot(1)])
    const valid = slots.flatMap(slot => slot.snapshot ? [slot.snapshot] : [])
    if (valid.length > 0) return valid.reduce((latest, candidate) => candidate.header.generation > latest.header.generation ? candidate : latest)
    if (slots.some(slot => slot.present)) throw new V4RecoveryRequiredError()
    return null
  }

  return {
    load,
    async save(input) {
      let previous: V4RecoverySnapshot | null = null
      try { previous = await load() } catch (error) { if (error instanceof V4RecoveryRequiredError) throw error; throw error }
      const generation = (previous?.header.generation ?? 0) + 1
      let payloadCiphertext: string | undefined
      if (input.payload) {
        let bytes = utf8ToBytes(JSON.stringify(input.payload))
        if (options.payloadKey) {
          bytes = await encryptV4Payload(options.payloadKey, bytes, {
            kind: "journal",
            aad: `local-recovery:${options.repoId}:${input.runId}:${generation}`,
          })
        }
        payloadCiphertext = toBase64(bytes)
      }
      const withoutIntegrity: Omit<V4RecoveryHeader, "integrity"> = {
        schemaVersion: V4_RECOVERY_SCHEMA_VERSION,
        generation,
        runId: input.runId,
        journalId: input.journalId,
        phase: input.phase,
        expectedRemoteHead: input.expectedRemoteHead,
        candidateCommitSha: input.candidateCommitSha,
        verifiedRemoteHead: input.verifiedRemoteHead,
        payloadCiphertext,
      }
      const header: V4RecoveryHeader = { ...withoutIntegrity, integrity: await integrityFor(withoutIntegrity) }
      await ensureDirectoryChain(options.adapter, root)
      await options.adapter.write(slotPath(root, generation % 2), JSON.stringify(header))
      return { header, payload: input.payload }
    },
  }
}

export interface V4RecoveryLocalApplyResult {
  snapshot: V4RecoverySnapshot
  replanRequired: boolean
}

function saveFromSnapshot(
  store: V4RecoveryStore,
  snapshot: V4RecoverySnapshot,
  phase: V4RecoveryPhase,
  payload: V4RecoveryPayload | undefined,
): Promise<V4RecoverySnapshot> {
  return store.save({
    runId: snapshot.header.runId,
    journalId: snapshot.header.journalId,
    phase,
    expectedRemoteHead: snapshot.header.expectedRemoteHead,
    candidateCommitSha: snapshot.header.candidateCommitSha,
    verifiedRemoteHead: snapshot.header.verifiedRemoteHead,
    payload,
  })
}

async function targetMatchesStage(io: V4LocalIo, path: string, stage: V4StageRef): Promise<boolean> {
  if (!io.stat) return false
  const stat = await io.stat(path)
  if (!stat || stat.size !== stage.size) return false
  if (stage.size <= DEFAULT_V4_WHOLE_BUFFER_CEILING_BYTES) {
    try { return await sha256Hex(await io.read(path)) === stage.hash } catch { return false }
  }
  if (!io.openContentSource) return false
  try {
    const source = await io.openContentSource({
      kind: "vault",
      path,
      expectedHash: stage.hash,
      expectedSize: stage.size,
      expectedMtime: stat.mtime,
    })
    return await hashV4StableContentSource(source, { chunkBytes: 4 * 1024 * 1024 }) === stage.hash
  } catch {
    return false
  }
}

export async function applyV4RecoveryLocalMutations(input: {
  store: V4RecoveryStore
  snapshot: V4RecoverySnapshot
  io: V4LocalIo
  onApplying?: (mutation: V4RecoveryPayload["mutations"][number]) => void
  onApplied?: (mutation: V4RecoveryPayload["mutations"][number]) => void
  signal?: AbortSignal
}): Promise<V4RecoveryLocalApplyResult> {
  let snapshot = input.snapshot
  const payload: V4RecoveryPayload = snapshot.payload
    ? { mutations: snapshot.payload.mutations, completedMutationIds: [...snapshot.payload.completedMutationIds] }
    : { mutations: [], completedMutationIds: [] }
  const completed = new Set(payload.completedMutationIds)

  const receipt = async (id: string): Promise<void> => {
    if (!completed.has(id)) { completed.add(id); payload.completedMutationIds = [...completed] }
    snapshot = await saveFromSnapshot(input.store, snapshot, "local-committing", payload)
  }
  const replan = async (): Promise<V4RecoveryLocalApplyResult> => {
    snapshot = await saveFromSnapshot(input.store, snapshot, "replan-required", payload)
    return { snapshot, replanRequired: true }
  }

  for (const mutation of payload.mutations) {
    throwIfV4Aborted(input.signal)
    if (completed.has(mutation.id)) continue
    input.onApplying?.(mutation)
    try {
      if (mutation.kind === "trash") {
        const current = input.io.stat ? await input.io.stat(mutation.path) : undefined
        if (input.io.stat && !current) {
          await receipt(mutation.id)
          throwIfV4Aborted(input.signal)
          input.onApplied?.(mutation)
          continue
        }
        await assertV4LocalTargetPrecondition(input.io, mutation.precondition)
        await input.io.trash(mutation.path)
        await receipt(mutation.id)
        throwIfV4Aborted(input.signal)
        input.onApplied?.(mutation)
        continue
      }

      if (await targetMatchesStage(input.io, mutation.path, mutation.stage)) {
        await receipt(mutation.id)
        try { await input.io.staging?.remove(mutation.stage) } catch {}
        input.onApplied?.(mutation)
        continue
      }
      await assertV4LocalTargetPrecondition(input.io, mutation.precondition)
      if (mutation.stage.size > DEFAULT_V4_WHOLE_BUFFER_CEILING_BYTES) {
        if (!input.io.commitStage) throw new V4RecoveryRequiredError(`V4 recovery cannot commit staged content: ${mutation.id}`)
        await input.io.commitStage({ stage: mutation.stage, path: mutation.path, precondition: mutation.precondition })
      } else {
        if (!input.io.staging) throw new V4RecoveryRequiredError(`V4 recovery stage is unavailable: ${mutation.id}`)
        const source = await input.io.staging.open(mutation.stage)
        const bytes = await collectV4ContentSource(source, DEFAULT_V4_WHOLE_BUFFER_CEILING_BYTES, input.signal)
        if (await sha256Hex(bytes) !== mutation.stage.hash) throw new V4RecoveryRequiredError(`V4 recovery stage hash mismatch: ${mutation.id}`)
        await input.io.write(mutation.path, bytes, mutation.stage.mtime)
      }
      await receipt(mutation.id)
      throwIfV4Aborted(input.signal)
      try { await input.io.staging?.remove(mutation.stage) } catch {}
      input.onApplied?.(mutation)
    } catch (error) {
      if (error instanceof V4LocalTargetChangedError || /local target changed/i.test((error as Error).message)) return replan()
      throw error
    }
  }
  return { snapshot, replanRequired: false }
}

export async function recoverV4PendingState(input: {
  store: V4RecoveryStore
  snapshot: V4RecoverySnapshot
  io: V4LocalIo
  currentRemoteHead: string | null
  publicationGithub?: V4PublishReconcilerGithub
  signal?: AbortSignal
}): Promise<V4RecoveryLocalApplyResult> {
  throwIfV4Aborted(input.signal)
  let snapshot = input.snapshot
  const header = snapshot.header
  if (header.phase === "index-committed") return { snapshot, replanRequired: false }
  if (header.phase === "replan-required") return { snapshot, replanRequired: true }

  if (header.phase === "publish-intent") {
    if (header.candidateCommitSha && input.publicationGithub) {
      const result = await reconcileV4CandidatePublication(input.publicationGithub, {
        candidateCommitSha: header.candidateCommitSha,
        expectedHeadSha: header.expectedRemoteHead,
        journalId: header.journalId,
        signal: input.signal,
      })
      snapshot = await reconcileV4RecoveryPublishIntent({ store: input.store, snapshot, result })
      if (snapshot.header.phase === "replan-required") return { snapshot, replanRequired: true }
    } else {
      if (!header.candidateCommitSha || input.currentRemoteHead !== header.candidateCommitSha) {
        snapshot = await saveFromSnapshot(input.store, snapshot, "replan-required", snapshot.payload)
        return { snapshot, replanRequired: true }
      }
      snapshot = await input.store.save({
        runId: header.runId,
        journalId: header.journalId,
        phase: "remote-verified",
        expectedRemoteHead: header.expectedRemoteHead,
        candidateCommitSha: header.candidateCommitSha,
        verifiedRemoteHead: header.candidateCommitSha,
        payload: snapshot.payload,
      })
    }
  }

  if (snapshot.header.phase === "remote-verified" || snapshot.header.phase === "local-committing") {
    const verified = snapshot.header.verifiedRemoteHead
    if (!verified || input.currentRemoteHead !== verified) {
      snapshot = await saveFromSnapshot(input.store, snapshot, "replan-required", snapshot.payload)
      return { snapshot, replanRequired: true }
    }
    const applied = await applyV4RecoveryLocalMutations({ store: input.store, snapshot, io: input.io, signal: input.signal })
    if (applied.replanRequired) return applied
    snapshot = await saveFromSnapshot(input.store, applied.snapshot, "replan-required", applied.snapshot.payload)
    return { snapshot, replanRequired: true }
  }

  snapshot = await saveFromSnapshot(input.store, snapshot, "replan-required", snapshot.payload)
  return { snapshot, replanRequired: true }
}

export async function markV4RecoveryIndexCommitted(store: V4RecoveryStore, runId: string): Promise<V4RecoverySnapshot | null> {
  const latest = await store.load()
  if (!latest || latest.header.runId !== runId) return latest
  if (latest.header.phase === "index-committed") return latest
  return saveFromSnapshot(store, latest, "index-committed", undefined)
}

export async function discardV4RecoveryStages(snapshot: V4RecoverySnapshot, io: V4LocalIo, keepStageIds: ReadonlySet<string> = new Set()): Promise<void> {
  const stageIds = new Set(snapshot.payload?.mutations.flatMap(mutation => mutation.kind === "stage-write" ? [mutation.stage.stageId] : []) ?? [])
  for (const stageId of stageIds) {
    if (keepStageIds.has(stageId)) continue
    try { await io.staging?.remove({ stageId }) } catch {}
  }
}

export async function reconcileV4RecoveryPublishIntent(input: {
  store: V4RecoveryStore
  snapshot: V4RecoverySnapshot
  result: V4PublishReconcileResult
}): Promise<V4RecoverySnapshot> {
  const { snapshot, result } = input
  if (snapshot.header.phase !== "publish-intent") return snapshot
  const candidate = snapshot.header.candidateCommitSha
  if (
    result.status === "published"
    && candidate
    && result.publishedCommitSha === candidate
    && result.currentHeadSha === candidate
  ) {
    return input.store.save({
      runId: snapshot.header.runId,
      journalId: snapshot.header.journalId,
      phase: "remote-verified",
      expectedRemoteHead: snapshot.header.expectedRemoteHead,
      candidateCommitSha: candidate,
      verifiedRemoteHead: candidate,
      payload: snapshot.payload,
    })
  }
  return input.store.save({
    runId: snapshot.header.runId,
    journalId: snapshot.header.journalId,
    phase: "replan-required",
    expectedRemoteHead: snapshot.header.expectedRemoteHead,
    candidateCommitSha: candidate,
    verifiedRemoteHead: result.status === "published-advanced" ? result.publishedCommitSha : snapshot.header.verifiedRemoteHead,
    payload: snapshot.payload,
  })
}
