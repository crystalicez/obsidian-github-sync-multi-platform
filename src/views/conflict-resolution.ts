import { ItemView, Notice, Platform, WorkspaceLeaf } from "obsidian"
import type FastSync from "../main"
import { createV4ConflictMergeModel, type V4ConflictMergeModel, type V4MergeHunkAction } from "../lib/v4/conflict-merge-model"
import type { V4ConflictCoordinatorSnapshot } from "../lib/v4/conflict-coordinator"
import type { V4ConflictFileResolution, V4ConflictFileSummary, V4ConflictMaterializedFile } from "../lib/v4/conflict-types"
import { V4PreviewObjectUrlBag, renderV4BinaryMetadata, renderV4TextPreview } from "./v4-diff-preview"

export const V4_CONFLICT_RESOLUTION_VIEW = "github-sync-v4-conflict-resolution"
export type V4ConflictViewMode = "auto" | "split" | "unified"
export type V4EffectiveConflictViewMode = Exclude<V4ConflictViewMode, "auto">

export function effectiveV4ConflictViewMode(mode: V4ConflictViewMode, desktop = Platform.isDesktopApp === true): V4EffectiveConflictViewMode {
  return mode === "auto" ? (desktop ? "split" : "unified") : mode
}

interface CachedModel {
  generation: number
  fingerprint: string
  model: V4ConflictMergeModel
  restoredResolutionFingerprint?: string
}

function currentResolution(snapshot: V4ConflictCoordinatorSnapshot, fileId: string): V4ConflictFileResolution | undefined {
  return snapshot.files.find(file => file.summary.fileId === fileId)?.resolution
}

export class V4ConflictResolutionView extends ItemView {
  private unsubscribe?: () => void
  private readonly urls = new V4PreviewObjectUrlBag()
  private readonly models = new Map<string, CachedModel>()
  private readonly mergedEditors = new Map<string, HTMLTextAreaElement>()
  private renderGeneration = 0
  private selectedFileId?: string
  private open = false

  constructor(leaf: WorkspaceLeaf, private readonly plugin: FastSync) { super(leaf) }

  getViewType(): string { return V4_CONFLICT_RESOLUTION_VIEW }
  getDisplayText(): string { return "Conflict Resolution" }
  getIcon(): string { return "git-merge" }

  async onOpen(): Promise<void> {
    this.open = true
    this.unsubscribe?.()
    this.unsubscribe = this.plugin.v4Runtime.subscribeConflicts(snapshot => { void this.render(snapshot) })
  }

  async onClose(): Promise<void> {
    this.open = false
    this.renderGeneration++
    this.unsubscribe?.()
    this.unsubscribe = undefined
    this.urls.clear()
  }

