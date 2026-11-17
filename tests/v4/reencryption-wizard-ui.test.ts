import assert from "node:assert/strict"
import test from "node:test"
import { Platform, Setting, setRequestUrlHandler, settingSliderControls } from "obsidian"
import type FastSync from "../../src/main"
import { GitHubClient } from "../../src/lib/github-api"
import { V4SyncCoordinator } from "../../src/lib/v4/sync-coordinator"
import { V4ReencryptionWizardModal } from "../../src/views/reencryption-wizard"

function fakePlugin(
  mode: "plaintext" | "encrypted" = "encrypted",
  active = false,
): FastSync {
  return {
    app: {},
    settings: {
      githubOwner: "owner",
      githubRepo: "vault",
      githubToken: "source-token-never-render",
      githubBranch: "main",
      encryptionMode: mode,
      encryptionPassphrase: "source-passphrase-never-render",
    },
    v4Runtime: { isSyncing: active, syncExecutionGeneration: 0, assertReencryptionSettingsSaveAllowed: async () => undefined },
    settingsSaveGeneration: 0,
  } as unknown as FastSync
}

test("D411 Wizard Preflight exposes installed read-only Recovery inspection even while migration is fenced", async () => {
  const plugin = fakePlugin()
  const before = JSON.stringify(plugin.settings)
  let inspectorCalls = 0
  let previewFenceChecks = 0
  let remoteCalls = 0
  ;(plugin.v4Runtime as FastSync["v4Runtime"]).assertReencryptionSettingsSaveAllowed = async () => {
    previewFenceChecks++
    throw Error("private-recovery-path-must-never-render")
  }
  ;(plugin.v4Runtime as FastSync["v4Runtime"]).inspectFencedReencryptionCompleteRecovery = async () => {
    inspectorCalls++
    return {
      observation: "authenticated-complete-recovery-evidence-still-fenced",
      integrityScope: "read-only-original-backup-encrypted-wal-complete-destination",
      originalKeyAuthenticated: true, completeOldBackupReverified: true,
      walReceiptsBoundToDestination: true, completeDestinationContentsReverified: true,
      commitDecisionAuthorized: false, localCutoverAuthorized: false,
      resumeSyncAuthorized: false, remoteWritesAuthorized: false,
      rollbackAuthorized: false, oldPassphraseCleanupAuthorized: false,
      installedObsidianAcceptanceProven: false, powerLossDurabilityProven: false,
      isolation: "desktop-os-cooperative-wal-lock", mobileOsLockProven: false,
      verifiedFileCount: 3, verifiedPlaintextBytes: "12",
    } as Awaited<ReturnType<FastSync["v4Runtime"]["inspectFencedReencryptionCompleteRecovery"]>>
  }
  setRequestUrlHandler(async () => { remoteCalls++; throw Error("Wizard read-only Recovery test must not call GitHub") })
  const wizard = new V4ReencryptionWizardModal(plugin)
  const content = wizard.contentEl as unknown as {
    findByText(text: string): { disabled: boolean; onclick?: () => void } | undefined
    flattenText(): string
  }
  try {
    wizard.onOpen()
    const button = content.findByText("Inspect installed Recovery (read-only)")
    assert.ok(button && !button.disabled, "the local inspector must be usable before Source verification")
    button.onclick?.()
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(inspectorCalls, 1, "use the installed Runtime inspector, not a fake Preview proof")
    assert.equal(previewFenceChecks, 0, "a pending Recovery fence must not block inspecting Recovery itself")
    assert.equal(remoteCalls, 0)
    assert.match(content.flattenText(), /authenticated.*recovery.*still.*fenced|authenticated.*still.*fenced/i)
    assert.match(content.flattenText(), /Sync.*Cutover.*blocked/i)
    assert.doesNotMatch(content.flattenText(), /ready to migrate|execution authorized/i)
    assert.doesNotMatch(content.flattenText(), /private-recovery-path-must-never-render|source-token-never-render|source-passphrase-never-render/i)
    plugin.settings.githubBranch = "changed-during-preview"
    ;(wizard as unknown as { render(): void }).render()
    assert.doesNotMatch(content.flattenText(), /Authenticated Re-encryption Recovery evidence was inspected/i,
      "an installed Recovery observation cannot remain authoritative after connection drift")
    assert.match(content.flattenText(), /Preview connection or Runtime changed/i)
    plugin.settings.githubBranch = "main"
    assert.equal(JSON.stringify(plugin.settings), before)
  } finally {
    wizard.onClose()
    setRequestUrlHandler(null)
  }
})

test("D411 failed or stale installed Recovery inspection cannot leak secrets or approve next step", async () => {
  const plugin = fakePlugin()
  let settle: ((value: null) => void) | undefined
  ;(plugin.v4Runtime as FastSync["v4Runtime"]).inspectFencedReencryptionCompleteRecovery = () =>
    new Promise(resolve => { settle = resolve })
  const wizard = new V4ReencryptionWizardModal(plugin)
  const content = wizard.contentEl as unknown as {
    findByText(text: string): { disabled: boolean; onclick?: () => void } | undefined
    flattenText(): string
  }
  try {
    wizard.onOpen()
    const button = content.findByText("Inspect installed Recovery (read-only)")
    assert.ok(button)
    button.onclick?.()
    wizard.onClose()
    wizard.onOpen()
    settle?.(null)
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.doesNotMatch(content.flattenText(), /inspected.*no authenticated/i)
    assert.ok(content.findByText("Next")?.disabled, "Recovery report never unlocks migration navigation")
    ;(plugin.v4Runtime as FastSync["v4Runtime"]).inspectFencedReencryptionCompleteRecovery = async () => {
      throw Error("private WAL path and secret-token-never-render")
    }
    content.findByText("Inspect installed Recovery (read-only)")?.onclick?.()
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.match(content.flattenText(), /inspection unavailable|manual recovery/i)
    assert.doesNotMatch(content.flattenText(), /private WAL path|secret-token-never-render/i)
    assert.ok(content.findByText("Next")?.disabled)
  } finally {
    settle?.(null)
    wizard.onClose()
  }
})

test("D363 Mobile Preview blocks a >32 MiB included file before GitHub I/O or one-way fencing", async () => {
  const priorDesktop = Platform.isDesktopApp
  Platform.isDesktopApp = false
  const plugin = fakePlugin()
  ;(plugin as unknown as { manifest: { id: string } }).manifest = { id: "mobile-rekey-test" }
  Object.assign(plugin.settings, {
    ignorePathRegex: "", syncObsidianConfig: false,
    syncBookmarks: false, syncPlugins: false,
  })
  let reads = 0
  let remote = 0
  let metadataLists = 0
  const adapter = {
    async list(path: string) {
      metadataLists++
      assert.equal(path, "/")
      return { files: ["small.md", "oversized.md"], folders: [] }
    },
    async stat(path: string) {
      return { type: "file" as const, size: path === "oversized.md" ? 32 * 1024 * 1024 + 1 : 10, mtime: 10 }
    },
    async readBinary() { reads++; throw new Error("Preview must never read Mobile file contents") },
  }
  ;(plugin.app as unknown as { vault: unknown }).vault = { adapter, configDir: ".obsidian" }
  setRequestUrlHandler(async () => { remote++; throw Error("Mobile oversize must stop before GitHub GET") })
  const wizard = new V4ReencryptionWizardModal(plugin)
  const view = wizard as unknown as { verifySource(): Promise<void>; source?: unknown }
  try {
    wizard.onOpen()
    await view.verifySource()
    assert.equal(view.source, undefined)
    assert.equal(metadataLists, 1, "real Mobile DataAdapter inventory must be scanned")
    assert.equal(reads, 0)
    assert.equal(remote, 0)
    const rendered = wizard.contentEl as unknown as { flattenText(): string }
    assert.match(rendered.flattenText(), /Mobile Re-encryption cannot start:.*32 MiB.*Desktop/iu)
    assert.doesNotMatch(rendered.flattenText(), /oversized\.md|source-token-never-render/iu)
  } finally {
    wizard.onClose()
    setRequestUrlHandler(null)
    Platform.isDesktopApp = priorDesktop
  }
})

