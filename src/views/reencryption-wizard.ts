import { Modal, Setting } from "obsidian"
import type FastSync from "../main"
import type { PluginSettings } from "../setting"
import { GitHubClient } from "../lib/github-api"
import { V4_DEFAULT_PBKDF2_ITERATIONS, V4_MAX_PBKDF2_ITERATIONS, V4_MIN_NEW_PBKDF2_ITERATIONS } from "../lib/v4/kdf-policy"
import { verifyGitHubReencryptionForkSource } from "../lib/v4/reencryption-trusted-loader"
import {
  proposeV4ReencryptionWizardDraft,
  suggestV4ReencryptionBranchNames,
  type V4ReencryptionWizardProposal,
} from "../lib/v4/reencryption-wizard-plan"

/**
 * D92: deliberately read-only Wizard. The source verifier reads immutable
 * encrypted Git objects, but no part of this view can create a ref, persist
 * a new passphrase, alter local notes, switch branches, or start a migration.
 *
 * Never call a publication/migration method from this class until the release
 * gate and crash-safe publication/cutover architecture are independently proven.
 */
const STEPS = [
  "Preflight & snapshot",
  "Destination & encryption",
  "Review & confirm",
  "Run & verify",
  "Finish & switch",
] as const

interface VerifiedSource {
  readonly physicalRepositoryId: number
  readonly defaultBranch: string
  readonly pinnedSourceCommitSha: string
  readonly verifiedFileCount: number
  readonly verifiedRemoteObjectCount: number
  readonly totalVerifiedPlaintextBytes: string
}

interface RefCheck {
  readonly destinationRepoId: string
  readonly backupRepoId: string
  readonly pinnedSourceCommitSha: string
  readonly physicalRepositoryId: number
}

export class V4ReencryptionWizardModal extends Modal {
  private step = 0
  private readonly initialSettings: PluginSettings
  private source: VerifiedSource | undefined
  private checked: RefCheck | undefined
  private busy = false
  private closed = false
  private requestEpoch = 0
  private abortController: AbortController | undefined
  private errorMessage = ""
  private destinationBranch = ""
  private backupBranch = ""
  private newPassphrase = ""
  private confirmPassphrase = ""
  private iterations = V4_DEFAULT_PBKDF2_ITERATIONS

  constructor(private readonly plugin: FastSync) {
    super(plugin.app)
    // Copy the connection at open time; Obsidian Settings may be mutated in place.
    this.initialSettings = Object.freeze({ ...plugin.settings })
    const provisional = suggestV4ReencryptionBranchNames(
      new Date(), "0".repeat(40),
    )
    this.destinationBranch = provisional.destinationBranch
    this.backupBranch = provisional.backupBranch
  }

  override onOpen(): void {
    this.closed = false
    this.render()
  }

  override onClose(): void {
    this.closed = true
    this.requestEpoch++
    this.busy = false
    this.abortController?.abort()
    this.abortController = undefined
    this.source = undefined
    this.checked = undefined
    this.newPassphrase = ""
    this.confirmPassphrase = ""
    this.contentEl.empty()
  }

  private matchesConnection(): boolean {
    const current = this.plugin.settings
    const snapshot = this.initialSettings
    return current.githubOwner === snapshot.githubOwner
      && current.githubRepo === snapshot.githubRepo
      && current.githubBranch === snapshot.githubBranch
      && current.githubToken === snapshot.githubToken
      && current.encryptionMode === snapshot.encryptionMode
      && current.encryptionPassphrase === snapshot.encryptionPassphrase
      && snapshot.githubOwner.length > 0 && snapshot.githubRepo.length > 0
      && snapshot.githubBranch.length > 0 && snapshot.githubToken.length > 0
      && snapshot.encryptionMode === "encrypted"
      && snapshot.encryptionPassphrase.length > 0
  }

  // A Sync can start after the initial idle check while a slow GitHub
  // request is in flight. Never mark an old Preview observation as ready
  // while a local Sync is actively changing the vault/connection state.
  private assertSyncStillIdle(): void {
    if (this.plugin.v4Runtime.isSyncing) {
      throw new Error("Sync started during verification. Wait for it to finish and verify again.")
    }
  }

  private sourceRepoId(): string {
    const s = this.initialSettings
    return `${s.githubOwner}/${s.githubRepo}#${s.githubBranch}`
  }

