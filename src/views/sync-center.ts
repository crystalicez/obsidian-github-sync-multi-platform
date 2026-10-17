import { ItemView, WorkspaceLeaf } from "obsidian"
import type FastSync from "../main"
import type { V4HistoryChange, V4HistoryCommit, V4HistoryService, V4VersionPreview } from "../lib/v4/history-service"
import { countV4FileOverview, filterV4FileOverview, treeV4FileOverview, V4_FILE_FILTERS, type V4FileFilter, type V4FileOverview, type V4FileOverviewEntry, type V4FileTreeNode } from "../lib/v4/file-overview"
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
  private serviceGeneration?: number
  private page = 1
  private mode: "files" | "commits" | "file" = "commits"
  private fileOverview?: V4FileOverview
  private fileFilter: V4FileFilter = "all"
  private fileQuery = ""
  private treeView = true
  private collapsedPaths = new Set<string>()
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
    if (this.plugin.githubClient) await this.renderFilesMode()
    else await this.renderCommitMode()
  }
  async onClose(): Promise<void> {
    this.isOpen = false
    this.openGeneration++
    this.renderGeneration++
    this.unsubscribeProgress?.()
    this.unsubscribeProgress = undefined
    this.clearProgressElements()
    this.releaseObjectUrl()
    this.service = undefined
    this.serviceGeneration = undefined
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
    const generation = this.plugin.v4Runtime.settingsGeneration
    if (!this.service || this.serviceGeneration !== generation) {
      const service = await this.plugin.v4Runtime.createHistoryService()
      if (this.plugin.v4Runtime.settingsGeneration !== generation) {
        throw new Error("V4 history settings generation changed.")
      }
      this.service = service
      this.serviceGeneration = generation
    }
    return this.service
  }

  private shell(title: string): { body: HTMLElement; detail: HTMLElement } {
    this.releaseObjectUrl()
    this.contentEl.empty()
    this.contentEl.addClass("github-sync-center")
    const header = this.contentEl.createDiv({ cls: "github-sync-center__header" })
    header.createEl("h3", { text: title })
    const actions = header.createDiv({ cls: "github-sync-center__actions" })
    const filesButton = actions.createEl("button", { text: "Files" })
    filesButton.setAttribute("aria-pressed", String(this.mode === "files"))
    filesButton.onclick = () => void this.renderFilesMode()
    const commitsButton = actions.createEl("button", { text: "Commits" })
    commitsButton.setAttribute("aria-pressed", String(this.mode === "commits"))
    commitsButton.onclick = () => void this.renderCommitMode()
    const fileButton = actions.createEl("button", { text: "Current file" })
    fileButton.setAttribute("aria-pressed", String(this.mode === "file"))
    fileButton.onclick = () => void this.renderFileMode()
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

  private async renderFilesMode(): Promise<void> {
    const generation = this.beginRender()
    if (!generation) return
    this.mode = "files"
    const { body, detail } = this.shell("Files")
    body.createEl("p", { text: "Reading the exact remote branch…", cls: "github-sync-center__muted" })
    detail.createEl("p", { text: "Select a file for details.", cls: "github-sync-center__muted" })
    try {
      // This call reads the exact Git ref and authenticates V4 remote records.
      // A cached local index alone must never masquerade as a remote listing.
      const overview = await this.plugin.v4Runtime.fileOverview()
      if (!this.isCurrent(generation)) return
      this.fileOverview = overview
      body.empty()
      const toolbar = body.createDiv({ cls: "github-sync-center__file-toolbar" })
      const repository = toolbar.createDiv({ cls: "github-sync-center__file-source" })
      repository.createEl("strong", { text: "GitHub files" })
      const source = repository.createEl("span", {
        text: `${this.plugin.settings.githubOwner}/${this.plugin.settings.githubRepo} · ${this.plugin.settings.githubBranch}`,
        cls: "github-sync-center__muted",
      })
      source.title = `Read-only snapshot at ${overview.remoteCommitSha}`
      const filterInput = toolbar.createEl("input", { cls: "github-sync-center__file-search", attr: {
        type: "search", placeholder: "Filter by path…", "aria-label": "Filter files by path",
      } }) as HTMLInputElement
      filterInput.value = this.fileQuery
      const filters = toolbar.createDiv({ cls: "github-sync-center__file-filters", attr: { "aria-label": "File status filters" } })
      const count = countV4FileOverview(overview.entries)
      const filterNames: Record<V4FileFilter, string> = {
        all: "All", changed: "Changed", "local-only": "Local only", "remote-only": "Remote", synced: "Synced",
      }
      const labelFor = (entry: V4FileOverviewEntry) => entry.reason === "local-deleted"
        ? "Deleted locally"
        : entry.reason === "remote-deleted" ? "Deleted remotely"
          : entry.reason === "remote-renamed-from" ? "Moved on GitHub"
            : entry.reason === "remote-renamed-to" ? "Renamed on GitHub"
              : filterNames[entry.status]
      const fileList = body.createDiv({ cls: "github-sync-center__file-list" })
      const controls = toolbar.createDiv({ cls: "github-sync-center__file-controls" })
      const treeToggle = controls.createEl("button", { text: "Tree view" })
      treeToggle.setAttribute("aria-pressed", String(this.treeView))
      treeToggle.onclick = () => {
        this.treeView = !this.treeView
        treeToggle.setAttribute("aria-pressed", String(this.treeView))
        draw()
      }
      const refresh = controls.createEl("button", { text: "Refresh status" })
      refresh.onclick = () => void this.renderFilesMode()
      controls.createEl("span", { text: "Read-only overview · Sync now applies the normal conflict policy", cls: "github-sync-center__muted" })
      const filterButtons = new Map<V4FileFilter, HTMLButtonElement>()
      for (const filter of V4_FILE_FILTERS) {
        const button = filters.createEl("button", { text: `${filterNames[filter]} ${count[filter]}` })
        button.setAttribute("aria-pressed", String(this.fileFilter === filter))
        button.onclick = () => {
          this.fileFilter = filter
          draw()
        }
        filterButtons.set(filter, button)
      }
      filterInput.oninput = () => { this.fileQuery = filterInput.value; draw() }
      const showDetails = (entry: V4FileOverviewEntry) => {
        detail.empty()
        const title = detail.createEl("h4", { text: entry.path })
        title.title = entry.path
        const name = labelFor(entry)
        detail.createDiv({ text: name, cls: `github-sync-center__file-status is-${entry.status}` })
        const help: Record<Exclude<V4FileFilter, "all">, string> = {
          "local-only": "Only in this vault at the inspected remote commit. Normal Sync can publish it.",
          "remote-only": "Only on the inspected remote commit. Normal Sync can download it.",
          changed: "Local state or remote version differs from the last synchronized index. Review before syncing.",
          synced: "Matches the last synchronized index by file size, modification time and remote version. A full content comparison has not been performed.",
        }
        const deletionHelp = entry.reason === "local-deleted"
          ? "Previously synchronized, but now missing locally. A future sync may propagate this deletion to GitHub. Check your changes before syncing."
          : entry.reason === "remote-deleted"
            ? "Previously synchronized, but now missing on GitHub. A future sync may remove the local file. Check your changes before syncing."
            : entry.reason === "remote-renamed-from"
              ? `GitHub has moved this tracked file to ${entry.relatedPath}. Check the new location and your local edits before syncing.`
              : entry.reason === "remote-renamed-to"
                ? `Previously synchronized as ${entry.relatedPath}; the same file identity now appears here on GitHub. Review the move before syncing.`
                : undefined
        detail.createEl("p", { text: deletionHelp ?? help[entry.status], cls: deletionHelp ? "github-sync-center__file-warning" : "github-sync-center__muted" })
        if (entry.local) {
          const open = detail.createEl("button", { text: "Open local file" })
          open.onclick = () => void this.app.workspace.openLinkText(entry.path, "", false)
        }
        detail.createEl("p", { text: "File actions use Sync now; this overview does not bypass conflict checks or modify the remote.", cls: "github-sync-center__muted" })
      }
      const draw = () => {
        if (!this.isCurrent(generation)) return
        for (const [filter, button] of filterButtons) button.setAttribute("aria-pressed", String(this.fileFilter === filter))
        fileList.empty()
        const matches = filterV4FileOverview(overview.entries, this.fileFilter, this.fileQuery)
        const shown = matches.slice(0, 400)
        fileList.createDiv({ text: `${matches.length} file${matches.length === 1 ? "" : "s"} · ${overview.remoteCommitSha.slice(0, 10)}`, cls: "github-sync-center__muted" })
        if (matches.length > shown.length) fileList.createEl("p", { text: "Showing the first 400 matches. Narrow the path search to see more.", cls: "github-sync-center__muted" })
        if (!matches.length) fileList.createEl("p", { text: "No files match this filter.", cls: "github-sync-center__muted" })
        const createFileRow = (container: HTMLElement, entry: V4FileOverviewEntry, name: string) => {
          const button = container.createEl("button", { cls: "github-sync-center__file-row" })
          button.setAttribute("aria-label", `${entry.path}, ${labelFor(entry)}`)
          const path = button.createEl("span", { text: name, cls: "github-sync-center__file-name" })
          path.title = entry.path
          button.createEl("span", { text: labelFor(entry), cls: `github-sync-center__file-status is-${entry.status}` })
          button.onclick = () => showDetails(entry)
        }
        const addTree = (container: HTMLElement, nodes: V4FileTreeNode[], depth: number) => {
          for (const node of nodes) {
            if (node.entry) createFileRow(container, node.entry, node.name)
            else {
              const wrap = container.createDiv({ cls: "github-sync-center__folder" })
              const toggle = wrap.createEl("button", { cls: "github-sync-center__folder-toggle", text: `${this.collapsedPaths.has(node.path) ? "▸" : "▾"}  ${node.name}` })
              toggle.setAttribute("aria-expanded", String(!this.collapsedPaths.has(node.path)))
              toggle.setAttribute("aria-label", `Folder ${node.path}`)
              const child = wrap.createDiv({ cls: "github-sync-center__folder-children" })
              if (!this.collapsedPaths.has(node.path)) addTree(child, node.children, depth + 1)
              toggle.onclick = () => {
                if (this.collapsedPaths.has(node.path)) this.collapsedPaths.delete(node.path)
                else this.collapsedPaths.add(node.path)
                draw()
              }
            }
          }
        }
        if (this.treeView) addTree(fileList, treeV4FileOverview(shown), 0)
        else for (const entry of shown) createFileRow(fileList, entry, entry.path)
      }
      draw()
    } catch (error) {
      if (this.isCurrent(generation)) this.renderError(body, error)
    }
  }

  private async renderCommitMode(): Promise<void> {
    const generation = this.beginRender()
    if (!generation) return
    this.mode = "commits"
    const { body, detail } = this.shell("Commit history")
    body.createEl("p", { text: "Loading commits…", cls: "github-sync-center__muted" })
    try {
      const service = await this.ensureService()
      if (!this.isCurrent(generation)) return
      const page = await service.listCommits(this.page)
      if (!this.isCurrent(generation)) return
      body.empty()
      if (this.selected && !page.items.some(item => item.sha === this.selected?.sha)) this.selected = undefined
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
      if (changes.length === 0) {
        detail.createEl("p", { text: "No file changes to preview in this commit.", cls: "github-sync-center__muted" })
        return
      }
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
    this.mode = "file"
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
    const message = error instanceof Error && error.message.trim()
      ? error.message
      : typeof error === "string" && error.trim()
        ? error
        : "Unable to load history. An unexpected error occurred."
    container.createEl("p", { text: message, cls: "github-sync-center__error" })
    // The error is already visible in this view; a toast would obscure its header and navigation.
  }
}