test("D360 persisted Recovery appearing after Preview revokes Preflight and Review Next without GitHub I/O", async () => {
  for (const stage of ["preflight", "review"] as const) {
    const plugin = fakePlugin()
    let checks = 0
    ;(plugin.v4Runtime as FastSync["v4Runtime"]).assertReencryptionSettingsSaveAllowed = async () => {
      checks++
      throw new Error("private-wal-and-passphrase-never-render")
    }
    let requests = 0
    setRequestUrlHandler(async () => {
      requests++
      throw Error("A stale Next click must not read GitHub.")
    })
    const wizard = new V4ReencryptionWizardModal(plugin)
    const view = wizard as unknown as {
      step: number; render(): void; source?: {
        physicalRepositoryId: number; defaultBranch: string; pinnedSourceCommitSha: string
        verifiedFileCount: number; verifiedRemoteObjectCount: number; totalVerifiedPlaintextBytes: string
      }
      checked?: { destinationRepoId: string; backupRepoId: string
        physicalRepositoryId: number; pinnedSourceCommitSha: string }
      destinationBranch: string; backupBranch: string
      newPassphrase: string; confirmPassphrase: string
    }
    try {
      wizard.onOpen()
      view.source = {
        physicalRepositoryId: 444, defaultBranch: "main", pinnedSourceCommitSha: "a".repeat(40),
        verifiedFileCount: 0, verifiedRemoteObjectCount: 0, totalVerifiedPlaintextBytes: "0",
      }
      if (stage === "review") {
        view.step = 2
        view.destinationBranch = "rekey/2026-11-09-abcdef01"
        view.backupBranch = "backup/rekey-2026-11-09-abcdef01"
        view.newPassphrase = "new-private-secret-never-render"
        view.confirmPassphrase = view.newPassphrase
        view.checked = {
          destinationRepoId: "owner/vault#" + view.destinationBranch,
          backupRepoId: "owner/vault#" + view.backupBranch,
          physicalRepositoryId: 444,
          pinnedSourceCommitSha: "a".repeat(40),
        }
      }
      view.render()
      const content = wizard.contentEl as unknown as {
        findByText(text: string): { disabled: boolean; onclick?: () => void } | undefined
        flattenText(): string
      }
      const button = content.findByText(stage === "review" ? "View execution requirements" : "Next")
      assert.ok(button && !button.disabled, "earlier read-only evidence made Next available")
      button.onclick?.()
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.equal(checks, 1, "navigation must recheck durable Recovery before accepting a stale proof")
      assert.equal(view.step, stage === "preflight" ? 0 : 2)
      assert.equal(view.source, undefined, "pending Recovery revokes earlier Source Preview evidence")
      assert.equal(view.checked, undefined, "pending Recovery revokes earlier branch availability")
      assert.equal(requests, 0, "Next must not issue a GitHub request")
      assert.match(content.flattenText(), /local re-encryption recovery|recovery.*pending/i)
      assert.doesNotMatch(content.flattenText(),
        /private-wal-and-passphrase-never-render|new-private-secret-never-render|source-token-never-render/iu)
    } finally {
      wizard.onClose()
      setRequestUrlHandler(null)
    }
  }
})

test("D360 clear persisted Recovery permits audited Preflight and Review Next without remote I/O", async () => {
  for (const stage of ["preflight", "review"] as const) {
    const plugin = fakePlugin()
    let checks = 0
    ;(plugin.v4Runtime as FastSync["v4Runtime"]).assertReencryptionSettingsSaveAllowed = async () => {
      checks++
    }
    const wizard = new V4ReencryptionWizardModal(plugin)
    const view = wizard as unknown as {
      step: number; render(): void
      source?: { physicalRepositoryId: number; defaultBranch: string; pinnedSourceCommitSha: string
        verifiedFileCount: number; verifiedRemoteObjectCount: number; totalVerifiedPlaintextBytes: string }
      checked?: { destinationRepoId: string; backupRepoId: string
        physicalRepositoryId: number; pinnedSourceCommitSha: string }
      destinationBranch: string; backupBranch: string; newPassphrase: string; confirmPassphrase: string
    }
    let calls = 0
    setRequestUrlHandler(async () => { calls++; throw Error("Next must not query GitHub") })
    try {
      wizard.onOpen()
      view.source = {
        physicalRepositoryId: 444, defaultBranch: "main", pinnedSourceCommitSha: "a".repeat(40),
        verifiedFileCount: 0, verifiedRemoteObjectCount: 0, totalVerifiedPlaintextBytes: "0",
      }
      if (stage === "review") {
        view.step = 2
        view.destinationBranch = "rekey/2026-11-09-abcdef01"
        view.backupBranch = "backup/rekey-2026-11-09-abcdef01"
        view.newPassphrase = "private-new-passphrase-not-visible"
        view.confirmPassphrase = view.newPassphrase
        view.checked = {
          destinationRepoId: "owner/vault#" + view.destinationBranch,
          backupRepoId: "owner/vault#" + view.backupBranch,
          physicalRepositoryId: 444, pinnedSourceCommitSha: "a".repeat(40),
        }
      }
      view.render()
      const content = wizard.contentEl as unknown as {
        findByText(label: string): { disabled: boolean; onclick?: () => void } | undefined
        flattenText(): string
      }
      const button = content.findByText(stage === "review" ? "View execution requirements" : "Next")
      assert.ok(button && !button.disabled)
      button.onclick?.()
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.equal(checks, 1)
      assert.equal(view.step, stage === "review" ? 3 : 1)
      assert.ok(view.source, "successful read-only navigation retains Source evidence")
      assert.equal(calls, 0)
      assert.doesNotMatch(content.flattenText(), /private-new-passphrase-not-visible|source-token-never-render/iu)
    } finally {
      wizard.onClose()
      setRequestUrlHandler(null)
    }
  }
})

test("D360 stale local Fence response cannot mutate a reopened Wizard", async () => {
  const plugin = fakePlugin()
  let resolve: (() => void) | undefined
  let calls = 0
  ;(plugin.v4Runtime as FastSync["v4Runtime"]).assertReencryptionSettingsSaveAllowed = () => {
    calls++
    return new Promise<void>(done => { resolve = done })
  }
  const wizard = new V4ReencryptionWizardModal(plugin)
  const view = wizard as unknown as {
    step: number; render(): void
    source?: { physicalRepositoryId: number; defaultBranch: string; pinnedSourceCommitSha: string
      verifiedFileCount: number; verifiedRemoteObjectCount: number; totalVerifiedPlaintextBytes: string }
  }
  const source = {
    physicalRepositoryId: 444, defaultBranch: "main", pinnedSourceCommitSha: "a".repeat(40),
    verifiedFileCount: 0, verifiedRemoteObjectCount: 0, totalVerifiedPlaintextBytes: "0",
  }
  const content = wizard.contentEl as unknown as {
    findByText(label: string): { disabled: boolean; onclick?: () => void } | undefined
  }
  try {
    wizard.onOpen()
    view.source = source
    view.render()
    const next = content.findByText("Next")
    assert.ok(next && !next.disabled)
    next.onclick?.()
    assert.equal(calls, 1, "old read-only fence probe is in flight")
    wizard.onClose()
    wizard.onOpen()
    view.source = source
    view.render()
    resolve?.()
    await new Promise<void>(done => setImmediate(done))
    assert.equal(view.step, 0, "an old async answer cannot navigate the reopened instance")
    assert.equal(view.source, source, "old callback cannot clear the new Preview's evidence")
  } finally {
    resolve?.()
    wizard.onClose()
  }
})

test("D358 existing local migration fence blocks both Source and ref Preview before GitHub I/O", async () => {
  for (const step of ["source", "branches"] as const) {
    const plugin = fakePlugin()
    let guardChecks = 0
    ;(plugin.v4Runtime as FastSync["v4Runtime"]).assertReencryptionSettingsSaveAllowed = async () => {
      guardChecks++
      throw new Error("private-path-and-secret-must-not-appear")
    }
    const wizard = new V4ReencryptionWizardModal(plugin)
    const view = wizard as unknown as {
      source?: {
        physicalRepositoryId: number; defaultBranch: string; pinnedSourceCommitSha: string
        verifiedFileCount: number; verifiedRemoteObjectCount: number; totalVerifiedPlaintextBytes: string
      }
      checked?: unknown
      destinationBranch: string; backupBranch: string
      newPassphrase: string; confirmPassphrase: string
      step: number; render(): void
      verifySource(): Promise<void>; checkBranchAvailability(): Promise<void>
    }
    let requests = 0
    setRequestUrlHandler(async () => {
      requests++
      throw new Error("A pending local recovery must prevent remote Preview requests.")
    })
    try {
      wizard.onOpen()
      if (step === "branches") {
        view.source = {
          physicalRepositoryId: 444, defaultBranch: "main", pinnedSourceCommitSha: "a".repeat(40),
          verifiedFileCount: 0, verifiedRemoteObjectCount: 0, totalVerifiedPlaintextBytes: "0",
        }
        view.destinationBranch = "rekey/2026-11-09-abcdef01"
        view.backupBranch = "backup/rekey-2026-11-09-abcdef01"
        view.newPassphrase = "new-private-secret-must-not-render"
        view.confirmPassphrase = view.newPassphrase
        view.step = 2
        view.render()
      }
      if (step === "source") await view.verifySource()
      else await view.checkBranchAvailability()
      assert.equal(guardChecks, 1, step + " must consult persisted local recovery")
      assert.equal(requests, 0, step + " cannot send GitHub GET while Recovery is pending")
      assert.equal(view.checked, undefined)
      if (step === "source") assert.equal(view.source, undefined)
      const visible = (wizard.contentEl as unknown as { flattenText(): string }).flattenText()
      assert.match(visible, /local.*re-encryption|recovery.*pending/i)
      assert.doesNotMatch(visible, /private-path-and-secret|new-private-secret-must-not-render|source-token-never-render/iu)
    } finally {
      wizard.onClose()
      setRequestUrlHandler(null)
    }
  }
})