  private scopedClient(branch: string): GitHubClient {
    const settings = this.initialSettings
    const client = new GitHubClient({
      owner: settings.githubOwner,
      repo: settings.githubRepo,
      token: settings.githubToken,
      branch,
    })
    client.setV4AbortSignal(this.abortController?.signal)
    return client
  }

  private plan(): V4ReencryptionWizardProposal {
    if (!this.source || !this.matchesConnection()) {
      throw new Error("Verify the encrypted source and save any changed connection settings first.")
    }
    return proposeV4ReencryptionWizardDraft({
      owner: this.initialSettings.githubOwner,
      repo: this.initialSettings.githubRepo,
      sourceBranch: this.initialSettings.githubBranch,
      destinationBranch: this.destinationBranch,
      backupBranch: this.backupBranch,
      defaultBranch: this.source.defaultBranch,
      sourceCommitSha: this.source.pinnedSourceCommitSha,
      sourcePhysicalRepositoryId: this.source.physicalRepositoryId,
      requestedIterations: this.iterations,
      oldPassphrase: this.initialSettings.encryptionPassphrase,
      newPassphrase: this.newPassphrase,
      confirmation: this.confirmPassphrase,
    })
  }

  private async verifySource(): Promise<void> {
    if (this.busy) return
    this.source = undefined
    this.checked = undefined
    this.errorMessage = ""
    if (!this.matchesConnection()) {
      this.errorMessage = "Save a configured encrypted GitHub connection with its original passphrase before verification."
      this.render()
      return
    }
    if (this.plugin.v4Runtime.isSyncing) {
      this.errorMessage = "A Sync operation is active. Try again after it finishes."
      this.render()
      return
    }
    this.busy = true
    const epoch = ++this.requestEpoch
    const controller = new AbortController()
    this.abortController = controller
    this.render()
    try {
      const client = this.scopedClient(this.initialSettings.githubBranch)
      const expectedFullName = `${this.initialSettings.githubOwner}/${this.initialSettings.githubRepo}`
      const repo = await client.getRepositoryIdentity()
      if (this.closed || controller.signal.aborted || epoch !== this.requestEpoch) return
      this.assertSyncStillIdle()
      if (repo.fullName.toLowerCase() !== expectedFullName.toLowerCase()) {
        throw new Error("GitHub repository identity does not match settings.")
      }
      const defaultBranch = await client.getRepositoryDefaultBranch()
      if (this.closed || controller.signal.aborted || epoch !== this.requestEpoch) return
      this.assertSyncStillIdle()
      if (!this.matchesConnection()) throw new Error("Connection settings changed during verification.")
      const proof = await verifyGitHubReencryptionForkSource({
        github: client, expectedRepoId: this.sourceRepoId(),
        expectedBranch: this.initialSettings.githubBranch,
        passphrase: this.initialSettings.encryptionPassphrase,
        signal: controller.signal,
      })
      if (this.closed || controller.signal.aborted || epoch !== this.requestEpoch) return
      this.assertSyncStillIdle()
      const repoAfter = await client.getRepositoryIdentity()
      const defaultBranchAfter = await client.getRepositoryDefaultBranch()
      if (this.closed || controller.signal.aborted || epoch !== this.requestEpoch) return
      this.assertSyncStillIdle()
      if (repo.id !== repoAfter.id || repo.fullName.toLowerCase() !== repoAfter.fullName.toLowerCase()
        || defaultBranch !== defaultBranchAfter) {
        throw new Error("Repository identity or default branch changed during source verification.")
      }
      if (!this.matchesConnection()) throw new Error("Connection settings changed during verification.")
      this.source = {
        physicalRepositoryId: repo.id,
        defaultBranch,
        pinnedSourceCommitSha: proof.pinnedSourceCommitSha,
        verifiedFileCount: proof.verifiedFileCount,
        verifiedRemoteObjectCount: proof.verifiedRemoteObjectCount,
        totalVerifiedPlaintextBytes: proof.totalVerifiedPlaintextBytes,
      }
      const names = suggestV4ReencryptionBranchNames(new Date(), proof.pinnedSourceCommitSha)
      this.destinationBranch = names.destinationBranch
      this.backupBranch = names.backupBranch
      this.errorMessage = ""
    } catch (error) {
      if (!this.closed && !controller.signal.aborted && epoch === this.requestEpoch) {
        // Network/backend exceptions can include sensitive request context.
        // Never display raw error text or vault filenames here.
        this.errorMessage = error instanceof Error && error.message.startsWith("Sync started during verification.")
          ? "Sync started during verification. Wait for it to finish and verify again."
          : error instanceof Error && /identity|settings changed|passphrase/i.test(error.message)
            ? "Source verification failed: check repository identity, configuration, passphrase and connection."
            : "Source verification failed. Check connection, credentials and remote data integrity."
      }
    } finally {
      if (epoch === this.requestEpoch) {
        this.busy = false
        this.abortController = undefined
        if (!this.closed) this.render()
      }
    }
  }

