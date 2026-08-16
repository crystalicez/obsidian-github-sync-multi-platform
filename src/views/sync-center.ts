import { ItemView, Notice, WorkspaceLeaf } from "obsidian"
import type FastSync from "../main"
import type { V4HistoryChange, V4HistoryCommit, V4HistoryService, V4VersionPreview } from "../lib/v4/history-service"
import {
  formatV4Duration,
  formatV4PhaseLabel,
  formatV4PhaseTiming,
  middleTruncateV4Path,
  remainingV4Progress,
  type V4DirectionalProgress,
  type V4SyncProgressSnapshot,
} from "../lib/v4/progress"

export const V4_SYNC_CENTER_VIEW = "github-sync-v4-center"

interface V4ViewRenderGeneration {
  open: number
  render: number
}

export class V4SyncCenterView extends ItemView {
  private service?: V4HistoryService
  private page = 1
  private selected?: V4HistoryCommit
  private objectUrl?: string
  private progressCard?: HTMLElement
  private progressLive?: HTMLElement
  private progressContext?: HTMLElement
  private progressDetails?: HTMLElement
  private progressTimings?: HTMLElement
  private progressLifecycle?: V4SyncProgressSnapshot["lifecycle"]
  private progressLiveSignature?: string
  private progressContextSignature?: string
  private progressDetailsSignature?: string
  private progressTimingsSignature?: string
  private unsubscribeProgress?: () => void
  private openGeneration = 0
  private renderGeneration = 0
  private isOpen = false

  constructor(leaf: WorkspaceLeaf, private readonly plugin: FastSync) { super(leaf) }
  getViewType(): string { return V4_SYNC_CENTER_VIEW }
  getDisplayText(): string { return "GitHub Sync Center" }
  getIcon(): string { return "git-compare-arrows" }

  async onOpen(): Promise<void> {
    this.isOpen = true
    this.openGeneration++
    this.renderGeneration++
    this.unsubscribeProgress?.()
    this.unsubscribeProgress = this.plugin.v4Runtime.subscribeProgress(snapshot => this.renderProgressCard(snapshot))
    await this.renderCommitMode()
  }
  async onClose(): Promise<void> {
    this.isOpen = false
    this.openGeneration++
    this.renderGeneration++
    this.unsubscribeProgress?.()
    this.unsubscribeProgress = undefined
    this.clearProgressElements()
    this.releaseObjectUrl()
  }

  private beginRender(): V4ViewRenderGeneration | undefined {
    if (!this.isOpen) return undefined
    return { open: this.openGeneration, render: ++this.renderGeneration }
  }

