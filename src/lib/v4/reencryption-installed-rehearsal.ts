import { fromBase64Url, sha256Hex, toBase64Url, utf8ToBytes } from "../bytes"
import type { GitHubClient } from "../github-api"
import { throwIfV4Aborted } from "./cancellation"
import { createV4WholeBufferContentSource, type V4ContentSource } from "./content-source"
import { deriveV4Keyring, type V4Keyring } from "./crypto"
import { readImmutableGitFile } from "./immutable-git-read"
import { assertV4Pbkdf2Iterations, V4_MIN_NEW_PBKDF2_ITERATIONS } from "./kdf-policy"
import type { V4LocalIndexAdapter } from "./local-index"
import { stageV4InstalledDestinationSecret, inspectV4InstalledDestinationSecret, restoreV4InstalledMissingDestinationSecret, type V4InstalledSecretOwner, type V4InstalledSecretReport } from "./reencryption-installed-secret"
import { stageV4InstalledReencryptionShadow, verifyV4InstalledReencryptionShadow, type V4InstalledShadowReport } from "./reencryption-installed-shadow"
import { expectedV4PathLayout, V4_CONFIG_PATH, type V4RemoteConfig } from "./protocol-types"
import { inspectV4BestEffortWalRecovery } from "./reencryption-best-effort-wal-recovery"
import type { V4DesktopRekeyWalStorage } from "./reencryption-desktop-wal"
import {
  verifyV4ReencryptionInitiatorLocalParity,
  type V4InitiatorLocalReader,
} from "./reencryption-initiator-parity"
import { planV4OrphanReencryptionDestination } from "./reencryption-orphan-branch"
import { proposeV4SameRepositoryReencryptionBackupBranch } from "./reencryption-owner-decisions"
import { createV4ReencryptionRecoveryJournal } from "./reencryption-recovery-journal"
import {
  createV4BestEffortJournaledFrozenBackup,
  prepareV4BestEffortJournaledOrphanCandidate,
  publishV4BestEffortJournaledThreeBranchDestination,
  stageV4BestEffortJournaledThreeBranchVault,
} from "./reencryption-ref-journal-coordinator"
import { verifyV4ReencryptionBackupRestoreRehearsal } from "./reencryption-restore-rehearsal"
import type { V4ReencryptionColdStartRouteReport } from "./reencryption-runtime-index-route"
import { V4ReencryptionSyncFencedError } from "./reencryption-sync-fence"
import {
  verifyGitHubFrozenReencryptionBackup,
  verifyGitHubReencryptionForkSourceWithTranscodeInventory,
} from "./reencryption-trusted-loader"
import { proposeV4ReencryptionWizardDraft } from "./reencryption-wizard-plan"
import type { V4StagingStore } from "./staging-store"
import { V4StorageCodec } from "./storage-codec"

const COMMIT_SHA = /^[0-9a-f]{40}$/u
const RUN_ID = /^[A-Za-z0-9_-]{8,128}$/u
const RISK_ACKNOWLEDGEMENT = "accept-best-effort-power-loss-recovery-risk" as const

export type V4InstalledRehearsalPhase =
  | "idle"
  | "source-verified"
  | "fenced-and-wal-opened"
  | "backup-created"
  | "staged"
  | "scratch-restored"
  | "candidate-prepared"
  | "destination-published-no-cutover"

export interface V4InstalledRehearsalWalStorage
  extends Pick<V4DesktopRekeyWalStorage, "assertExclusiveStageLease" | "assertBestEffortCheckpoint" | "release"> {
  readonly journalRoot: string
  readonly adapter: V4LocalIndexAdapter
}

export interface V4InstalledRehearsalReadOnlyWal
  extends Pick<V4DesktopRekeyWalStorage, "assertExclusiveStageLease" | "assertBestEffortCheckpoint" | "release"> {
  readonly journalRoot: string
  readonly adapter: Pick<V4LocalIndexAdapter, "read" | "exists">
}

export interface V4InstalledPreCutoverRehearsalOwner {
  readonly armFenceAndOpenWal: (input: {
    readonly runId: string
    readonly destinationRepoId: string
    readonly assertExclusiveInitiatorLease: () => Promise<void>
  }) => Promise<{
    readonly wal: V4InstalledRehearsalWalStorage
    readonly initiatorReader: V4InitiatorLocalReader
    readonly scratch: V4StagingStore
    readonly assertScratchIsIsolated: () => Promise<void>
    readonly cleanupScratch?: () => Promise<void>
  }>
  readonly assertOwnerStillValid: () => void
}

export interface V4InstalledPreCutoverRehearsalInput {
  readonly runId: string
  readonly owner: string
  readonly repo: string
  readonly sourceBranch: string
  readonly backupBranch: string
  readonly destinationBranch: string
  readonly oldPassphrase: string
  readonly newPassphrase: string
  readonly requestedIterations: number
  readonly deviceId: string
  readonly acknowledgement: typeof RISK_ACKNOWLEDGEMENT
  readonly assertExclusiveInitiatorLease: () => Promise<void>
  readonly createGitHubClient: (branch: string) => GitHubClient
  readonly runtimeOwner: V4InstalledPreCutoverRehearsalOwner
  readonly shadowAdapter?: V4LocalIndexAdapter | undefined
  readonly secretOwner?: V4InstalledSecretOwner | undefined
  readonly newSalt?: Uint8Array | undefined
  readonly createdAt?: number | undefined
  readonly signal?: AbortSignal | undefined
  readonly onPhase?: ((phase: V4InstalledRehearsalPhase) => void | Promise<void>) | undefined
}

export interface V4InstalledPreCutoverRehearsalReport {
  readonly integrityScope: "installed-owner-pre-cutover-source-backup-destination-rehearsal"
  readonly status: "destination-published-fenced-no-cutover"
  readonly finalPhase: "destination-published-no-cutover"
  readonly runId: string
  readonly sourceRepoId: string
  readonly backupRepoId: string
  readonly destinationRepoId: string
  readonly pinnedSourceCommitSha: string
  readonly sourceTreeSha: string
  readonly destinationCommitSha: string
  readonly destinationTreeSha: string
  readonly finalWalGeneration: number
  readonly verifiedFileCount: number
  readonly verifiedPlaintextBytes: string
  readonly shadow?: V4InstalledShadowReport | undefined
  readonly stagedSecret?: V4InstalledSecretReport | undefined
  readonly stagedBlobCount: number
  readonly scratchRestoredFileCount: number
  readonly cutoverAuthorized: false
  readonly localCutoverExecuted: false
  readonly resumeSyncAuthorized: false
  readonly oldPassphraseCleanupAuthorized: false
  readonly powerLossDurabilityProven: false
}

