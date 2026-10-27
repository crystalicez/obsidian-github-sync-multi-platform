import { bytesToUtf8, fromBase64, sha256Hex, toBase64, utf8ToBytes } from "../bytes"
import { assertSafeGitHubBranch, assertSafeGitHubRepositoryCoordinates } from "../github-config"
import { decryptV4Payload, encryptV4Payload } from "./crypto"
import type { V4LocalIndexAdapter } from "./local-index"
import { V4_GITHUB_REST_SAFE_WRITER_BYTES } from "./large-files"
import type { V4ReencryptionObjectReceipt } from "./reencryption-staging-receipts"

const SCHEMA_VERSION = 1 as const
const MAX_JOURNAL_BYTES = 2 * 1024 * 1024
const GIT_SHA = /^[0-9a-f]{40}$/u
const SAFE_RUN = /^[A-Za-z0-9_-]{8,128}$/u
const REMOTE_OPAQUE_PATH = /^\.obsidian-github-sync-v4\/(?:data|packs)\/[0-9a-f]{2}\/[0-9a-f]{64}\.enc$|^\.obsidian-github-sync-v4\/parts\/[0-9a-f]{2}\/[0-9a-f]{64}\/[A-Za-z0-9_-]{1,128}\/\d{6}\.enc$/u

export class V4ReencryptionJournalRecoveryRequiredError extends Error {
  constructor() {
    super("Re-encryption recovery journal needs manual revalidation before it can be modified.")
    this.name = "V4ReencryptionJournalRecoveryRequiredError"
  }
}

interface Slot {
  readonly schemaVersion: 1
  readonly generation: number
  readonly runId: string
  readonly sourceCommitSha: string
  readonly destinationRepoId: string
  readonly ciphertext: string
  readonly digest: string
}

export interface V4ReencryptionRefIntent {
  readonly role: "backup" | "destination"
  readonly repoId: string
  readonly commitSha: string
  readonly treeSha: string
  /** Required ONLY for Destination; binds commit/tree to exact manifest. */
  readonly manifestSha256?: string
}

interface Payload {
  readonly status: "staging-only"
  readonly pendingIntents: readonly V4ReencryptionObjectReceipt[]
  readonly receipts: readonly V4ReencryptionObjectReceipt[]
  /** Optional on legacy D80/D81 journals; encrypted within the WAL. */
  readonly refIntents?: readonly V4ReencryptionRefIntent[]
  readonly refReceipts?: readonly V4ReencryptionRefIntent[]
  readonly stageHandoffStarted?: boolean
  readonly candidatePreparationSha256?: string
}

export interface V4ReencryptionJournalSnapshot {
  readonly generation: number
  readonly receipts: readonly V4ReencryptionObjectReceipt[]
  readonly pendingIntents: readonly V4ReencryptionObjectReceipt[]
  readonly pendingRefIntents: readonly V4ReencryptionRefIntent[]
  readonly verifiedRefObservations: readonly V4ReencryptionRefIntent[]
  readonly stageHandoffStarted: boolean
  /** One-shot encrypted pre-commit candidate manifest intent; null on D80/D81 legacy. */
  readonly candidatePreparationSha256: string | null
  readonly requiresRemoteRevalidation: true
  readonly permissionToPublish: false
  readonly cutoverAuthorized: false
}

export interface V4ReencryptionRecoveryJournal {
  /** Immutable identity to prevent accidental cross-source/cross-branch WAL reuse. */
  readonly sourceCommitSha: string
  readonly destinationRepoId: string
  load(): Promise<V4ReencryptionJournalSnapshot | null>
  /** Unlike load(), refuses ANY damaged sibling slot. Required immediately
   * before sending an irreversible Git ref creation request. */
  assertHealthySnapshot(expectedGeneration: number): Promise<V4ReencryptionJournalSnapshot>
  /** Only allowed for two wholly absent slots; never clears previous work. */
  begin(): Promise<V4ReencryptionJournalSnapshot>
  /** Persist upload intent BEFORE invoking GitHub; ambiguous results stay pending. */
  recordUploadIntent(receipt: V4ReencryptionObjectReceipt, expectedGeneration: number): Promise<V4ReencryptionJournalSnapshot>
  /** Called only after the exact expected Git Blob SHA receipt is observed. */
  appendReceipt(receipt: V4ReencryptionObjectReceipt, expectedGeneration: number): Promise<V4ReencryptionJournalSnapshot>
  /** Persist a create-only Git ref intent BEFORE its very first POST attempt. */
  recordRefIntent(intent: V4ReencryptionRefIntent, expectedGeneration: number): Promise<V4ReencryptionJournalSnapshot>
  /** One-shot WAL transition AFTER authenticated Backup ref readback, BEFORE staging any new ciphertext. */
  recordStagingHandoff(backup: V4ReencryptionRefIntent, expectedGeneration: number): Promise<V4ReencryptionJournalSnapshot>
  /** One-shot BEFORE metadata blobs/tree/commit. Never auto replay after crash. */
  recordCandidatePreparationIntent(digest: string, expectedGeneration: number): Promise<V4ReencryptionJournalSnapshot>
  /** Only AFTER separate complete Git/crypto readback; never grants publication or local cutover. */
  markRefReadbackObserved(intent: V4ReencryptionRefIntent, expectedGeneration: number): Promise<V4ReencryptionJournalSnapshot>
}