test("D358 local fence appearing during branch GET revokes the final ready observation", async () => {
  const plugin = fakePlugin()
  let blocked = false
  let checks = 0
  ;(plugin.v4Runtime as FastSync["v4Runtime"]).assertReencryptionSettingsSaveAllowed = async () => {
    checks++
    if (blocked) throw new Error("private-wal-path-never-expose")
  }
  const wizard = new V4ReencryptionWizardModal(plugin)
  const view = wizard as unknown as {
    source?: {
      physicalRepositoryId: number; defaultBranch: string; pinnedSourceCommitSha: string
      verifiedFileCount: number; verifiedRemoteObjectCount: number; totalVerifiedPlaintextBytes: string
    }
    checked?: unknown
    destinationBranch: string; backupBranch: string
    newPassphrase: string; confirmPassphrase: string
    step: number; render(): void; checkBranchAvailability(): Promise<void>
  }
  let reads = 0
  setRequestUrlHandler(async raw => {
    const request = raw as { method?: string; url: string; body?: string }
    reads++
    assert.equal(request.method, "GET")
    assert.equal(request.body, undefined)
    if (reads === 10) blocked = true
    if (request.url.includes("/git/ref/heads/")) {
      return request.url.includes("/heads/main?")
        ? { status: 200, text: "", headers: {}, json: {
          ref: "refs/heads/main", object: { sha: "a".repeat(40), type: "commit" },
        } }
        : { status: 404, text: "", headers: {}, json: {} }
    }
    return { status: 200, text: "", headers: {}, json: {
      id: 444, full_name: "owner/vault", default_branch: "main",
    } }
  })
  try {
    wizard.onOpen()
    view.source = {
      physicalRepositoryId: 444, defaultBranch: "main", pinnedSourceCommitSha: "a".repeat(40),
      verifiedFileCount: 0, verifiedRemoteObjectCount: 0, totalVerifiedPlaintextBytes: "0",
    }
    view.destinationBranch = "rekey/2026-11-09-abcdef01"
    view.backupBranch = "backup/rekey-2026-11-09-abcdef01"
    view.newPassphrase = "new-secret-never-render"
    view.confirmPassphrase = view.newPassphrase
    view.step = 2
    view.render()
    await view.checkBranchAvailability()
    assert.equal(reads, 10, "exercise final remote snapshot before local fence becomes observable")
    assert.ok(checks >= 2, "local persisted state must be checked again after remote reads")
    assert.equal(view.checked, undefined, "late recovery fence revokes apparent GitHub branch availability")
    const visible = (wizard.contentEl as unknown as { flattenText(): string }).flattenText()
    assert.match(visible, /local re-encryption recovery|recovery.*pending/i)
    assert.doesNotMatch(visible, /private-wal-path-never-expose|new-secret-never-render|source-token-never-render/iu)
  } finally {
    wizard.onClose()
    setRequestUrlHandler(null)
  }
})

test("D92 Wizard opens in a read-only, blocked state with no network or branch writes", () => {
  let apiCalls = 0
  setRequestUrlHandler(async () => {
    apiCalls++
    throw new Error("The Wizard must not call GitHub merely because it opened.")
  })
  try {
    const wizard = new V4ReencryptionWizardModal(fakePlugin())
    wizard.onOpen()
    const content = wizard.contentEl.textContent ?? (wizard.contentEl as unknown as {flattenText:()=>string}).flattenText()
    assert.match(content, /Preview|preview/)
    assert.match(content, /source|snapshot/i)
    assert.match(content, /read-only/i)
    assert.match(content, /production safety gates/i)
    assert.ok(!content.includes("source-passphrase-never-render"))
    assert.ok(!content.includes("source-token-never-render"))
    assert.equal(apiCalls, 0)
    wizard.onClose()
    assert.equal(apiCalls, 0)
  } finally {
    setRequestUrlHandler(null)
  }
})

test("D92 Wizard preflight refuses unencrypted and busy source without network I/O or mutation", async () => {
  let apiCalls = 0
  setRequestUrlHandler(async () => {
    apiCalls++
    throw new Error("Unexpected GitHub call from an ineligible Wizard.")
  })
  try {
    for (const [mode, active] of [["plaintext", false], ["encrypted", true]] as const) {
      const wizard = new V4ReencryptionWizardModal(fakePlugin(mode, active))
      wizard.onOpen()
      // Exercise the same click handler used by Step 1; no private data exposed.
      await (wizard as unknown as { verifySource(): Promise<void> }).verifySource()
      const text = (wizard.contentEl as unknown as { flattenText(): string }).flattenText()
      assert.match(text, /Save a configured encrypted|Sync or Settings save operation is active/i)
      assert.match(text, /BLOCKED|disabled/i)
      wizard.onClose()
    }
    assert.equal(apiCalls, 0)
  } finally {
    setRequestUrlHandler(null)
  }
})

test("D96 Wizard rejects in-place and replacement connection edits after dialog opens", async () => {
  const plugin = fakePlugin()
  const wizard = new V4ReencryptionWizardModal(plugin)
  wizard.onOpen()
  const internal = wizard as unknown as {
    matchesConnection(): boolean
    verifySource(): Promise<void>
  }
  assert.equal(internal.matchesConnection(), true)

  const originalToken = plugin.settings.githubToken
  plugin.settings.githubToken = "secret-rotated-in-place"
  assert.equal(internal.matchesConnection(), false)
  let apiCalls = 0
  setRequestUrlHandler(async () => {
    apiCalls++
    throw new Error("Wizard must not run a verified source read with changed settings.")
  })
  try {
    await internal.verifySource()
    assert.equal(apiCalls, 0)
    const text = (wizard.contentEl as unknown as { flattenText(): string }).flattenText()
    assert.match(text, /configured encrypted GitHub connection/i)
    assert.ok(!text.includes("secret-rotated-in-place"))
    plugin.settings.githubToken = originalToken
    assert.equal(internal.matchesConnection(), true)
    const original = plugin.settings
    plugin.settings = { ...original, githubBranch: "another" }
    assert.equal(internal.matchesConnection(), false)
    plugin.settings = original
    assert.equal(internal.matchesConnection(), true)
  } finally {
    setRequestUrlHandler(null)
    wizard.onClose()
  }
})

test("D130 Wizard preview explains cross-platform best-effort and one-confirmation automatic finish without authorizing execution", () => {
  const wizard = new V4ReencryptionWizardModal(fakePlugin())
  wizard.onOpen()
  const debug = wizard as unknown as { step: number; render(): void }
  let content = (wizard.contentEl as unknown as { flattenText(): string }).flattenText()
  assert.match(content, /best.effort/i)
  assert.match(content, /external.*write|external.*edit/i)
  debug.step = 4
  debug.render()
  content = (wizard.contentEl as unknown as { flattenText(): string }).flattenText()
  assert.match(content, /automatic/i)
  assert.match(content, /once|one confirmation/i)
  assert.match(content, /best.effort recovery/i)
  assert.match(content, /Manual Recovery/i)
  assert.match(content, /no physical power.loss guarantee/i)
  assert.match(content, /BOTH passphrases/i)
  assert.match(content, /BLOCKED|disabled/i)
  wizard.onClose()
})

test("D187 Wizard Preview shows safe Manual Recovery actions without GitHub or settings writes", () => {
  let apiCalls = 0
  setRequestUrlHandler(async () => {
    apiCalls++
    throw new Error("Recovery guidance must not make a GitHub request.")
  })
  const plugin = fakePlugin()
  const originalSettings = JSON.stringify(plugin.settings)
  try {
    const wizard = new V4ReencryptionWizardModal(plugin)
    wizard.onOpen()
    const view = wizard as unknown as { step: number; render(): void }
    view.step = 3
    view.render()
    const text = (wizard.contentEl as unknown as { flattenText(): string }).flattenText()
    assert.match(text, /Manual Recovery checklist/i)
    assert.match(text, /only if a future migration is interrupted/i)
    assert.match(text, /Preview has made no changes/i)
    assert.match(text, /stop.*Sync.*device/i)
    assert.match(text, /vault.*plugin data/i)
    assert.match(text, /BOTH passphrases/i)
    assert.match(text, /Source.*Backup.*Destination.*history/i)
    assert.match(text, /WAL.*Selector.*Receipt/i)
    assert.match(text, /do not.*(force push|Force Push)/i)
    assert.match(text, /do not.*resume Sync/i)
    assert.doesNotMatch(text, /source-passphrase-never-render|source-token-never-render/i)
    assert.equal(apiCalls, 0)
    assert.equal(JSON.stringify(plugin.settings), originalSettings)
    wizard.onClose()
    assert.equal(apiCalls, 0)
  } finally {
    setRequestUrlHandler(null)
  }
})

test("D222 Wizard explains distinct Manual Recovery scenarios as preview examples only, without I/O or Cutover", () => {
  const plugin = fakePlugin()
  const original = JSON.stringify(plugin.settings)
  let calls = 0
  setRequestUrlHandler(async () => {
    calls++
    throw Error("The Manual Recovery guide must never fetch GitHub.")
  })
  try {
    const wizard = new V4ReencryptionWizardModal(plugin)
    wizard.onOpen()
    const debug = wizard as unknown as { step: number; render(): void }
    debug.step = 3
    debug.render()
    const text = (wizard.contentEl as unknown as { flattenText(): string }).flattenText()
    assert.match(text, /Manual Recovery examples — not a live scan/)
    assert.match(text, /has NOT inspected local WAL\/Selector\/Receipt or current Git branches/)
    assert.match(text, /Receipt\/Selector staging was interrupted/)
    assert.match(text, /Historical test pair matches; current Git remains uncertain/)
    assert.match(text, /Encrypted test pair and current Git content match, but no commit exists/)
    assert.match(text, /Settings and local Index no longer both point at Source/)
    assert.match(text, /Evidence is missing, foreign, torn or cannot be verified/)
    assert.match(text, /No example authorizes Sync Resume, rollback, a branch switch, or old-key deletion/)
    assert.doesNotMatch(text, /source-passphrase-never-render|source-token-never-render/)
    assert.match(text, /NOT STARTED/)
    assert.equal(JSON.stringify(plugin.settings), original)
    assert.equal(calls, 0)
    wizard.onClose()
    assert.equal(calls, 0)
  } finally {
    setRequestUrlHandler(null)
  }
})

