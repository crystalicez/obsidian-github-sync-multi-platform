import { assertSafeGitHubBranch, assertSafeGitHubRepositoryCoordinates } from "../github-config"
import {
  isV4LocalIndexCacheComplete, loadV4LocalIndex, type V4LocalIndexAdapter,
} from "./local-index"
import { expectedV4PathLayout } from "./protocol-types"

const SHA = /^[0-9a-f]{40}$/u

/** Pin nonsecret identities from a separately verified migration record;
 * never infer them from possibly partially saved device settings.
 */
export interface V4LocalCutoverExpected {
  readonly sourceRepoId: string
  readonly destinationRepoId: string
  readonly destinationCommitSha: string
  readonly sourcePassphraseSecretId: string
  readonly destinationPassphraseSecretId: string
  readonly deviceId: string
}

export interface V4LocalCutoverSettings {
  readonly githubOwner: string
  readonly githubRepo: string
  readonly githubBranch: string
  readonly encryptionMode: string
  readonly encryptionPassphraseSecretId: string
  readonly vault: string
}

export type V4LocalCutoverObservation =
  | "source-observed"
  | "destination-observed-unconfirmed"
  | "mixed-or-unverifiable"

export interface V4LocalCutoverInspection {
  readonly integrityScope: "read-only-local-cutover-identity-observation"
  readonly observation: V4LocalCutoverObservation
  /** No durable transaction receipt: NEVER authorize automatic resume/switch. */
  readonly localCutoverAuthorized: false
  readonly resumeSyncAuthorized: false
  readonly rollbackAuthorized: false
  readonly secretValuesExposed: false
}

export interface V4LocalCutoverInspectInput {
  readonly expected: V4LocalCutoverExpected
  readonly settings: V4LocalCutoverSettings
  readonly indexAdapter: V4LocalIndexAdapter
  readonly indexRoot: string
  /** Read-only credential presence check. Never persist or return plaintext. */
  readonly getSecret: (id: string) => string | null
}

function validExpected(input: V4LocalCutoverInspectInput): V4LocalCutoverExpected {
  const expected = input.expected
  if (!expected || !SHA.test(expected.destinationCommitSha)
    || typeof expected.sourceRepoId !== "string"
    || typeof expected.destinationRepoId !== "string"
    || typeof expected.sourcePassphraseSecretId !== "string"
    || typeof expected.destinationPassphraseSecretId !== "string"
    || !expected.sourcePassphraseSecretId || !expected.destinationPassphraseSecretId
    || expected.sourcePassphraseSecretId === expected.destinationPassphraseSecretId
    || typeof expected.deviceId !== "string" || !expected.deviceId
    || typeof input.indexRoot !== "string" || !input.indexRoot
    || input.indexRoot.includes("\\")
    || input.indexRoot.split("/").some(part => !part || part === "." || part === "..")
    || typeof input.getSecret !== "function"
    || typeof input.indexAdapter?.exists !== "function"
    || typeof input.indexAdapter.read !== "function") {
    throw new Error("Re-encryption cutover inspection requires valid pinned nonsecret identities and a reader.")
  }
  const parse = (repoId: string) => {
    const matched = /^([^/#]+)\/([^/#]+)#(.+)$/u.exec(repoId)
    if (!matched) throw new Error("Invalid re-encryption cutover repository identity.")
    const owner = matched[1]!
    const repo = matched[2]!
    const branch = matched[3]!
    assertSafeGitHubRepositoryCoordinates(owner, repo)
    assertSafeGitHubBranch(branch)
    return { owner, repo, branch }
  }
  const oldId = parse(expected.sourceRepoId)
  const newId = parse(expected.destinationRepoId)
  if (oldId.owner !== newId.owner || oldId.repo !== newId.repo
    || oldId.branch === newId.branch) {
    throw new Error("Re-encryption cutover inspection requires distinct branches in one repository.")
  }
  return Object.freeze({ ...expected })
}

const REPORT_BASE = Object.freeze({
  integrityScope: "read-only-local-cutover-identity-observation" as const,
  localCutoverAuthorized: false as const,
  resumeSyncAuthorized: false as const,
  rollbackAuthorized: false as const,
  secretValuesExposed: false as const,
})

/**
 * D131: Read potentially interrupted local cutover evidence without changing
 * Settings, SecretStorage, index, GitHub, or the WAL. Even a matching new
 * config/index is NOT proof of committed settings durability or backup restore.
 */
export async function inspectV4ReencryptionLocalCutoverAfterRestart(
  input: V4LocalCutoverInspectInput,
): Promise<V4LocalCutoverInspection> {
  const expected = validExpected(input)
  const captured = Object.freeze({ ...input.settings })
  const index = await loadV4LocalIndex(input.indexAdapter, input.indexRoot)
  const unchanged = Object.entries(captured).every(([key, value]) =>
    input.settings[key as keyof V4LocalCutoverSettings] === value)
  const observed = captured.githubOwner + "/" + captured.githubRepo + "#" + captured.githubBranch
  const validIndex = index.mode === "encrypted"
    && index.pathLayout === expectedV4PathLayout("encrypted")
    && index.deviceId === expected.deviceId
    && captured.encryptionMode === "encrypted"
    && captured.vault === expected.deviceId
    && isV4LocalIndexCacheComplete(index)
  let observation: V4LocalCutoverObservation = "mixed-or-unverifiable"
  if (unchanged && validIndex && index.repoId === observed) {
    if (observed === expected.sourceRepoId
      && captured.encryptionPassphraseSecretId === expected.sourcePassphraseSecretId
      && !!input.getSecret(expected.sourcePassphraseSecretId)) {
      observation = "source-observed"
    } else if (observed === expected.destinationRepoId
      && index.remoteCommitSha === expected.destinationCommitSha
      && captured.encryptionPassphraseSecretId === expected.destinationPassphraseSecretId
      && !!input.getSecret(expected.destinationPassphraseSecretId)) {
      observation = "destination-observed-unconfirmed"
    }
  }
  // A secret provider or other synchronous callback may mutate the caller's
  // live settings after the index read. Never return a stale positive result.
  if (!Object.entries(captured).every(([key, value]) =>
    input.settings[key as keyof V4LocalCutoverSettings] === value)) {
    observation = "mixed-or-unverifiable"
  }
  return Object.freeze({ ...REPORT_BASE, observation })
}
