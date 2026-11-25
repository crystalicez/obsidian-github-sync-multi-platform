import type { V4StageRef } from "./staging-store"
import type { V4LocalTargetPrecondition } from "./local-io"

export type V4RecoveryPhase =
  | "publish-intent"
  | "remote-verified"
  | "local-committing"
  | "replan-required"
  | "index-committed"

export interface V4RecoveryHeader {
  schemaVersion: 1
  generation: number
  runId: string
  journalId?: string | undefined
  phase: V4RecoveryPhase
  expectedRemoteHead: string | null
  candidateCommitSha?: string | undefined
  verifiedRemoteHead?: string | undefined
  payloadCiphertext?: string | undefined
  integrity: string
}

export interface V4RecoveryStageMutation {
  id: string
  kind: "stage-write"
  path: string
  stage: V4StageRef
  precondition: V4LocalTargetPrecondition
}

export interface V4RecoveryTrashMutation {
  id: string
  kind: "trash"
  path: string
  precondition: V4LocalTargetPrecondition
}

export type V4RecoveryLocalMutation = V4RecoveryStageMutation | V4RecoveryTrashMutation

/** Candidate-bound identity evidence for a new file published from the local Vault. */
export interface V4RecoveryPublishedCreate {
  path: string
  fileId: string
  hash: string
  size: number
}

export interface V4RecoveryPayload {
  publishedCreates?: V4RecoveryPublishedCreate[] | undefined
  /** Exact descendant HEAD proven to contain the published candidate; never a local replay authorization. */
  publishedCreateVerifiedHead?: string | undefined
  mutations: V4RecoveryLocalMutation[]
  completedMutationIds: string[]
}

export interface V4RecoverySnapshot {
  header: V4RecoveryHeader
  payload?: V4RecoveryPayload | undefined
}
