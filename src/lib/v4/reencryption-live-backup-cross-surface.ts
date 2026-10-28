import type { GitHubClient } from "../github-api"
import { throwIfV4Aborted } from "./cancellation"
import {
  inspectV4ReencryptionCrossSurfaceProof,
  type V4ReencryptionCrossSurfaceProofInput,
} from "./reencryption-cross-surface-proof"

const SHA = /^[a-f0-9]{40}$/u

export interface V4ReencryptionLiveBackupCrossSurfaceInput extends V4ReencryptionCrossSurfaceProofInput {
  /** A separate GET-only client configured for the exact frozen Backup branch. */
  readonly backupReader: Pick<GitHubClient,
    "branchName" | "getRepositoryIdentity" | "getRepositoryDefaultBranch"
    | "getGitRefOrNull" | "getGitCommit">
}

export interface V4ReencryptionLiveBackupCrossSurfaceReport {
  readonly integrityScope: "read-only-live-backup-and-full-destination-cross-surface"
  readonly observation: "all-three-ref-evidence-coherent-uncommitted" | "manual-recovery-required"
  readonly localCutoverAuthorized: false
  readonly resumeSyncAuthorized: false
  readonly rollbackAuthorized: false
  readonly remoteWritesAuthorized: false
  readonly oldPassphraseCleanupAuthorized: false
}

const MANUAL: V4ReencryptionLiveBackupCrossSurfaceReport = Object.freeze({
  integrityScope: "read-only-live-backup-and-full-destination-cross-surface",
  observation: "manual-recovery-required",
  localCutoverAuthorized: false,
  resumeSyncAuthorized: false,
  rollbackAuthorized: false,
  remoteWritesAuthorized: false,
  oldPassphraseCleanupAuthorized: false,
})
const COHERENT: V4ReencryptionLiveBackupCrossSurfaceReport = Object.freeze({
  ...MANUAL,
  observation: "all-three-ref-evidence-coherent-uncommitted",
})

/**
 * D143: Revalidate the *live* frozen Backup branch before and after D138.
 * D138 already checks the local Source/Shadow/WAL/Intent and full Destination
 * Git ciphertext/plaintext proof. None of these observations is a durable
 * local commit, nor a guarantee refs cannot move AFTER the final GET.
 */