test("D327 Preview discloses the current Mobile whole-buffer Re-encryption size limit", () => {
  const wizard = new V4ReencryptionWizardModal(fakePlugin())
  const view = wizard as unknown as {
    step: number; render(): void
    source?: {
      physicalRepositoryId: number; defaultBranch: string; pinnedSourceCommitSha: string
      verifiedFileCount: number; verifiedRemoteObjectCount: number; totalVerifiedPlaintextBytes: string
    }
    newPassphrase: string; confirmPassphrase: string
  }
  const visible = () => (wizard.contentEl as unknown as { flattenText(): string }).flattenText()
  try {
    wizard.onOpen()
    assert.match(visible(), /Mobile.*32 MiB/i,
      "preflight must disclose the Mobile whole-file limit before remote verification")
    assert.match(visible(), /readBinary|whole.buffer/i)
    view.source = {
      physicalRepositoryId: 444, defaultBranch: "main",
      pinnedSourceCommitSha: "a".repeat(40),
      verifiedFileCount: 0, verifiedRemoteObjectCount: 0, totalVerifiedPlaintextBytes: "0",
    }
    view.newPassphrase = "new-private-secret-never-render"
    view.confirmPassphrase = view.newPassphrase
    view.step = 2
    view.render()
    assert.match(visible(), /Mobile.*32 MiB/i,
      "review must disclose the limit before any future execution authorization")
    assert.match(visible(), /Preview|BLOCKED/i)
    assert.doesNotMatch(visible(), /new-private-secret-never-render|source-token-never-render/u)
  } finally {
    wizard.onClose()
  }
})

test("D133 old-passphrase loss warning appears before migration confirmation, without exposing secrets or another confirmation", () => {
  const wizard = new V4ReencryptionWizardModal(fakePlugin())
  wizard.onOpen()
  const debug = wizard as unknown as {
    step: number
    render(): void
    source: {
      physicalRepositoryId: number; defaultBranch: string; pinnedSourceCommitSha: string
      verifiedFileCount: number; verifiedRemoteObjectCount: number; totalVerifiedPlaintextBytes: string
    }
    newPassphrase: string; confirmPassphrase: string
  }
  const flattened = () => (wizard.contentEl as unknown as { flattenText(): string }).flattenText()
  debug.step = 1
  debug.render()
  assert.match(flattened(), /old passphrase/i)
  assert.match(flattened(), /source.*backup|backup.*source/i)
  debug.source = {
    physicalRepositoryId: 123456, defaultBranch: "main",
    pinnedSourceCommitSha: "a".repeat(40),
    verifiedFileCount: 0, verifiedRemoteObjectCount: 0, totalVerifiedPlaintextBytes: "0",
  }
  debug.newPassphrase = "new-passphrase-never-render"
  debug.confirmPassphrase = "new-passphrase-never-render"
  debug.step = 2
  debug.render()
  const review = flattened()
  assert.match(review, /old passphrase/i)
  assert.match(review, /save|keep.*copy/i)
  assert.match(review, /source.*backup|backup.*source/i)
  assert.match(review, /after.*crash.safe|after.*verified/i)
  assert.match(review, /SecretStorage/i)
  assert.doesNotMatch(review, /source-passphrase-never-render|new-passphrase-never-render|source-token-never-render/)
  assert.match(review, /BLOCKED/)
  debug.step = 4
  debug.render()
  const finish = flattened()
  assert.match(finish, /old passphrase/i)
  assert.match(finish, /clear|remove/i)
  assert.match(finish, /crash.safe|verified/i)
  assert.match(finish, /BLOCKED/)
  wizard.onClose()
})



test("D153 Wizard branch availability rechecks exact pinned Source HEAD and default branch via GET only", async () => {
  const expectedSha = "a".repeat(40)
  const otherSha = "b".repeat(40)
  const respond = (json: unknown, status = 200) => ({
    status, text: status === 200 ? "" : "unavailable", json, headers: {},
  })
  for (const scenario of [
    "stable", "source-moved", "default-moved", "wrong-source-ref",
    "missing-source-ref", "source-request-fails", "repository-swapped", "destination-collision",
    "untrusted-ref-error", "untrusted-repo-error",
    "late-source-moved", "late-default-moved", "late-repository-swapped",
  ] as const) {
    const plugin = fakePlugin()
    const wizard = new V4ReencryptionWizardModal(plugin)
    const view = wizard as unknown as {
      source: {
        physicalRepositoryId: number; defaultBranch: string; pinnedSourceCommitSha: string;
        verifiedFileCount: number; verifiedRemoteObjectCount: number;
        totalVerifiedPlaintextBytes: string
      }
      checked?: {
        pinnedSourceCommitSha: string; physicalRepositoryId: number;
        destinationRepoId: string; backupRepoId: string
      }
      step: number; render(): void; checkBranchAvailability(): Promise<void>
      destinationBranch: string; backupBranch: string;
      newPassphrase: string; confirmPassphrase: string
    }
    view.source = {
      physicalRepositoryId: 444, defaultBranch: "main", pinnedSourceCommitSha: expectedSha,
      verifiedFileCount: 0, verifiedRemoteObjectCount: 0, totalVerifiedPlaintextBytes: "0",
    }
    view.destinationBranch = "rekey/2026-10-29-abcdef01"
    view.backupBranch = "backup/rekey-2026-10-29-abcdef01"
    view.newPassphrase = "different-preview-only-passphrase"
    view.confirmPassphrase = "different-preview-only-passphrase"
    const requests: Array<{url: string; method?: string; body?: unknown}> = []
    let sourceHeadReads = 0
    let branchReadsAfterSource = 0
    setRequestUrlHandler(async raw => {
      const request = raw as {url: string; method?: string; body?: unknown}
      requests.push(request)
      assert.equal(request.method, "GET", "Preview must never send a mutation")
      assert.equal(request.body, undefined, "Preview must never send request payloads")
      if (request.url.includes("/git/ref/heads/")) {
        if (scenario === "untrusted-ref-error" && request.url.includes("/heads/rekey/")) {
          throw new Error("A proposed branch already exists. source-token-never-render")
        }
        if (request.url.includes("/heads/main?")) {
          sourceHeadReads++
          if (scenario === "missing-source-ref") return respond({}, 404)
          if (scenario === "source-request-fails") return respond({}, 403)
          return respond({
            ref: scenario === "wrong-source-ref" ? "refs/heads/other" : "refs/heads/main",
            object: { sha: scenario === "source-moved"
              || (scenario === "late-source-moved" && sourceHeadReads > 1) ? otherSha : expectedSha, type: "commit" },
          })
        }
        if (sourceHeadReads > 0) branchReadsAfterSource++
        return scenario === "destination-collision"
          && request.url.includes("/heads/rekey/")
          ? respond({ ref: "refs/heads/rekey/2026-10-29-abcdef01",
              object: { sha: otherSha, type: "commit" } })
          : respond({}, 404)
      }
      assert.match(request.url, /^https:\/\/api\.github\.com\/repos\/owner\/vault$/u)
      if (scenario === "untrusted-repo-error") {
        throw new Error("Repository identity changed. source-token-never-render")
      }
      return respond({
        id: scenario === "repository-swapped"
          || (scenario === "late-repository-swapped" && branchReadsAfterSource >= 2) ? 999 : 444,
        full_name: "owner/vault",
        default_branch: scenario === "default-moved"
          || (scenario === "late-default-moved" && branchReadsAfterSource >= 2) ? "alternate" : "main",
      })
    })
    try {
      wizard.onOpen()
      view.step = 2
      view.render()
      await view.checkBranchAvailability()
      const text = (wizard.contentEl as unknown as {flattenText(): string}).flattenText()
      if (scenario === "stable") {
        assert.equal(view.checked?.pinnedSourceCommitSha, expectedSha)
        assert.equal(view.checked?.physicalRepositoryId, 444)
        assert.match(text, /Both refs were absent before and after Source/i)
        assert.equal(requests.length, 10, "two pairs of branch lookups and two Source identity/default/HEAD observations")
      } else {
        assert.equal(view.checked, undefined, scenario + " must not mark branch names ready")
        if (scenario === "source-moved" || scenario === "default-moved"
          || scenario === "late-source-moved" || scenario === "late-default-moved") {
          assert.match(text, /source again/i, "stale source must tell user to repeat verification")
        }
        if (scenario === "untrusted-ref-error" || scenario === "untrusted-repo-error") {
          assert.match(text, /Branch verification failed. GitHub must confirm both names are unused/i)
        }
        assert.match(text, /Not checked|Check the destination/i)
      }
      assert.ok(requests.every(request => request.method === "GET" && request.body === undefined))
      assert.ok(!text.includes("source-token-never-render"))
      assert.ok(!text.includes("source-passphrase-never-render"))
      assert.ok(!text.includes("different-preview-only-passphrase"))
    } finally {
      wizard.onClose()
      setRequestUrlHandler(null)
    }
  }
})


