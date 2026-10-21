export type V4InterruptedRecoveryPolicy = "ask" | "auto" | "notify"

export interface V4RecoveryPolicyIdentity {
  githubOwner: string
  githubRepo: string
  githubBranch: string
  encryptionMode: string
  githubTokenSecretId: string
  encryptionPassphraseSecretId: string
}

/** A remembered answer belongs to this vault AND to its precise remote/credential context. */
export function v4RecoveryPolicyContext(settings: V4RecoveryPolicyIdentity): string {
  return JSON.stringify([
    settings.githubOwner, settings.githubRepo, settings.githubBranch || "main",
    settings.encryptionMode, settings.githubTokenSecretId, settings.encryptionPassphraseSecretId,
  ])
}

export function effectiveV4RecoveryPolicy(
  policy: V4InterruptedRecoveryPolicy,
  savedContext: string,
  currentContext: string,
): V4InterruptedRecoveryPolicy {
  return savedContext === currentContext ? policy : "ask"
}
