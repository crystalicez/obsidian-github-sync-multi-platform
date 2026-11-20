import type { GitHubCommitSummary, GitHubTree } from "../github-api"
import { bytesToUtf8 } from "../bytes"
import { decryptV4Payload, V4_ENCRYPTED_PAYLOAD_OVERHEAD_BYTES, type V4Keyring } from "./crypto"
import { assertV4MetadataBytes } from "./metadata-bounds"
import type { V4JournalChange, V4JournalPage, V4VersionDescriptor } from "./history-journal"
import type { V4IndexFileRecord } from "./local-index"
import { expectedV4PathLayout, V4_ROOT, type V4RemoteConfig } from "./protocol-types"
import { V4StorageCodec } from "./storage-codec"
import { assertV4PathLayoutCompatible } from "./sync-session"

export class V4HistoryNotInitializedError extends Error {
  constructor() {
    super("V4 history is not initialized on this GitHub branch.")
    this.name = "V4HistoryNotInitializedError"
  }
}

export class V4HistoryPreviewLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "V4HistoryPreviewLimitError"
  }
}

export interface V4HistoryGithub {
  listCommits(options?: { page?: number; perPage?: number }): Promise<GitHubCommitSummary[]>
  getFileBytes(path: string, ref?: string): Promise<{ bytes: Uint8Array; sha: string } | null>
  getGitCommit(sha: string): Promise<{ sha: string; treeSha: string; parentShas: string[] }>
  getTreeAt(treeSha: string, recursive?: boolean): Promise<GitHubTree>
  getBlob(sha: string): Promise<Uint8Array>
}

export interface V4HistoryCommit extends GitHubCommitSummary {
  source: "plugin" | "external"
  journalId?: string | undefined
}

export interface V4CommitPage { items: V4HistoryCommit[]; page: number; hasMore: boolean }
export interface V4HistoryChange extends V4JournalChange { source: "plugin" | "external" }
export type V4VersionPreview =
  | { kind: "text"; text: string; bytes: Uint8Array }
  | { kind: "image"; mime: string; bytes: Uint8Array }
  | { kind: "binary"; bytes: Uint8Array }

const TEXT_EXTENSIONS = new Set(["md", "txt", "json", "canvas", "yaml", "yml", "csv", "css", "scss", "js", "ts", "tsx", "jsx", "html", "xml"])
export const V4_HISTORY_PREVIEW_MAX_BYTES = 5 * 1024 * 1024

const IMAGE_MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp" }
const SAFE_JOURNAL_ID = /^[A-Za-z0-9_-]{1,128}$/u

function extension(path: string): string { return path.split(".").at(-1)?.toLowerCase() ?? "" }

export class V4HistoryService {
  private readonly codec: V4StorageCodec

  constructor(private readonly input: { github: V4HistoryGithub; config: V4RemoteConfig; keyring?: V4Keyring | undefined }) {
    assertV4PathLayoutCompatible(input.config, { ...input.config, pathLayout: expectedV4PathLayout(input.config.mode) }, "normal")
    const pathLayout = input.config.pathLayout ?? expectedV4PathLayout(input.config.mode)
    this.codec = new V4StorageCodec({
      mode: input.config.mode,
      pathLayout,
      keyring: input.keyring,
    })
  }

  async listCommits(page = 1): Promise<V4CommitPage> {
    const items = (await this.input.github.listCommits({ page, perPage: 50 })).map(commit => {
      const match = /^obsidian-sync-v4:([^\s]+)$/u.exec(commit.message.split("\n", 1)[0] ?? "")
      const journalId = match?.[1]
      const isPluginCommit = journalId !== undefined && SAFE_JOURNAL_ID.test(journalId)
      return { ...commit, source: isPluginCommit ? "plugin" as const : "external" as const, journalId: isPluginCommit ? journalId : undefined }
    })
    return { items, page, hasMore: items.length === 50 }
  }

  async getCommitChanges(commit: V4HistoryCommit): Promise<V4HistoryChange[]> {
    if (commit.source === "plugin" && commit.journalId) return this.readJournal(commit.journalId, commit.sha)
    return this.diffExternalCommit(commit)
  }