  private async checkBranchAvailability(): Promise<void> {
    if (this.busy) return
    this.checked = undefined
    this.errorMessage = ""
    let proposal: V4ReencryptionWizardProposal
    try {
      proposal = this.plan()
    } catch (error) {
      this.errorMessage = error instanceof Error ? error.message : "Invalid Wizard plan."
      this.render()
      return
    }
    if (this.plugin.v4Runtime.isSyncing) {
      this.errorMessage = "Wait for the active Sync to finish before checking the branch names."
      this.render()
      return
    }
    this.busy = true
    const epoch = ++this.requestEpoch
    const controller = new AbortController()
    this.abortController = controller
    this.render()
    try {
      const destinationClient = this.scopedClient(this.destinationBranch)
      const backupClient = this.scopedClient(this.backupBranch)
      const [destination, backup] = await Promise.all([
        destinationClient.getGitRefOrNull(),
        backupClient.getGitRefOrNull(),
      ])
      if (this.closed || controller.signal.aborted || epoch !== this.requestEpoch) return
      this.assertSyncStillIdle()
      if (!this.matchesConnection()) throw new Error("Wizard settings changed during verification.")
      if (destination !== null || backup !== null) {
        throw new Error("A proposed branch already exists. Choose unused branch names.")
      }
      // Branch absence is only useful for the same verified Source snapshot.
      // Recheck the pinned HEAD and default branch; do not quietly approve an
      // old preview after another device changed the source or its policy.
      const sourceClient = this.scopedClient(this.initialSettings.githubBranch)
      const [repo, defaultBranch, sourceRef] = await Promise.all([
        sourceClient.getRepositoryIdentity(),
        sourceClient.getRepositoryDefaultBranch(),
        sourceClient.getGitRef(),
      ])
      if (this.closed || controller.signal.aborted || epoch !== this.requestEpoch) return
      this.assertSyncStillIdle()
      if (repo.id !== proposal.physicalRepositoryId
        || repo.fullName.toLowerCase() !== `${this.initialSettings.githubOwner}/${this.initialSettings.githubRepo}`.toLowerCase()) {
        throw new Error("Repository identity changed.")
      }
      if (defaultBranch !== this.source?.defaultBranch
        || sourceRef.ref !== `refs/heads/${this.initialSettings.githubBranch}`
        || sourceRef.type !== "commit"
        || sourceRef.sha !== proposal.pinnedSourceCommitSha) {
        throw new Error("Source branch or default branch changed. Return to Preflight and verify the source again.")
      }
      const [destinationAfter, backupAfter] = await Promise.all([
        destinationClient.getGitRefOrNull(),
        backupClient.getGitRefOrNull(),
      ])
      if (this.closed || controller.signal.aborted || epoch !== this.requestEpoch) return
      this.assertSyncStillIdle()
      if (destinationAfter !== null || backupAfter !== null) {
        throw new Error("A proposed branch already exists. Choose unused branch names.")
      }
      if (!this.matchesConnection() || this.plan().destinationRepoId !== proposal.destinationRepoId
        || this.plan().backupRepoId !== proposal.backupRepoId) {
        throw new Error("Wizard settings changed during verification.")
      }
      this.checked = {
        destinationRepoId: proposal.destinationRepoId,
        backupRepoId: proposal.backupRepoId,
        pinnedSourceCommitSha: proposal.pinnedSourceCommitSha,
        physicalRepositoryId: proposal.physicalRepositoryId,
      }
    } catch (error) {
      if (!this.closed && !controller.signal.aborted && epoch === this.requestEpoch) {
        this.errorMessage = error instanceof Error && /already exists|settings changed|identity changed|source branch or default branch changed|^Sync started during verification[.]/i.test(error.message)
          ? error.message
          : "Branch verification failed. GitHub must confirm both names are unused."
      }
    } finally {
      if (epoch === this.requestEpoch) {
        this.busy = false
        this.abortController = undefined
        if (!this.closed) this.render()
      }
    }
  }