  private async render(snapshot: V4ConflictCoordinatorSnapshot): Promise<void> {
    if (!this.open) return
    const renderGeneration = ++this.renderGeneration
    this.urls.clear()
    this.contentEl.empty()
    this.contentEl.addClass("github-sync-conflicts")

    if (!snapshot.active || !snapshot.pending || snapshot.files.length === 0) {
      this.models.clear()
      this.contentEl.createEl("h3", { text: "Conflict Resolution" })
      this.contentEl.createEl("p", { text: "No active conflicts." })
      return
    }

    const header = this.contentEl.createDiv({ cls: "github-sync-conflicts__header" })
    const heading = header.createDiv()
    heading.createEl("h3", { text: "Conflict Resolution" })
    const unresolvedFiles = snapshot.files.filter(file => !file.resolution || (file.summary.requiresReview && !file.reviewed)).length
    heading.createDiv({ text: `${snapshot.files.length} file${snapshot.files.length === 1 ? "" : "s"} · ${unresolvedFiles} unresolved`, cls: "github-sync-conflicts__muted" })

    const headerActions = header.createDiv({ cls: "github-sync-conflicts__header-actions" })
    for (const mode of ["split", "unified"] as const) {
      const button = headerActions.createEl("button", { text: mode === "split" ? "Split" : "Unified" })
      if (effectiveV4ConflictViewMode(this.plugin.settings.conflictViewMode) === mode) button.addClass("is-active")
      button.onclick = () => { void this.setViewMode(mode) }
    }
    headerActions.createEl("button", { text: "Cancel sync", cls: "mod-warning" }).onclick = () => this.plugin.v4Runtime.cancelConflictResolution()

    const tabs = this.contentEl.createDiv({ cls: "github-sync-conflicts__tabs" })
    const activeExists = this.selectedFileId && snapshot.files.some(file => file.summary.fileId === this.selectedFileId)
    if (!activeExists) this.selectedFileId = snapshot.files[0].summary.fileId
    for (const file of snapshot.files) {
      const resolved = !!file.resolution && (!file.summary.requiresReview || file.reviewed)
      const button = tabs.createEl("button", {
        text: `${resolved ? "✓ " : ""}${file.summary.displayPath}`,
        cls: `github-sync-conflicts__tab${file.summary.fileId === this.selectedFileId ? " is-active" : ""}`,
      })
      button.onclick = () => {
        this.selectedFileId = file.summary.fileId
        void this.render(this.plugin.v4Runtime.conflictSnapshot)
      }
    }

    const body = this.contentEl.createDiv({ cls: "github-sync-conflicts__body" })
    body.createEl("p", { text: "Loading conflict…", cls: "github-sync-conflicts__muted" })
    const selected = snapshot.files.find(file => file.summary.fileId === this.selectedFileId) ?? snapshot.files[0]
    const generation = snapshot.generation
    if (generation === undefined) return

    let materialized: V4ConflictMaterializedFile
    try {
      materialized = await this.plugin.v4Runtime.materializeConflict(selected.summary.fileId)
    } catch (error) {
      if (!this.isCurrent(renderGeneration, generation)) return
      body.empty()
      body.createEl("p", { text: (error as Error).message, cls: "github-sync-conflicts__error" })
      return
    }
    if (!this.isCurrent(renderGeneration, generation)) return
    const current = this.plugin.v4Runtime.conflictSnapshot
    const currentFile = current.files.find(file => file.summary.fileId === selected.summary.fileId)
    if (!currentFile || materialized.generation !== generation || currentFile.summary.fingerprint !== materialized.summary.fingerprint) return

    body.empty()
    if (materialized.mode === "text" && materialized.baseBytes && materialized.localBytes && materialized.remoteBytes) {
      this.renderTextConflict(body, current, currentFile.summary, materialized)
    } else {
      this.renderFileConflict(body, currentFile.summary, materialized)
    }

    const footer = this.contentEl.createDiv({ cls: "github-sync-conflicts__footer" })
    const continueButton = footer.createEl("button", { text: "Resolve all & continue", cls: "mod-cta" })
    continueButton.disabled = !this.plugin.v4Runtime.conflictSnapshot.canContinue
    continueButton.onclick = () => this.plugin.v4Runtime.continueConflictResolution()
  }

  private renderTextConflict(
    body: HTMLElement,
    snapshot: V4ConflictCoordinatorSnapshot,
    summary: V4ConflictFileSummary,
    materialized: V4ConflictMaterializedFile,
  ): void {
    const generation = materialized.generation
    const key = `${generation}:${summary.fileId}:${summary.fingerprint}`
    let cached = this.models.get(key)
    if (!cached) {
      cached = {
        generation,
        fingerprint: summary.fingerprint,
        model: createV4ConflictMergeModel({
          baseBytes: materialized.baseBytes!,
          localBytes: materialized.localBytes!,
          remoteBytes: materialized.remoteBytes!,
        }),
      }
      this.models.set(key, cached)
    }
    const resolution = currentResolution(snapshot, summary.fileId)
    if (resolution?.kind === "merged" && cached.restoredResolutionFingerprint !== resolution.fingerprint) {
      cached.model.applyManualText(new TextDecoder().decode(resolution.bytes))
      cached.restoredResolutionFingerprint = resolution.fingerprint
    }

    const mode = effectiveV4ConflictViewMode(this.plugin.settings.conflictViewMode)
    const layout = body.createDiv({ cls: `github-sync-conflicts__${mode}` })
    if (mode === "split") {
      renderV4TextPreview(layout, "LOCAL", materialized.localBytes)
      const actions = layout.createDiv({ cls: "github-sync-conflicts__hunk-actions" })
      this.renderHunkActions(actions, summary, cached.model)
      renderV4TextPreview(layout, "REMOTE", materialized.remoteBytes)
    } else {
      renderV4TextPreview(layout, "BASE", materialized.baseBytes)
      renderV4TextPreview(layout, "LOCAL", materialized.localBytes)
      renderV4TextPreview(layout, "REMOTE", materialized.remoteBytes)
      const actions = layout.createDiv({ cls: "github-sync-conflicts__hunk-actions" })
      this.renderHunkActions(actions, summary, cached.model)
    }

    const merged = body.createDiv({ cls: "github-sync-conflicts__merged" })
    const mergedHeader = merged.createDiv({ cls: "github-sync-conflicts__merged-heading" })
    mergedHeader.createEl("strong", { text: "Merged result" })
    mergedHeader.createEl("span", { text: `${cached.model.unresolvedCount} unresolved`, cls: "github-sync-conflicts__muted" })
    const editor = merged.createEl("textarea", { cls: "github-sync-conflicts__merged-editor" }) as HTMLTextAreaElement
    this.mergedEditors.set(summary.fileId, editor)
    editor.value = cached.model.text
    editor.oninput = () => {
      cached!.model.applyManualText(editor.value)
      this.persistMerged(summary, cached!.model)
    }

    const controls = merged.createDiv({ cls: "github-sync-conflicts__merged-controls" })
    const reset = controls.createEl("button", { text: "Reset file" })
    reset.onclick = () => {
      cached!.model.reset()
      editor.value = cached!.model.text
      this.persistMerged(summary, cached!.model)
    }
    if (cached.model.unresolvedCount === 0 && !currentResolution(snapshot, summary.fileId)) {
      controls.createEl("button", { text: "Confirm merged result", cls: "mod-cta" }).onclick = () => this.persistMerged(summary, cached!.model, true)
    }
  }