  async previewChange(commit: V4HistoryCommit, change: V4HistoryChange): Promise<V4VersionPreview> {
    const descriptor = change.after ?? change.before
    if (!descriptor) return { kind: "binary", bytes: new Uint8Array() }
    if (!Number.isSafeInteger(descriptor.size) || descriptor.size < 0) {
      throw new V4HistoryPreviewLimitError("V4 history preview has an invalid declared size.")
    }
    if (descriptor.size > V4_HISTORY_PREVIEW_MAX_BYTES) {
      throw new V4HistoryPreviewLimitError(`V4 history preview exceeds the ${V4_HISTORY_PREVIEW_MAX_BYTES}-byte preview limit.`)
    }
    const gitCommit = await this.input.github.getGitCommit(commit.sha)
    const parentSha = gitCommit.parentShas[0] ?? commit.parentShas[0]
    if (!change.after && !parentSha) throw new Error("Deleted version has no parent commit.")
    const versionCommit = change.after ? gitCommit : await this.input.github.getGitCommit(parentSha!)
    const tree = await this.input.github.getTreeAt(versionCommit.treeSha, true)
    if (tree.truncated) throw new Error("Historical Git tree is truncated; preview is unsafe.")
    const blobs = new Map(tree.tree.filter(node => node.type === "blob").map(node => [node.path, node]))
    const record = this.recordFromDescriptor(change, descriptor)
    const encryptionOverhead = this.input.config.mode === "encrypted" ? V4_ENCRYPTED_PAYLOAD_OVERHEAD_BYTES : 0
    const maxSingleBlobBytes = V4_HISTORY_PREVIEW_MAX_BYTES + encryptionOverhead
    const partPaths = record.storage === "chunked" ? record.partPaths : undefined
    let maxChunkWireBytes = V4_HISTORY_PREVIEW_MAX_BYTES
    if (record.storage === "chunked") {
      if (!Array.isArray(partPaths) || partPaths.length === 0 || partPaths.length > 256
        || !partPaths.every(path => typeof path === "string" && path.length > 0)
        || new Set(partPaths).size !== partPaths.length) {
        throw new V4HistoryPreviewLimitError("V4 history preview part count or paths exceed the safe limit.")
      }
      maxChunkWireBytes += partPaths.length * encryptionOverhead
      let remainingBytes = maxChunkWireBytes
      for (const path of partPaths) {
        const blob = blobs.get(path)
        if (!blob) throw new Error(`Version blob is missing: ${path}`)
        if (!Number.isSafeInteger(blob.size) || blob.size === undefined || blob.size < 0
          || blob.size > remainingBytes) {
          throw new V4HistoryPreviewLimitError("V4 history preview chunk sizes exceed the safe limit.")
        }
        remainingBytes -= blob.size
      }
    }
    let fetchedChunkBytes = 0
    const readBlob = async (path: string): Promise<Uint8Array> => {
      const blob = blobs.get(path)
      if (!blob) throw new Error(`Version blob is missing: ${path}`)
      if (record.storage === "single" && blob.size !== undefined
        && (!Number.isSafeInteger(blob.size) || blob.size < 0 || blob.size > maxSingleBlobBytes)) {
        throw new V4HistoryPreviewLimitError("V4 history preview exceeds the single-blob size limit.")
      }
      const fetched = await this.input.github.getBlob(blob.sha)
      if (record.storage === "single" && fetched.byteLength > maxSingleBlobBytes) {
        throw new V4HistoryPreviewLimitError("V4 history preview exceeds the single-blob size limit.")
      }
      if (record.storage === "chunked") {
        fetchedChunkBytes += fetched.byteLength
        if (fetchedChunkBytes > maxChunkWireBytes) {
          throw new V4HistoryPreviewLimitError("V4 history preview exceeds the multipart size limit.")
        }
      }
      return fetched
    }
    let bytes: Uint8Array
    if (record.storage === "chunked") {
      bytes = new Uint8Array(record.size)
      let offset = 0
      // readToSink fetches one part at a time, rather than launching all
      // remote blob requests at once for a historical multipart preview.
      await this.codec.readToSink({
        record,
        reader: readBlob,
        sink: {
          async append(part) { bytes.set(part, offset); offset += part.byteLength },
          async finish() { throw new Error("History preview does not persist a stage.") },
          async abort() {},
        },
      })
    } else {
      bytes = await this.codec.read(record, readBlob)
    }
    if (bytes.byteLength > V4_HISTORY_PREVIEW_MAX_BYTES) {
      throw new V4HistoryPreviewLimitError("V4 history preview exceeds the decoded content size limit.")
    }
    const ext = extension(change.path)
    if (TEXT_EXTENSIONS.has(ext)) return { kind: "text", text: bytesToUtf8(bytes), bytes }
    if (IMAGE_MIME[ext]) return { kind: "image", mime: IMAGE_MIME[ext], bytes }
    return { kind: "binary", bytes }
  }