  private isCurrent(generation: V4ViewRenderGeneration): boolean {
    return this.isOpen
      && generation.open === this.openGeneration
      && generation.render === this.renderGeneration
  }

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
    this.clearProgressElements()
    this.progressCard = this.contentEl.createDiv({ cls: "github-sync-center__progress" })
    const progressHeading = this.progressCard.createDiv({ cls: "github-sync-center__progress-heading" })
    this.progressLive = progressHeading.createEl("strong", { cls: "github-sync-center__progress-live" })
    this.progressLive.setAttribute("role", "status")
    this.progressLive.setAttribute("aria-live", "polite")
    this.progressLive.setAttribute("aria-atomic", "true")
    this.progressContext = progressHeading.createEl("span", { cls: "github-sync-center__muted" })
    this.progressDetails = this.progressCard.createDiv({ cls: "github-sync-center__progress-details" })
    this.progressTimings = this.progressCard.createDiv({ cls: "github-sync-center__timings" })
    this.renderProgressCard(this.plugin.v4Runtime.progressSnapshot)
    const layout = this.contentEl.createDiv({ cls: "github-sync-center__layout" })
    return {
      body: layout.createDiv({ cls: "github-sync-center__master" }),
      detail: layout.createDiv({ cls: "github-sync-center__detail" }),
    }
  }

  private renderProgressCard(snapshot: V4SyncProgressSnapshot): void {
    const card = this.progressCard
    const live = this.progressLive
    const contextElement = this.progressContext
    const details = this.progressDetails
    const timingsElement = this.progressTimings
    if (!card || !live || !contextElement || !details || !timingsElement) return

    if (snapshot.lifecycle !== this.progressLifecycle) {
      if (this.progressLifecycle) card.removeClass(`is-${this.progressLifecycle}`)
      card.addClass(`is-${snapshot.lifecycle}`)
      this.progressLifecycle = snapshot.lifecycle
    }

    const heading = this.progressHeading(snapshot)
    const liveSignature = `${snapshot.lifecycle}\u0000${snapshot.phase ?? ""}\u0000${heading}`
    if (liveSignature !== this.progressLiveSignature) {
      live.setText(heading)
      this.progressLiveSignature = liveSignature
    }
    const context = [
      snapshot.operation && this.operationLabel(snapshot.operation),
      snapshot.trigger && this.triggerLabel(snapshot.trigger),
      snapshot.attempt > 0 && `Attempt ${snapshot.attempt}`,
    ].filter((value): value is string => Boolean(value))
    const contextText = context.join(" · ")
    if (contextText !== this.progressContextSignature) {
      contextElement.setText(contextText)
      this.progressContextSignature = contextText
    }

    const detailsSignature = JSON.stringify({
      lifecycle: snapshot.lifecycle,
      currentPath: snapshot.currentPath,
      pull: snapshot.pull,
      push: snapshot.push,
      lastSyncTime: snapshot.lastSyncTime,
      errorMessage: snapshot.errorMessage,
      failurePhase: snapshot.failurePhase,
      failurePath: snapshot.failurePath,
    })
    if (detailsSignature !== this.progressDetailsSignature) {
      details.empty()
      this.renderProgressDetails(details, snapshot)
      this.progressDetailsSignature = detailsSignature
    }

    const timingRows = snapshot.totalElapsedMs > 0 || snapshot.timings.length > 0
      ? [
          ["Total", formatV4Duration(snapshot.totalElapsedMs), true] as const,
          ...snapshot.timings.map(timing => {
            const phaseLabel = formatV4PhaseLabel(timing.phase)
            const label = timing.phase === "encrypting" ? "Encryption" : phaseLabel
            return [label, formatV4PhaseTiming(timing).slice(phaseLabel.length + 1), false] as const
          }),
        ]
      : []
    const timingsSignature = JSON.stringify(timingRows)
    if (timingsSignature !== this.progressTimingsSignature) {
      timingsElement.empty()
      for (const [label, duration, total] of timingRows) this.renderTiming(timingsElement, label, duration, total)
      this.progressTimingsSignature = timingsSignature
    }
  }

  private renderProgressDetails(container: HTMLElement, snapshot: V4SyncProgressSnapshot): void {
    if (snapshot.lifecycle === "failed") {
      const failure = container.createDiv({ cls: "github-sync-center__failure" })
      if (snapshot.failurePhase) failure.createDiv({ text: `Failed phase: ${formatV4PhaseLabel(snapshot.failurePhase)}` })
      if (snapshot.failurePath) this.renderPath(failure, snapshot.failurePath, "Failed path")
      if (snapshot.errorMessage) failure.createDiv({ text: `Error: ${snapshot.errorMessage}`, cls: "github-sync-center__error" })
    }

    if (snapshot.lifecycle !== "idle") {
      const directions = container.createDiv({ cls: "github-sync-center__progress-directions" })
      this.renderDirection(directions, "Pull", snapshot.pull)
      this.renderDirection(directions, "Push", snapshot.push)
    }

    if (snapshot.currentPath && (snapshot.lifecycle !== "failed" || snapshot.currentPath !== snapshot.failurePath)) {
      this.renderPath(container, snapshot.currentPath)
    }

    if (snapshot.lastSyncTime > 0) {
      container.createDiv({ text: `Completed ${new Date(snapshot.lastSyncTime).toLocaleString()}`, cls: "github-sync-center__progress-completed github-sync-center__muted" })
    }
  }

  private clearProgressElements(): void {
    this.progressCard = undefined
    this.progressLive = undefined
    this.progressContext = undefined
    this.progressDetails = undefined
    this.progressTimings = undefined
    this.progressLifecycle = undefined
    this.progressLiveSignature = undefined
    this.progressContextSignature = undefined
    this.progressDetailsSignature = undefined
    this.progressTimingsSignature = undefined
  }

  private renderTiming(container: HTMLElement, label: string, duration: string, total = false): void {
    const row = container.createDiv({ cls: `github-sync-center__timing${total ? " is-total" : ""}` })
    row.createEl("span", { text: label })
    row.createEl("span", { text: duration, cls: "github-sync-center__timing-duration" })
  }

  private progressHeading(snapshot: V4SyncProgressSnapshot): string {
    if (snapshot.lifecycle === "failed") return "Failed"
    if (snapshot.lifecycle === "success") return "Success"
    if (snapshot.lifecycle === "no-change") return "No changes"
    if (snapshot.lifecycle === "cancelled") return "Cancelled"
    if (snapshot.lifecycle === "idle") return "Idle"
    return snapshot.phase ? formatV4PhaseLabel(snapshot.phase) : "Syncing"
  }

  private renderDirection(container: HTMLElement, label: string, progress: V4DirectionalProgress): void {
    const remaining = remainingV4Progress(progress)
    const count = progress.total === undefined ? `${progress.completed}/?` : `${progress.completed}/${progress.total}`
    const detail = remaining === undefined ? "total unknown" : `${remaining} remaining`
    const row = container.createDiv({ cls: "github-sync-center__progress-direction" })
    row.createEl("span", { text: `${label} ${count}`, cls: "github-sync-center__progress-count" })
    row.createEl("span", { text: detail, cls: "github-sync-center__muted" })
  }

  private renderPath(container: HTMLElement, fullPath: string, label = "Path"): void {
    const row = container.createDiv({ cls: "github-sync-center__progress-path-row" })
    row.createEl("span", { text: `${label}:`, cls: "github-sync-center__muted" })
    const path = row.createEl("span", {
      text: middleTruncateV4Path(fullPath, 72),
      cls: "github-sync-center__progress-path",
    })
    path.title = fullPath
  }

  private operationLabel(operation: V4SyncProgressSnapshot["operation"]): string {
    if (operation === "forcePush") return "Force push"
    if (operation === "forcePull") return "Force pull"
    return "Normal"
  }

  private triggerLabel(trigger: V4SyncProgressSnapshot["trigger"]): string {
    const labels = {
      manual: "Manual",
      startup: "Startup",
      scheduled: "Scheduled",
      localChange: "Local change",
      forcePush: "Force push",
      forcePull: "Force pull",
    } as const
    return trigger ? labels[trigger] : ""
  }

  private async renderCommitMode(): Promise<void> {
    const generation = this.beginRender()
    if (!generation) return
    const { body, detail } = this.shell("Commit history")
    body.createEl("p", { text: "Loading commits…", cls: "github-sync-center__muted" })
    try {
      const service = await this.ensureService()
      if (!this.isCurrent(generation)) return
      const page = await service.listCommits(this.page)
      if (!this.isCurrent(generation)) return
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
      if (this.selected) {
        await this.renderCommitDetail(this.selected, detail)
        if (!this.isCurrent(generation)) return
      }
      else detail.createEl("p", { text: "Select a commit to inspect its changes.", cls: "github-sync-center__muted" })
    } catch (error) { if (this.isCurrent(generation)) this.renderError(body, error) }
  }

  private async renderCommitDetail(commit: V4HistoryCommit, detail: HTMLElement): Promise<void> {
    const generation = this.beginRender()
    if (!generation) return
    this.selected = commit
    this.releaseObjectUrl()
    detail.empty()
    detail.createEl("h4", { text: commit.message.split("\n", 1)[0] })
    detail.createEl("p", { text: "Loading changes…", cls: "github-sync-center__muted" })
    try {
      const service = await this.ensureService()
      if (!this.isCurrent(generation)) return
      const changes = await service.getCommitChanges(commit)
      if (!this.isCurrent(generation)) return
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
    } catch (error) { if (this.isCurrent(generation)) this.renderError(detail, error) }
  }

  private async renderFileMode(): Promise<void> {
    const generation = this.beginRender()
    if (!generation) return
    const active = this.app.workspace.getActiveFile()
    const { body, detail } = this.shell(active ? `Versions of ${active.path}` : "File versions")
    if (!active) { body.createEl("p", { text: "Open a file to view its versions." }); return }
    body.createEl("p", { text: "Loading versions…", cls: "github-sync-center__muted" })
    try {
      const fileId = await this.plugin.v4Runtime.fileIdForPath(active.path)
      if (!this.isCurrent(generation)) return
      if (!fileId) { body.empty(); body.createEl("p", { text: "This file has not been synced by V4 yet." }); return }
      const service = await this.ensureService()
      if (!this.isCurrent(generation)) return
      const versions = await service.getFileVersions(fileId)
      if (!this.isCurrent(generation)) return
      body.empty()
      for (const version of versions) {
        const row = body.createEl("button", { cls: "github-sync-center__row" })
        row.createDiv({ text: `${version.change.kind.toUpperCase()} · ${version.change.path}`, cls: "github-sync-center__row-title" })
        row.createDiv({ text: version.commit.authoredAt || version.commit.sha.slice(0, 8), cls: "github-sync-center__muted" })
        row.onclick = () => void this.renderPreview(version.commit, version.change, detail)
      }
      if (versions.length === 0) body.createEl("p", { text: "No versions found in the loaded history." })
    } catch (error) { if (this.isCurrent(generation)) this.renderError(body, error) }
  }

  private async renderPreview(commit: V4HistoryCommit, change: V4HistoryChange, container: HTMLElement): Promise<void> {
    const generation = this.beginRender()
    if (!generation) return
    this.releaseObjectUrl()
    container.empty()
    container.createEl("h4", { text: change.path })
    container.createEl("p", { text: "Loading preview…", cls: "github-sync-center__muted" })
    try {
      const service = await this.ensureService()
      if (!this.isCurrent(generation)) return
      const preview = await service.previewChange(commit, change)
      if (!this.isCurrent(generation)) return
      container.empty()
      container.createEl("h4", { text: change.path })
      this.appendPreview(container, preview)
    } catch (error) { if (this.isCurrent(generation)) this.renderError(container, error) }
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