test("D345 replaced Vault DataAdapter prevents stale Preview from starting a new GitHub read", async () => {
  const plugin = fakePlugin()
  const vault = { configDir: ".obsidian", adapter: { id: "original" } }
  ;(plugin.app as unknown as { vault: typeof vault }).vault = vault
  const wizard = new V4ReencryptionWizardModal(plugin)
  const view = wizard as unknown as {
    verifySource(): Promise<void>; checkBranchAvailability(): Promise<void>
    source?: {
      physicalRepositoryId: number; defaultBranch: string; pinnedSourceCommitSha: string
      verifiedFileCount: number; verifiedRemoteObjectCount: number; totalVerifiedPlaintextBytes: string
    }
    checked?: { destinationRepoId: string }
    destinationBranch: string; backupBranch: string
    newPassphrase: string; confirmPassphrase: string
    step: number; render(): void
  }
  let reads = 0
  setRequestUrlHandler(async () => {
    reads++
    throw new Error("Stale Preview must not start GitHub I/O after Vault adapter replacement.")
  })
  try {
    wizard.onOpen()
    vault.adapter = { id: "replacement" }
    await view.verifySource()
    assert.equal(reads, 0, "stale Source preflight must reject before GitHub GET")
    let visible = (wizard.contentEl as unknown as { flattenText(): string }).flattenText()
    assert.match(visible, /configured encrypted|connection|Vault|scope/i)

    // Reintroduce a previously verified remote snapshot only to exercise
    // branch-check entrypoint. The current Vault adapter is still different.
    view.source = {
      physicalRepositoryId: 444, defaultBranch: "main",
      pinnedSourceCommitSha: "a".repeat(40), verifiedFileCount: 0,
      verifiedRemoteObjectCount: 0, totalVerifiedPlaintextBytes: "0",
    }
    view.destinationBranch = "rekey/2026-11-08-abcdef01"
    view.backupBranch = "backup/rekey-2026-11-08-abcdef01"
    view.newPassphrase = "new-private-d345"
    view.confirmPassphrase = view.newPassphrase
    view.step = 2
    view.render()
    await view.checkBranchAvailability()
    assert.equal(reads, 0, "stale branch preflight must reject before GitHub GET")
    assert.equal(view.checked, undefined)
    visible = (wizard.contentEl as unknown as { flattenText(): string }).flattenText()
    assert.doesNotMatch(visible, /new-private-d345|source-token-never-render/)
  } finally {
    wizard.onClose()
    setRequestUrlHandler(null)
  }
})

test("D313 Wizard refuses late local Sync scope or Vault replacement despite unchanged GitHub HEAD", async () => {
  const pinnedSha = "a".repeat(40)
  const respond = (json: unknown, status = 200) => ({
    status, text: status === 200 ? "" : "not found", json, headers: {},
  })
  const scopeChanges: ReadonlyArray<readonly [string, (plugin: FastSync) => void]> = [
    ["ignore-regex", plugin => { plugin.settings.ignorePathRegex = "^exclude-now" }],
    ["plugins-scope", plugin => { plugin.settings.syncPlugins = !plugin.settings.syncPlugins }],
    ["bookmarks-scope", plugin => { plugin.settings.syncBookmarks = !plugin.settings.syncBookmarks }],
    ["config-scope", plugin => { plugin.settings.syncObsidianConfig = !plugin.settings.syncObsidianConfig }],
    ["vault-identity", plugin => { plugin.settings.vault = "different-vault" }],
    ["secret-identity", plugin => { plugin.settings.encryptionPassphraseSecretId = "rotated-secret-id" }],
    ["physical-vault", plugin => {
      (plugin.app as unknown as {vault: {configDir: string}}).vault = { configDir: ".obsidian" }
    }],
    ["config-dir", plugin => {
      (plugin.app as unknown as {vault: {configDir: string}}).vault.configDir = ".alternate"
    }],
    ["vault-adapter-in-place", plugin => {
      (plugin.app as unknown as {vault: {adapter: object}}).vault.adapter = { changed: true }
    }],
  ]
  for (const [scenario, change] of scopeChanges) {
    const plugin = fakePlugin()
    ;(plugin.app as unknown as {vault: {configDir: string; adapter: object}}).vault = {
      configDir: ".obsidian", adapter: {},
    }
    const wizard = new V4ReencryptionWizardModal(plugin)
    const view = wizard as unknown as {
      source: {
        physicalRepositoryId: number; defaultBranch: string; pinnedSourceCommitSha: string
        verifiedFileCount: number; verifiedRemoteObjectCount: number; totalVerifiedPlaintextBytes: string
      }
      checked?: {pinnedSourceCommitSha: string}
      step: number; render(): void; checkBranchAvailability(): Promise<void>
      destinationBranch: string; backupBranch: string
      newPassphrase: string; confirmPassphrase: string
    }
    view.source = {
      physicalRepositoryId: 444, defaultBranch: "main", pinnedSourceCommitSha: pinnedSha,
      verifiedFileCount: 0, verifiedRemoteObjectCount: 0, totalVerifiedPlaintextBytes: "0",
    }
    view.destinationBranch = "rekey/2026-11-07-abcdef01"
    view.backupBranch = "backup/rekey-2026-11-07-abcdef01"
    view.newPassphrase = "new-passphrase-never-render"
    view.confirmPassphrase = "new-passphrase-never-render"
    let requests = 0
    setRequestUrlHandler(async raw => {
      const request = raw as {url: string; method?: string; body?: unknown}
      requests++
      assert.equal(request.method, "GET", "Wizard Preview is strictly read-only")
      assert.equal(request.body, undefined)
      if (requests === 10) change(plugin)
      if (request.url.includes("/git/ref/heads/")) {
        if (request.url.includes("/heads/main?")) {
          return respond({ref: "refs/heads/main", object: {sha: pinnedSha, type: "commit"}})
        }
        return respond({}, 404)
      }
      assert.match(request.url, /^https:\/\/api\.github\.com\/repos\/owner\/vault$/u)
      return respond({id: 444, full_name: "owner/vault", default_branch: "main"})
    })
    try {
      wizard.onOpen()
      view.step = 2
      view.render()
      await view.checkBranchAvailability()
      assert.equal(requests, 10, scenario + " must reach the final source read")
      assert.equal(view.checked, undefined, scenario + " must not reuse a stale verified scope")
      const text = (wizard.contentEl as unknown as {flattenText(): string}).flattenText()
      assert.match(text, /settings changed during verification|connection changed/i, scenario)
      assert.doesNotMatch(text, /new-passphrase-never-render|source-token-never-render/u)
    } finally {
      wizard.onClose()
      setRequestUrlHandler(null)
    }
  }
})

test("D326 Wizard refuses a late PBKDF2 or reconfirmed passphrase edit during branch verification", async () => {
  const sourceSha = "a".repeat(40)
  const respond = (json: unknown, status = 200) => ({
    status, text: status === 200 ? "" : "not found", json, headers: {},
  })
  for (const scenario of ["iterations", "new-passphrase-and-confirmation"] as const) {
    const plugin = fakePlugin()
    const wizard = new V4ReencryptionWizardModal(plugin)
    const view = wizard as unknown as {
      source: {
        physicalRepositoryId: number; defaultBranch: string; pinnedSourceCommitSha: string
        verifiedFileCount: number; verifiedRemoteObjectCount: number
        totalVerifiedPlaintextBytes: string
      }
      checked?: { destinationRepoId: string }
      step: number; render(): void; checkBranchAvailability(): Promise<void>
      destinationBranch: string; backupBranch: string
      newPassphrase: string; confirmPassphrase: string; iterations: number
    }
    view.source = {
      physicalRepositoryId: 444, defaultBranch: "main",
      pinnedSourceCommitSha: sourceSha, verifiedFileCount: 0,
      verifiedRemoteObjectCount: 0, totalVerifiedPlaintextBytes: "0",
    }
    view.destinationBranch = "rekey/2026-11-07-abcdef01"
    view.backupBranch = "backup/rekey-2026-11-07-abcdef01"
    view.newPassphrase = "new-secret-before-remote-request"
    view.confirmPassphrase = view.newPassphrase
    const originalIterations = view.iterations
    let requests = 0
    setRequestUrlHandler(async raw => {
      const request = raw as { url: string; method?: string; body?: unknown }
      requests++
      assert.equal(request.method, "GET", "Wizard Preview must never mutate GitHub")
      assert.equal(request.body, undefined)
      // A real user can change the slider or both passphrase inputs while a
      // slow final GET is outstanding. The branch names remain identical.
      if (requests === 10) {
        if (scenario === "iterations") {
          view.iterations = originalIterations + 100_000
        } else {
          view.newPassphrase = "new-secret-after-remote-request"
          view.confirmPassphrase = view.newPassphrase
        }
      }
      if (request.url.includes("/git/ref/heads/")) {
        return request.url.includes("/heads/main?")
          ? respond({ ref: "refs/heads/main", object: { sha: sourceSha, type: "commit" } })
          : respond({}, 404)
      }
      assert.equal(request.url, "https://api.github.com/repos/owner/vault")
      return respond({ id: 444, full_name: "owner/vault", default_branch: "main" })
    })
    try {
      wizard.onOpen()
      view.step = 2
      view.render()
      await view.checkBranchAvailability()
      assert.equal(requests, 10, scenario + " must reach final remote revalidation")
      assert.equal(view.checked, undefined,
        scenario + " must not certify changed encryption parameters under old branch checks")
      const visible = (wizard.contentEl as unknown as { flattenText(): string }).flattenText()
      assert.match(visible, /settings changed during verification|verify again/i)
      assert.doesNotMatch(visible, /new-secret-before-remote-request|new-secret-after-remote-request/)
    } finally {
      wizard.onClose()
      setRequestUrlHandler(null)
    }
  }
})

