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
  journalId?: string
  phase: V4RecoveryPhase
  expectedRemoteHead: string | null
  candidateCommitSha?: string
  verifiedRemoteHead?: string
  payloadCiphertext?: string
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

export interface V4RecoveryPayload {
  mutations: V4RecoveryLocalMutation[]
  completedMutationIds: string[]
}

export interface V4RecoverySnapshot {
  header: V4RecoveryHeader
  payload?: V4RecoveryPayload
}
