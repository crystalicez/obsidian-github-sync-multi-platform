import type { GitHubCommitSummary, GitHubTree } from "../github-api"
import { bytesToUtf8 } from "../bytes"
import { decryptV4Payload, type V4Keyring } from "./crypto"
import { isV4JournalId, V4_JOURNAL_PAGE_SIZE, V4_MAX_JOURNAL_PAGES, type V4JournalChange, type V4JournalPage, type V4VersionDescriptor } from "./history-journal"
import { createEmptyV4LocalIndex, type V4IndexFileRecord } from "./local-index"
import { normalizeV4VaultPath } from "./paths"
import { expectedV4PathLayout, V4_ROOT, type V4RemoteConfig } from "./protocol-types"
import { assertV4RemoteRecordDescriptor } from "./remote-index"
import { V4StorageCodec } from "./storage-codec"
import { assertV4PathLayoutCompatible, loadV4RemoteConfig, loadV4RemoteState } from "./remote-loader"

export interface V4HistoryGithub {
  listCommits(options?: { page?: number; perPage?: number }): Promise<GitHubCommitSummary[]>
  getFileBytes(path: string, ref?: string): Promise<{ bytes: Uint8Array; sha: string } | null>
  getGitCommit(sha: string): Promise<{ sha: string; treeSha: string; parentShas: string[] }>
  getTreeAt(treeSha: string, recursive?: boolean): Promise<GitHubTree>
  getBlob(sha: string): Promise<Uint8Array>
}

export interface V4HistoryCommit extends GitHubCommitSummary {
  source: "plugin" | "external"
  journalId?: string
}

export interface V4CommitPage { items: V4HistoryCommit[]; page: number; hasMore: boolean }
export interface V4HistoryChange extends V4JournalChange { source: "plugin" | "external" }
export type V4VersionPreview =
  | { kind: "text"; text: string; bytes: Uint8Array }
  | { kind: "image"; mime: string; bytes: Uint8Array }
  | { kind: "binary"; bytes: Uint8Array }

const TEXT_EXTENSIONS = new Set(["md", "txt", "json", "canvas", "yaml", "yml", "csv", "css", "scss", "js", "ts", "tsx", "jsx", "html", "xml"])
export const V4_HISTORY_PREVIEW_MAX_BYTES = 5 * 1024 * 1024
export const V4_HISTORY_MAX_JOURNAL_PAGE_READS = 1024

const IMAGE_MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp" }

function extension(path: string): string { return path.split(".").at(-1)?.toLowerCase() ?? "" }

export class V4HistoryService {
  private readonly codec: V4StorageCodec

  constructor(private readonly input: { github: V4HistoryGithub; config: V4RemoteConfig; keyring?: V4Keyring; assertCurrent?: () => void }) {
    this.assertCurrent()
    assertV4PathLayoutCompatible(input.config, { ...input.config, pathLayout: expectedV4PathLayout(input.config.mode) }, "normal")
    const pathLayout = input.config.pathLayout ?? expectedV4PathLayout(input.config.mode)
    this.codec = new V4StorageCodec({
      mode: input.config.mode,
      pathLayout,
      keyring: input.keyring,
    })
  }

  async listCommits(page = 1): Promise<V4CommitPage> {
    this.assertCurrent()
    const listed = await this.input.github.listCommits({ page, perPage: 50 })
    this.assertCurrent()
    const items = listed.map(commit => {
      const match = /^obsidian-sync-v4:([^\s]+)$/u.exec(commit.message.split("\n", 1)[0])
      const journalId = match?.[1]
      const plugin = isV4JournalId(journalId)
      return { ...commit, source: plugin ? "plugin" as const : "external" as const, journalId: plugin ? journalId : undefined }
    })
    return { items, page, hasMore: items.length === 50 }
  }

  async getCommitChanges(commit: V4HistoryCommit): Promise<V4HistoryChange[]> {
    this.assertCurrent()
    const changes = commit.source === "plugin" && commit.journalId
      ? await this.readJournal(commit.journalId, commit.sha)
      : await this.diffExternalCommit(commit)
    this.assertCurrent()
    return changes
  }