  private renderHunkActions(container: HTMLElement, summary: V4ConflictFileSummary, model: V4ConflictMergeModel): void {
    const conflicts = model.hunks.filter(hunk => hunk.kind === "conflict")
    if (conflicts.length === 0) {
      container.createDiv({ text: "No unresolved text hunks.", cls: "github-sync-conflicts__muted" })
      return
    }
    for (const [index, hunk] of conflicts.entries()) {
      const row = container.createDiv({ cls: "github-sync-conflicts__hunk-action" })
      row.createEl("span", { text: `Conflict ${index + 1}` })
      const actions: Array<[string, V4MergeHunkAction]> = [
        ["Local", "accepted-local"],
        ["Remote", "accepted-remote"],
        ["Both", "accepted-both"],
        ["Base", "discarded-both"],
      ]
      for (const [label, action] of actions) {
        row.createEl("button", { text: label, attr: { "aria-label": `${label} for conflict ${index + 1}` } }).onclick = () => {
          model.applyHunkAction(hunk.id, action)
          const editor = this.mergedEditors.get(summary.fileId)
          if (editor) editor.value = model.text
          this.persistMerged(summary, model)
        }
      }
    }
  }

  private renderFileConflict(body: HTMLElement, summary: V4ConflictFileSummary, materialized: V4ConflictMaterializedFile): void {
    body.createEl("h4", { text: summary.displayPath })
    if (materialized.downgradeReason) body.createEl("p", { text: materialized.downgradeReason, cls: "github-sync-conflicts__warning" })
    const sides = body.createDiv({ cls: "github-sync-conflicts__file-sides" })
    renderV4BinaryMetadata(sides, "LOCAL", summary.local.exists ? summary.local : { exists: false })
    renderV4BinaryMetadata(sides, "REMOTE", summary.remote.exists ? summary.remote : { exists: false })
    const actions = body.createDiv({ cls: "github-sync-conflicts__file-actions" })
    const localLabel = summary.local.exists ? "Use local" : "Keep deletion"
    actions.createEl("button", { text: localLabel }).onclick = () => this.setFileResolution(summary, "use-local")
    const remoteLabel = summary.remote.exists ? "Use remote" : "Keep remote deletion"
    actions.createEl("button", { text: remoteLabel }).onclick = () => this.setFileResolution(summary, "use-remote")
    if (summary.local.exists && summary.remote.exists) {
      actions.createEl("button", { text: "Keep both" }).onclick = () => this.setFileResolution(summary, "keep-both")
    }
  }

  private setFileResolution(summary: V4ConflictFileSummary, kind: "use-local" | "use-remote" | "keep-both"): void {
    this.plugin.v4Runtime.setConflictResolution({ fileId: summary.fileId, fingerprint: summary.fingerprint, kind })
    this.plugin.v4Runtime.markConflictReviewed(summary.fileId, true)
  }

  private persistMerged(summary: V4ConflictFileSummary, model: V4ConflictMergeModel, forceReviewed = false): void {
    this.plugin.v4Runtime.setConflictResolution({
      fileId: summary.fileId,
      fingerprint: summary.fingerprint,
      kind: "merged",
      path: summary.displayPath,
      bytes: model.toBytes(),
    })
    this.plugin.v4Runtime.markConflictReviewed(summary.fileId, forceReviewed || model.unresolvedCount === 0)
  }

  private isCurrent(renderGeneration: number, batchGeneration: number): boolean {
    const snapshot = this.plugin.v4Runtime.conflictSnapshot
    return this.open && this.renderGeneration === renderGeneration && snapshot.active && snapshot.generation === batchGeneration
  }

  private async setViewMode(mode: V4EffectiveConflictViewMode): Promise<void> {
    if (this.plugin.settings.conflictViewMode === mode) return
    this.plugin.settings.conflictViewMode = mode
    await this.plugin.persistData()
    if (!this.open) return
    await this.render(this.plugin.v4Runtime.conflictSnapshot)
    new Notice(`Conflict editor layout: ${mode === "split" ? "Split" : "Unified"}`)
  }
}
