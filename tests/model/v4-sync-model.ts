import { V4_PART_BYTES } from "../../src/lib/v4/large-files"
import { planV4Sync, type V4LogicalFile, type V4SyncOperation } from "../../src/lib/v4/planner"

export type V4ModelDevice = "A" | "B"
export type V4ModelConflictAction = "use-local" | "use-remote" | "keep-local-copy-remote" | "merged" | "ask"
export type V4ModelFault =
  | "source-mutation"
  | "lost-response"
  | "rate-limit"
  | "cancellation"
  | "staging-failure"
  | "disk-space-failure"
  | "corrupt-recovery"
  | "index-save-crash"

interface ModelDeviceState {
  local: Map<string, V4LogicalFile>
  base: Map<string, V4LogicalFile>
  knownRemoteGeneration: number
}

export interface V4ModelSyncResult {
  staleHeadObserved: boolean
  pendingConflict: boolean
  recoveryRequired: boolean
  unverifiedIndexAdvanced: boolean
}

function cloneFile(file: V4LogicalFile): V4LogicalFile { return { ...file } }
function cloneMap(input: Map<string, V4LogicalFile>): Map<string, V4LogicalFile> {
  return new Map([...input].map(([id, file]) => [id, cloneFile(file)]))
}
function byPath(input: Map<string, V4LogicalFile>, path: string): V4LogicalFile | undefined {
  return [...input.values()].find(file => file.path === path)
}
function replaceById(input: Map<string, V4LogicalFile>, file: V4LogicalFile | undefined, fileId: string): void {
  if (!file) input.delete(fileId)
  else input.set(fileId, cloneFile(file))
}
function applyChanges(target: Map<string, V4LogicalFile>, changes: ReturnType<typeof planV4Sync>["pushes"], side: "after" | "before" = "after"): void {
  for (const change of changes) replaceById(target, side === "after" ? change.after : change.before, change.fileId)
}
function conflictCopyPath(path: string, device: V4ModelDevice, serial: number): string {
  const slash = path.lastIndexOf("/")
  const folder = slash >= 0 ? path.slice(0, slash + 1) : ""
  const name = slash >= 0 ? path.slice(slash + 1) : path
  const dot = name.lastIndexOf(".")
  if (dot <= 0) return `${folder}${name}.conflict-${device}-${serial}`
  return `${folder}${name.slice(0, dot)}.conflict-${device}-${serial}${name.slice(dot)}`
}