  private row(container: HTMLElement, heading: string, detail: string): void {
    new Setting(container).setName(heading).setDesc(detail)
  }

  private renderPreflight(container: HTMLElement): void {
    const s = this.initialSettings
    this.row(container, "Current source (read-only)", `${s.githubOwner}/${s.githubRepo}#${s.githubBranch}`)
    this.row(container, "Mode", s.encryptionMode === "encrypted" ? "Encrypted V4 source required" : "Current connection is not encrypted")
    this.row(container, "Vault change detection (planned)",
      "Cross-platform best-effort: recheck file inventory, hashes, open editors and Sync state. External apps can still write after the last check; this is NOT an OS-wide write lock.")
    this.row(container, "Remote source verification", this.source
      ? `Verified ${this.source.verifiedFileCount} files, ${this.source.verifiedRemoteObjectCount} objects (${this.source.totalVerifiedPlaintextBytes} plaintext bytes) at immutable commit ${this.source.pinnedSourceCommitSha}`
      : "Not verified. This read-only check decrypts and validates every live source object from one pinned Git commit and may be expensive.")
    new Setting(container)
      .setName("Check encrypted source")
      .setDesc("Read GitHub only. No backup or destination branch will be created.")
      .addButton(button => button
        .setButtonText(this.busy ? "Verifying…" : this.source ? "Verify again" : "Verify source (read-only)")
        .setDisabled(this.busy)
        .onClick(() => void this.verifySource()))
    if (this.source) {
      this.row(container, "Pinned source snapshot", this.source.pinnedSourceCommitSha)
      this.row(container, "Actual default branch", this.source.defaultBranch)
    }
  }

  private renderDestination(container: HTMLElement): void {
    container.createEl("p", { text: "The destination is a newly encrypted orphan branch. The separate frozen backup preserves the source snapshot; the old branch remains active." })
    container.createEl("p", {
      cls: "github-sync-rekey__warning",
      text: "Important: After a fully verified cutover, the old passphrase is planned to be cleared from this device's Obsidian SecretStorage. The original Source and Backup branches still require your OLD passphrase to decrypt. Save your old passphrase securely outside this plugin before starting Re-encryption if you may need those branches later. Other devices are not changed.",
    })
    new Setting(container).setName("New destination branch")
      .setDesc("Must not exist, equal the source, backup or default branch.")
      .addText(text => text.setValue(this.destinationBranch).onChange(value => {
        this.destinationBranch = value
        this.checked = undefined
        this.errorMessage = ""
      }))
    new Setting(container).setName("Pinned backup branch")
      .setDesc("Separate from destination and source. This name must not exist.")
      .addText(text => text.setValue(this.backupBranch).onChange(value => {
        this.backupBranch = value
        this.checked = undefined
        this.errorMessage = ""
      }))
    new Setting(container).setName("New encryption passphrase")
      .setDesc("This stays in this unsaved Wizard only. Losing it means the new encrypted branch cannot be decrypted.")
      .addText(text => {
        text.inputEl.type = "password"
        text.setValue(this.newPassphrase).onChange(value => {
          this.newPassphrase = value
          this.checked = undefined
          this.errorMessage = ""
        })
      })
    new Setting(container).setName("Confirm new passphrase")
      .addText(text => {
        text.inputEl.type = "password"
        text.setValue(this.confirmPassphrase).onChange(value => {
          this.confirmPassphrase = value
          this.checked = undefined
          this.errorMessage = ""
        })
      })
    new Setting(container).setName("PBKDF2 iterations")
      .setDesc("Default 600,000; maximum 1,200,000. New encrypted branch only.")
      .addSlider(slider => slider
        .setLimits(V4_MIN_NEW_PBKDF2_ITERATIONS, V4_MAX_PBKDF2_ITERATIONS, 100_000)
        .setValue(this.iterations)
        .setDynamicTooltip()
        .onChange(value => {
          this.iterations = value
          this.checked = undefined
          this.errorMessage = ""
        }))
  }