test("D188 Wizard refuses a backup or destination created during Source revalidation", async () => {
  const sourceSha = "a".repeat(40)
  const newlyCreatedSha = "b".repeat(40)
  const destination = "rekey/2026-10-31-a1b2c3d4"
  const backup = "backup/rekey-2026-10-31-a1b2c3d4"
  const respond = (json: unknown, status = 200) => ({
    status, text: status === 200 ? "" : "not found", json, headers: {},
  })
  for (const created of ["destination", "backup"] as const) {
    const plugin = fakePlugin()
    const wizard = new V4ReencryptionWizardModal(plugin)
    const view = wizard as unknown as {
      source: {
        physicalRepositoryId: number; defaultBranch: string; pinnedSourceCommitSha: string;
        verifiedFileCount: number; verifiedRemoteObjectCount: number;
        totalVerifiedPlaintextBytes: string
      }
      checked?: { destinationRepoId: string }
      step: number; render(): void; checkBranchAvailability(): Promise<void>
      destinationBranch: string; backupBranch: string
      newPassphrase: string; confirmPassphrase: string
    }
    view.source = {
      physicalRepositoryId: 444, defaultBranch: "main",
      pinnedSourceCommitSha: sourceSha, verifiedFileCount: 0,
      verifiedRemoteObjectCount: 0, totalVerifiedPlaintextBytes: "0",
    }
    view.destinationBranch = destination
    view.backupBranch = backup
    view.newPassphrase = "new-secret-never-render"
    view.confirmPassphrase = "new-secret-never-render"
    let sourceRechecked = false
    const requests: Array<{url: string; method?: string; body?: unknown}> = []
    setRequestUrlHandler(async raw => {
      const request = raw as {url: string; method?: string; body?: unknown}
      requests.push(request)
      assert.equal(request.method, "GET")
      assert.equal(request.body, undefined)
      if (request.url.includes("/git/ref/heads/")) {
        if (request.url.includes("/heads/main?")) {
          sourceRechecked = true
          return respond({ref: "refs/heads/main", object: {sha: sourceSha, type: "commit"}})
        }
        const branch = created === "destination" ? destination : backup
        if (sourceRechecked && request.url.includes("/heads/" + branch + "?")) {
          return respond({ref: "refs/heads/" + branch,
            object: {sha: newlyCreatedSha, type: "commit"}})
        }
        return respond({}, 404)
      }
      assert.equal(request.url, "https://api.github.com/repos/owner/vault")
      return respond({id: 444, full_name: "owner/vault", default_branch: "main"})
    })
    try {
      wizard.onOpen()
      view.step = 2
      view.render()
      await view.checkBranchAvailability()
      const text = (wizard.contentEl as unknown as {flattenText(): string}).flattenText()
      assert.equal(sourceRechecked, true, created)
      assert.equal(view.checked, undefined, created + " became occupied during verification")
      assert.match(text, /already exists|Branch verification failed/i)
      assert.doesNotMatch(text, /new-secret-never-render|source-token-never-render/)
      assert.ok(requests.every(r => r.method === "GET" && r.body === undefined))
    } finally {
      wizard.onClose()
      setRequestUrlHandler(null)
    }
  }
})

test("D189 Wizard never displays a credential-bearing GitHub client error as trusted review guidance", async () => {
  const plugin = fakePlugin()
  const wizard = new V4ReencryptionWizardModal(plugin)
  const view = wizard as unknown as {
    source: {
      physicalRepositoryId: number; defaultBranch: string; pinnedSourceCommitSha: string;
      verifiedFileCount: number; verifiedRemoteObjectCount: number;
      totalVerifiedPlaintextBytes: string
    }
    step: number; render(): void; checkBranchAvailability(): Promise<void>
    destinationBranch: string; backupBranch: string
    newPassphrase: string; confirmPassphrase: string
    checked?: { destinationRepoId: string }
  }
  view.source = {
    physicalRepositoryId: 444, defaultBranch: "main",
    pinnedSourceCommitSha: "a".repeat(40),
    verifiedFileCount: 0, verifiedRemoteObjectCount: 0,
    totalVerifiedPlaintextBytes: "0",
  }
  view.destinationBranch = "rekey/2026-10-31-a1b2c3d4"
  view.backupBranch = "backup/rekey-2026-10-31-a1b2c3d4"
  view.newPassphrase = "new-secret-never-render"
  view.confirmPassphrase = "new-secret-never-render"
  const originalReader = GitHubClient.prototype.getGitRefOrNull
  GitHubClient.prototype.getGitRefOrNull = async () => {
    throw new Error("A proposed branch already exists. source-token-never-render")
  }
  let networkCalls = 0
  setRequestUrlHandler(async () => {
    networkCalls++
    throw Error("Unexpected network request during injected error.")
  })
  try {
    wizard.onOpen()
    view.step = 2
    view.render()
    await view.checkBranchAvailability()
    const text = (wizard.contentEl as unknown as { flattenText(): string }).flattenText()
    assert.equal(view.checked, undefined)
    assert.match(text, /Branch verification failed. GitHub must confirm both names are unused/i)
    assert.doesNotMatch(text, /source-token-never-render|new-secret-never-render/i)
    assert.equal(networkCalls, 0)
  } finally {
    GitHubClient.prototype.getGitRefOrNull = originalReader
    wizard.onClose()
    setRequestUrlHandler(null)
  }
})

test("D341 completed Sync invalidates Preview before either new GitHub read starts", async () => {
  for (const mode of ["source", "branches"] as const) {
    const plugin = fakePlugin()
    const wizard = new V4ReencryptionWizardModal(plugin)
    const view = wizard as unknown as {
      source?: {
        physicalRepositoryId: number; defaultBranch: string; pinnedSourceCommitSha: string
        verifiedFileCount: number; verifiedRemoteObjectCount: number; totalVerifiedPlaintextBytes: string
      }
      checked?: { destinationRepoId: string }
      destinationBranch: string; backupBranch: string
      newPassphrase: string; confirmPassphrase: string
      step: number; render(): void
      verifySource(): Promise<void>; checkBranchAvailability(): Promise<void>
    }
    if (mode === "branches") {
      view.source = {
        physicalRepositoryId: 444, defaultBranch: "main",
        pinnedSourceCommitSha: "a".repeat(40), verifiedFileCount: 0,
        verifiedRemoteObjectCount: 0, totalVerifiedPlaintextBytes: "0",
      }
      view.destinationBranch = "rekey/2026-11-08-abcdef01"
      view.backupBranch = "backup/rekey-2026-11-08-abcdef01"
      view.newPassphrase = "new-secret-never-render"
      view.confirmPassphrase = view.newPassphrase
    }
    let requests = 0
    let fenceCalls = 0
    ;(plugin.v4Runtime as unknown as { armReencryptionSyncFence: () => Promise<void> })
      .armReencryptionSyncFence = async () => { fenceCalls++ }
    setRequestUrlHandler(async () => {
      requests++
      throw new Error("Stale Preview must not start a GitHub request.")
    })
    try {
      wizard.onOpen()
      if (mode === "branches") {
        view.step = 2
        view.render()
      }
      // A complete Sync can start and finish between Wizard open and a click.
      // Its active flag is false, but the generation is now different.
      ;(plugin.v4Runtime as unknown as { syncExecutionGeneration: number })
        .syncExecutionGeneration++
      await (mode === "source" ? view.verifySource() : view.checkBranchAvailability())
      assert.equal(requests, 0, mode + " must reject stale proof before GET")
      assert.equal(fenceCalls, 0, "read-only Preview must not arm the one-way Sync fence")
      assert.equal(view.checked, undefined)
      if (mode === "source") assert.equal(view.source, undefined)
      const display = (wizard.contentEl as unknown as { flattenText(): string }).flattenText()
      assert.match(display, /Sync|reopen Preview/i)
      assert.doesNotMatch(display, /new-secret-never-render|source-token-never-render/i)
    } finally {
      wizard.onClose()
      setRequestUrlHandler(null)
    }
  }
})

test("D330 Wizard refuses starting new GitHub Preview checks during plugin-level Sync or Settings save", async () => {
  for (const mode of ["source", "branches"] as const) {
    for (const state of ["plugin-sync", "settings-save"] as const) {
      const plugin = fakePlugin()
      const wizard = new V4ReencryptionWizardModal(plugin)
      const view = wizard as unknown as {
        source?: {
          physicalRepositoryId: number; defaultBranch: string; pinnedSourceCommitSha: string
          verifiedFileCount: number; verifiedRemoteObjectCount: number
          totalVerifiedPlaintextBytes: string
        }
        checked?: { destinationRepoId: string }
        destinationBranch: string; backupBranch: string
        newPassphrase: string; confirmPassphrase: string
        step: number; render(): void
        verifySource(): Promise<void>; checkBranchAvailability(): Promise<void>
      }
      if (mode === "branches") {
        view.source = {
          physicalRepositoryId: 444, defaultBranch: "main",
          pinnedSourceCommitSha: "a".repeat(40), verifiedFileCount: 0,
          verifiedRemoteObjectCount: 0, totalVerifiedPlaintextBytes: "0",
        }
        view.destinationBranch = "rekey/2026-11-07-abcdef01"
        view.backupBranch = "backup/rekey-2026-11-07-abcdef01"
        view.newPassphrase = "new-secret-never-show"
        view.confirmPassphrase = view.newPassphrase
      }
      if (state === "plugin-sync") {
        (plugin as FastSync & {isSyncInProgress: boolean}).isSyncInProgress = true
      } else {
        plugin.isSettingsSaveInProgress = () => true
      }
      let calls = 0
      setRequestUrlHandler(async () => {
        calls++
        throw Error("Busy Wizard must not contact GitHub")
      })
      try {
        wizard.onOpen()
        if (mode === "branches") {
          view.step = 2
          view.render()
        }
        await (mode === "source" ? view.verifySource() : view.checkBranchAvailability())
        assert.equal(calls, 0, mode + "/" + state + " must fail closed before GitHub")
        assert.equal(view.checked, undefined)
        if (mode === "source") assert.equal(view.source, undefined)
        const display = (wizard.contentEl as unknown as {flattenText(): string}).flattenText()
        assert.match(display, /Sync|Settings save/i)
        assert.doesNotMatch(display, /new-secret-never-show|source-token-never-render/)
      } finally {
        wizard.onClose()
        setRequestUrlHandler(null)
      }
    }
  }
})

