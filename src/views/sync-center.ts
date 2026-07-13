import { ItemView, Notice, WorkspaceLeaf } from "obsidian"
import type FastSync from "../main"
import type { V4HistoryChange, V4HistoryCommit, V4HistoryService, V4VersionPreview } from "../lib/v4/history-service"

export const V4_SYNC_CENTER_VIEW = "github-sync-v4-center"

export class V4SyncCenterView extends ItemView {
  private service?: V4HistoryService
  private page = 1
  private selected?: V4HistoryCommit
  private objectUrl?: string

  constructor(leaf: WorkspaceLeaf, private readonly plugin: FastSync) { super(leaf) }
  getViewType(): string { return V4_SYNC_CENTER_VIEW }
  getDisplayText(): string { return "GitHub Sync Center" }
  getIcon(): string { return "git-compare-arrows" }

  async onOpen(): Promise<void> { await this.renderCommitMode() }
  async onClose(): Promise<void> { this.releaseObjectUrl() }

  private async ensureService(): Promise<V4HistoryService> {
    this.service ??= await this.plugin.v4Runtime.createHistoryService()
    return this.service
  }

  private shell(title: string): { body: HTMLElement; detail: HTMLElement } {
    this.releaseObjectUrl()
    this.contentEl.empty()
    this.contentEl.addClass("github-sync-center")
    const header = this.contentEl.createDiv({ cls: "github-sync-center__header" })
    header.createEl("h3", { text: title })
    const actions = header.createDiv({ cls: "github-sync-center__actions" })
    actions.createEl("button", { text: "Commits" }).onclick = () => void this.renderCommitMode()
    actions.createEl("button", { text: "Current file" }).onclick = () => void this.renderFileMode()
    actions.createEl("button", { text: "Sync now", cls: "mod-cta" }).onclick = () => void this.plugin.v4Runtime.manualSync()
    const layout = this.contentEl.createDiv({ cls: "github-sync-center__layout" })
    return {
      body: layout.createDiv({ cls: "github-sync-center__master" }),
      detail: layout.createDiv({ cls: "github-sync-center__detail" }),
    }
  }

  private async renderCommitMode(): Promise<void> {
    const { body, detail } = this.shell("Commit history")
    body.createEl("p", { text: "Loading commits…", cls: "github-sync-center__muted" })
    try {
      const page = await (await this.ensureService()).listCommits(this.page)
      body.empty()
      const pager = body.createDiv({ cls: "github-sync-center__pager" })
      const previous = pager.createEl("button", { text: "Previous" })
      previous.disabled = this.page <= 1
      previous.onclick = () => { this.page--; void this.renderCommitMode() }
      pager.createEl("span", { text: `Page ${this.page}` })
      const next = pager.createEl("button", { text: "Next" })
      next.disabled = !page.hasMore
      next.onclick = () => { this.page++; void this.renderCommitMode() }
      if (page.items.length === 0) body.createEl("p", { text: "No commits found." })
      for (const commit of page.items) {
        const row = body.createEl("button", { cls: "github-sync-center__row" })
        row.createDiv({ text: commit.message.split("\n", 1)[0], cls: "github-sync-center__row-title" })
        row.createDiv({ text: `${commit.source === "plugin" ? "Synced" : "External"} · ${commit.authoredAt || commit.sha.slice(0, 8)}`, cls: "github-sync-center__muted" })
        row.onclick = () => void this.renderCommitDetail(commit, detail)
      }
      if (this.selected) await this.renderCommitDetail(this.selected, detail)
      else detail.createEl("p", { text: "Select a commit to inspect its changes.", cls: "github-sync-center__muted" })
    } catch (error) { this.renderError(body, error) }
  }

  private async renderCommitDetail(commit: V4HistoryCommit, detail: HTMLElement): Promise<void> {
    this.selected = commit
    detail.empty()
    detail.createEl("h4", { text: commit.message.split("\n", 1)[0] })
    detail.createEl("p", { text: "Loading changes…", cls: "github-sync-center__muted" })
    try {
      const changes = await (await this.ensureService()).getCommitChanges(commit)
      detail.empty()
      detail.createEl("h4", { text: `${changes.length} changed file${changes.length === 1 ? "" : "s"}` })
      const list = detail.createDiv({ cls: "github-sync-center__changes" })
      const preview = detail.createDiv({ cls: "github-sync-center__preview" })
      for (const change of changes) {
        const row = list.createEl("button", { cls: "github-sync-center__change" })
        row.createEl("span", { text: change.kind.toUpperCase(), cls: `github-sync-center__badge is-${change.kind}` })
        row.createEl("span", { text: change.previousPath ? `${change.previousPath} → ${change.path}` : change.path })
        row.onclick = () => void this.renderPreview(commit, change, preview)
      }
    } catch (error) { this.renderError(detail, error) }
  }

  private async renderFileMode(): Promise<void> {
    const active = this.app.workspace.getActiveFile()
    const { body, detail } = this.shell(active ? `Versions of ${active.path}` : "File versions")
    if (!active) { body.createEl("p", { text: "Open a file to view its versions." }); return }
    body.createEl("p", { text: "Loading versions…", cls: "github-sync-center__muted" })
    try {
      const fileId = await this.plugin.v4Runtime.fileIdForPath(active.path)
      if (!fileId) { body.empty(); body.createEl("p", { text: "This file has not been synced by V4 yet." }); return }
      const versions = await (await this.ensureService()).getFileVersions(fileId)
      body.empty()
      for (const version of versions) {
        const row = body.createEl("button", { cls: "github-sync-center__row" })
        row.createDiv({ text: `${version.change.kind.toUpperCase()} · ${version.change.path}`, cls: "github-sync-center__row-title" })
        row.createDiv({ text: version.commit.authoredAt || version.commit.sha.slice(0, 8), cls: "github-sync-center__muted" })
        row.onclick = () => void this.renderPreview(version.commit, version.change, detail)
      }
      if (versions.length === 0) body.createEl("p", { text: "No versions found in the loaded history." })
    } catch (error) { this.renderError(body, error) }
  }

  private async renderPreview(commit: V4HistoryCommit, change: V4HistoryChange, container: HTMLElement): Promise<void> {
    container.empty()
    container.createEl("h4", { text: change.path })
    container.createEl("p", { text: "Loading preview…", cls: "github-sync-center__muted" })
    try {
      const preview = await (await this.ensureService()).previewChange(commit, change)
      container.empty()
      container.createEl("h4", { text: change.path })
      this.appendPreview(container, preview)
    } catch (error) { this.renderError(container, error) }
  }

  private appendPreview(container: HTMLElement, preview: V4VersionPreview): void {
    this.releaseObjectUrl()
    if (preview.kind === "text") {
      container.createEl("pre", { text: preview.text, cls: "github-sync-center__text-preview" })
      return
    }
    if (preview.kind === "image") {
      this.objectUrl = URL.createObjectURL(new Blob([preview.bytes as BlobPart], { type: preview.mime }))
      container.createEl("img", { attr: { src: this.objectUrl, alt: "Historical version preview" } })
      return
    }
    container.createEl("p", { text: `Binary file · ${preview.bytes.byteLength.toLocaleString()} bytes` })
  }

  private releaseObjectUrl(): void { if (this.objectUrl) URL.revokeObjectURL(this.objectUrl); this.objectUrl = undefined }
  private renderError(container: HTMLElement, error: unknown): void {
    container.empty()
    const message = (error as Error).message
    container.createEl("p", { text: message, cls: "github-sync-center__error" })
    new Notice(`GitHub Sync Center: ${message}`)
  }
}