  private renderReview(container: HTMLElement): void {
    const proposal = this.plan()
    this.row(container, "Source (continues to Sync independently)", proposal.sourceRepoId)
    this.row(container, "Frozen backup (pinned source commit)", proposal.backupRepoId)
    this.row(container, "New orphan destination (fresh encryption)", proposal.destinationRepoId)
    this.row(container, "Source Git commit", proposal.pinnedSourceCommitSha)
    this.row(container, "PBKDF2 iterations for new branch", String(proposal.requestedIterations))
    this.row(container, "User approval (planned)",
      "One confirmation before execution will include acknowledgement of best-effort power-loss risk and authorize a fully verified migration. No second confirmation after successful completion.")
    this.row(container, "Best-effort change detection (planned)",
      "Uniform cross-platform detection; cannot prevent changes by external programs. Abort on detected drift. Never treat this as a full Vault write fence.")
    container.createEl("p", {
      cls: "github-sync-rekey__warning",
      text: "OLD PASSPHRASE WARNING: Save a secure copy of your old passphrase before confirming. After a fully verified cutover, this device is planned to clear its old passphrase from Obsidian SecretStorage, with no extra confirmation. The Source and Backup branches and old encrypted Git history remain unchanged and still need that old passphrase to decrypt. This is a planned policy; no secrets are cleared in Preview.",
    })
    this.row(container, "Expected source files / logical bytes",
      `${this.source?.verifiedFileCount ?? 0} files / ${this.source?.totalVerifiedPlaintextBytes ?? "unverified"} bytes`)
    container.createEl("p", {
      cls: "github-sync-rekey__warning",
      text: "All three branches remain in ONE GitHub repository. Repository loss may affect all three. Old ciphertext remains in the source/backup/history. Other devices stay on the old branch unless you manually reconfigure them. There is no cross-branch auto-sync or merge.",
    })
    new Setting(container).setName("Destination and backup branch availability")
      .setDesc(this.checked
        ? "Both refs were absent before and after Source HEAD/default-branch revalidation. This is not a create-time guarantee or a remote lock."
        : "Not checked. Confirm both new names are absent and the verified Source has not changed.")
      .addButton(button => button.setButtonText(this.busy ? "Checking…" : "Check both branches")
        .setDisabled(this.busy)
        .onClick(() => void this.checkBranchAvailability()))
    this.row(container, "Publication authorization", "BLOCKED — the production migration, best-effort WAL recovery, safe cutover and installed-device release gates are unfinished.")
  }

  private renderRun(container: HTMLElement): void {
    container.createEl("p", {
      text: "Execution is not yet available. This page previews the approved sequence; it does not initiate a migration or create Git refs.",
    })
    const phases = [
      "Freeze the source snapshot and verify frozen backup",
      "Download and decrypt authenticated source objects",
      "Re-encrypt every live file using fresh branch-scoped keys",
      "Upload and publish the zero-parent orphan Git commit",
      "Verify complete destination tree, files, backup and restore",
    ]
    const list = container.createEl("ol")
    for (const phase of phases) list.createEl("li", { text: `Pending — ${phase}` })
    this.row(container, "Status", "NOT STARTED. No network writes, encryption changes or local cutover were made by this Wizard.")
    this.row(container, "Recovery", "Best-effort WAL readback, authenticated interruption recovery, safe local cutover and installed Obsidian acceptance must pass before execution can be enabled. Unknown states require Manual Recovery.")
    container.createEl("h4", { text: "Manual Recovery checklist (read-only guidance)" })
    container.createEl("p", { text: "Use these steps only if a future migration is interrupted or its state becomes uncertain. This Preview has made no changes." })
    const recoverySteps = [
      "Stop Sync on every device that uses this repository. Do not let another device write while recovery is reviewed.",
      "Make a secure copy of the vault and plugin data before changing anything. Keep BOTH passphrases securely outside logs and screenshots.",
      "Preserve the Source, Backup and Destination branches and Git history. Do not delete, reset or force push any branch.",
      "Keep local WAL, Selector and Receipt files unchanged, including incomplete files. They may be needed to identify the interrupted stage.",
      "Do not resume Sync, delete old secrets, retry migration or roll back automatically. Review the saved evidence and branch state before any manual action.",
    ]
    const checklist = container.createEl("ol")
    for (const step of recoverySteps) checklist.createEl("li", { text: step })
  }

