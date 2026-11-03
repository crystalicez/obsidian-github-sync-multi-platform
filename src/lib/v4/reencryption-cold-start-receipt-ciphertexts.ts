import type { GitHubClient } from "../github-api"
import { assertV4GitBlobIdentity } from "./git-blob-identity"
import {
  assertV4ReencryptionCutoverSnapshotContract,
  type V4ReencryptionCutoverSnapshotContract,
} from "./reencryption-cutover-snapshot-contract"
import {
  assertV4ReencryptionJournalObjectReceipt,
} from "./reencryption-recovery-journal"
import type { V4ReencryptionObjectReceipt } from "./reencryption-staging-receipts"

export type V4WalReceiptDestinationGit = Pick<GitHubClient,
  "branchName" | "getRepositoryIdentity" | "getRepositoryDefaultBranch"
  | "getGitRef" | "getGitCommit" | "getTreeAt" | "getBlob">

export interface V4WalReceiptDestinationReadback {
  /** Recovered from an independently verified old Frozen Backup, never Settings. */
  readonly expectedPhysicalRepositoryId: number
  /** Fresh read-only client scoped to the exact saved new-key branch. */
  readonly git: V4WalReceiptDestinationGit
}

/**
 * INTERNAL read-only ciphertext check. Supplied receipts are NOT authenticated
 * by this helper: D237 must call it only after verifying the old-key AES-GCM
 * WAL and its exact saved Cutover digest. Object bytes and paths never escape
 * to a UI report. This proves neither plaintext decryptability nor completeness
 * of the encrypted Destination's index/manifest.
 */
export async function inspectV4WalReceiptDestinationCiphertexts(input: {
  readonly contract: V4ReencryptionCutoverSnapshotContract
  readonly receipts: readonly V4ReencryptionObjectReceipt[]
  readonly readback: V4WalReceiptDestinationReadback
  readonly assertLiveOwner: () => void
}): Promise<boolean> {
  try {
    const { contract, receipts, readback, assertLiveOwner } = input
    if (!contract || !Array.isArray(receipts) || !readback
      || typeof assertLiveOwner !== "function" || receipts.length === 0
      || receipts.length > 100_000) return false
    assertV4ReencryptionCutoverSnapshotContract(contract)
    const id = contract.identity
    const branch = id.destinationRepoId.split("#")[1]
    const repo = id.destinationRepoId.split("#")[0]
    const git = readback.git
    const physicalId = readback.expectedPhysicalRepositoryId
    if (!repo || !branch || !git || git.branchName !== branch
      || !Number.isSafeInteger(physicalId) || physicalId <= 0) return false
    const pinned = {
      repo: git.getRepositoryIdentity, defaultBranch: git.getRepositoryDefaultBranch,
      ref: git.getGitRef, commit: git.getGitCommit,
      tree: git.getTreeAt, blob: git.getBlob,
    }
    if (Object.values(pinned).some(method => typeof method !== "function")) return false
    const contractText = JSON.stringify(contract)
    const receiptsText = JSON.stringify(receipts)
    const check = () => {
      assertLiveOwner()
      if (input.contract !== contract || input.receipts !== receipts
        || input.readback !== readback || input.assertLiveOwner !== assertLiveOwner
        || readback.git !== git || readback.expectedPhysicalRepositoryId !== physicalId
        || git.branchName !== branch
        || git.getRepositoryIdentity !== pinned.repo
        || git.getRepositoryDefaultBranch !== pinned.defaultBranch
        || git.getGitRef !== pinned.ref || git.getGitCommit !== pinned.commit
        || git.getTreeAt !== pinned.tree || git.getBlob !== pinned.blob
        || JSON.stringify(contract) !== contractText
        || JSON.stringify(receipts) !== receiptsText) {
        throw Error("D253 current Destination receipt scope changed.")
      }
    }
    const receiptMap = new Map<string, V4ReencryptionObjectReceipt>()
    for (const receipt of receipts) {
      assertV4ReencryptionJournalObjectReceipt(receipt)
      if (receiptMap.has(receipt.path)) return false
      receiptMap.set(receipt.path, receipt)
    }
    const observe = async () => {
      check()
      const physical = await pinned.repo.call(git)
      check()
      const defaultBranch = await pinned.defaultBranch.call(git)
      check()
      const ref = await pinned.ref.call(git)
      check()
      const commit = await pinned.commit.call(git, id.destinationCommitSha)
      check()
      if (!physical || physical.id !== physicalId
        || physical.fullName.toLowerCase() !== repo.toLowerCase()
        || defaultBranch === branch || defaultBranch === id.backupRepoId.split("#")[1]
        || ref.ref !== "refs/heads/" + branch || ref.type !== "commit"
        || ref.sha !== id.destinationCommitSha
        || commit.sha !== id.destinationCommitSha || commit.treeSha !== id.destinationTreeSha
        || !Array.isArray(commit.parentShas) || commit.parentShas.length !== 0) return null
      const tree = await pinned.tree.call(git, id.destinationTreeSha, true)
      check()
      if (!tree || tree.sha !== id.destinationTreeSha || tree.truncated !== false
        || !Array.isArray(tree.tree) || tree.tree.length > 100_000) return null
      const blobs = new Map<string, string>()
      const allPaths = new Set<string>()
      for (const node of tree.tree) {
        if (!node || typeof node.path !== "string" || !node.path
          || node.path.split("/").some(segment => !segment || segment === "." || segment === "..")
          || !/^[0-9a-f]{40}$/u.test(node.sha) || allPaths.has(node.path)) return null
        allPaths.add(node.path)
        if (node.type === "tree" && node.mode === "040000") continue
        if (node.type !== "blob" || node.mode !== "100644") return null
        blobs.set(node.path, node.sha)
      }
      for (const receipt of receipts) {
        check()
        if (blobs.get(receipt.path) !== receipt.sha) return null
        const bytes = await pinned.blob.call(git, receipt.sha)
        check()
        if (!(bytes instanceof Uint8Array) || bytes.byteLength !== receipt.byteLength) return null
        assertV4GitBlobIdentity(bytes, receipt.sha)
      }
      check()
      return JSON.stringify({ physicalId: physical.id, fullName: physical.fullName,
        defaultBranch, ref, commit, tree })
    }
    const first = await observe()
    if (first === null) return false
    check()
    const second = await observe()
    check()
    return second !== null && first === second
  } catch {
    return false
  }
}
