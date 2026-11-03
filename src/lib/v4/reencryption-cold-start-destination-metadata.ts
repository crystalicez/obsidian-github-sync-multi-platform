import { fromBase64Url, sha256Hex, utf8ToBytes } from "../bytes"
import { deriveV4Keyring, type V4Keyring } from "./crypto"
import { assertV4GitBlobIdentity } from "./git-blob-identity"
import { isV4LocalIndexCacheComplete, loadV4LocalIndex, type V4LocalIndexAdapter } from "./local-index"
import { assertV4ReencryptionCutoverSnapshotContract, type V4ReencryptionCutoverSnapshotContract } from "./reencryption-cutover-snapshot-contract"
import type { V4WalReceiptDestinationGit } from "./reencryption-cold-start-receipt-ciphertexts"
import { decodeV4RemoteConfig, decodeV4RemoteHead } from "./remote-index"
import { V4_CONFIG_PATH, V4_HEAD_PATH } from "./protocol-types"

interface V4DestinationMetadataEvidence {
  readonly contract: V4ReencryptionCutoverSnapshotContract
  readonly adapter: Pick<V4LocalIndexAdapter, "read" | "exists">
  readonly destinationGit: V4WalReceiptDestinationGit
  /** Proven by the independent old Frozen Backup physical Git identity. */
  readonly expectedPhysicalRepositoryId: number
  /** Obtained from the pinned installed SecretStorage owner. */
  readonly destinationPassphrase: string
  readonly assertLiveOwner: () => void
}

/**
 * The caller must first authenticate the Cutover contract via the old-key
 * route MAC and WAL; local digests and Git SHA-1 alone cannot prove it.
 * Independently read Source/Shadow and authenticate the new-key encrypted HEAD.
 * This does not verify remote shards, file plaintext, or a complete Cutover.
 */