export interface V4InstalledPreCutoverRecoveryInput {
  readonly runId: string
  readonly owner: string
  readonly repo: string
  readonly sourceBranch: string
  readonly backupBranch: string
  readonly destinationBranch: string
  readonly pinnedSourceCommitSha: string
  readonly sourceTreeSha: string
  readonly destinationCommitSha: string
  readonly destinationTreeSha: string
  readonly expectedFinalWalGeneration: number
  readonly expectedFileCount: number
  readonly expectedPlaintextBytes: string
  readonly oldPassphrase: string
  readonly newPassphrase?: string | undefined
  readonly secretOwner?: V4InstalledSecretOwner | undefined
  readonly restoreMissingSecret?: true | undefined
  readonly expectedPhysicalRepositoryId: number
  readonly defaultBranch: string
  readonly assertPersistedFenceActive: () => Promise<void>
  readonly inspectRoute: () => Promise<V4ReencryptionColdStartRouteReport>
  readonly shadow?: { readonly adapter: V4LocalIndexAdapter; readonly deviceId: string } | undefined
  readonly inspectFenceAndNoPartialCutover?: (() => Promise<boolean>) | undefined
  /** Optional activation-readiness scan, never used for missing-key repair. */
  readonly createInitiatorReader?: ((assertLease: () => Promise<void>) => V4InitiatorLocalReader) | undefined
  readonly openReadOnlyWal: () => Promise<V4InstalledRehearsalReadOnlyWal>
  readonly createGitHubClient: (branch: string) => GitHubClient
  readonly assertOwnerStillValid?: (() => void) | undefined
  readonly signal?: AbortSignal | undefined
}

export interface V4InstalledPreCutoverRecoveryReport {
  readonly integrityScope: "read-only-installed-pre-cutover-wal-backup-and-destination" | "installed-pre-cutover-staged-secret-recovery"
  readonly observation: "authenticated-pre-cutover-destination-still-fenced" | "manual-recovery-required"
  readonly walAuthenticated: boolean
  readonly backupReverified: boolean
  readonly destinationReverified: boolean
  readonly shadowReverified?: true | undefined
  readonly stagedSecretReverified?: true | undefined
  readonly stagedSecretMissing?: true | undefined
  readonly stagedSecretRestored?: true | undefined
  readonly physicalParityReverified?: true | undefined
  readonly sourceRefReverified?: true | undefined
  readonly failureStage?: "fence" | "backup" | "wal" | "destination" | "secret" | "shadow" | "physical-parity" | "source-ref" | "final-readback" | undefined
  readonly verifiedFileCount: number
  readonly verifiedPlaintextBytes: string
  readonly cutoverAuthorized: false
  readonly localCutoverAuthorized: false
  readonly resumeSyncAuthorized: false
  readonly oldPassphraseCleanupAuthorized: false
  readonly powerLossDurabilityProven: false
}

function wipeKeyring(keyring: V4Keyring | undefined): void {
  if (!keyring) return
  for (const part of [
    keyring.masterKey,
    keyring.pathKey,
    keyring.contentKey,
    keyring.indexKey,
    keyring.journalKey,
  ]) {
    part.fill(0)
  }
}

function createReadOnlyIndexAdapter(
  adapter: Pick<V4LocalIndexAdapter, "read" | "exists">,
): V4LocalIndexAdapter {
  return {
    read: path => adapter.read(path),
    exists: path => adapter.exists(path),
    async write() {
      throw new Error("Read-only recovery adapter forbids writes.")
    },
    async mkdir() {
      throw new Error("Read-only recovery adapter forbids mkdir.")
    },
  }
}

function manualRecoveryReport(failureStage?: V4InstalledPreCutoverRecoveryReport["failureStage"], restore = false, missing = false): V4InstalledPreCutoverRecoveryReport {
  return Object.freeze({
    integrityScope: restore ? "installed-pre-cutover-staged-secret-recovery" : "read-only-installed-pre-cutover-wal-backup-and-destination",
    observation: "manual-recovery-required",
    ...(missing ? { stagedSecretMissing: true as const } : {}),
    ...(failureStage ? { failureStage } : {}),
    walAuthenticated: false,
    backupReverified: false,
    destinationReverified: false,
    verifiedFileCount: 0,
    verifiedPlaintextBytes: "0",
    cutoverAuthorized: false,
    localCutoverAuthorized: false,
    resumeSyncAuthorized: false,
    oldPassphraseCleanupAuthorized: false,
    powerLossDurabilityProven: false,
  })
}

async function assertBranchesAbsentTwice(
  backupClient: GitHubClient,
  destinationClient: GitHubClient,
): Promise<void> {
  for (let pass = 0; pass < 2; pass++) {
    const [backupRef, destinationRef] = await Promise.all([
      backupClient.getGitRefOrNull(),
      destinationClient.getGitRefOrNull(),
    ])
    if (backupRef !== null || destinationRef !== null) {
      throw new Error("A proposed backup or destination branch already exists.")
    }
  }
}

/**
 * Orchestrates one fenced, installed-owner pre-cutover Re-encryption rehearsal
 * (Source verification -> Sync fence & WAL -> frozen Backup -> new-key staging
 * -> isolated scratch restore -> orphan candidate -> physical parity & orphan
 * Destination publication) without executing Settings, Index, or SecretStorage Cutover.
 */