  private renderFinish(container: HTMLElement): void {
    container.createEl("p", { text: "Not completed. Source, backup and destination must be verified in a real run before the initiating device can switch." })
    this.row(container, "Initiating device",
      "After one confirmation before execution, automatically switch branch, passphrase and local index ONLY after verified end-to-end completion and best-effort recovery checks. No second confirmation, no Force Pull/Push.")
    this.row(container, "Other devices", "Stay on the old branch, or manually enter the new branch and passphrase whenever desired.")
    this.row(container, "Retention", "Never auto-delete source or backup branches.")
    this.row(container, "Old passphrase cleanup (planned)",
      "Clear the old passphrase from this device's SecretStorage only AFTER verified cutover and recovery commit. The old Source/Backup still need it; keep your own copy if required. No cleanup is implemented in Preview.")
    this.row(container, "Current release gate", "BLOCKED — the planned automatic switch is NOT implemented or authorized.")
  }

  private render(): void {
    if (this.closed) return
    this.titleEl.setText("Create encrypted branch · Preview only")
    const content = this.contentEl
    content.empty()
    content.addClass("github-sync-rekey")
    const progress = content.createDiv({ cls: "github-sync-rekey__steps", attr: { "aria-label": "Re-encryption Wizard steps" } })
    STEPS.forEach((label, index) => {
      progress.createEl("span", {
        cls: index === this.step ? "github-sync-rekey__step is-current" : "github-sync-rekey__step",
        text: `${index + 1}. ${label}`,
      })
    })
    const section = content.createDiv({ cls: "github-sync-rekey__body" })
    section.createEl("h3", { text: STEPS[this.step] ?? STEPS[0] })
    section.createEl("p", { cls: "github-sync-rekey__warning", text: "Development preview — publishing and device cutover are disabled until all production safety gates pass." })
    section.createEl("p", { cls: "github-sync-rekey__warning", text: "BEST-EFFORT RECOVERY WARNING: Sudden power loss can lose recent WAL, Settings or SecretStorage writes even after a successful readback. There is no physical power-loss guarantee. Keep secure copies of BOTH passphrases; preserve Source and Backup. Inconsistent state after restart requires Manual Recovery, not automatic Sync or deletion." })
    if (this.step === 0) this.renderPreflight(section)
    else if (this.step === 1) this.renderDestination(section)
    else if (this.step === 2) {
      try { this.renderReview(section) }
      catch (error) {
        this.errorMessage = error instanceof Error ? error.message : "Invalid proposed branches."
      }
    } else if (this.step === 3) this.renderRun(section)
    else this.renderFinish(section)
    if (this.errorMessage) {
      content.createEl("p", { cls: "github-sync-rekey__error", attr: { role: "alert" }, text: this.errorMessage })
    }
    const navigation = content.createDiv({ cls: "github-sync-rekey__navigation" })
    const close = navigation.createEl("button", { text: "Close" })
    close.onclick = () => this.close()
    if (this.step > 0) {
      const back = navigation.createEl("button", { text: "Back" })
      back.disabled = this.busy
      back.onclick = () => {
        this.step--
        this.errorMessage = ""
        this.render()
      }
    }
    if (this.step < STEPS.length - 1) {
      const next = navigation.createEl("button", {
        text: this.step === 2 ? "View execution requirements" : this.step === 3 ? "View planned finish" : "Next",
        cls: "mod-cta",
      })
      next.disabled = this.busy || (this.step === 0 && !this.source) || (this.step === 2 && !this.checked)
      next.onclick = () => {
        if (this.busy) return
        this.errorMessage = ""
        try {
          if (this.step === 0 && !this.source) return
          if (this.step >= 1 && this.step <= 2) {
            const proposal = this.plan()
            if (this.step === 2 && (!this.checked
              || this.checked.destinationRepoId !== proposal.destinationRepoId
              || this.checked.backupRepoId !== proposal.backupRepoId
              || this.checked.pinnedSourceCommitSha !== proposal.pinnedSourceCommitSha
              || this.checked.physicalRepositoryId !== proposal.physicalRepositoryId)) {
              throw new Error("Check the destination and backup ref names again.")
            }
          }
          this.step++
        } catch (error) {
          this.errorMessage = error instanceof Error ? error.message : "Invalid Wizard configuration."
        }
        this.render()
      }
    }
  }
}