  async previewChange(commit: V4HistoryCommit, change: V4HistoryChange): Promise<V4VersionPreview> {
    this.assertCurrent()
    const descriptor = change.after ?? change.before
    if (!descriptor) return { kind: "binary", bytes: new Uint8Array() }
    if (descriptor.size > V4_HISTORY_PREVIEW_MAX_BYTES) {
      throw new Error(`V4 history preview exceeds the ${V4_HISTORY_PREVIEW_MAX_BYTES}-byte preview limit.`)
    }
    const gitCommit = await this.input.github.getGitCommit(commit.sha)
    this.assertCurrent()
    const parentSha = gitCommit.parentShas[0] ?? commit.parentShas[0]
    if (!change.after && !parentSha) throw new Error("Deleted version has no parent commit.")
    const versionCommit = change.after ? gitCommit : await this.input.github.getGitCommit(parentSha!)
    this.assertCurrent()
    const tree = await this.input.github.getTreeAt(versionCommit.treeSha, true)
    this.assertCurrent()
    if (tree.truncated) throw new Error("Historical Git tree is truncated; preview is unsafe.")
    const shas = new Map(tree.tree.filter(node => node.type === "blob").map(node => [node.path, node.sha]))
    let bytes: Uint8Array
    if (change.source === "external") {
      const sha = shas.get(descriptor.remotePath)
      if (!sha) throw new Error(`Version blob is missing: ${descriptor.remotePath}`)
      bytes = await this.input.github.getBlob(sha)
      this.assertCurrent()
    } else {
      const record = this.recordFromDescriptor(change, descriptor)
      const readBlob = async (path: string) => {
        this.assertCurrent()
        const sha = shas.get(path)
        if (!sha) throw new Error(`Version blob is missing: ${path}`)
        const blob = await this.input.github.getBlob(sha)
        this.assertCurrent()
        return blob
      }
      if (record.storage === "pack") {
        const remoteConfig = await loadV4RemoteConfig({ github: this.input.github, desiredConfig: this.input.config }, versionCommit.sha, "normal")
        if (!remoteConfig) throw new Error("Historical V4 config is missing.")
        const historicalIndex = createEmptyV4LocalIndex({
          repoId: remoteConfig.repoId,
          deviceId: "history-preview",
          mode: remoteConfig.mode,
          pathLayout: expectedV4PathLayout(remoteConfig.mode),
        })
        const remoteState = await loadV4RemoteState({ github: this.input.github, index: historicalIndex, keyring: this.input.keyring }, versionCommit.sha, remoteConfig)
        if (!remoteState) throw new Error("Historical V4 state is missing.")
        const packRecords = remoteState.records.filter(candidate => candidate.storage === "pack"
          && candidate.packId === record.packId
          && candidate.remotePath === record.remotePath)
        if (!packRecords.some(candidate => candidate.fileId === record.fileId)) {
          throw new Error(`Historical V4 packed record is missing: ${record.fileId}`)
        }
        const entries = await this.codec.readPackRecords(packRecords, readBlob)
        const packed = entries.get(record.fileId)
        if (!packed) throw new Error(`Historical V4 packed entry is missing after verified decode: ${record.fileId}`)
        bytes = packed
      } else {
        bytes = await this.codec.read(record, readBlob)
      }
      this.assertCurrent()
    }
    const ext = extension(change.path)
    if (TEXT_EXTENSIONS.has(ext) && bytes.byteLength <= 5 * 1024 * 1024) return { kind: "text", text: bytesToUtf8(bytes), bytes }
    if (IMAGE_MIME[ext]) return { kind: "image", mime: IMAGE_MIME[ext], bytes }
    return { kind: "binary", bytes }
  }