export async function runV4InstalledPreCutoverRehearsal(
  input: V4InstalledPreCutoverRehearsalInput,
): Promise<V4InstalledPreCutoverRehearsalReport> {
  throwIfV4Aborted(input.signal)
  if (!input || input.acknowledgement !== RISK_ACKNOWLEDGEMENT
    || typeof input.runId !== "string" || !RUN_ID.test(input.runId)
    || typeof input.deviceId !== "string" || !input.deviceId
    || typeof input.assertExclusiveInitiatorLease !== "function"
    || typeof input.createGitHubClient !== "function"
    || typeof input.runtimeOwner?.armFenceAndOpenWal !== "function"
    || typeof input.runtimeOwner?.assertOwnerStillValid !== "function") {
    throw new Error("Installed pre-cutover rehearsal requires explicit risk acknowledgement, valid run ID, and live owner.")
  }
  assertV4Pbkdf2Iterations(input.requestedIterations, V4_MIN_NEW_PBKDF2_ITERATIONS)

  const newSalt = input.newSalt
    ? Uint8Array.from(input.newSalt)
    : crypto.getRandomValues(new Uint8Array(16))
  if (newSalt.byteLength !== 16) {
    throw new Error("Installed pre-cutover rehearsal requires a 16-byte destination salt.")
  }

  let oldKeyring: V4Keyring | undefined
  let newKeyring: V4Keyring | undefined
  let oldSalt: Uint8Array | undefined
  let wal: V4InstalledRehearsalWalStorage | undefined
  let cleanupScratch: (() => Promise<void>) | undefined
  let succeeded = false

  const sourceClient = input.createGitHubClient(input.sourceBranch)
  const backupClient = input.createGitHubClient(input.backupBranch)
  const destinationClient = input.createGitHubClient(input.destinationBranch)
  const backupReadbackClient = input.createGitHubClient(input.backupBranch)
  const destinationReadbackClient = input.createGitHubClient(input.destinationBranch)
  const expectedFullName = `${input.owner}/${input.repo}`.toLowerCase()

  let phase: V4InstalledRehearsalPhase = "idle"
  const advance = async (expectedFrom: V4InstalledRehearsalPhase, to: V4InstalledRehearsalPhase) => {
    if (phase !== expectedFrom) {
      throw new Error(`Invalid pre-cutover rehearsal phase transition: ${phase} -> ${to}`)
    }
    phase = to
    await input.onPhase?.(phase)
  }

  try {
    input.runtimeOwner.assertOwnerStillValid()
    await input.assertExclusiveInitiatorLease()
    input.runtimeOwner.assertOwnerStillValid()

    // Preflight Source & destination/backup branch absence BEFORE arming Sync fence.
    const [sourceIdentity, backupIdentity, destinationIdentity, defaultBranch] = await Promise.all([
      sourceClient.getRepositoryIdentity(),
      backupClient.getRepositoryIdentity(),
      destinationClient.getRepositoryIdentity(),
      sourceClient.getRepositoryDefaultBranch(),
    ])
    throwIfV4Aborted(input.signal)
    if (sourceIdentity.id !== backupIdentity.id || sourceIdentity.id !== destinationIdentity.id
      || sourceIdentity.fullName.toLowerCase() !== expectedFullName
      || backupIdentity.fullName.toLowerCase() !== expectedFullName
      || destinationIdentity.fullName.toLowerCase() !== expectedFullName) {
      throw new Error("Repository identity mismatch across Source, Backup, and Destination clients.")
    }
    await assertBranchesAbsentTwice(backupClient, destinationClient)

    const sourceInventory = await verifyGitHubReencryptionForkSourceWithTranscodeInventory({
      github: sourceClient,
      expectedRepoId: `${input.owner}/${input.repo}#${input.sourceBranch}`,
      expectedBranch: input.sourceBranch,
      passphrase: input.oldPassphrase,
      signal: input.signal,
    })
    const pinnedSourceCommitSha = sourceInventory.pinnedSourceCommitSha
    const pinnedCommit = await sourceClient.getGitCommit(pinnedSourceCommitSha)
    if (!COMMIT_SHA.test(pinnedCommit.treeSha)) {
      throw new Error("Pinned source commit tree SHA is invalid.")
    }

    // Validate the full three-branch draft before crossing any mutating boundary.
    const wizardProposal = proposeV4ReencryptionWizardDraft({
      owner: input.owner,
      repo: input.repo,
      sourceBranch: input.sourceBranch,
      destinationBranch: input.destinationBranch,
      backupBranch: input.backupBranch,
      defaultBranch,
      sourceCommitSha: pinnedSourceCommitSha,
      sourcePhysicalRepositoryId: sourceIdentity.id,
      requestedIterations: input.requestedIterations,
      oldPassphrase: input.oldPassphrase,
      newPassphrase: input.newPassphrase,
      confirmation: input.newPassphrase,
    })
    const backupPlan = proposeV4SameRepositoryReencryptionBackupBranch({
      sourceRepoId: wizardProposal.sourceRepoId,
      backupRepoId: wizardProposal.backupRepoId,
      destinationRepoId: wizardProposal.destinationRepoId,
      pinnedSourceCommitSha,
      sourcePhysicalRepositoryId: sourceIdentity.id,
      backupPhysicalRepositoryId: sourceIdentity.id,
      destinationPhysicalRepositoryId: sourceIdentity.id,
      expectedPhysicalRepositoryId: sourceIdentity.id,
      defaultBranch,
    })
    const orphanPlan = planV4OrphanReencryptionDestination({
      sourceRepoId: wizardProposal.sourceRepoId,
      destinationRepoId: wizardProposal.destinationRepoId,
      sourceCommitSha: pinnedSourceCommitSha,
      sourcePhysicalRepositoryId: sourceIdentity.id,
      destinationPhysicalRepositoryId: sourceIdentity.id,
      expectedPhysicalRepositoryId: sourceIdentity.id,
      defaultBranch,
    })

    // Re-check branch absence immediately before arming the one-way Sync fence.
    await assertBranchesAbsentTwice(backupClient, destinationClient)
    input.runtimeOwner.assertOwnerStillValid()
    await input.assertExclusiveInitiatorLease()
    await advance("idle", "source-verified")

    const combinedLease = async () => {
      throwIfV4Aborted(input.signal)
      input.runtimeOwner.assertOwnerStillValid()
      await input.assertExclusiveInitiatorLease()
    }

    const armed = await input.runtimeOwner.armFenceAndOpenWal({
      runId: input.runId,
      destinationRepoId: wizardProposal.destinationRepoId,
      assertExclusiveInitiatorLease: combinedLease,
    })
    wal = armed.wal
    cleanupScratch = armed.cleanupScratch
    await combinedLease()
    await wal.assertExclusiveStageLease()

    const sourceKdf = sourceInventory.sourceConfig.kdfParams
    if (!sourceKdf) {
      throw new Error("Encrypted Source configuration is missing KDF parameters.")
    }
    oldSalt = fromBase64Url(sourceKdf.salt)
    oldKeyring = await deriveV4Keyring({
      passphrase: input.oldPassphrase,
      repoId: wizardProposal.sourceRepoId,
      salt: oldSalt,
      iterations: sourceKdf.iterations,
    })
    const destinationConfig: V4RemoteConfig = {
      ...sourceInventory.sourceConfig,
      repoId: wizardProposal.destinationRepoId,
      kdfParams: { iterations: input.requestedIterations, salt: toBase64Url(newSalt) },
    }
    newKeyring = await deriveV4Keyring({
      passphrase: input.newPassphrase,
      repoId: wizardProposal.destinationRepoId,
      salt: newSalt,
      iterations: input.requestedIterations,
    })

    const journal = createV4ReencryptionRecoveryJournal({
      adapter: wal.adapter,
      root: wal.journalRoot,
      runId: input.runId,
      sourceCommitSha: pinnedSourceCommitSha,
      destinationRepoId: wizardProposal.destinationRepoId,
      journalKey: oldKeyring.journalKey,
    })
    await journal.begin()
    await advance("source-verified", "fenced-and-wal-opened")

    // Step 1: Create and verify frozen old-key Backup.
    const createdBackup = await createV4BestEffortJournaledFrozenBackup({
      plan: backupPlan,
      journal,
      wal,
      verifiedSource: sourceInventory.verifiedSource,
      source: sourceClient,
      backup: backupClient,
      expectedSourceTreeSha: pinnedCommit.treeSha,
      originalPassphrase: input.oldPassphrase,
      acknowledgement: input.acknowledgement,
      signal: input.signal,
    })
    const verifiedBackup = await verifyGitHubFrozenReencryptionBackup({
      github: backupReadbackClient,
      plan: backupPlan,
      expectedSourceTreeSha: pinnedCommit.treeSha,
      passphrase: input.oldPassphrase,
      signal: input.signal,
    })
    if (!verifiedBackup.backupContentsReadbackVerified) {
      throw new Error("Frozen Backup independent readback failed.")
    }
    const postBackupWal = await journal.load()
    if (!postBackupWal) {
      throw new Error("Encrypted WAL snapshot missing after Backup readback.")
    }
    await advance("fenced-and-wal-opened", "backup-created")

    // Step 2: Re-encrypt and stage all live Source objects with fresh Destination keys.
    const checkPinnedFrozenBackup = async () => {
      throwIfV4Aborted(input.signal)
      await combinedLease()
      const ref = await backupReadbackClient.getGitRefOrNull()
      if (!ref || ref.sha !== pinnedSourceCommitSha) {
        throw new Error("Frozen Backup ref moved or disappeared during staging.")
      }
    }
    const staged = await stageV4BestEffortJournaledThreeBranchVault({
      plan: orphanPlan,
      journal,
      wal,
      acknowledgement: input.acknowledgement,
      beginAfterVerifiedBackup: {
        expectedJournalGeneration: postBackupWal.generation,
        backupRef: {
          role: "backup",
          repoId: backupPlan.backupRepoId,
          commitSha: pinnedSourceCommitSha,
          treeSha: pinnedCommit.treeSha,
        },
      },
      sourceConfig: sourceInventory.sourceConfig,
      sourceHead: sourceInventory.sourceHead,
      sourceShards: sourceInventory.sourceShards,
      sourceKeyring: oldKeyring,
      destinationConfig,
      destinationKeyring: newKeyring,
      signal: input.signal,
      verifySourceStillPinned: checkPinnedFrozenBackup,
      async readSourceObject(objectPath, sha) {
        if (sha !== pinnedSourceCommitSha) {
          throw new Error("Source object read requested unexpected commit SHA.")
        }
        const found = await readImmutableGitFile(objectPath, sha, {
          getCommit: commit => sourceClient.getGitCommit(commit),
          getTree: tree => sourceClient.getTreeAt(tree, false),
          getBlob: blob => sourceClient.getBlob(blob),
        })
        return found?.bytes ?? null
      },
      async stageImmutableObject(_objectPath, ciphertext) {
        return destinationClient.createGitBlob(ciphertext)
      },
    })
    await advance("backup-created", "staged")

    // Step 3: Isolated scratch restore round-trip from frozen Backup.
    const liveRecords = Object.values(sourceInventory.sourceShards)
      .flatMap(shard => Object.values(shard.records).filter(record => !record.deleted))
    const recordsByPath = new Map(liveRecords.map(record => [record.path, record] as const))
    const oldCodec = new V4StorageCodec({
      mode: "encrypted",
      pathLayout: expectedV4PathLayout("encrypted"),
      keyring: oldKeyring,
    })
    const snapshotId = await sha256Hex(utf8ToBytes(
      `d412-installed-backup:${wizardProposal.backupRepoId}:${pinnedSourceCommitSha}`,
    ))
    const scratchRestore = await verifyV4ReencryptionBackupRestoreRehearsal({
      config: sourceInventory.sourceConfig,
      head: sourceInventory.sourceHead,
      shards: sourceInventory.sourceShards,
      keyring: oldKeyring,
      pinnedSourceCommitSha,
      sourceRefPolicy: "pinned-immutable-commit",
      readCurrentSourceHeadSha: async () => pinnedSourceCommitSha,
      scratch: armed.scratch,
      assertScratchIsIsolated: armed.assertScratchIsIsolated,
      signal: input.signal,
      backup: {
        snapshotId,
        sourceCommitSha: pinnedSourceCommitSha,
        async readCurrentSnapshotId() {
          const ref = await backupReadbackClient.getGitRefOrNull()
          return ref?.sha === pinnedSourceCommitSha ? snapshotId : null
        },
        async listFiles() {
          return liveRecords.map(record => ({
            path: record.path,
            size: record.size,
            plaintextSha256: record.plaintextSha256,
            mtime: record.mtime,
          }))
        },
        async openFile(logicalPath, size): Promise<V4ContentSource> {
          const ref = await backupReadbackClient.getGitRef()
          if (ref.sha !== pinnedSourceCommitSha) {
            throw new Error("Backup snapshot SHA drifted during scratch restore.")
          }
          const record = recordsByPath.get(logicalPath)
          if (!record || record.size !== size) {
            throw new Error("Backup scratch restore requested unexpected file metadata.")
          }
          const content = await oldCodec.read(record, async opaque => {
            const loaded = await readImmutableGitFile(opaque, pinnedSourceCommitSha, {
              getCommit: sha => backupReadbackClient.getGitCommit(sha),
              getTree: sha => backupReadbackClient.getTreeAt(sha, false),
              getBlob: sha => backupReadbackClient.getBlob(sha),
            })
            if (!loaded) throw new Error("Backup object missing during scratch restore.")
            return loaded.bytes
          })
          return createV4WholeBufferContentSource(content)
        },
      },
    })
    await advance("staged", "scratch-restored")

    // Step 4: Prepare zero-parent orphan commit & record sealed candidate receipt in WAL.
    const prepared = await prepareV4BestEffortJournaledOrphanCandidate({
      plan: orphanPlan,
      journal,
      wal,
      acknowledgement: input.acknowledgement,
      github: destinationClient,
      verifiedBackup,
      sourceConfig: sourceInventory.sourceConfig,
      destinationConfig,
      destinationKeyring: newKeyring,
      sourceTreeSha: pinnedCommit.treeSha,
      staged,
      deviceId: input.deviceId,
      journalId: `d412-${input.runId}`,
      createdAt: input.createdAt ?? Date.now(),
      signal: input.signal,
    })
    await advance("scratch-restored", "candidate-prepared")

    // Step 5: Verify initiating physical Vault parity & publish Destination ref WITHOUT Cutover.
    const initiatorLocalParity = {
      pinnedSourceCommitSha,
      verifiedSource: sourceInventory.verifiedSource,
      sourceRecords: sourceInventory.sourceRecords.filter(record => !record.deleted),
      reader: armed.initiatorReader,
      signal: input.signal,
    }
    const parityBefore = await verifyV4ReencryptionInitiatorLocalParity(initiatorLocalParity)
    if (parityBefore.checkedFileCount !== staged.records.length) {
      throw new Error("Initiating physical parity count differs from staged Destination inventory.")
    }

    const published = await publishV4BestEffortJournaledThreeBranchDestination({
      plan: orphanPlan,
      backupPlan,
      journal,
      wal,
      acknowledgement: input.acknowledgement,
      github: destinationClient,
      backupRefReader: backupReadbackClient,
      createdAndVerifiedBackup: createdBackup,
      scratchRestore,
      initiatorLocalParity,
      prepared,
      sourceTreeSha: pinnedCommit.treeSha,
      sourceConfig: sourceInventory.sourceConfig,
      expectedDestinationConfig: destinationConfig,
      expectedRecords: staged.records,
      expectedReceipts: staged.receipts,
      destinationPassphrase: input.newPassphrase,
      signal: input.signal,
      assertInitiatingVaultUnchanged: async () => {
        await combinedLease()
        const parityAfter = await verifyV4ReencryptionInitiatorLocalParity(initiatorLocalParity)
        if (parityAfter.checkedFileCount !== staged.records.length
          || parityAfter.checkedPlaintextBytes !== staged.preview.totalPlaintextBytes) {
          throw new Error("Initiating vault parity drifted during Destination publication.")
        }
      },
    })

    // Confirm independent read-only Destination verification & final WAL generation.
    const destInventory = await verifyGitHubReencryptionForkSourceWithTranscodeInventory({
      github: destinationReadbackClient,
      expectedRepoId: wizardProposal.destinationRepoId,
      expectedBranch: input.destinationBranch,
      passphrase: input.newPassphrase,
      signal: input.signal,
    })
    const verifiedDestination = destInventory.verifiedSource
    const destReadbackIdentity = await destinationReadbackClient.getRepositoryIdentity()
    if (destReadbackIdentity.id !== sourceIdentity.id
      || verifiedDestination.pinnedSourceCommitSha !== published.destinationCommitSha
      || verifiedDestination.verifiedFileCount !== published.verifiedFileCount
      || verifiedDestination.totalVerifiedPlaintextBytes !== published.verifiedPlaintextBytes) {
      throw new Error("Independent Destination readback disagreed with published counts.")
    }

    const finalWal = await journal.load()
    if (!finalWal || finalWal.pendingRefIntents.length !== 0 || finalWal.pendingIntents.length !== 0
      || finalWal.cutoverAuthorized !== false || finalWal.permissionToPublish !== false
      || finalWal.verifiedRefObservations.length !== 2) {
      throw new Error("Final WAL state is incomplete after pre-cutover Destination publication.")
    }

    await combinedLease()
    const shadow = input.shadowAdapter ? await stageV4InstalledReencryptionShadow({
      adapter: input.shadowAdapter, runId: input.runId, deviceId: input.deviceId,
      source: sourceInventory, destination: destInventory,
      assertLeaseAndOwner: async () => {
        await combinedLease()
        await wal!.assertExclusiveStageLease()
        const [sourceRef, backupRef, destinationRef] = await Promise.all([
          sourceClient.getGitRef(), backupReadbackClient.getGitRef(), destinationReadbackClient.getGitRef(),
        ])
        if (sourceRef.sha !== pinnedSourceCommitSha || backupRef.sha !== pinnedSourceCommitSha
          || destinationRef.sha !== published.destinationCommitSha) throw Error("Re-encryption refs changed during Shadow staging.")
        await combinedLease()
      },
      assertPhysicalParity: async () => { await verifyV4ReencryptionInitiatorLocalParity(initiatorLocalParity) },
      checkpoint: async () => {
        await wal!.assertBestEffortCheckpoint()
        await journal.assertHealthySnapshot(finalWal.generation)
      },
    }) : undefined
    const stagedSecret = input.secretOwner && shadow && input.shadowAdapter ? await stageV4InstalledDestinationSecret({
      adapter: input.shadowAdapter, owner: input.secretOwner, key: oldKeyring.journalKey,
      identity: {
        runId: input.runId, deviceId: input.deviceId, sourceRepoId: wizardProposal.sourceRepoId,
        backupRepoId: wizardProposal.backupRepoId, destinationRepoId: wizardProposal.destinationRepoId,
        pinnedSourceCommitSha, sourceTreeSha: pinnedCommit.treeSha,
        destinationCommitSha: published.destinationCommitSha, destinationTreeSha: prepared.treeSha,
        finalWalGeneration: finalWal.generation, verifiedFileCount: published.verifiedFileCount,
        verifiedPlaintextBytes: published.verifiedPlaintextBytes, physicalRepositoryId: sourceIdentity.id, defaultBranch,
      },
      newPassphrase: input.newPassphrase,
      assertLease: async () => {
        await combinedLease()
        await wal!.assertExclusiveStageLease()
        const [sourceRef, backupRef, destinationRef] = await Promise.all([
          sourceClient.getGitRef(), backupReadbackClient.getGitRef(), destinationReadbackClient.getGitRef(),
        ])
        if (sourceRef.sha !== pinnedSourceCommitSha || backupRef.sha !== pinnedSourceCommitSha
          || destinationRef.sha !== published.destinationCommitSha) throw Error("Re-encryption refs changed during secret staging.")
        await combinedLease()
      },
      checkpoint: async () => {
        await wal!.assertBestEffortCheckpoint()
        await journal.assertHealthySnapshot(finalWal.generation)
      },
    }) : undefined
    await advance("candidate-prepared", "destination-published-no-cutover")
    succeeded = true
    return Object.freeze({
      integrityScope: "installed-owner-pre-cutover-source-backup-destination-rehearsal",
      status: "destination-published-fenced-no-cutover",
      finalPhase: "destination-published-no-cutover",
      runId: input.runId,
      sourceRepoId: wizardProposal.sourceRepoId,
      backupRepoId: wizardProposal.backupRepoId,
      destinationRepoId: wizardProposal.destinationRepoId,
      pinnedSourceCommitSha,
      sourceTreeSha: pinnedCommit.treeSha,
      destinationCommitSha: published.destinationCommitSha,
      destinationTreeSha: prepared.treeSha,
      finalWalGeneration: finalWal.generation,
      verifiedFileCount: published.verifiedFileCount,
      verifiedPlaintextBytes: published.verifiedPlaintextBytes,
      ...(shadow ? { shadow } : {}),
      ...(stagedSecret ? { stagedSecret } : {}),
      stagedBlobCount: staged.receipts.length,
      scratchRestoredFileCount: scratchRestore.roundTripFileCount,
      cutoverAuthorized: false,
      localCutoverExecuted: false,
      resumeSyncAuthorized: false,
      oldPassphraseCleanupAuthorized: false,
      powerLossDurabilityProven: false,
    })
  } finally {
    newSalt.fill(0)
    oldSalt?.fill(0)
    wipeKeyring(oldKeyring)
    wipeKeyring(newKeyring)
    if (succeeded) {
      let cleanupError: unknown
      try {
        await cleanupScratch?.()
      } catch (err) {
        cleanupError = err
      }
      await wal?.release()
      if (cleanupError !== undefined) throw cleanupError
    } else {
      await cleanupScratch?.().catch(() => {})
      await wal?.release().catch(() => {})
    }
  }
}

