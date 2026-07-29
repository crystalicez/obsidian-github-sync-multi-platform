import type { V4ContentHandle } from "./content-source"
import type { V4IndexFileRecord } from "./local-index"
import type { V4PlannedChange } from "./planner"
import type { V4StageRef } from "./staging-store"

export interface V4PushBinding {
  change: V4PlannedChange
  source?: V4ContentHandle
  reuseRecord?: V4IndexFileRecord
}

export interface V4PullBinding {
  change: V4PlannedChange
  remoteRecord?: V4IndexFileRecord
  remoteCommitSha?: string
  stage?: V4StageRef
}

export interface V4StagedWriteBinding {
  change: V4PlannedChange
  stage: V4StageRef
}

export interface V4ResolvedBatch {
  runId: string
  journalId?: string
  pulls: V4PullBinding[]
  pushes: V4PushBinding[]
  stagedWrites: V4StagedWriteBinding[]
}