export async function inspectV4ReencryptionLiveBackupCrossSurface(
  input: V4ReencryptionLiveBackupCrossSurfaceInput,
): Promise<V4ReencryptionLiveBackupCrossSurfaceReport> {
  const { restart, shadow, preparedCandidate: prepared, backupReader: reader } = input ?? {}
  const plan = shadow?.remote?.plan
  const match = /^([^/#]+)\/([^/#]+)#(.+)$/u.exec(restart?.backupRepoId ?? "")
  if (!restart || !shadow || !prepared || !reader || !plan || !match
    || typeof input.withExclusiveInitiatorLease !== "function"
    || typeof reader.getRepositoryIdentity !== "function"
    || typeof reader.getRepositoryDefaultBranch !== "function"
    || typeof reader.getGitRefOrNull !== "function"
    || typeof reader.getGitCommit !== "function"
    || !SHA.test(restart.sourceCommitSha)
    || restart.sourceCommitSha !== plan.pinnedSourceCommitSha
    || prepared.pinnedSourceCommitSha !== restart.sourceCommitSha
    || prepared.sourceTreeSha !== shadow.remote.sourceTreeSha
    || prepared.physicalRepositoryId !== plan.physicalRepositoryId
    || prepared.physicalRepositoryId < 1
    || restart.expected.sourceRepoId !== plan.sourceRepoId
    || restart.expected.destinationRepoId !== plan.destinationRepoId
    || match[1] + "/" + match[2] !== plan.sourceRepoId.split("#")[0]
    || restart.backupRepoId === plan.sourceRepoId
    || restart.backupRepoId === plan.destinationRepoId
    || match[3] === plan.sourceRepoId.split("#")[1] || match[3] === plan.destinationBranch
    || reader.branchName !== match[3]) {
    throw new Error("Re-encryption Backup live-ref inspection requires exact same-repository frozen Backup identity.")
  }
  const backupBranch = match[3]!
  const repositoryName = match[1] + "/" + match[2]
  const pinned = {
    holder: input.withExclusiveInitiatorLease, reader,
    destinationClient: shadow.remote.github,
    destinationGetIdentity: shadow.remote.github.getRepositoryIdentity,
    destinationGetRef: shadow.remote.github.getGitRef,
    destinationGetCommit: shadow.remote.github.getGitCommit,
    destinationGetTree: shadow.remote.github.getTreeAt,
    destinationGetBlob: shadow.remote.github.getBlob,
    destinationPassphrase: shadow.remote.destinationPassphrase,
    destinationSignal: shadow.remote.signal,
    adapter: restart.indexAdapter,
    adapterRead: restart.indexAdapter.read,
    adapterExists: restart.indexAdapter.exists,
    adapterStat: restart.indexAdapter.stat,
    journal: restart.journal,
    walRead: restart.journal.assertHealthySnapshot,
    getSecret: restart.getSecret,
    getIdentity: reader.getRepositoryIdentity,
    getDefault: reader.getRepositoryDefaultBranch,
    getRef: reader.getGitRefOrNull,
    getCommit: reader.getGitCommit,
    branch: reader.branchName,
    lease: restart.assertExclusiveInitiatorLease,
    durable: restart.assertCrashDurable,
    restart, shadow, prepared,
    scope: JSON.stringify({
      backupRepoId: restart.backupRepoId, sourceCommitSha: restart.sourceCommitSha,
      sourceTreeSha: shadow.remote.sourceTreeSha,
      plan: shadow.remote.plan,
      sourceConfig: shadow.remote.sourceConfig,
      destinationConfig: shadow.remote.expectedDestinationConfig,
      receipts: shadow.remote.expectedReceipts,
      settings: restart.settings, expected: restart.expected, prepared,
    }),
  }
  const unchanged = (): boolean =>
    input.withExclusiveInitiatorLease === pinned.holder
    && input.backupReader === pinned.reader && input.restart === pinned.restart
    && input.shadow === pinned.shadow && input.preparedCandidate === pinned.prepared
    && reader.branchName === pinned.branch && reader.getRepositoryIdentity === pinned.getIdentity
    && reader.getRepositoryDefaultBranch === pinned.getDefault
    && reader.getGitRefOrNull === pinned.getRef && reader.getGitCommit === pinned.getCommit
    && shadow.remote.github === pinned.destinationClient
    && pinned.destinationClient.getRepositoryIdentity === pinned.destinationGetIdentity
    && pinned.destinationClient.getGitRef === pinned.destinationGetRef
    && pinned.destinationClient.getGitCommit === pinned.destinationGetCommit
    && pinned.destinationClient.getTreeAt === pinned.destinationGetTree
    && pinned.destinationClient.getBlob === pinned.destinationGetBlob
    && shadow.remote.destinationPassphrase === pinned.destinationPassphrase
    && shadow.remote.signal === pinned.destinationSignal
    && restart.indexAdapter === pinned.adapter
    && pinned.adapter.read === pinned.adapterRead
    && pinned.adapter.exists === pinned.adapterExists
    && pinned.adapter.stat === pinned.adapterStat
    && restart.journal === pinned.journal
    && pinned.journal.assertHealthySnapshot === pinned.walRead
    && restart.getSecret === pinned.getSecret
    && restart.assertExclusiveInitiatorLease === pinned.lease
    && restart.assertCrashDurable === pinned.durable
    && JSON.stringify({
      backupRepoId: restart.backupRepoId, sourceCommitSha: restart.sourceCommitSha,
      sourceTreeSha: shadow.remote.sourceTreeSha,
      plan: shadow.remote.plan,
      sourceConfig: shadow.remote.sourceConfig,
      destinationConfig: shadow.remote.expectedDestinationConfig,
      receipts: shadow.remote.expectedReceipts,
      settings: restart.settings, expected: restart.expected, prepared,
    }) === pinned.scope

  const checkLiveBackup = async (): Promise<boolean> => {
    throwIfV4Aborted(shadow.remote.signal)
    if (!unchanged()) return false
    const repo = await pinned.getIdentity.call(reader)
    throwIfV4Aborted(shadow.remote.signal)
    if (!unchanged() || repo?.id !== plan.physicalRepositoryId
      || repo.fullName.toLowerCase() !== repositoryName.toLowerCase()) return false
    const defaultBranch = await pinned.getDefault.call(reader)
    throwIfV4Aborted(shadow.remote.signal)
    if (!unchanged() || defaultBranch === backupBranch
      || defaultBranch === plan.destinationBranch) return false
    const ref = await pinned.getRef.call(reader)
    throwIfV4Aborted(shadow.remote.signal)
    if (!unchanged() || ref?.ref !== `refs/heads/${backupBranch}`
      || ref.type !== "commit" || ref.sha !== restart.sourceCommitSha) return false
    const commit = await pinned.getCommit.call(reader, restart.sourceCommitSha)
    throwIfV4Aborted(shadow.remote.signal)
    return unchanged() && !!commit && commit.sha === restart.sourceCommitSha
      && commit.treeSha === shadow.remote.sourceTreeSha
      && Array.isArray(commit.parentShas)
      && commit.parentShas.every(sha => SHA.test(sha))
  }

  let invoked = false
  const report = await pinned.holder(async () => {
    if (invoked) throw new Error("Re-encryption frozen Backup holder invoked proof repeatedly.")
    invoked = true
    await pinned.lease()
    await pinned.durable()
    if (!unchanged() || !await checkLiveBackup()) return MANUAL

    // D138's holder is invoked once *inside* the still-held real outer lease.
    // Its own guards still run throughout; never acquire/release a second
    // independent lease, and never return a result with write authority.
    let innerInvoked = false
    const checked = await inspectV4ReencryptionCrossSurfaceProof({
      restart, shadow, preparedCandidate: prepared,
      withExclusiveInitiatorLease: async body => {
        if (innerInvoked) throw new Error("Re-encryption nested proof was invoked twice.")
        innerInvoked = true
        if (!unchanged()) throw new Error("Re-encryption Backup boundary changed before nested proof.")
        return body()
      },
    })
    await pinned.lease()
    await pinned.durable()
    if (!innerInvoked || !unchanged()
      || checked.observation !== "all-surfaces-coherent-uncommitted"
      || !await checkLiveBackup() || !unchanged()) return MANUAL
    // The last live Backup GET can outlast the caller's OS lease. Never
    // promote an observation without a fresh fence check AFTER that await.
    await pinned.lease()
    await pinned.durable()
    if (!unchanged()) return MANUAL
    return COHERENT
  })
  if (!invoked || !unchanged()) return MANUAL
  return report === COHERENT ? COHERENT : MANUAL
}