function invalid(): never { throw new V4ReencryptionJournalRecoveryRequiredError() }

function safeRoot(root: string): string {
  const segments = root.split("/")
  if (segments.length < 2 || segments.some(s => !s || s === "." || s === ".."
    || !/^[A-Za-z0-9_.-]+$/u.test(s))) {
    throw new Error("Invalid local Re-encryption WAL directory.")
  }
  return root
}

export function assertV4ReencryptionJournalObjectReceipt(value: unknown): asserts value is V4ReencryptionObjectReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid()
  const r = value as Partial<V4ReencryptionObjectReceipt>
  if (typeof r.path !== "string" || !REMOTE_OPAQUE_PATH.test(r.path)
    || typeof r.sha !== "string" || !GIT_SHA.test(r.sha)
    || !Number.isSafeInteger(r.byteLength) || (r.byteLength ?? 0) <= 0
    || (r.byteLength ?? 0) > V4_GITHUB_REST_SAFE_WRITER_BYTES) invalid()
}

function assertRefIntent(value: unknown, sourceCommitSha: string, destinationRepoId: string): asserts value is V4ReencryptionRefIntent {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid()
  const r = value as Partial<V4ReencryptionRefIntent>
  if ((r.role !== "backup" && r.role !== "destination")
    || typeof r.repoId !== "string" || r.repoId.length >= 200
    || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[A-Za-z0-9_./-]+$/u.test(r.repoId)
    || typeof r.commitSha !== "string" || !GIT_SHA.test(r.commitSha)
    || typeof r.treeSha !== "string" || !GIT_SHA.test(r.treeSha)
    || r.repoId.split("#")[0]!.toLowerCase() !== destinationRepoId.split("#")[0]!.toLowerCase()
    || (r.role === "destination" && (r.repoId !== destinationRepoId || r.commitSha === sourceCommitSha
      || typeof r.manifestSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(r.manifestSha256)))
    || (r.role === "backup" && r.manifestSha256 !== undefined)
    || (r.role === "backup" && (r.repoId === destinationRepoId || r.commitSha !== sourceCommitSha))) {
    invalid()
  }
  const [ownerRepo, branch] = r.repoId.split("#")
  const [owner, repo] = ownerRepo!.split("/")
  try {
    assertSafeGitHubRepositoryCoordinates(owner ?? "", repo ?? "")
    assertSafeGitHubBranch(branch ?? "")
  } catch {
    invalid()
  }
}

function equalRef(a: V4ReencryptionRefIntent, b: V4ReencryptionRefIntent): boolean {
  return a.role === b.role && a.repoId === b.repoId
    && a.commitSha === b.commitSha && a.treeSha === b.treeSha
    && a.manifestSha256 === b.manifestSha256
}

function isSlot(value: unknown): value is Slot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const s = value as Partial<Slot>
  return s.schemaVersion === SCHEMA_VERSION
    && Number.isSafeInteger(s.generation) && (s.generation ?? 0) > 0
    && typeof s.runId === "string" && SAFE_RUN.test(s.runId)
    && typeof s.sourceCommitSha === "string" && GIT_SHA.test(s.sourceCommitSha)
    && typeof s.destinationRepoId === "string" && s.destinationRepoId.length < 200
    && typeof s.ciphertext === "string" && s.ciphertext.length < MAX_JOURNAL_BYTES
    && typeof s.digest === "string" && /^[0-9a-f]{64}$/u.test(s.digest)
}