  async getFileVersions(fileId: string, maxPages = 20): Promise<Array<{ commit: V4HistoryCommit; change: V4HistoryChange }>> {
    this.assertCurrent()
    const versions: Array<{ commit: V4HistoryCommit; change: V4HistoryChange }> = []
    const journalBudget = { remaining: V4_HISTORY_MAX_JOURNAL_PAGE_READS }
    for (let page = 1; page <= maxPages; page++) {
      const commits = await this.listCommits(page)
      for (const commit of commits.items.filter(item => item.source === "plugin")) {
        for (const change of await this.readJournal(commit.journalId!, commit.sha, journalBudget)) {
          if (change.fileId === fileId) versions.push({ commit, change })
        }
      }
      if (!commits.hasMore) break
    }
    this.assertCurrent()
    return versions.reverse()
  }

  private assertCurrent(): void {
    this.input.assertCurrent?.()
  }

  private async readJournal(
    journalId: string,
    commitSha: string,
    budget?: { remaining: number },
  ): Promise<V4HistoryChange[]> {
    if (!isV4JournalId(journalId)) throw new Error("V4 history journal id is invalid.")
    const first = await this.readJournalPage(journalId, 0, commitSha, undefined, budget)
    const pages = [first]
    for (let page = 1; page < first.pageCount; page++) {
      pages.push(await this.readJournalPage(journalId, page, commitSha, first.pageCount, budget))
    }
    return pages.flatMap(page => page.changes.map(change => ({ ...change, source: "plugin" as const })))
  }

  private async readJournalPage(
    journalId: string,
    page: number,
    commitSha: string,
    expectedPageCount?: number,
    budget?: { remaining: number },
  ): Promise<V4JournalPage> {
    const encrypted = this.input.config.mode === "encrypted"
    const path = `${V4_ROOT}/journals/${journalId}/${String(page).padStart(6, "0")}.${encrypted ? "enc" : "json"}`
    this.assertCurrent()
    if (budget) {
      if (budget.remaining <= 0) throw new Error("V4 history journal read budget exceeded.")
      budget.remaining--
    }
    const file = await this.input.github.getFileBytes(path, commitSha)
    this.assertCurrent()
    if (!file) throw new Error(`V4 history journal is missing: ${journalId}/${page}`)
    const bytes = encrypted
      ? await decryptV4Payload(this.input.keyring!.journalKey, file.bytes, { kind: "journal", aad: `${this.input.config.repoId}:${journalId}:${page}` })
      : file.bytes
    const journal = JSON.parse(bytesToUtf8(bytes)) as V4JournalPage
    if (!journal || typeof journal !== "object" || Array.isArray(journal)) throw new Error("V4 history journal is malformed.")
    if (journal.journalId !== journalId || journal.page !== page) throw new Error("V4 history journal identity mismatch.")
    if (!Number.isSafeInteger(journal.pageCount) || journal.pageCount < 1 || journal.pageCount > V4_MAX_JOURNAL_PAGES) {
      throw new Error("V4 history journal page count exceeds the protocol limit.")
    }
    if (expectedPageCount !== undefined && journal.pageCount !== expectedPageCount) {
      throw new Error("V4 history journal page count is inconsistent.")
    }
    if (!Array.isArray(journal.changes) || journal.changes.length > V4_JOURNAL_PAGE_SIZE) {
      throw new Error("V4 history journal change count exceeds the per-page limit.")
    }
    for (const change of journal.changes) this.assertJournalChange(change)
    return journal
  }

  private async diffExternalCommit(commit: V4HistoryCommit): Promise<V4HistoryChange[]> {
    this.assertCurrent()
    const currentCommit = await this.input.github.getGitCommit(commit.sha)
    this.assertCurrent()
    const current = await this.input.github.getTreeAt(currentCommit.treeSha, true)
    this.assertCurrent()
    const parentSha = commit.parentShas[0] ?? currentCommit.parentShas[0]
    let parent: GitHubTree
    if (parentSha) {
      const parentCommit = await this.input.github.getGitCommit(parentSha)
      this.assertCurrent()
      parent = await this.input.github.getTreeAt(parentCommit.treeSha, true)
      this.assertCurrent()
    } else {
      parent = { tree: [] } as unknown as GitHubTree
    }
    if (current.truncated || parent.truncated) throw new Error("Historical Git tree is truncated; change list is unsafe.")
    const before = new Map(parent.tree.filter(node => node.type === "blob").map(node => [node.path, node]))
    const after = new Map(current.tree.filter(node => node.type === "blob").map(node => [node.path, node]))
    const paths = new Set([...before.keys(), ...after.keys()])
    const changes: V4HistoryChange[] = []
    for (const path of paths) {
      const oldNode = before.get(path)
      const newNode = after.get(path)
      if (oldNode?.sha === newNode?.sha) continue
      const descriptor = (node: typeof oldNode): V4VersionDescriptor | undefined => node ? { remotePath: path, sha: node.sha, size: node.size ?? 0 } : undefined
      changes.push({
        source: "external",
        fileId: path,
        kind: !oldNode ? "create" : !newNode ? "delete" : "modify",
        path,
        before: descriptor(oldNode),
        after: descriptor(newNode),
      })
    }
    return changes.sort((a, b) => a.path.localeCompare(b.path))
  }