  async getFileVersions(fileId: string, maxPages = 20): Promise<Array<{ commit: V4HistoryCommit; change: V4HistoryChange }>> {
    const versions: Array<{ commit: V4HistoryCommit; change: V4HistoryChange }> = []
    for (let page = 1; page <= maxPages; page++) {
      const commits = await this.listCommits(page)
      for (const commit of commits.items.filter(item => item.source === "plugin")) {
        for (const change of await this.getCommitChanges(commit)) if (change.fileId === fileId) versions.push({ commit, change })
      }
      if (!commits.hasMore) break
    }
    return versions.reverse()
  }

  private async readJournal(journalId: string, commitSha: string): Promise<V4HistoryChange[]> {
    if (!SAFE_JOURNAL_ID.test(journalId)) throw new Error("Invalid V4 history journal ID.")
    const first = await this.readJournalPage(journalId, 0, commitSha)
    const pages = [first]
    for (let page = 1; page < first.pageCount; page++) {
      const continuation = await this.readJournalPage(journalId, page, commitSha)
      if (continuation.pageCount !== first.pageCount) throw new Error("V4 history journal page count is inconsistent.")
      pages.push(continuation)
    }
    return pages.flatMap(page => page.changes.map(change => ({ ...change, source: "plugin" as const })))
  }

  private async readJournalPage(journalId: string, page: number, commitSha: string): Promise<V4JournalPage> {
    const encrypted = this.input.config.mode === "encrypted"
    const path = `${V4_ROOT}/journals/${journalId}/${String(page).padStart(6, "0")}.${encrypted ? "enc" : "json"}`
    const file = await this.input.github.getFileBytes(path, commitSha)
    if (!file) throw new Error(`V4 history journal is missing: ${journalId}/${page}`)
    assertV4MetadataBytes(file.bytes, "journal", encrypted)
    const bytes = encrypted
      ? await decryptV4Payload(this.input.keyring!.journalKey, file.bytes, { kind: "journal", aad: `${this.input.config.repoId}:${journalId}:${page}` })
      : file.bytes
    assertV4MetadataBytes(bytes, "journal")
    const parsed: unknown = JSON.parse(bytesToUtf8(bytes))
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("V4 history journal is malformed.")
    }
    const journal = parsed as Partial<V4JournalPage>
    if (journal.journalId !== journalId || journal.page !== page) throw new Error("V4 history journal identity mismatch.")
    if (typeof journal.pageCount !== "number" || !Number.isSafeInteger(journal.pageCount)
      || journal.pageCount < 1 || journal.pageCount > 256) {
      throw new Error("V4 history journal page count exceeds the protocol limit.")
    }
    if (!Array.isArray(journal.changes) || journal.changes.length > 500) {
      throw new Error("V4 history journal change count exceeds the per-page limit.")
    }
    return journal as V4JournalPage
  }

  private async diffExternalCommit(commit: V4HistoryCommit): Promise<V4HistoryChange[]> {
    const currentCommit = await this.input.github.getGitCommit(commit.sha)
    const current = await this.input.github.getTreeAt(currentCommit.treeSha, true)
    const parentSha = commit.parentShas[0] ?? currentCommit.parentShas[0]
    const parent = parentSha
      ? await this.input.github.getTreeAt((await this.input.github.getGitCommit(parentSha)).treeSha, true)
      : { tree: [] } as unknown as GitHubTree
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

  private recordFromDescriptor(change: V4HistoryChange, descriptor: V4VersionDescriptor): V4IndexFileRecord {
    return {
      path: change.path,
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
  }
}