test("D154 Wizard discards async preview reads if Sync starts, settings change or dialog closes", async () => {
  const respond = (json: unknown, status = 200) => ({
    status, text: status === 200 ? "" : "unavailable", json, headers: {},
  })
  for (const mode of ["source", "branches"] as const) {
    for (const interruption of ["sync", "sync-finished", "settings", "close", "runtime",
      "plugin-sync", "settings-save", "settings-save-finished"] as const) {
      const plugin = fakePlugin()
      const wizard = new V4ReencryptionWizardModal(plugin)
      const view = wizard as unknown as {
        source?: {
          physicalRepositoryId: number; defaultBranch: string; pinnedSourceCommitSha: string;
          verifiedFileCount: number; verifiedRemoteObjectCount: number;
          totalVerifiedPlaintextBytes: string
        }
        checked?: {pinnedSourceCommitSha: string}
        destinationBranch: string; backupBranch: string
        newPassphrase: string; confirmPassphrase: string
        step: number; render(): void
        verifySource(): Promise<void>; checkBranchAvailability(): Promise<void>
      }
      if (mode === "branches") {
        view.source = {
          physicalRepositoryId: 444, defaultBranch: "main",
          pinnedSourceCommitSha: "a".repeat(40),
          verifiedFileCount: 0, verifiedRemoteObjectCount: 0,
          totalVerifiedPlaintextBytes: "0",
        }
        view.destinationBranch = "rekey/2026-10-29-abcdef01"
        view.backupBranch = "backup/rekey-2026-10-29-abcdef01"
        view.newPassphrase = "new-preview-only-secret"
        view.confirmPassphrase = "new-preview-only-secret"
      }
      let entered!: () => void
      let release!: () => void
      const requestEntered = new Promise<void>(resolve => { entered = resolve })
      const requestReleased = new Promise<void>(resolve => { release = resolve })
      const requests: Array<{url: string; method?: string; body?: unknown}> = []
      setRequestUrlHandler(async raw => {
        const request = raw as {url: string; method?: string; body?: unknown}
        requests.push(request)
        assert.equal(request.method, "GET", "Preview must be read-only")
        assert.equal(request.body, undefined, "Preview must not upload data")
        if (request.url.includes("/git/ref/heads/")) {
          return request.url.includes("/heads/main?")
            ? respond({ref: "refs/heads/main",
              object: {sha: "a".repeat(40), type: "commit"}})
            : respond({}, 404)
        }
        assert.equal(request.url, "https://api.github.com/repos/owner/vault")
        entered()
        await requestReleased
        return respond({id: 444, full_name: "owner/vault", default_branch: "main"})
      })
      try {
        wizard.onOpen()
        if (mode === "branches") {
          view.step = 2
          view.render()
        }
        const pending = mode === "source"
          ? view.verifySource() : view.checkBranchAvailability()
        await requestEntered
        if (interruption === "sync") {
          (plugin.v4Runtime as unknown as {isSyncing: boolean}).isSyncing = true
        } else if (interruption === "sync-finished") {
          const runtime = plugin.v4Runtime as unknown as {
            isSyncing: boolean
            syncExecutionGeneration: number
          }
          runtime.isSyncing = true
          runtime.syncExecutionGeneration++
          runtime.isSyncing = false
        } else if (interruption === "settings") {
          plugin.settings.githubToken = "changed-token-never-render"
        } else if (interruption === "plugin-sync") {
          (plugin as FastSync & {isSyncInProgress: boolean}).isSyncInProgress = true
        } else if (interruption === "settings-save") {
          plugin.isSettingsSaveInProgress = () => true
        } else if (interruption === "settings-save-finished") {
          // A save of identical Settings starts and finishes entirely while
          // GitHub is pending, so comparing draft values or a busy boolean
          // cannot detect it.
          (plugin as unknown as { settingsSaveGeneration: number }).settingsSaveGeneration++
          plugin.isSettingsSaveInProgress = () => false
        } else if (interruption === "runtime") {
          plugin.v4Runtime = { isSyncing: false } as FastSync["v4Runtime"]
        } else {
          wizard.onClose()
        }
        release()
        await pending
        assert.equal(view.checked, undefined, mode + "/" + interruption)
        if (mode === "source") {
          assert.equal(view.source, undefined, "stale verification must not persist source")
          assert.ok(requests.length <= 2, "no full encrypted source scan after interrupted preflight")
        }
        const content = (wizard.contentEl as unknown as {flattenText(): string}).flattenText()
        if (interruption === "sync" || interruption === "sync-finished"
          || interruption === "plugin-sync") {
          assert.match(content, /Sync started during verification/i)
        }
        if (interruption === "settings-save" || interruption === "settings-save-finished") {
          assert.match(content, /Settings save started during verification|Settings changed/i)
        }
        if (interruption === "runtime") {
          assert.match(content, /Runtime changed during verification/i,
            "the preview must explicitly reject a superseded Runtime owner")
        }
        assert.doesNotMatch(content, /source-passphrase-never-render|source-token-never-render|changed-token-never-render|new-preview-only-secret/u)
        assert.ok(requests.every(r => r.method === "GET" && r.body === undefined))
      } finally {
        wizard.onClose()
        release()
        setRequestUrlHandler(null)
      }
    }
  }
})

test("D280 Wizard stale Preflight Next refuses a changed Runtime owner without GitHub I/O", () => {
  const plugin = fakePlugin()
  const wizard = new V4ReencryptionWizardModal(plugin)
  const internal = wizard as unknown as {
    step: number; render(): void
    source?: {
      physicalRepositoryId: number; defaultBranch: string; pinnedSourceCommitSha: string
      verifiedFileCount: number; verifiedRemoteObjectCount: number
      totalVerifiedPlaintextBytes: string
    }
  }
  let calls = 0
  setRequestUrlHandler(async () => {
    calls++
    throw Error("Stale Next cannot contact GitHub.")
  })
  try {
    wizard.onOpen()
    internal.source = {
      physicalRepositoryId: 123, defaultBranch: "main",
      pinnedSourceCommitSha: "a".repeat(40),
      verifiedFileCount: 0, verifiedRemoteObjectCount: 0,
      totalVerifiedPlaintextBytes: "0",
    }
    internal.render()
    const view = wizard.contentEl as unknown as {
      findByText(text: string): { disabled: boolean; onclick?: () => void } | undefined
      flattenText(): string
    }
    const next = view.findByText("Next")
    assert.ok(next && !next.disabled, "Next was available after an earlier source Preview")
    plugin.v4Runtime = { isSyncing: false } as FastSync["v4Runtime"]
    next.onclick?.()
    assert.equal(internal.step, 0, "stale Runtime source proof must never advance the Wizard")
    assert.equal(internal.source, undefined, "stale Preflight source must be discarded")
    assert.match(view.flattenText(), /Runtime changed during verification/i)
    assert.equal(calls, 0, "stale navigation cannot perform network access")
  } finally {
    wizard.onClose()
    setRequestUrlHandler(null)
  }
})

test("D280 Wizard invalidates Preflight Next on Settings drift or an active Sync", () => {
  for (const change of ["settings", "sync", "sync-finished", "plugin-sync", "settings-save"] as const) {
    const plugin = fakePlugin()
    const wizard = new V4ReencryptionWizardModal(plugin)
    const internal = wizard as unknown as {
      step: number; render(): void
      source?: {
        physicalRepositoryId: number; defaultBranch: string; pinnedSourceCommitSha: string
        verifiedFileCount: number; verifiedRemoteObjectCount: number
        totalVerifiedPlaintextBytes: string
      }
    }
    let calls = 0
    setRequestUrlHandler(async () => {
      calls++
      throw Error("Invalidated Preflight Next must not contact GitHub.")
    })
    try {
      wizard.onOpen()
      internal.source = {
        physicalRepositoryId: 123, defaultBranch: "main",
        pinnedSourceCommitSha: "a".repeat(40),
        verifiedFileCount: 0, verifiedRemoteObjectCount: 0,
        totalVerifiedPlaintextBytes: "0",
      }
      internal.render()
      const view = wizard.contentEl as unknown as {
        findByText(text: string): { disabled: boolean; onclick?: () => void } | undefined
        flattenText(): string
      }
      const next = view.findByText("Next")
      assert.ok(next && !next.disabled)
      if (change === "settings") {
        plugin.settings.githubBranch = "changed-source"
      } else if (change === "sync") {
        (plugin.v4Runtime as { isSyncing: boolean }).isSyncing = true
      } else if (change === "plugin-sync") {
        (plugin as FastSync & { isSyncInProgress: boolean }).isSyncInProgress = true
      } else if (change === "settings-save") {
        plugin.isSettingsSaveInProgress = () => true
      } else {
        const runtime = plugin.v4Runtime as { isSyncing: boolean; syncExecutionGeneration: number }
        runtime.isSyncing = true
        runtime.syncExecutionGeneration++
        runtime.isSyncing = false
      }
      next.onclick?.()
      assert.equal(internal.step, 0, change + ": no stale source navigation")
      assert.equal(internal.source, undefined, change + ": stale source discarded")
      assert.match(view.flattenText(),
        change === "settings" ? /Wizard connection changed/i
          : change === "settings-save" ? /Settings save started during verification/i
          : /Sync started during verification/i)
      assert.equal(calls, 0)
    } finally {
      wizard.onClose()
      setRequestUrlHandler(null)
    }
  }
})