  private assertJournalChange(value: unknown): asserts value is V4JournalChange {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("V4 history journal change shape is invalid.")
    const change = value as Partial<V4JournalChange>
    if (typeof change.fileId !== "string" || !change.fileId) throw new Error("V4 history journal change fileId is invalid.")
    if (change.kind !== "create" && change.kind !== "modify" && change.kind !== "delete" && change.kind !== "rename") {
      throw new Error("V4 history journal change kind is invalid.")
    }
    if (!this.isNormalizedJournalPath(change.path)) throw new Error("V4 history journal change path is invalid.")
    if (change.previousPath !== undefined && !this.isNormalizedJournalPath(change.previousPath)) {
      throw new Error("V4 history journal previous path is invalid.")
    }
    const hasBefore = change.before !== undefined
    const hasAfter = change.after !== undefined
    const hasPreviousPath = change.previousPath !== undefined
    if (
      (change.kind === "create" && (hasBefore || !hasAfter || hasPreviousPath))
      || (change.kind === "delete" && (!hasBefore || hasAfter || hasPreviousPath))
      || (change.kind === "modify" && (!hasBefore || !hasAfter || hasPreviousPath))
      || (change.kind === "rename" && (!hasBefore || !hasAfter || !hasPreviousPath || change.previousPath === change.path))
    ) {
      throw new Error("V4 history journal change shape is inconsistent with its kind.")
    }
    const typed = change as V4JournalChange
    if (typed.before !== undefined) {
      this.assertJournalDescriptor(typed, typed.before, typed.kind === "rename" ? typed.previousPath! : typed.path)
    }
    if (typed.after !== undefined) this.assertJournalDescriptor(typed, typed.after, typed.path)
  }

  private isNormalizedJournalPath(value: unknown): value is string {
    if (typeof value !== "string") return false
    try { return normalizeV4VaultPath(value) === value } catch { return false }
  }

  private assertJournalDescriptor(change: V4JournalChange, value: unknown, logicalPath: string): asserts value is V4VersionDescriptor {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("V4 history journal descriptor shape is invalid.")
    const descriptor = value as Partial<V4VersionDescriptor>
    if (typeof descriptor.sha !== "string") throw new Error("V4 history journal descriptor SHA is invalid.")
    this.recordFromDescriptor(change, descriptor as V4VersionDescriptor, logicalPath)
  }

  private recordFromDescriptor(
    change: Pick<V4JournalChange, "path" | "fileId">,
    descriptor: V4VersionDescriptor,
    logicalPath = change.path,
  ): V4IndexFileRecord {
    const record: V4IndexFileRecord = {
      path: logicalPath,
      pathId: descriptor.pathId ?? change.fileId,
      fileId: change.fileId,
      plaintextSha256: descriptor.plaintextSha256 ?? "",
      size: descriptor.size,
      mtime: descriptor.mtime ?? 0,
      remoteVersion: descriptor.remoteVersion ?? "",
      remotePath: descriptor.remotePath,
      storage: descriptor.storage ?? "single",
      partPaths: descriptor.partPaths,
      packId: descriptor.packId,
    }
    assertV4RemoteRecordDescriptor(record, this.input.config)
    return record
  }
}