/**
 * Read-only post-restart verification of an interrupted or completed pre-cutover
 * rehearsal (before Cutover intent / runtime index route). Confirms persisted
 * Sync fence, absence of Cutover route, authenticated WAL receipts, Backup,
 * and full orphan Destination content without modifying remote or local state.
 */
export async function inspectV4InstalledPreCutoverRecoveryAfterRestart(
  input: V4InstalledPreCutoverRecoveryInput,
): Promise<V4InstalledPreCutoverRecoveryReport> {
  if (!input
    || !RUN_ID.test(input.runId)
    || !COMMIT_SHA.test(input.pinnedSourceCommitSha)
    || !COMMIT_SHA.test(input.sourceTreeSha)
    || !COMMIT_SHA.test(input.destinationCommitSha)
    || !COMMIT_SHA.test(input.destinationTreeSha)
    || !input.oldPassphrase || (!input.secretOwner && !input.newPassphrase) || input.oldPassphrase === input.newPassphrase
    || (input.restoreMissingSecret && (!input.secretOwner || !input.shadow || !input.newPassphrase || input.createInitiatorReader))
    || (input.createInitiatorReader && (!input.secretOwner || !input.shadow || !input.inspectFenceAndNoPartialCutover))
    || !Number.isSafeInteger(input.expectedFinalWalGeneration) || input.expectedFinalWalGeneration < 1) {
    return manualRecoveryReport()
  }

  let oldKeyring: V4Keyring | undefined
  let oldSalt: Uint8Array | undefined
  let wal: V4InstalledRehearsalReadOnlyWal | undefined
  let walAuthenticated = false
  let backupReverified = false
  let destinationReverified = false
  let failureStage: V4InstalledPreCutoverRecoveryReport["failureStage"] = "fence"
  const restore = input.restoreMissingSecret === true
  let missing = false
  const fail = () => manualRecoveryReport(failureStage, restore, missing)

  try {
    throwIfV4Aborted(input.signal)
    input.assertOwnerStillValid?.()

    // 1. Confirm persisted Sync fence is active and NO Cutover route or partial Cutover artifacts exist.
    let settingsDenied = false
    try {
      await input.assertPersistedFenceActive()
    } catch (error) {
      settingsDenied = error instanceof V4ReencryptionSyncFencedError
    }
    if (!settingsDenied) return fail()

    const route = await input.inspectRoute()
    if (route.observation !== "fenced-before-routing-intent" || route.localCutoverAuthorized !== false) {
      return fail()
    }
    if (input.inspectFenceAndNoPartialCutover && !(await input.inspectFenceAndNoPartialCutover())) {
      return fail()
    }

    // Hold the read-only WAL lease while authenticating the immutable Backup.
    wal = await input.openReadOnlyWal()
    await wal.assertExclusiveStageLease()
    const sourceRepoId = `${input.owner}/${input.repo}#${input.sourceBranch}`
    const backupRepoId = `${input.owner}/${input.repo}#${input.backupBranch}`
    const destinationRepoId = `${input.owner}/${input.repo}#${input.destinationBranch}`

    // Recovery can use the immutable Backup after an old client advances Source.
    // Activation readiness cannot silently discard that divergence.
    const sourceClient = input.createInitiatorReader ? input.createGitHubClient(input.sourceBranch) : undefined
    const assertSourceStillPinned = async () => {
      if (!sourceClient) return
      await wal!.assertExclusiveStageLease()
      input.assertOwnerStillValid?.()
      const [identity, defaultBranch, ref] = await Promise.all([
        sourceClient.getRepositoryIdentity(), sourceClient.getRepositoryDefaultBranch(), sourceClient.getGitRef(),
      ])
      if (sourceClient.branchName !== input.sourceBranch || identity.id !== input.expectedPhysicalRepositoryId
        || identity.fullName.toLowerCase() !== (input.owner + "/" + input.repo).toLowerCase()
        || defaultBranch !== input.defaultBranch || ref.ref !== "refs/heads/" + input.sourceBranch
        || ref.sha !== input.pinnedSourceCommitSha) throw Error("Source advanced or changed before activation.")
      await wal!.assertExclusiveStageLease()
      input.assertOwnerStillValid?.()
    }
    failureStage = "source-ref"
    await assertSourceStillPinned()
    failureStage = "backup"
    const backupPlan = proposeV4SameRepositoryReencryptionBackupBranch({
      sourceRepoId,
      backupRepoId,
      destinationRepoId,
      pinnedSourceCommitSha: input.pinnedSourceCommitSha,
      sourcePhysicalRepositoryId: input.expectedPhysicalRepositoryId,
      backupPhysicalRepositoryId: input.expectedPhysicalRepositoryId,
      destinationPhysicalRepositoryId: input.expectedPhysicalRepositoryId,
      expectedPhysicalRepositoryId: input.expectedPhysicalRepositoryId,
      defaultBranch: input.defaultBranch,
    })
    const backupClient = input.createGitHubClient(input.backupBranch)
    const verifiedBackup = await verifyGitHubFrozenReencryptionBackup({
      github: backupClient,
      plan: backupPlan,
      expectedSourceTreeSha: input.sourceTreeSha,
      passphrase: input.oldPassphrase,
      signal: input.signal,
    })
    if (!verifiedBackup.backupContentsReadbackVerified
      || verifiedBackup.verifiedFileCount !== input.expectedFileCount
      || verifiedBackup.verifiedPlaintextBytes !== input.expectedPlaintextBytes) {
      return fail()
    }
    // Recover the original journal key from the exact frozen snapshot, never
    // from an advancing Source tip or a caller-supplied random key.
    const backupInventory = await verifyGitHubReencryptionForkSourceWithTranscodeInventory({
      github: backupClient,
      expectedRepoId: sourceRepoId,
      expectedBranch: input.backupBranch,
      expectedPinnedCommitSha: input.pinnedSourceCommitSha,
      expectedSourceTreeSha: input.sourceTreeSha,
      expectedPhysicalRepositoryId: input.expectedPhysicalRepositoryId,
      passphrase: input.oldPassphrase,
      signal: input.signal,
    })
    const sourceKdf = backupInventory.sourceConfig.kdfParams
    if (!sourceKdf || backupInventory.pinnedSourceCommitSha !== input.pinnedSourceCommitSha
      || backupInventory.verifiedSource.verifiedFileCount !== input.expectedFileCount
      || backupInventory.verifiedSource.totalVerifiedPlaintextBytes !== input.expectedPlaintextBytes) {
      return fail()
    }
    const backupSalt = sourceKdf.salt
    const backupLiveFiles = new Map<string, { size: number; sha: string }>()
    for (const rec of backupInventory.sourceRecords) {
      if (!rec.deleted) backupLiveFiles.set(rec.path, { size: rec.size, sha: rec.plaintextSha256 })
    }
    oldSalt = fromBase64Url(sourceKdf.salt)
    oldKeyring = await deriveV4Keyring({
      passphrase: input.oldPassphrase, repoId: sourceRepoId,
      salt: oldSalt, iterations: sourceKdf.iterations,
    })
    await wal.assertExclusiveStageLease()
    input.assertOwnerStillValid?.()
    backupReverified = true

    // Authenticate the original encrypted WAL at its expected generation.
    failureStage = "wal"
    const readOnlyJournal = createV4ReencryptionRecoveryJournal({
      adapter: createReadOnlyIndexAdapter(wal.adapter),
      root: wal.journalRoot,
      runId: input.runId,
      sourceCommitSha: input.pinnedSourceCommitSha,
      destinationRepoId,
      journalKey: oldKeyring.journalKey,
    })
    const walCheck = await inspectV4BestEffortWalRecovery({
      storage: wal,
      journal: readOnlyJournal,
      expected: {
        sourceCommitSha: input.pinnedSourceCommitSha,
        destinationRepoId,
        generation: input.expectedFinalWalGeneration,
      },
    })
    if (walCheck.observation !== "authenticated-uncommitted"
      || walCheck.generation !== input.expectedFinalWalGeneration) {
      return fail()
    }
    const snapshot = await readOnlyJournal.assertHealthySnapshot(input.expectedFinalWalGeneration)
    const backupObs = snapshot.verifiedRefObservations.find(item => item.role === "backup")
    const destObs = snapshot.verifiedRefObservations.find(item => item.role === "destination")
    if (snapshot.pendingRefIntents.length !== 0 || snapshot.pendingIntents.length !== 0
      || !snapshot.stageHandoffStarted || snapshot.cutoverAuthorized !== false
      || snapshot.permissionToPublish !== false
      || !backupObs || backupObs.repoId !== backupRepoId
      || backupObs.commitSha !== input.pinnedSourceCommitSha || backupObs.treeSha !== input.sourceTreeSha
      || !destObs || destObs.repoId !== destinationRepoId
      || destObs.commitSha !== input.destinationCommitSha || destObs.treeSha !== input.destinationTreeSha
      || snapshot.preparedCandidateReceipt?.commitSha !== input.destinationCommitSha
      || snapshot.preparedCandidateReceipt.treeSha !== input.destinationTreeSha
      || (destObs.manifestSha256 !== undefined
        && destObs.manifestSha256 !== snapshot.preparedCandidateReceipt.manifestSha256)) {
      return fail()
    }
    walAuthenticated = true

    // 4. Re-verify zero-parent Destination commit, tree hygiene, KDF policy, WAL receipts 1:1, and full new-key content.
    failureStage = "destination"
    const destinationClient = input.createGitHubClient(input.destinationBranch)
    const [destIdentity, destRef, destCommit, destTree] = await Promise.all([
      destinationClient.getRepositoryIdentity(),
      destinationClient.getGitRef(),
      destinationClient.getGitCommit(input.destinationCommitSha),
      destinationClient.getTreeAt(input.destinationTreeSha, true),
    ])
    if (destIdentity.id !== input.expectedPhysicalRepositoryId
      || destRef.sha !== input.destinationCommitSha
      || destCommit.sha !== input.destinationCommitSha
      || destCommit.treeSha !== input.destinationTreeSha
      || destCommit.parentShas.length !== 0
      || destTree.sha !== input.destinationTreeSha
      || destTree.truncated !== false) {
      return fail()
    }
    const blobByPath = new Map<string, string>()
    for (const node of destTree.tree) {
      if (node.type === "tree") {
        if (node.mode !== "040000") return fail()
        continue
      }
      if (node.type !== "blob" || node.mode !== "100644" || blobByPath.has(node.path)) {
        return fail()
      }
      blobByPath.set(node.path, node.sha)
    }
    if (!blobByPath.has(V4_CONFIG_PATH)) return fail()

    failureStage = "secret"
    const secretInput = input.secretOwner && input.shadow ? {
      adapter: input.shadow.adapter, owner: input.secretOwner, key: oldKeyring.journalKey,
      identity: {
        runId: input.runId, deviceId: input.shadow.deviceId, sourceRepoId, backupRepoId, destinationRepoId,
        pinnedSourceCommitSha: input.pinnedSourceCommitSha, sourceTreeSha: input.sourceTreeSha,
        destinationCommitSha: input.destinationCommitSha, destinationTreeSha: input.destinationTreeSha,
        finalWalGeneration: input.expectedFinalWalGeneration, verifiedFileCount: input.expectedFileCount,
        verifiedPlaintextBytes: input.expectedPlaintextBytes, physicalRepositoryId: input.expectedPhysicalRepositoryId,
        defaultBranch: input.defaultBranch,
      },
    } : undefined
    const stagedSecret = secretInput ? await inspectV4InstalledDestinationSecret(secretInput) : undefined
    missing = stagedSecret?.passphrase === null
    if (missing && !restore) return fail()
    if (restore && (!missing || !secretInput || !stagedSecret)) return fail()
    const destinationPassphrase = stagedSecret?.passphrase ?? input.newPassphrase
    if (!destinationPassphrase || (input.secretOwner && !stagedSecret)) return fail()
    failureStage = "destination"
    const destInventory = await verifyGitHubReencryptionForkSourceWithTranscodeInventory({
      github: destinationClient,
      expectedRepoId: destinationRepoId,
      expectedBranch: input.destinationBranch,
      passphrase: destinationPassphrase,
      signal: input.signal,
    })
    if (destInventory.pinnedSourceCommitSha !== input.destinationCommitSha
      || destInventory.verifiedSource.verifiedFileCount !== input.expectedFileCount
      || destInventory.verifiedSource.totalVerifiedPlaintextBytes !== input.expectedPlaintextBytes
      || !destInventory.sourceConfig.kdfParams) {
      return fail()
    }
    assertV4Pbkdf2Iterations(destInventory.sourceConfig.kdfParams.iterations, V4_MIN_NEW_PBKDF2_ITERATIONS)
    if (backupSalt && destInventory.sourceConfig.kdfParams.salt === backupSalt) {
      return fail()
    }

    // Verify 1:1 per-file content parity against Backup inventory and 1:1 WAL receipts against live Destination objects.
    const destLiveRecords = destInventory.sourceRecords.filter(rec => !rec.deleted)
    if (destLiveRecords.length !== backupLiveFiles.size) return fail()
    const expectedObjectPaths = new Set<string>()
    for (const rec of destLiveRecords) {
      const expectedFile = backupLiveFiles.get(rec.path)
      if (!expectedFile || expectedFile.size !== rec.size || expectedFile.sha !== rec.plaintextSha256) {
        return fail()
      }
      const paths = rec.storage === "chunked" ? (rec.partPaths ?? []) : [rec.remotePath]
      for (const objectPath of paths) expectedObjectPaths.add(objectPath)
    }
    const receiptPaths = new Set(snapshot.receipts.map(r => r.path))
    if (receiptPaths.size !== snapshot.receipts.length
      || receiptPaths.size !== expectedObjectPaths.size
      || snapshot.receipts.some(receipt => !expectedObjectPaths.has(receipt.path) || blobByPath.get(receipt.path) !== receipt.sha)) {
      return fail()
    }
    failureStage = "shadow"
    if (input.shadow) {
      await verifyV4InstalledReencryptionShadow({
        adapter: input.shadow.adapter, runId: input.runId, deviceId: input.shadow.deviceId,
        source: backupInventory, destination: destInventory,
      })
    }
    // Bind the final observation to the same exact refs and WAL generation
    // after all awaited content reads, not a moving branch.
    failureStage = "final-readback"
    const [finalBackupRef, finalDestinationRef] = await Promise.all([
      backupClient.getGitRef(), destinationClient.getGitRef(),
    ])
    if (finalBackupRef.sha !== input.pinnedSourceCommitSha
      || finalDestinationRef.sha !== input.destinationCommitSha) return fail()
    await wal.assertExclusiveStageLease()
    await readOnlyJournal.assertHealthySnapshot(input.expectedFinalWalGeneration)

    destinationReverified = true
    if (secretInput && stagedSecret) {
      failureStage = "secret"
      const assertRestoreLease = async () => {
        throwIfV4Aborted(input.signal)
        input.assertOwnerStillValid?.()
        await wal!.assertExclusiveStageLease()
        if (!input.inspectFenceAndNoPartialCutover || !(await input.inspectFenceAndNoPartialCutover())) throw Error("Recovery fence changed.")
        const [backup, destination] = await Promise.all([backupClient.getGitRef(), destinationClient.getGitRef()])
        if (backup.sha !== input.pinnedSourceCommitSha || destination.sha !== input.destinationCommitSha) throw Error("Recovery refs changed.")
        await readOnlyJournal.assertHealthySnapshot(input.expectedFinalWalGeneration)
        input.assertOwnerStillValid?.()
      }
      if (restore) {
        await restoreV4InstalledMissingDestinationSecret({
          ...secretInput, expectedId: stagedSecret.id, verifiedPassphrase: destinationPassphrase,
          assertLease: assertRestoreLease,
          checkpoint: async () => { await wal!.assertBestEffortCheckpoint(); await readOnlyJournal.assertHealthySnapshot(input.expectedFinalWalGeneration) },
        })
        missing = false
      }
      const finalSecret = await inspectV4InstalledDestinationSecret(secretInput)
      if (finalSecret.id !== stagedSecret.id || finalSecret.passphrase !== destinationPassphrase) return fail()
      await assertRestoreLease()
    }
    if (input.createInitiatorReader) {
      // Reuse authenticated frozen Backup inventory, not the local cache.
      // The lease remains held across the live physical scan and final ref checks.
      failureStage = "physical-parity"
      const assertLease = async () => {
        throwIfV4Aborted(input.signal)
        input.assertOwnerStillValid?.()
        await wal!.assertExclusiveStageLease()
        if (!await input.inspectFenceAndNoPartialCutover!()) throw Error("Recovery fence changed.")
      }
      const parity = await verifyV4ReencryptionInitiatorLocalParity({
        pinnedSourceCommitSha: input.pinnedSourceCommitSha,
        verifiedSource: backupInventory.verifiedSource,
        sourceRecords: backupInventory.sourceRecords.filter(record => !record.deleted),
        reader: input.createInitiatorReader(assertLease),
        signal: input.signal,
      })
      if (parity.checkedFileCount !== input.expectedFileCount
        || parity.checkedPlaintextBytes !== input.expectedPlaintextBytes) return fail()
      failureStage = "source-ref"
      await assertSourceStillPinned()
      failureStage = "final-readback"
      const [backup, destination] = await Promise.all([backupClient.getGitRef(), destinationClient.getGitRef()])
      if (backup.sha !== input.pinnedSourceCommitSha || destination.sha !== input.destinationCommitSha) return fail()
      await assertLease()
      await readOnlyJournal.assertHealthySnapshot(input.expectedFinalWalGeneration)
      const finalSecret = await inspectV4InstalledDestinationSecret(secretInput!)
      if (finalSecret.id !== stagedSecret!.id || finalSecret.passphrase !== destinationPassphrase) return fail()
      await assertLease()
    }
    input.assertOwnerStillValid?.()
    return Object.freeze({
      integrityScope: restore ? "installed-pre-cutover-staged-secret-recovery" : "read-only-installed-pre-cutover-wal-backup-and-destination",
      observation: "authenticated-pre-cutover-destination-still-fenced",
      walAuthenticated,
      backupReverified,
      destinationReverified,
      ...(input.shadow ? { shadowReverified: true as const } : {}),
      ...(stagedSecret ? { stagedSecretReverified: true as const } : {}),
      ...(restore ? { stagedSecretRestored: true as const } : {}),
      ...(input.createInitiatorReader ? { physicalParityReverified: true as const, sourceRefReverified: true as const } : {}),
      verifiedFileCount: destInventory.verifiedSource.verifiedFileCount,
      verifiedPlaintextBytes: destInventory.verifiedSource.totalVerifiedPlaintextBytes,
      cutoverAuthorized: false,
      localCutoverAuthorized: false,
      resumeSyncAuthorized: false,
      oldPassphraseCleanupAuthorized: false,
      powerLossDurabilityProven: false,
    })
  } catch {
    return fail()
  } finally {
    oldSalt?.fill(0)
    wipeKeyring(oldKeyring)
    await wal?.release().catch(() => {})
  }
}