test("D281 a closed Wizard refuses a queued Preflight verification before GitHub I/O", async () => {
  const wizard = new V4ReencryptionWizardModal(fakePlugin())
  let requests = 0
  setRequestUrlHandler(async () => {
    requests++
    throw Error("A closed Wizard must never contact GitHub")
  })
  try {
    wizard.onOpen()
    wizard.onClose()
    await (wizard as unknown as { verifySource(): Promise<void> }).verifySource()
    assert.equal(requests, 0, "a stale Preflight click cannot start any remote read after close")
    assert.equal((wizard.contentEl as unknown as { flattenText(): string }).flattenText(), "",
      "closed Preview remains empty even after a stale callback")
  } finally {
    wizard.onClose()
    setRequestUrlHandler(null)
  }
})

test("D281 stale navigation cannot advance a reopened Wizard while the current button can", () => {
  const wizard = new V4ReencryptionWizardModal(fakePlugin())
  const view = wizard as unknown as { step: number; render(): void }
  const content = wizard.contentEl as unknown as {
    findByText(text: string): { onclick?: () => void } | undefined
    flattenText(): string
  }
  try {
    wizard.onOpen()
    view.step = 3
    view.render()
    const obsoleteNext = content.findByText("View planned finish")
    assert.ok(obsoleteNext?.onclick, "first Preview generated an actionable Next button")
    wizard.onClose()
    wizard.onOpen()
    view.step = 3
    view.render()
    const freshNext = content.findByText("View planned finish")
    assert.ok(freshNext?.onclick)
    obsoleteNext.onclick()
    assert.equal(view.step, 3, "old detached Next must not move the reopened Preview")
    freshNext.onclick()
    assert.equal(view.step, 4, "new Preview can still navigate with its own button")
  } finally {
    wizard.onClose()
  }
})

test("D281 stale PBKDF2 slider event cannot mutate a closed or newly reopened Preview", () => {
  const wizard = new V4ReencryptionWizardModal(fakePlugin())
  const view = wizard as unknown as { step: number; render(): void; iterations: number }
  try {
    wizard.onOpen()
    view.step = 1
    view.render()
    const previous = settingSliderControls.at(-1)
    assert.ok(previous?.change, "destination form must expose a PBKDF2 slider")
    assert.equal(view.iterations, 600_000)
    wizard.onClose()

    // Re-opening the same Modal object is supported for stale-event defense.
    wizard.onOpen()
    view.step = 1
    view.render()
    const current = settingSliderControls.at(-1)
    assert.ok(current?.change)
    previous.change(1_200_000)
    assert.equal(view.iterations, 600_000, "detached old slider cannot change newly opened policy")
    current.change(700_000)
    assert.equal(view.iterations, 700_000, "current slider still works")
    wizard.onClose()
    current.change(1_200_000)
    assert.equal(view.iterations, 700_000, "closed Wizard ignores delayed slider events")
  } finally {
    wizard.onClose()
  }
})

test("D281 old passphrase-input events cannot revive cleared secrets after Wizard close", () => {
  const textHandlers: Array<(value: string) => void> = []
  const setting = Setting.prototype as unknown as {
    addText(callback: (input: {
      inputEl: { type: string }
      setValue(value: string): unknown
      onChange(callback: (value: string) => void): unknown
    }) => void): Setting
  }
  const originalAddText = setting.addText
  setting.addText = function(callback) {
    callback({
      inputEl: { type: "text" },
      setValue(_value: string) { return this },
      onChange(listener: (value: string) => void) {
        textHandlers.push(listener)
        return this
      },
    })
    return this
  }

  const wizard = new V4ReencryptionWizardModal(fakePlugin())
  const view = wizard as unknown as {
    step: number
    render(): void
    newPassphrase: string
    confirmPassphrase: string
  }
  try {
    wizard.onOpen()
    view.step = 1
    view.render()
    const oldInputs = textHandlers.slice(-4)
    assert.equal(oldInputs.length, 4, "four destination/backup/secret inputs are attached")
    oldInputs[2]!("first-private-secret")
    oldInputs[3]!("first-private-secret")
    assert.equal(view.newPassphrase, "first-private-secret")
    wizard.onClose()
    assert.equal(view.newPassphrase, "")
    assert.equal(view.confirmPassphrase, "")
    oldInputs[2]!("stale-secret-must-not-return")
    oldInputs[3]!("stale-secret-must-not-return")
    assert.equal(view.newPassphrase, "")
    assert.equal(view.confirmPassphrase, "")

    wizard.onOpen()
    view.step = 1
    view.render()
    const newInputs = textHandlers.slice(-4)
    oldInputs[2]!("stale-after-reopen")
    assert.equal(view.newPassphrase, "", "old detached input cannot mutate new Preview")
    newInputs[2]!("fresh-private-secret")
    newInputs[3]!("fresh-private-secret")
    assert.equal(view.newPassphrase, "fresh-private-secret")
    assert.equal(view.confirmPassphrase, "fresh-private-secret")
    wizard.onClose()
    newInputs[2]!("late-after-second-close")
    newInputs[3]!("late-after-second-close")
    assert.equal(view.newPassphrase, "")
    assert.equal(view.confirmPassphrase, "")
  } finally {
    wizard.onClose()
    setting.addText = originalAddText
  }
})

test("D282 real Sync Coordinator start-and-finish invalidates a held Wizard Git read", async () => {
  const coordinator = new V4SyncCoordinator({
    execute: async () => ({ changedFiles: 0 }),
  })
  const plugin = fakePlugin()
  ;(coordinator as V4SyncCoordinator & { assertReencryptionSettingsSaveAllowed: () => Promise<void> }).assertReencryptionSettingsSaveAllowed = async () => undefined
  plugin.v4Runtime = coordinator as unknown as FastSync["v4Runtime"]
  const wizard = new V4ReencryptionWizardModal(plugin)
  const view = wizard as unknown as {
    source?: { pinnedSourceCommitSha: string }
    verifySource(): Promise<void>
  }
  let entered!: () => void
  let release!: () => void
  const firstReadEntered = new Promise<void>(resolve => { entered = resolve })
  const firstReadReleased = new Promise<void>(resolve => { release = resolve })
  const requests: Array<{ method?: string; body?: unknown }> = []
  setRequestUrlHandler(async raw => {
    const request = raw as { method?: string; body?: unknown }
    requests.push(request)
    assert.equal(request.method, "GET")
    assert.equal(request.body, undefined)
    entered()
    await firstReadReleased
    return { status: 200, text: "", headers: {},
      json: { id: 444, full_name: "owner/vault", default_branch: "main" } }
  })
  try {
    wizard.onOpen()
    const pending = view.verifySource()
    await firstReadEntered
    assert.equal(coordinator.syncExecutionGeneration, 0)
    assert.equal(coordinator.isSyncing, false)
    const result = await coordinator.run({ operation: "normal", trigger: "manual" })
    assert.equal(result.status, "completed")
    assert.equal(coordinator.isSyncing, false, "Sync has completed before GitHub returns")
    assert.equal(coordinator.syncExecutionGeneration, 1)
    release()
    await pending
    assert.equal(view.source, undefined, "Wizard cannot accept proof made during an intervening Sync")
    assert.equal(requests.length, 1, "Wizard rejects evidence before more GitHub reads")
    const content = (wizard.contentEl as unknown as { flattenText(): string }).flattenText()
    assert.match(content, /Sync started during verification/i)
  } finally {
    release?.()
    wizard.onClose()
    coordinator.dispose()
    setRequestUrlHandler(null)
  }
})

test("D92 Wizard has no direct GitHub mutation or local settings-save capability", () => {
  const wizard = new V4ReencryptionWizardModal(fakePlugin())
  wizard.onOpen()
  // The only method with a currently accessible navigation destination
  // deliberately shows NOT STARTED instead of a fictitious progress bar.
  const debug = wizard as unknown as {step:number; render(): void; onClose():void}
  debug.step = 3
  debug.render()
  assert.match((wizard.contentEl as unknown as {flattenText():string}).flattenText(), /NOT STARTED/)
  debug.step = 4
  debug.render()
  assert.match((wizard.contentEl as unknown as {flattenText():string}).flattenText(), /Not completed/)
  wizard.onClose()
})
