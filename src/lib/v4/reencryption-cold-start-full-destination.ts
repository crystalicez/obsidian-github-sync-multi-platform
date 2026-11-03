import { assertV4GitBlobIdentity } from "./git-blob-identity"
import { planV4OrphanReencryptionDestination } from "./reencryption-orphan-branch"
import { decodeV4RemoteConfig } from "./remote-index"
import { V4_CONFIG_PATH, type V4RemoteConfig } from "./protocol-types"
import {
  inspectV4ColdStartDestination,
  type V4ColdStartDestinationInput,
} from "./reencryption-cold-start-destination"
import type { V4ReencryptionCutoverSnapshotContract } from "./reencryption-cutover-snapshot-contract"
import type { V4ReencryptionObjectReceipt } from "./reencryption-staging-receipts"

/**
 * D255's receipts are passed ONLY inside D237's authenticated two-slot WAL
 * callback. The caller must have independently verified the source config,
 * the old Backup physical repository, and D254's new-key encrypted HEAD.
 */
export interface V4ColdStartFullDestinationEvidence {
  readonly contract: V4ReencryptionCutoverSnapshotContract
  readonly adapter: V4ColdStartDestinationInput["adapter"]
  readonly destinationGit: V4ColdStartDestinationInput["destinationGit"]
  readonly expectedPhysicalRepositoryId: number
  readonly sourceConfig: V4RemoteConfig
  readonly sourceDefaultBranch: string
  readonly receipts: readonly V4ReencryptionObjectReceipt[]
  readonly destinationPassphrase: string
  readonly getSecret: V4ColdStartDestinationInput["getSecret"]
  readonly assertLiveOwner: () => void
}

/**
 * Authenticate every Destination shard, Shadow record and file plaintext
 * through D238. Neither new-key Git config nor Shadow is trusted as the WAL
 * receipt list; those receipts come from old-key AES-GCM and a bound digest.
 */
export async function inspectV4ColdStartFullDestination(
  input: V4ColdStartFullDestinationEvidence,
): Promise<boolean> {
  try {
    const { contract, adapter, destinationGit: git, expectedPhysicalRepositoryId: physical,
      sourceConfig, sourceDefaultBranch, receipts, destinationPassphrase: passphrase,
      getSecret, assertLiveOwner } = input
    const identity = contract.identity
    if (!git || !adapter || !Array.isArray(receipts) || receipts.length === 0
      || git.branchName !== identity.destinationRepoId.split("#")[1]
      || sourceConfig.repoId !== identity.sourceRepoId
      || !Number.isSafeInteger(physical) || physical <= 0
      || typeof sourceDefaultBranch !== "string" || !sourceDefaultBranch
      || getSecret(identity.destinationPassphraseSecretId) !== passphrase) return false
    const methods = {
      repo: git.getRepositoryIdentity, defaultBranch: git.getRepositoryDefaultBranch,
      ref: git.getGitRef, commit: git.getGitCommit, tree: git.getTreeAt, blob: git.getBlob,
      read: adapter.read, exists: adapter.exists,
    }
    const original = JSON.stringify({ contract, sourceConfig, receipts })
    const check = () => {
      assertLiveOwner()
      if (input.contract !== contract || input.adapter !== adapter
        || input.destinationGit !== git || input.expectedPhysicalRepositoryId !== physical
        || input.sourceConfig !== sourceConfig || input.sourceDefaultBranch !== sourceDefaultBranch
        || input.receipts !== receipts || input.destinationPassphrase !== passphrase
        || input.getSecret !== getSecret || input.assertLiveOwner !== assertLiveOwner
        || git.branchName !== identity.destinationRepoId.split("#")[1]
        || git.getRepositoryIdentity !== methods.repo
        || git.getRepositoryDefaultBranch !== methods.defaultBranch
        || git.getGitRef !== methods.ref || git.getGitCommit !== methods.commit
        || git.getTreeAt !== methods.tree || git.getBlob !== methods.blob
        || adapter.read !== methods.read || adapter.exists !== methods.exists
        || JSON.stringify({ contract, sourceConfig, receipts }) !== original
        || getSecret(identity.destinationPassphraseSecretId) !== passphrase) {
        throw Error("D255 Destination proof evidence changed during readback.")
      }
    }
    check()
    const defaultBranch = await methods.defaultBranch.call(git)
    check()
    if (defaultBranch !== sourceDefaultBranch) return false
    const plan = planV4OrphanReencryptionDestination({
      sourceRepoId: identity.sourceRepoId, destinationRepoId: identity.destinationRepoId,
      sourceCommitSha: identity.sourceCommitSha,
      sourcePhysicalRepositoryId: physical,
      destinationPhysicalRepositoryId: physical,
      expectedPhysicalRepositoryId: physical,
      defaultBranch,
    })
    const commit = await methods.commit.call(git, identity.destinationCommitSha)
    check()
    if (commit.sha !== identity.destinationCommitSha
      || commit.treeSha !== identity.destinationTreeSha
      || !Array.isArray(commit.parentShas) || commit.parentShas.length !== 0) return false
    const tree = await methods.tree.call(git, identity.destinationTreeSha, true)
    check()
    if (tree.sha !== identity.destinationTreeSha || tree.truncated !== false
      || !Array.isArray(tree.tree) || tree.tree.length > 100_000) return false
    const entries = tree.tree.filter(node => node?.path === V4_CONFIG_PATH)
    if (entries.length !== 1 || entries[0]?.type !== "blob"
      || entries[0]?.mode !== "100644") return false
    const bytes = await methods.blob.call(git, entries[0].sha)
    check()
    assertV4GitBlobIdentity(bytes, entries[0].sha)
    const destinationConfig = decodeV4RemoteConfig(bytes)
    if (destinationConfig.repoId !== identity.destinationRepoId
      || destinationConfig.mode !== "encrypted" || !destinationConfig.kdfParams) return false

    const report = await inspectV4ColdStartDestination({
      contract, adapter, destinationGit: git, expectedPhysicalRepositoryId: physical,
      getSecret, assertLiveOwner: check,
      remote: {
        plan, destinationCommitSha: identity.destinationCommitSha,
        sourceTreeSha: identity.sourceTreeSha, sourceConfig,
        expectedDestinationConfig: destinationConfig, expectedReceipts: receipts,
        destinationPassphrase: passphrase,
      },
    })
    check()
    return report.observation === "complete-destination-still-fenced"
      && report.completeDestinationContentsReverified
      && report.sourceAndShadowSnapshotMatched
  } catch {
    return false
  }
}