export function createV4TwoDeviceModel() {
  let nextId = 1
  let nextCopy = 1
  let clock = 1
  let remoteGeneration = 0
  let remote = new Map<string, V4LogicalFile>()
  const devices: Record<V4ModelDevice, ModelDeviceState> = {
    A: { local: new Map(), base: new Map(), knownRemoteGeneration: 0 },
    B: { local: new Map(), base: new Map(), knownRemoteGeneration: 0 },
  }

  const createFile = (path: string, hash: string, fileId = `file-${nextId++}`): V4LogicalFile => ({
    path, fileId, hash, size: hash.length, mtime: clock++,
  })
  const setPath = (device: V4ModelDevice, path: string, hash: string, recreate = false): string => {
    const state = devices[device]
    const existing = byPath(state.local, path)
    if (existing && !recreate) {
      state.local.set(existing.fileId, { ...existing, hash, size: hash.length, mtime: clock++ })
      return existing.fileId
    }
    if (existing) state.local.delete(existing.fileId)
    const file = createFile(path, hash)
    state.local.set(file.fileId, file)
    return file.fileId
  }

  const finishVerified = (device: V4ModelDevice): void => {
    devices[device].local = cloneMap(remote)
    devices[device].base = cloneMap(remote)
    devices[device].knownRemoteGeneration = remoteGeneration
  }

  const publishLocalPlan = (device: V4ModelDevice, operation: V4SyncOperation, action: V4ModelConflictAction): { pending: boolean; changedRemote: boolean } => {
    const state = devices[device]
    const plan = planV4Sync({ operation, base: [...state.base.values()], local: [...state.local.values()], remote: [...remote.values()] })
    if (action === "ask" && plan.conflicts.length) return { pending: true, changedRemote: false }
    let changedRemote = false
    if (operation === "forcePush") {
      const before = JSON.stringify([...remote.values()].sort((a, b) => a.fileId.localeCompare(b.fileId)))
      remote = cloneMap(state.local)
      changedRemote = before !== JSON.stringify([...remote.values()].sort((a, b) => a.fileId.localeCompare(b.fileId)))
      return { pending: false, changedRemote }
    }
    if (operation === "forcePull") return { pending: false, changedRemote: false }

    if (plan.pushes.length) { applyChanges(remote, plan.pushes); changedRemote = true }
    for (const conflict of plan.conflicts) {
      const local = conflict.local
      const remoteFile = conflict.remote
      if (action === "use-local") {
        replaceById(remote, local, conflict.fileId)
        changedRemote = true
      } else if (action === "use-remote") {
        // No remote mutation; convergence happens in finishVerified.
      } else if (action === "merged") {
        if (!local && !remoteFile) continue
        const merged = createFile(local?.path ?? remoteFile!.path, `merged:${local?.hash ?? "deleted"}:${remoteFile?.hash ?? "deleted"}`, conflict.fileId)
        remote.set(conflict.fileId, merged)
        changedRemote = true
      } else if (action === "keep-local-copy-remote") {
        if (local) {
          const copy = createFile(conflictCopyPath(local.path, device, nextCopy), local.hash, `copy-${nextCopy++}`)
          remote.set(copy.fileId, copy)
          changedRemote = true
        }
        replaceById(remote, remoteFile, conflict.fileId)
      }
    }
    return { pending: false, changedRemote }
  }

  return {
    create(device: V4ModelDevice, path: string, hash: string) { return setPath(device, path, hash) },
    recreate(device: V4ModelDevice, path: string, hash: string) { return setPath(device, path, hash, true) },
    modify(device: V4ModelDevice, path: string, hash: string) {
      const existing = byPath(devices[device].local, path)
      if (!existing) throw new Error(`missing model path: ${path}`)
      setPath(device, path, hash)
    },
    rename(device: V4ModelDevice, from: string, to: string) {
      const existing = byPath(devices[device].local, from)
      if (!existing) throw new Error(`missing model path: ${from}`)
      devices[device].local.set(existing.fileId, { ...existing, path: to, mtime: clock++ })
    },
    renameFolder(device: V4ModelDevice, from: string, to: string) {
      const prefix = `${from.replace(/\/+$/u, "")}/`
      const replacement = `${to.replace(/\/+$/u, "")}/`
      for (const [id, file] of devices[device].local) {
        if (file.path.startsWith(prefix)) devices[device].local.set(id, { ...file, path: replacement + file.path.slice(prefix.length), mtime: clock++ })
      }
    },
    delete(device: V4ModelDevice, path: string) {
      const existing = byPath(devices[device].local, path)
      if (existing) devices[device].local.delete(existing.fileId)
    },
    directRemoteEdit(path: string, hash: string) {
      const existing = byPath(remote, path)
      const file = existing ? { ...existing, hash, size: hash.length, mtime: clock++ } : createFile(path, hash, `direct-${nextId++}`)
      remote.set(file.fileId, file)
      remoteGeneration++
    },
    file(device: V4ModelDevice, path: string) { return byPath(devices[device].local, path) },
    snapshot() {
      const stable = (map: Map<string, V4LogicalFile>) => [...map.values()].map(cloneFile).sort((a, b) => a.fileId.localeCompare(b.fileId))
      return { A: stable(devices.A.local), B: stable(devices.B.local), remote: stable(remote), generation: remoteGeneration }
    },
    sync(device: V4ModelDevice, operation: V4SyncOperation, action: V4ModelConflictAction = "use-local", fault?: V4ModelFault): V4ModelSyncResult {
      const state = devices[device]
      const staleHeadObserved = state.knownRemoteGeneration !== remoteGeneration
      const baseBefore = cloneMap(state.base)
      const localBefore = cloneMap(state.local)
      const remoteBefore = cloneMap(remote)
      const published = publishLocalPlan(device, operation, action)
      if (published.pending) return { staleHeadObserved, pendingConflict: true, recoveryRequired: false, unverifiedIndexAdvanced: false }

      if (fault && !["lost-response", "index-save-crash"].includes(fault)) {
        remote = remoteBefore
        state.local = localBefore
        state.base = baseBefore
        return { staleHeadObserved, pendingConflict: false, recoveryRequired: true, unverifiedIndexAdvanced: false }
      }
      if (published.changedRemote) remoteGeneration++
      if (fault === "lost-response") {
        state.base = baseBefore
        state.local = localBefore
        return { staleHeadObserved, pendingConflict: false, recoveryRequired: true, unverifiedIndexAdvanced: false }
      }
      if (operation === "forcePull") state.local = cloneMap(remote)
      else finishVerified(device)
      if (operation === "forcePull") {
        state.base = cloneMap(remote)
        state.knownRemoteGeneration = remoteGeneration
      }
      if (fault === "index-save-crash") {
        state.base = baseBefore
        return { staleHeadObserved, pendingConflict: false, recoveryRequired: true, unverifiedIndexAdvanced: false }
      }
      return { staleHeadObserved, pendingConflict: false, recoveryRequired: false, unverifiedIndexAdvanced: false }
    },
    storageShape(first: number, second: number): { kind: "pack"; entries: number } | { kind: "chunked"; parts: number } | { kind: "single" } {
      if (first <= 500 && second >= 1) return first >= 64 && second <= 1024 * 1024 ? { kind: "pack", entries: first } : { kind: "single" }
      return first > 50 * 1024 * 1024 ? { kind: "chunked", parts: Math.ceil(first / V4_PART_BYTES) } : { kind: "single" }
    },
    assertNoSilentDataLoss() {
      for (const map of [remote, devices.A.local, devices.B.local, devices.A.base, devices.B.base]) {
        const paths = new Set<string>()
        for (const file of map.values()) {
          if (paths.has(file.path)) throw new Error(`duplicate logical model path: ${file.path}`)
          paths.add(file.path)
          if (!file.fileId || !file.hash) throw new Error("model contains an incomplete logical file")
        }
      }
    },
  }
}