function slotView(slot: Omit<Slot, "digest">): string {
  return JSON.stringify({
    schemaVersion: slot.schemaVersion, generation: slot.generation,
    runId: slot.runId, sourceCommitSha: slot.sourceCommitSha,
    destinationRepoId: slot.destinationRepoId, ciphertext: slot.ciphertext,
  })
}

function snapshot(
  generation: number,
  receipts: readonly V4ReencryptionObjectReceipt[],
  pendingIntents: readonly V4ReencryptionObjectReceipt[],
  pendingRefIntents: readonly V4ReencryptionRefIntent[],
  verifiedRefObservations: readonly V4ReencryptionRefIntent[],
  stageHandoffStarted: boolean,
  candidatePreparationSha256: string | null,
): V4ReencryptionJournalSnapshot {
  return Object.freeze({
    generation,
    receipts: Object.freeze(receipts.map(r => Object.freeze({ ...r }))),
    pendingIntents: Object.freeze(pendingIntents.map(r => Object.freeze({ ...r }))),
    pendingRefIntents: Object.freeze(pendingRefIntents.map(r => Object.freeze({ ...r }))),
    verifiedRefObservations: Object.freeze(verifiedRefObservations.map(r => Object.freeze({ ...r }))),
    stageHandoffStarted,
    candidatePreparationSha256,
    requiresRemoteRevalidation: true,
    permissionToPublish: false,
    cutoverAuthorized: false,
  })
}

/**
 * Separate two-slot encrypted WAL for unreachable immutable Git blob staging.
 * Neither decrypted receipts nor plaintext file paths ever appear in the slot
 * header. A crash may lose the newest receipt, never grant publication rights.
 *
 * A trusted platform must provide durable, same-vault single-writer adapter
 * semantics. V4LocalIndexAdapter.write alone does not prove disk fsync.
 */