export async function inspectV4ColdStartDestinationMetadata(
  input: V4DestinationMetadataEvidence,
): Promise<boolean> {
  let ring: V4Keyring | undefined
  try {
    const { contract, adapter, destinationGit: git, expectedPhysicalRepositoryId: physicalId,
      destinationPassphrase: passphrase, assertLiveOwner } = input
    assertV4ReencryptionCutoverSnapshotContract(contract)
    const id = contract.identity
    const [repo, branch] = id.destinationRepoId.split("#")
    if (!repo || !branch || !adapter || !git || git.branchName !== branch
      || !Number.isSafeInteger(physicalId) || physicalId <= 0
      || typeof passphrase !== "string" || !passphrase
      || typeof assertLiveOwner !== "function") return false
    const methods = {
      read: adapter.read, exists: adapter.exists,
      repository: git.getRepositoryIdentity, defaultBranch: git.getRepositoryDefaultBranch,
      ref: git.getGitRef, commit: git.getGitCommit,
      tree: git.getTreeAt, blob: git.getBlob,
    }
    if (Object.values(methods).some(method => typeof method !== "function")) return false
    const contractText = JSON.stringify(contract)
    const check = () => {
      assertLiveOwner()
      if (input.adapter !== adapter || input.contract !== contract
        || input.destinationGit !== git || input.destinationPassphrase !== passphrase
        || input.expectedPhysicalRepositoryId !== physicalId || input.assertLiveOwner !== assertLiveOwner
        || git.branchName !== branch || adapter.read !== methods.read || adapter.exists !== methods.exists
        || git.getRepositoryIdentity !== methods.repository
        || git.getRepositoryDefaultBranch !== methods.defaultBranch
        || git.getGitRef !== methods.ref || git.getGitCommit !== methods.commit
        || git.getTreeAt !== methods.tree || git.getBlob !== methods.blob
        || JSON.stringify(contract) !== contractText) {
        throw Error("D254 recovery metadata owner or proof changed.")
      }
    }
    const readonly: V4LocalIndexAdapter = {
      async read(path) {
        check()
        const value = await methods.read.call(adapter, path)
        check()
        return value
      },
      async exists(path) {
        check()
        const value = await methods.exists.call(adapter, path)
        check()
        return value
      },
      async write() { throw Error("D254 cannot write Source/Shadow.") },
      async mkdir() { throw Error("D254 cannot create Source/Shadow.") },
    }
    const readLocal = async (): Promise<string | null> => {
      check()
      const source = await loadV4LocalIndex(readonly, id.indexRoot)
      const shadow = await loadV4LocalIndex(readonly, id.indexRoot + "-rekey-" + id.runId)
      check()
      if (!isV4LocalIndexCacheComplete(source) || !isV4LocalIndexCacheComplete(shadow)
        || source.repoId !== id.sourceRepoId || shadow.repoId !== id.destinationRepoId
        || source.remoteCommitSha !== id.sourceCommitSha
        || shadow.remoteCommitSha !== id.destinationCommitSha
        || source.deviceId !== id.deviceId || shadow.deviceId !== id.deviceId
        || source.mode !== "encrypted" || shadow.mode !== "encrypted"
        || source.pathLayout !== "opaque-stable-v1" || shadow.pathLayout !== "opaque-stable-v1"
        || await sha256Hex(utf8ToBytes(JSON.stringify(source))) !== contract.sourceIndexSha256
        || await sha256Hex(utf8ToBytes(JSON.stringify(shadow))) !== contract.destinationShadowSha256) {
        return null
      }
      check()
      // Keep only the compact, digest-validated HEAD witness; Source/Shadow
      // may contain thousands of records and must not be copied into a report.
      return JSON.stringify({
        deviceId: shadow.deviceId, epoch: shadow.epoch, generation: shadow.generation,
        shardHashes: shadow.shardHashes,
      })
    }
    const firstLocal = await readLocal()
    if (!firstLocal) return false
    const shadow = JSON.parse(firstLocal) as {
      deviceId: string; epoch: number; generation: number; shardHashes: Record<string, string>
    }
    const observeGit = async () => {
      check()
      const repository = await methods.repository.call(git)
      check()
      const defaultBranch = await methods.defaultBranch.call(git)
      check()
      const ref = await methods.ref.call(git)
      check()
      const commit = await methods.commit.call(git, id.destinationCommitSha)
      check()
      if (!repository || repository.id !== physicalId
        || repository.fullName.toLowerCase() !== repo.toLowerCase()
        || defaultBranch === branch
        || ref.ref !== "refs/heads/" + branch || ref.type !== "commit"
        || ref.sha !== id.destinationCommitSha
        || commit.sha !== id.destinationCommitSha || commit.treeSha !== id.destinationTreeSha
        || !Array.isArray(commit.parentShas) || commit.parentShas.length !== 0) return null
      const tree = await methods.tree.call(git, id.destinationTreeSha, true)
      check()
      if (!tree || tree.sha !== id.destinationTreeSha || tree.truncated !== false
        || !Array.isArray(tree.tree) || tree.tree.length > 100_000) return null
      const byPath = new Map<string, string>()
      const seen = new Set<string>()
      for (const entry of tree.tree) {
        if (!entry || typeof entry.path !== "string" || !entry.path
          || entry.path.split("/").some(s => !s || s === "." || s === "..")
          || !/^[0-9a-f]{40}$/u.test(entry.sha) || seen.has(entry.path)) return null
        seen.add(entry.path)
        if (entry.type === "tree" && entry.mode === "040000") continue
        if (entry.type !== "blob" || entry.mode !== "100644") return null
        byPath.set(entry.path, entry.sha)
      }
      const configSha = byPath.get(V4_CONFIG_PATH)
      const headSha = byPath.get(V4_HEAD_PATH)
      if (!configSha || !headSha) return null
      const configBytes = await methods.blob.call(git, configSha)
      check()
      assertV4GitBlobIdentity(configBytes, configSha)
      const headBytes = await methods.blob.call(git, headSha)
      check()
      assertV4GitBlobIdentity(headBytes, headSha)
      return {
        identity: JSON.stringify({ repository, defaultBranch, ref, commit, tree }),
        configBytes, headBytes,
      }
    }
    const firstGit = await observeGit()
    if (!firstGit) return false
    const config = decodeV4RemoteConfig(firstGit.configBytes)
    if (config.repoId !== id.destinationRepoId || config.mode !== "encrypted"
      || config.pathLayout !== "opaque-stable-v1" || config.algorithm !== "AES-GCM"
      || config.kdf !== "PBKDF2-SHA-256" || !config.kdfParams) return false
    ring = await deriveV4Keyring({
      passphrase, repoId: config.repoId, salt: fromBase64Url(config.kdfParams.salt),
      iterations: config.kdfParams.iterations,
    })
    check()
    const head = await decodeV4RemoteHead(firstGit.headBytes, config, ring)
    check()
    if (head.mode !== "encrypted" || head.deviceId !== shadow.deviceId
      || head.epoch !== shadow.epoch || head.generation !== shadow.generation
      || JSON.stringify(head.shardHashes) !== JSON.stringify(shadow.shardHashes)) return false
    const secondGit = await observeGit()
    check()
    if (!secondGit || secondGit.identity !== firstGit.identity
      || !sameBytes(secondGit.configBytes, firstGit.configBytes)
      || !sameBytes(secondGit.headBytes, firstGit.headBytes)) return false
    const finalLocal = await readLocal()
    check()
    return finalLocal !== null && firstLocal === finalLocal
  } catch {
    return false
  } finally {
    if (ring) {
      for (const key of [ring.masterKey, ring.pathKey, ring.contentKey,
        ring.indexKey, ring.journalKey]) key.fill(0)
    }
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && a.every((value, i) => value === b[i])
}
