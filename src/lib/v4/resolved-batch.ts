import type { V4ContentHandle } from "./content-source"
import type { V4IndexFileRecord } from "./local-index"
import type { V4LogicalFile, V4PlannedChange } from "./planner"
import type { V4StageRef } from "./staging-store"

export interface V4PushBinding {
  change: V4PlannedChange
  source?: V4ContentHandle
  reuseRecord?: V4IndexFileRecord
}

export interface V4PullBinding {
  change: V4PlannedChange
  /** Hash of the local note the user reviewed when choosing the remote copy. */
  expectedLocalHash?: string
  remoteRecord?: V4IndexFileRecord
  remoteCommitSha?: string
  packRecords?: readonly V4IndexFileRecord[]
  stage?: V4StageRef
}

export interface V4StagedWriteBinding {
  change: V4PlannedChange
  stage: V4StageRef
  /** Original vault file whose reviewed contents must remain unchanged until Apply. */
  expectedLocal?: V4LogicalFile
}

export interface V4ResolvedBatch {
  runId: string
  journalId?: string
  pulls: V4PullBinding[]
  pushes: V4PushBinding[]
  stagedWrites: V4StagedWriteBinding[]
}