export function createV4ReencryptionRecoveryJournal(input: {
  readonly adapter: V4LocalIndexAdapter
  readonly root: string
  readonly destinationRepoId: string
  readonly sourceCommitSha: string
  readonly runId: string
  readonly journalKey: Uint8Array
}): V4ReencryptionRecoveryJournal {
  const root = safeRoot(input.root)
  if (!GIT_SHA.test(input.sourceCommitSha) || !SAFE_RUN.test(input.runId)
    || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[A-Za-z0-9_./-]+$/u.test(input.destinationRepoId)
    || !(input.journalKey instanceof Uint8Array) || input.journalKey.byteLength !== 32) {
    throw new Error("Invalid Re-encryption recovery journal identity or key.")
  }
  const pathFor = (slot: number) => `${root}/slot-${slot}.json`
  const aadFor = (generation: number) =>
    `v4-rekey-wal:${input.destinationRepoId}:${input.sourceCommitSha}:${input.runId}:${generation}`

  const readSlot = async (i: number): Promise<{ present: boolean; state?: V4ReencryptionJournalSnapshot }> => {
    const file = pathFor(i)
    if (!(await input.adapter.exists(file))) return { present: false }
    try {
      const text = await input.adapter.read(file)
      if (utf8ToBytes(text).length > MAX_JOURNAL_BYTES) return { present: true }
      const decoded: unknown = JSON.parse(text)
      if (!isSlot(decoded)) return { present: true }
      const { digest, ...data } = decoded
      if (await sha256Hex(utf8ToBytes(slotView(data))) !== digest
        || data.destinationRepoId !== input.destinationRepoId
        || data.sourceCommitSha !== input.sourceCommitSha || data.runId !== input.runId
        || data.generation % 2 !== i) return { present: true }
      const decrypted = await decryptV4Payload(input.journalKey, fromBase64(data.ciphertext), {
        kind: "journal", aad: aadFor(data.generation),
      })
      let payload: unknown
      try { payload = JSON.parse(bytesToUtf8(decrypted)) }
      finally { decrypted.fill(0) }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { present: true }
      const v = payload as Partial<Payload>
      if (v.status !== "staging-only" || !Array.isArray(v.receipts)
        || !Array.isArray(v.pendingIntents)) return { present: true }
      const seen = new Set<string>()
      for (const receipt of [...v.receipts, ...v.pendingIntents]) {
        assertV4ReencryptionJournalObjectReceipt(receipt)
        if (seen.has(receipt.path)) return { present: true }
        seen.add(receipt.path)
      }
      const refIntents = v.refIntents ?? []
      const refReceipts = v.refReceipts ?? []
      if (v.stageHandoffStarted !== undefined && typeof v.stageHandoffStarted !== "boolean") return { present: true }
      const stageHandoffStarted = v.stageHandoffStarted === true
      const candidatePreparationSha256 = v.candidatePreparationSha256 ?? null
      if (candidatePreparationSha256 !== null && (typeof candidatePreparationSha256 !== "string"
        || !/^[0-9a-f]{64}$/u.test(candidatePreparationSha256))) return { present: true }
      if (!Array.isArray(refIntents) || !Array.isArray(refReceipts)
        || refIntents.length + refReceipts.length > 2) return { present: true }
      const usedRoles = new Set<string>()
      for (const item of [...refIntents, ...refReceipts]) {
        assertRefIntent(item, input.sourceCommitSha, input.destinationRepoId)
        if (usedRoles.has(item.role)) return { present: true }
        usedRoles.add(item.role)
      }
      if (usedRoles.has("destination")
        && !refReceipts.some(item => item.role === "backup")) return { present: true }
      const backupObserved = refReceipts.some(r => r.role === "backup")
      if (stageHandoffStarted && !backupObserved) return { present: true }
      if (usedRoles.has("destination") && !stageHandoffStarted) return { present: true }
      if (candidatePreparationSha256 && (!stageHandoffStarted || !backupObserved || v.pendingIntents.length)) return { present: true }
      if (usedRoles.has("destination") && !candidatePreparationSha256) return { present: true }
      if (backupObserved && !stageHandoffStarted
        && (v.pendingIntents.length > 0 || v.receipts.length > 0)) return { present: true }
      if (usedRoles.has("destination") && v.pendingIntents.length > 0) return { present: true }
      return { present: true, state: snapshot(data.generation, v.receipts, v.pendingIntents,
        refIntents, refReceipts, stageHandoffStarted, candidatePreparationSha256) }
    } catch {
      return { present: true }
    }
  }

  const observe = async () => {
    const slots = await Promise.all([readSlot(0), readSlot(1)])
    const candidates = slots.flatMap(s => s.state ? [s.state] : [])
    if (!candidates.length) {
      if (slots.some(s => s.present)) invalid()
      return { latest: null as V4ReencryptionJournalSnapshot | null, damaged: false, incomplete: false }
    }
    // Adjacent alternate slots are required. Skipped authenticated generations
    // indicate replay/rollback or filesystem corruption, never normal WAL.
    if (candidates.length === 2
      && Math.abs(candidates[0]!.generation - candidates[1]!.generation) !== 1) invalid()
    const latest = candidates.reduce((a, b) => a.generation > b.generation ? a : b)
    return { latest, damaged: slots.some(s => s.present && !s.state),
      incomplete: latest.generation > 1 && slots.some(s => !s.present) }
  }

  let busy = false
  const locked = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (busy) invalid()
    busy = true
    try { return await operation() } finally { busy = false }
  }

  const save = async (
    generation: number,
    receipts: readonly V4ReencryptionObjectReceipt[],
    pendingIntents: readonly V4ReencryptionObjectReceipt[],
    refIntents: readonly V4ReencryptionRefIntent[],
    refReceipts: readonly V4ReencryptionRefIntent[],
    stageHandoffStarted: boolean,
    candidatePreparationSha256: string | null = null,
  ) => {
    if (!Number.isSafeInteger(generation) || generation < 1) invalid()
    const payload = utf8ToBytes(JSON.stringify({ status: "staging-only", receipts, pendingIntents, refIntents, refReceipts, stageHandoffStarted, candidatePreparationSha256 }))
    if (payload.length > MAX_JOURNAL_BYTES / 2) invalid()
    let ciphertext: string
    try {
      ciphertext = toBase64(await encryptV4Payload(input.journalKey, payload, {
        kind: "journal", aad: aadFor(generation),
      }))
    } finally {
      payload.fill(0)
    }
    const draft: Omit<Slot, "digest"> = {
      schemaVersion: SCHEMA_VERSION, generation, runId: input.runId,
      sourceCommitSha: input.sourceCommitSha, destinationRepoId: input.destinationRepoId, ciphertext,
    }
    const serialized = JSON.stringify({
      ...draft, digest: await sha256Hex(utf8ToBytes(slotView(draft))),
    })
    if (utf8ToBytes(serialized).length > MAX_JOURNAL_BYTES) invalid()
    for (const segmentIndex of root.split("/").keys()) {
      const partial = root.split("/").slice(0, segmentIndex + 1).join("/")
      try { await input.adapter.mkdir(partial) } catch (error) {
        if (!/exist/iu.test((error as Error).message)) throw error
      }
    }
    await input.adapter.write(pathFor(generation % 2), serialized)
    const readback = await readSlot(generation % 2)
    if (!readback.state || readback.state.generation !== generation) invalid()
    return readback.state
  }

  return Object.freeze({
    sourceCommitSha: input.sourceCommitSha,
    destinationRepoId: input.destinationRepoId,
    load: async () => (await observe()).latest,
    assertHealthySnapshot: (expectedGeneration: number) => locked(async () => {
      const observed = await observe()
      if (!observed.latest || observed.damaged || observed.incomplete
        || observed.latest.generation !== expectedGeneration) {
        throw new V4ReencryptionJournalRecoveryRequiredError()
      }
      return observed.latest
    }),
    begin: () => locked(async () => {
      const state = await observe()
      if (state.latest || state.damaged) invalid()
      return save(1, [], [], [], [], false, null)
    }),
    recordUploadIntent: (receipt: V4ReencryptionObjectReceipt, expectedGeneration: number) => locked(async () => {
      assertV4ReencryptionJournalObjectReceipt(receipt)
      const state = await observe()
      if (!state.latest || state.damaged || state.incomplete) invalid()
      if (state.latest.generation !== expectedGeneration) {
        throw new Error("Re-encryption WAL stale generation: source of truth changed.")
      }
      if (state.latest.candidatePreparationSha256 !== null) {
        throw new Error("Re-encryption WAL cannot add staged blobs after candidate preparation began.")
      }
      if (state.latest.pendingRefIntents.length > 0
        || state.latest.verifiedRefObservations.some(r => r.role === "destination")) {
        throw new Error("Re-encryption WAL cannot upload staged blobs during unresolved ref publication.")
      }
      if (state.latest.verifiedRefObservations.some(r => r.role === "backup")
        && !state.latest.stageHandoffStarted) {
        throw new Error("Re-encryption WAL requires a one-shot Staging handoff after verified Backup.")
      }
      if ([...state.latest.receipts, ...state.latest.pendingIntents].some(r => r.path === receipt.path)) {
        throw new Error("Re-encryption WAL duplicate staged object path.")
      }
      if (state.latest.generation >= Number.MAX_SAFE_INTEGER) invalid()
      return save(state.latest.generation + 1, state.latest.receipts,
        [...state.latest.pendingIntents, { ...receipt }],
        state.latest.pendingRefIntents, state.latest.verifiedRefObservations,
        state.latest.stageHandoffStarted)
    }),
    appendReceipt: (receipt: V4ReencryptionObjectReceipt, expectedGeneration: number) => locked(async () => {
      assertV4ReencryptionJournalObjectReceipt(receipt)
      const state = await observe()
      if (!state.latest || state.damaged || state.incomplete) invalid()
      if (state.latest.generation !== expectedGeneration) {
        throw new Error("Re-encryption WAL stale generation: source of truth changed.")
      }
      if (state.latest.verifiedRefObservations.some(r => r.role === "backup")
        && !state.latest.stageHandoffStarted) {
        throw new Error("Re-encryption WAL cannot complete blobs before the one-shot Staging handoff.")
      }
      const matching = state.latest.pendingIntents.find(r => r.path === receipt.path)
      if (!matching || matching.sha !== receipt.sha || matching.byteLength !== receipt.byteLength) {
        throw new Error("Re-encryption WAL receipt does not match a recorded upload intent.")
      }
      if (state.latest.generation >= Number.MAX_SAFE_INTEGER) invalid()
      return save(state.latest.generation + 1, [...state.latest.receipts, { ...receipt }],
        state.latest.pendingIntents.filter(r => r.path !== receipt.path),
        state.latest.pendingRefIntents, state.latest.verifiedRefObservations,
        state.latest.stageHandoffStarted)
    }),
    recordStagingHandoff: (backup: V4ReencryptionRefIntent, expectedGeneration: number) => locked(async () => {
      assertRefIntent(backup, input.sourceCommitSha, input.destinationRepoId)
      const state = await observe()
      if (!state.latest || state.damaged || state.incomplete
        || state.latest.generation !== expectedGeneration
        || backup.role !== "backup"
        || state.latest.stageHandoffStarted
        || state.latest.receipts.length > 0
        || state.latest.pendingIntents.length > 0
        || state.latest.pendingRefIntents.length > 0
        || state.latest.verifiedRefObservations.length !== 1
        || !equalRef(state.latest.verifiedRefObservations[0]!, backup)) {
        throw new Error("Re-encryption WAL staging handoff already started, is stale, or lacks the exact verified Backup.")
      }
      if (state.latest.generation >= Number.MAX_SAFE_INTEGER) invalid()
      return save(state.latest.generation + 1, state.latest.receipts, state.latest.pendingIntents,
        state.latest.pendingRefIntents, state.latest.verifiedRefObservations, true)
    }),
    recordCandidatePreparationIntent: (digest: string, expectedGeneration: number) => locked(async () => {
      if (typeof digest !== "string" || !/^[0-9a-f]{64}$/u.test(digest)) invalid()
      const state = await observe()
      if (!state.latest || state.damaged || state.incomplete) invalid()
      if (state.latest.generation !== expectedGeneration
        || !state.latest.stageHandoffStarted
        || state.latest.candidatePreparationSha256 !== null
        || state.latest.pendingIntents.length !== 0
        || state.latest.pendingRefIntents.length !== 0
        || state.latest.verifiedRefObservations.length !== 1
        || state.latest.verifiedRefObservations[0]?.role !== "backup") {
        throw new Error("Re-encryption WAL cannot repeat or skip the one-shot candidate preparation after verified Staging.")
      }
      if (state.latest.generation >= Number.MAX_SAFE_INTEGER) invalid()
      return save(state.latest.generation + 1, state.latest.receipts, state.latest.pendingIntents,
        state.latest.pendingRefIntents, state.latest.verifiedRefObservations,
        state.latest.stageHandoffStarted, digest)
    }),
    recordRefIntent: (intent: V4ReencryptionRefIntent, expectedGeneration: number) => locked(async () => {
      assertRefIntent(intent, input.sourceCommitSha, input.destinationRepoId)
      const state = await observe()
      if (!state.latest || state.damaged || state.incomplete) invalid()
      if (state.latest.generation !== expectedGeneration) {
        throw new Error("Re-encryption WAL stale ref-intent generation.")
      }
      if ([...state.latest.pendingRefIntents, ...state.latest.verifiedRefObservations]
        .some(previous => previous.role === intent.role)) {
        throw new Error("Re-encryption WAL duplicate Git ref role cannot be created twice.")
      }
      if (intent.role === "destination" && (
        !state.latest.stageHandoffStarted
        || state.latest.candidatePreparationSha256 === null
        || state.latest.pendingIntents.length !== 0
        || !state.latest.verifiedRefObservations.some(r => r.role === "backup"))) {
        throw new Error("Re-encryption WAL destination requires the one-shot Staging handoff, completed staging and verified Backup ref.")
      }
      if (intent.role === "backup" && (state.latest.receipts.length > 0
        || state.latest.pendingIntents.length > 0)) {
        throw new Error("Re-encryption WAL Backup ref must be planned before staging new ciphertext.")
      }
      if (state.latest.generation >= Number.MAX_SAFE_INTEGER) invalid()
      return save(state.latest.generation + 1, state.latest.receipts, state.latest.pendingIntents,
        [...state.latest.pendingRefIntents, { ...intent }], state.latest.verifiedRefObservations,
        state.latest.stageHandoffStarted, state.latest.candidatePreparationSha256)
    }),
    markRefReadbackObserved: (intent: V4ReencryptionRefIntent, expectedGeneration: number) => locked(async () => {
      assertRefIntent(intent, input.sourceCommitSha, input.destinationRepoId)
      const state = await observe()
      if (!state.latest || state.damaged || state.incomplete) invalid()
      if (state.latest.generation !== expectedGeneration) {
        throw new Error("Re-encryption WAL stale ref-readback generation.")
      }
      if (intent.role === "destination" && !state.latest.stageHandoffStarted) {
        throw new Error("Re-encryption WAL destination readback requires the one-shot Staging handoff.")
      }
      const matching = state.latest.pendingRefIntents.find(r => r.role === intent.role)
      if (!matching || !equalRef(matching, intent)) {
        throw new Error("Re-encryption WAL ref readback does not match the exact pending intent.")
      }
      if (state.latest.generation >= Number.MAX_SAFE_INTEGER) invalid()
      return save(state.latest.generation + 1, state.latest.receipts, state.latest.pendingIntents,
        state.latest.pendingRefIntents.filter(r => r.role !== intent.role),
        [...state.latest.verifiedRefObservations, { ...intent }], state.latest.stageHandoffStarted,
        state.latest.candidatePreparationSha256)
    }),
  })
}
