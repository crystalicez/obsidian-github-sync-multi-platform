import { fromBase64Url } from "../bytes"
import type { GitHubClient } from "../github-api"
import { deriveV4Keyring, type V4Keyring } from "./crypto"
import { assertV4GitBlobIdentity } from "./git-blob-identity"
import { readImmutableGitFile } from "./immutable-git-read"
import { decodeV4RemoteConfig, decodeV4RemoteHead } from "./remote-index"
import { V4_CONFIG_PATH, V4_HEAD_PATH } from "./protocol-types"
import { decodeV4ReencryptionCutoverCandidateManifest } from "./reencryption-cutover-candidate-manifest"
import {
  inspectV4ReencryptionColdStartIndexRoute,
  type V4ReencryptionColdStartRouteInput,
} from "./reencryption-runtime-index-route"
import { V4_REENCRYPTION_RUNTIME_ROUTE_PATH } from "./reencryption-index-root"

const SHA = /^[0-9a-f]{40}$/u
type BackupGit = Pick<GitHubClient,
  "branchName" | "getRepositoryIdentity" | "getGitRef" | "getGitCommit" | "getTreeAt" | "getBlob">

export interface V4ReencryptionColdStartJournalInput
  extends Omit<V4ReencryptionColdStartRouteInput, "journalKey" | "getSecret"> {
  /** A read-only client for the SAME GitHub repo, scoped to the frozen Backup branch. */
  readonly backupGit: BackupGit
  /** Reads the original key from Obsidian SecretStorage, never persists it. */
  readonly getSecret: (id: string) => string | null
  /** Refuse if the plugin instance, adapter or GitHub credentials changed. */
  readonly assertLiveOwner: () => void
}
export interface V4ReencryptionColdStartJournalReport {
  readonly integrityScope: "authenticated-original-key-and-pinned-backup-config-head"
  readonly observation: "authenticated-local-route-still-fenced" | "manual-recovery-required"
  readonly diagnosticIndexRoot: string | null
  readonly originalKeyAuthenticated: boolean
  readonly pinnedBackupConfigAndEncryptedHeadVerified: boolean
  readonly completeBackupContentsReverified: false
  readonly completeDestinationContentsReverified: false
  readonly coldStartWalReverified: false
  readonly commitDecisionAuthorized: false
  readonly localCutoverAuthorized: false
  readonly resumeSyncAuthorized: false
  readonly rollbackAuthorized: false
  readonly remoteWritesAuthorized: false
  readonly oldPassphraseCleanupAuthorized: false
}
const BASE = Object.freeze({
  integrityScope: "authenticated-original-key-and-pinned-backup-config-head" as const,
  completeBackupContentsReverified: false as const,
  completeDestinationContentsReverified: false as const,
  coldStartWalReverified: false as const,
  commitDecisionAuthorized: false as const,
  localCutoverAuthorized: false as const, resumeSyncAuthorized: false as const,
  rollbackAuthorized: false as const, remoteWritesAuthorized: false as const,
  oldPassphraseCleanupAuthorized: false as const,
})
const MANUAL: V4ReencryptionColdStartJournalReport = Object.freeze({
  ...BASE, observation: "manual-recovery-required",
  diagnosticIndexRoot: null, originalKeyAuthenticated: false,
  pinnedBackupConfigAndEncryptedHeadVerified: false,
})
function parseId(value: string): { owner: string; repo: string; branch: string } {
  const match = /^([^/#]+)\/([^/#]+)#(.+)$/u.exec(value)
  if (!match) throw Error("D235 invalid branch identity.")
  return { owner: match[1]!, repo: match[2]!, branch: match[3]! }
}
function eraseKeyring(keyring: V4Keyring): void {
  for (const key of [
    keyring.masterKey, keyring.pathKey, keyring.contentKey,
    keyring.indexKey, keyring.journalKey,
  ]) key.fill(0)
}

/**
 * A fresh Obsidian process rederives the original journal key from the
 * immutable frozen Backup's config and SecretStorage, never from an
 * unauthenticated local salt or the Destination's new password.
 *
 * The old encrypted Git HEAD is also authenticated before any route is
 * described as keyed. Full Backup/Destination content and WAL proofs are
 * deliberately NOT inferred; even a successful result cannot resume Sync.
 */
export async function inspectV4ReencryptionColdStartJournalKey(
  input: V4ReencryptionColdStartJournalInput,
): Promise<V4ReencryptionColdStartJournalReport> {
  let keyring: V4Keyring | undefined
  try {
    const { adapter, backupGit, getSecret, readPersistedPluginData, assertLiveOwner } = input
    if (!adapter || !backupGit || typeof getSecret !== "function"
      || typeof readPersistedPluginData !== "function"
      || typeof assertLiveOwner !== "function") return MANUAL
    const pinned = {
      repo: backupGit.getRepositoryIdentity, ref: backupGit.getGitRef,
      commit: backupGit.getGitCommit, tree: backupGit.getTreeAt,
      blob: backupGit.getBlob, branch: backupGit.branchName,
      read: adapter.read, exists: adapter.exists,
    }
    const unchanged = () => backupGit.getRepositoryIdentity === pinned.repo
      && backupGit.getGitRef === pinned.ref
      && backupGit.getGitCommit === pinned.commit
      && backupGit.getTreeAt === pinned.tree
      && backupGit.getBlob === pinned.blob
      && backupGit.branchName === pinned.branch
      && adapter.read === pinned.read && adapter.exists === pinned.exists
      && input.adapter === adapter && input.backupGit === backupGit
      && input.getSecret === getSecret && input.readPersistedPluginData === readPersistedPluginData
      && input.assertLiveOwner === assertLiveOwner
    const check = () => {
      assertLiveOwner()
      if (!unchanged()) throw Error("D235 cold-start reader changed during verification.")
    }
    check()
    // This is an untrusted LOCAL diagnostic, not the final key proof.
    const first = await inspectV4ReencryptionColdStartIndexRoute({
      adapter, readPersistedPluginData, getSecret,
    })
    if (first.observation !== "destination-shadow-diagnostic-only"
      && first.observation !== "source-settings-pending") return MANUAL
    check()
    const routeText = await pinned.read.call(adapter, V4_REENCRYPTION_RUNTIME_ROUTE_PATH)
    if (typeof routeText !== "string" || routeText.length > 4096) return MANUAL
    const route: unknown = JSON.parse(routeText)
    if (!route || typeof route !== "object" || Array.isArray(route)) return MANUAL
    const data = route as { runId?: unknown; sourceRepoId?: unknown; destinationRepoId?: unknown }
    if (typeof data.runId !== "string" || typeof data.sourceRepoId !== "string"
      || typeof data.destinationRepoId !== "string") return MANUAL
    const manifestText = await pinned.read.call(adapter,
      "github-sync-v4-index-rekey-cutover-candidate-" + data.runId + "/contract.json")
    const contract = decodeV4ReencryptionCutoverCandidateManifest(manifestText)
    const identity = contract.identity
    if (identity.runId !== data.runId || identity.sourceRepoId !== data.sourceRepoId
      || identity.destinationRepoId !== data.destinationRepoId) return MANUAL
    const source = parseId(identity.sourceRepoId)
    const backup = parseId(identity.backupRepoId)
    if (backup.owner !== source.owner || backup.repo !== source.repo
      || backup.branch !== pinned.branch) return MANUAL

    const originalPassphrase = getSecret(identity.sourcePassphraseSecretId)
    const destinationPassphrase = getSecret(identity.destinationPassphraseSecretId)
    if (!originalPassphrase || !destinationPassphrase) return MANUAL
    const physical = await pinned.repo.call(backupGit)
    check()
    if (!physical || !Number.isSafeInteger(physical.id) || physical.id <= 0
      || physical.fullName.toLowerCase() !== source.owner.toLowerCase() + "/" + source.repo.toLowerCase()) {
      return MANUAL
    }
    const expectedRef = "refs/heads/" + backup.branch
    const ref = await pinned.ref.call(backupGit)
    check()
    if (ref.ref !== expectedRef || ref.type !== "commit"
      || ref.sha !== identity.sourceCommitSha || !SHA.test(ref.sha)) return MANUAL
    const immutable = {
      getCommit: async (sha: string) => {
        if (sha !== identity.sourceCommitSha) throw Error("D235 unexpected Backup commit.")
        const commit = await pinned.commit.call(backupGit, sha)
        check()
        if (commit.sha !== identity.sourceCommitSha || commit.treeSha !== identity.sourceTreeSha
          || !SHA.test(commit.treeSha)) throw Error("D235 wrong pinned Backup tree.")
        return commit
      },
      getTree: async (treeSha: string) => {
        const tree = await pinned.tree.call(backupGit, treeSha, false)
        check()
        return tree
      },
      getBlob: async (blobSha: string) => {
        const bytes = await pinned.blob.call(backupGit, blobSha)
        check()
        assertV4GitBlobIdentity(bytes, blobSha)
        return bytes
      },
    }
    const encodedConfig = await readImmutableGitFile(
      V4_CONFIG_PATH, identity.sourceCommitSha, immutable,
    )
    if (!encodedConfig) return MANUAL
    const config = decodeV4RemoteConfig(encodedConfig.bytes)
    if (config.repoId !== identity.sourceRepoId || config.mode !== "encrypted"
      || config.pathLayout !== "opaque-stable-v1" || config.kdf !== "PBKDF2-SHA-256"
      || config.algorithm !== "AES-GCM" || !config.kdfParams) return MANUAL
    keyring = await deriveV4Keyring({
      passphrase: originalPassphrase, repoId: config.repoId,
      salt: fromBase64Url(config.kdfParams.salt),
      iterations: config.kdfParams.iterations,
    })
    check()
    const encryptedHead = await readImmutableGitFile(
      V4_HEAD_PATH, identity.sourceCommitSha, immutable,
    )
    if (!encryptedHead) return MANUAL
    // The last writer of the old Source HEAD may be another device. A
    // successfully decrypted HEAD proves the old key without falsely
    // identifying that remote writer as this initiating device.
    await decodeV4RemoteHead(encryptedHead.bytes, config, keyring)
    check()
    const keyed = await inspectV4ReencryptionColdStartIndexRoute({
      adapter, readPersistedPluginData, getSecret, journalKey: keyring.journalKey,
    })
    if (!keyed.routingHintAuthenticated
      || keyed.observation !== first.observation
      || keyed.diagnosticIndexRoot !== first.diagnosticIndexRoot) return MANUAL
    check()
    const [lastRef, lastPhysical] = await Promise.all([
      pinned.ref.call(backupGit), pinned.repo.call(backupGit),
    ])
    check()
    if (lastRef.ref !== expectedRef || lastRef.type !== "commit"
      || lastRef.sha !== identity.sourceCommitSha || lastPhysical.id !== physical.id
      || lastPhysical.fullName !== physical.fullName
      || await pinned.read.call(adapter, V4_REENCRYPTION_RUNTIME_ROUTE_PATH) !== routeText
      || getSecret(identity.sourcePassphraseSecretId) !== originalPassphrase
      || getSecret(identity.destinationPassphraseSecretId) !== destinationPassphrase) return MANUAL
    return Object.freeze({
      ...BASE, observation: "authenticated-local-route-still-fenced",
      diagnosticIndexRoot: keyed.diagnosticIndexRoot,
      originalKeyAuthenticated: true,
      pinnedBackupConfigAndEncryptedHeadVerified: true,
    })
  } catch {
    return MANUAL
  } finally {
    if (keyring) eraseKeyring(keyring)
  }
}
