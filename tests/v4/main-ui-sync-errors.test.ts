import assert from "node:assert/strict"
import test from "node:test"
import { Modal, Notice, WorkspaceLeaf, modalButtons, resetModalTestState } from "obsidian"
import FastSync from "../../src/main"
import { DEFAULT_SETTINGS } from "../../src/setting"
import { createIdleV4Progress } from "../../src/lib/v4/progress"
import { V4SyncCenterView } from "../../src/views/sync-center"
import { ElementStub } from "../stubs/obsidian"

type Task = "manual" | "startup" | "scheduled" | "forcePush" | "forcePull"

function setupUi() {
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  const timers = new Map<number, { kind: "timeout" | "interval"; callback: () => void }>()
  let id = 0
  Object.defineProperty(globalThis, "window", {
    configurable: true, value: {
      setTimeout(callback: () => void) {
        const key = ++id
        timers.set(key, { kind: "timeout", callback })
        return key
      },
      clearTimeout(key: number) { timers.delete(key) },
      setInterval(callback: () => void) {
        const key = ++id
        timers.set(key, { kind: "interval", callback })
        return key
      },
      clearInterval(key: number) { timers.delete(key) },
    },
  })
  const plugin = new FastSync() as FastSync & Record<string, any>
  const commands = new Map<string, () => void>()
  const ribbons = new Map<string, () => void>()
  const statusRoot = new ElementStub()
  const attempts: Task[] = []
  let mode: "reject" | "throw" | "resolve" = "reject"
  let disposed = false
  const savedSecrets = new Map<string, string>()
  const run = (kind: Task): Promise<unknown> => {
    attempts.push(kind)
    if (mode === "throw") throw new Error("secret synchronous network failure")
    if (mode === "reject") return Promise.reject(new Error("secret asynchronous network failure"))
    return Promise.resolve({ status: "completed" })
  }
  const runtime = {
    get progressSnapshot() { return createIdleV4Progress() },
    isSyncing: false,
    subscribeProgress() { return () => {} },
    createHistoryService: async () => { throw new Error("test history unavailable") },
    manualSync: () => run("manual"), startupSync: () => run("startup"),
    scheduledSync: () => run("scheduled"),
    forcePush: () => run("forcePush"), forcePull: () => run("forcePull"),
    dispose() { disposed = true },
    credentialsChanged() {},
    enqueueModify() {}, enqueueDelete() {}, enqueueRename() {},
    enqueueFolderDelete() {}, enqueueFolderRename() {},
  }
  plugin.app = {
    secretStorage: {
      getSecret(id: string) { return savedSecrets.get(id) ?? null },
      setSecret(id: string, value: string) { savedSecrets.set(id, value) },
    },
    vault: { configDir: ".obsidian", getFiles: () => [], on: () => ({}), offref: () => undefined },
    workspace: { onLayoutReady: (callback: () => void) => callback() },
  }
  plugin.manifest = { id: "test" }
  plugin.loadSettings = async () => {
    plugin.settings = {
      ...DEFAULT_SETTINGS,
      syncEnabled: true, syncOnStartup: true, scheduledSyncEnabled: true,
      githubOwner: "owner", githubRepo: "vault", githubToken: "secret-token",
      statusBarStatusEnabled: true,
    }
  }
  plugin.persistData = async () => undefined
  plugin.initGitHubClient = () => undefined
  plugin.addSettingTab = () => undefined
  plugin.registerView = () => undefined
  plugin.registerEvent = () => undefined
  plugin.register = () => undefined
  plugin.updateRibbonIcon = () => undefined
  plugin.addStatusBarItem = () => statusRoot
  plugin.addRibbonIcon = (_icon: string, label: string, callback: () => void) => {
    ribbons.set(label, callback)
    return new ElementStub()
  }
  plugin.addCommand = (command: {id: string; callback: () => void}) => {
    commands.set(command.id, command.callback)
  }
  plugin.createV4Runtime = () => runtime
  return {
    plugin, commands, ribbons, statusRoot, timers, attempts,
    setMode(next: typeof mode) { mode = next },
    get disposed() { return disposed },
    cleanup() {
      plugin.onunload()
      if (oldWindow) Object.defineProperty(globalThis, "window", oldWindow)
      else Reflect.deleteProperty(globalThis, "window")
    },
  }
}

const tick = () => new Promise<void>(resolve => setImmediate(resolve))

test("D278 read-only Complete Recovery command never starts after unload and keeps results non-authorizing", async () => {
  const ui = setupUi()
  Notice.messages.length = 0
  try {
    await ui.plugin.onload()
    const invoke = ui.commands.get("verify-reencryption-complete-recovery-read-only")
    assert.ok(invoke, "the installed Command Palette entry exists")
    let attempts = 0
    const scope = ui.plugin.v4Runtime as Record<string, any>
    const report = {
      observation: "authenticated-complete-recovery-evidence-still-fenced",
      originalKeyAuthenticated: true,
      completeOldBackupReverified: true,
      walReceiptsBoundToDestination: true,
      completeDestinationContentsReverified: true,
      integrityScope: "read-only-original-backup-encrypted-wal-complete-destination",
      isolation: "desktop-os-cooperative-wal-lock",
      powerLossDurabilityProven: false,
      mobileOsLockProven: false,
      installedObsidianAcceptanceProven: false,
      commitDecisionAuthorized: false,
      rollbackAuthorized: false,
      oldPassphraseCleanupAuthorized: false,
      localCutoverAuthorized: false,
      resumeSyncAuthorized: false,
      remoteWritesAuthorized: false,
    }
    scope.inspectFencedReencryptionCompleteRecovery = async () => {
      attempts++
      return report
    }
    invoke()
    await tick()
    assert.equal(attempts, 1)
    assert.equal(Notice.messages.length, 2, "start and completion notices only")
    assert.match(Notice.messages[1]!, /read-only Desktop scan/)
    assert.match(Notice.messages[1]!, /Cutover, Sync restart/)
    assert.deepEqual(ui.attempts, [], "no Sync or remote write operation starts from the recovery command")

    scope.inspectFencedReencryptionCompleteRecovery = async () => {
      attempts++
      return null
    }
    Notice.messages.length = 0
    invoke()
    await tick()
    assert.equal(Notice.messages.length, 2)
    assert.match(Notice.messages[1]!, /Manual Recovery/)
    assert.match(Notice.messages[1]!, /Sync stays paused/)

    scope.inspectFencedReencryptionCompleteRecovery = async () => {
      attempts++
      throw Error("sensitive-token-never-display")
    }
    Notice.messages.length = 0
    invoke()
    await tick()
    assert.equal(Notice.messages.length, 2)
    assert.match(Notice.messages[1]!, /check unavailable/)
    assert.ok(Notice.messages.every(message => !message.includes("sensitive-token-never-display")))

    ui.plugin.onunload()
    Notice.messages.length = 0
    const before = attempts
    invoke()
    await tick()
    assert.equal(attempts, before, "an unloaded plugin must not start Complete Recovery")
    assert.deepEqual(Notice.messages, [], "an unloaded plugin cannot display a stale recovery notice")
  } finally {
    ui.cleanup()
    Notice.messages.length = 0
  }
})

test("D283 Complete Recovery Command refuses contradictory authority and unknown WAL isolation", async () => {
  const ui = setupUi()
  Notice.messages.length = 0
  try {
    await ui.plugin.onload()
    const invoke = ui.commands.get("verify-reencryption-complete-recovery-read-only")
    assert.ok(invoke)
    const runtime = ui.plugin.v4Runtime as Record<string, any>
    const verified = {
      observation: "authenticated-complete-recovery-evidence-still-fenced",
      originalKeyAuthenticated: true,
      completeOldBackupReverified: true,
      walReceiptsBoundToDestination: true,
      completeDestinationContentsReverified: true,
      integrityScope: "read-only-original-backup-encrypted-wal-complete-destination",
      isolation: "desktop-os-cooperative-wal-lock",
      powerLossDurabilityProven: false,
      mobileOsLockProven: false,
      installedObsidianAcceptanceProven: false,
      commitDecisionAuthorized: false,
      rollbackAuthorized: false,
      oldPassphraseCleanupAuthorized: false,
      localCutoverAuthorized: false,
      resumeSyncAuthorized: false,
      remoteWritesAuthorized: false,
    }
    for (const report of [
      { ...verified, isolation: "unknown-untrusted-platform" },
      { ...verified, isolation: undefined },
      { ...verified, integrityScope: "untrusted-summary-only" },
      { ...verified, commitDecisionAuthorized: true },
      { ...verified, powerLossDurabilityProven: true },
      { ...verified, installedObsidianAcceptanceProven: true },
      { ...verified, localCutoverAuthorized: true },
      { ...verified, resumeSyncAuthorized: true },
      { ...verified, remoteWritesAuthorized: true },
    ]) {
      Notice.messages.length = 0
      runtime.inspectFencedReencryptionCompleteRecovery = async () => report
      invoke()
      await tick()
      assert.equal(Notice.messages.length, 2, "progress and one result notice only")
      assert.match(Notice.messages[1]!, /could not be independently verified/i,
        "contradictory Recovery must fail closed rather than claim a Desktop WAL lock")
      assert.match(Notice.messages[1]!, /Manual Recovery/i)
      assert.doesNotMatch(Notice.messages[1]!, /read-only Desktop scan/i)
    }
    assert.deepEqual(ui.attempts, [], "no authorizing Sync from inconsistent Recovery evidence")
  } finally {
    ui.cleanup()
    Notice.messages.length = 0
  }
})

test("D278 duplicate Complete Recovery command does not produce a false Manual Recovery warning", async () => {
  const ui = setupUi()
  Notice.messages.length = 0
  try {
    await ui.plugin.onload()
    const invoke = ui.commands.get("verify-reencryption-complete-recovery-read-only")
    assert.ok(invoke)
    let finish!: (report: null) => void
    const pending = new Promise<null>(resolve => { finish = resolve })
    let attempts = 0
    const runtime = ui.plugin.v4Runtime as Record<string, any>
    runtime.inspectFencedReencryptionCompleteRecovery = () => {
      attempts++
      return pending
    }
    invoke()
    invoke()
    await tick()
    assert.equal(attempts, 1, "duplicate command must not start a second Recovery scan")
    assert.equal(Notice.messages.length, 1, "only one progress notice while the first scan is pending")
    finish(null)
    await tick()
    assert.equal(Notice.messages.length, 2)
    assert.match(Notice.messages[1]!, /Manual Recovery/)
    runtime.inspectFencedReencryptionCompleteRecovery = async () => {
      attempts++
      return null
    }
    invoke()
    await tick()
    assert.equal(attempts, 2, "after first scan completes the user may run a new read-only scan")
    assert.equal(Notice.messages.length, 4)
    assert.deepEqual(ui.attempts, [], "Recovery command must not launch Sync")
  } finally {
    ui.cleanup()
    Notice.messages.length = 0
  }
})

test("D278 legacy and Complete Recovery commands share one exclusive UI diagnostic", async () => {
  const ui = setupUi()
  Notice.messages.length = 0
  try {
    await ui.plugin.onload()
    const legacy = ui.commands.get("verify-reencryption-recovery-read-only")
    const complete = ui.commands.get("verify-reencryption-complete-recovery-read-only")
    assert.ok(legacy && complete)
    let finish!: (value: null) => void
    const pending = new Promise<null>(resolve => { finish = resolve })
    const runtime = ui.plugin.v4Runtime as Record<string, any>
    let oldReads = 0
    let newReads = 0
    runtime.verifyFencedReencryptionAuthenticatedWal = () => {
      oldReads++
      return pending
    }
    runtime.inspectFencedReencryptionCompleteRecovery = async () => {
      newReads++
      return null
    }
    legacy()
    complete()
    await tick()
    assert.equal(oldReads, 1)
    assert.equal(newReads, 0, "Complete Recovery must not overlap an old WAL diagnostic")
    assert.deepEqual(Notice.messages, [], "an ignored overlap must not report failure")
    finish(null)
    await tick()
    assert.equal(Notice.messages.length, 1)
    assert.match(Notice.messages[0]!, /Recovery unverified/)
    complete()
    await tick()
    assert.equal(newReads, 1, "a completed legacy WAL inspection releases the UI diagnostic")
    assert.match(Notice.messages.at(-1)!, /Manual Recovery/)
  } finally {
    ui.cleanup()
    Notice.messages.length = 0
  }
})

test("D279 old Recovery result cannot report success or inspect a replacement Runtime", async () => {
  for (const commandId of [
    "verify-reencryption-complete-recovery-read-only",
    "verify-reencryption-recovery-read-only",
  ] as const) {
    const ui = setupUi()
    Notice.messages.length = 0
    try {
      await ui.plugin.onload()
      const invoke = ui.commands.get(commandId)
      assert.ok(invoke)
      const oldRuntime = ui.plugin.v4Runtime as Record<string, any>
      let release!: (report: unknown) => void
      const pending = new Promise<unknown>(resolve => { release = resolve })
      if (commandId === "verify-reencryption-complete-recovery-read-only") {
        oldRuntime.inspectFencedReencryptionCompleteRecovery = () => pending
      } else {
        oldRuntime.verifyFencedReencryptionAuthenticatedWal = () => pending
      }
      invoke()
      const messagesWhilePending = Notice.messages.length
      let replacementReads = 0
      ui.plugin.v4Runtime = {
        ...oldRuntime,
        inspectFencedReencryptionCandidateGitRefs: async () => {
          replacementReads++
          return { destinationOrphanTopologyObserved: true }
        },
      }
      release(commandId === "verify-reencryption-complete-recovery-read-only"
        ? {
          observation: "authenticated-complete-recovery-evidence-still-fenced",
          originalKeyAuthenticated: true,
          completeOldBackupReverified: true,
          walReceiptsBoundToDestination: true,
          completeDestinationContentsReverified: true,
          isolation: "desktop-os-cooperative-wal-lock",
        }
        : {
          originalKeyAuthenticated: true,
          completeBackupContentsReverified: true,
          coldStartWalReverified: true,
          completeDestinationContentsReverified: true,
          recoveryLeaseReverified: true,
        })
      await tick()
      assert.equal(Notice.messages.length, messagesWhilePending,
        "old Runtime's authenticated result cannot become an authoritative UI message")
      assert.equal(replacementReads, 0, "legacy callback cannot inspect Git refs using replacement Runtime")
    } finally {
      ui.cleanup()
      Notice.messages.length = 0
    }
  }
})

test("D279 stale Recovery rejection must not show an error from a replaced Runtime", async () => {
  for (const commandId of [
    "verify-reencryption-complete-recovery-read-only",
    "verify-reencryption-recovery-read-only",
  ] as const) {
    const ui = setupUi()
    Notice.messages.length = 0
    try {
      await ui.plugin.onload()
      const invoke = ui.commands.get(commandId)
      assert.ok(invoke)
      const runtime = ui.plugin.v4Runtime as Record<string, any>
      let rejectPending!: (error: Error) => void
      const pending = new Promise<never>((_resolve, reject) => {
        rejectPending = reject
      })
      if (commandId === "verify-reencryption-complete-recovery-read-only") {
        runtime.inspectFencedReencryptionCompleteRecovery = () => pending
      } else {
        runtime.verifyFencedReencryptionAuthenticatedWal = () => pending
      }
      invoke()
      const previousNotices = Notice.messages.length
      ui.plugin.v4Runtime = { ...runtime }
      rejectPending(Error("stale-internal-credential-error"))
      await tick()
      assert.equal(Notice.messages.length, previousNotices,
        "a rejected stale Runtime cannot produce a misleading Recovery error")
      assert.ok(Notice.messages.every(message => !message.includes("stale-internal-credential-error")))
    } finally {
      ui.cleanup()
      Notice.messages.length = 0
    }
  }
})

test("D279 reloading a plugin instance invalidates old Recovery notices without freeing a new diagnostic", async () => {
  const ui = setupUi()
  Notice.messages.length = 0
  try {
    await ui.plugin.onload()
    const runtime = ui.plugin.v4Runtime as Record<string, any>
    const pending: Array<(value: unknown) => void> = []
    let invoked = 0
    runtime.inspectFencedReencryptionCompleteRecovery = () => {
      invoked++
      return new Promise(resolve => { pending.push(resolve) })
    }
    ui.commands.get("verify-reencryption-complete-recovery-read-only")!()
    assert.equal(invoked, 1)
    ui.plugin.onunload()
    await ui.plugin.onload()
    const current = ui.commands.get("verify-reencryption-complete-recovery-read-only")!
    current()
    assert.equal(invoked, 2, "the new plugin lifecycle must admit a fresh diagnostic")
    pending[0]!({
      observation: "authenticated-complete-recovery-evidence-still-fenced",
      originalKeyAuthenticated: true,
      completeOldBackupReverified: true,
      walReceiptsBoundToDestination: true,
      completeDestinationContentsReverified: true,
      isolation: "desktop-os-cooperative-wal-lock",
    })
    await tick()
    assert.equal(Notice.messages.filter(message => /verified in a read-only Desktop scan/u.test(message)).length, 0,
      "an old lifecycle cannot announce authenticated evidence in the new lifecycle")
    current()
    assert.equal(invoked, 2,
      "the late completion of an old lifecycle must not release the new in-flight diagnostic")
    pending[1]!(null)
    await tick()
    assert.equal(Notice.messages.filter(message => /use Manual Recovery/u.test(message)).length, 1)
    assert.deepEqual(ui.attempts, [], "neither lifecycle starts Sync")
  } finally {
    ui.cleanup()
    Notice.messages.length = 0
  }
})

test("D278 legacy read-only Recovery command does not start after plugin unload", async () => {
  const ui = setupUi()
  Notice.messages.length = 0
  try {
    await ui.plugin.onload()
    const legacy = ui.commands.get("verify-reencryption-recovery-read-only")
    assert.ok(legacy)
    let reads = 0
    const runtime = ui.plugin.v4Runtime as Record<string, any>
    runtime.verifyFencedReencryptionAuthenticatedWal = async () => {
      reads++
      return null
    }
    ui.plugin.onunload()
    legacy()
    await tick()
    assert.equal(reads, 0)
    assert.equal(Notice.messages.length, 0)
  } finally {
    ui.cleanup()
    Notice.messages.length = 0
  }
})

test("D418 disabling Sync while startup is queued prevents both old automatic triggers", async () => {
  const ui = setupUi()
  try {
    ui.setMode("resolve")
    await ui.plugin.onload()
    const startup = [...ui.timers.values()].find(timer => timer.kind === "timeout")?.callback
    const scheduled = [...ui.timers.values()].find(timer => timer.kind === "interval")?.callback
    assert.ok(startup)
    assert.ok(scheduled)
    await ui.plugin.saveSettings({ ...ui.plugin.settings, syncEnabled: false })
    ui.plugin.disableWatch()
    startup()
    scheduled()
    await tick()
    assert.deepEqual(ui.attempts, [],
      "already queued callbacks must not Sync after the user disabled the feature")
    assert.equal(ui.plugin.isWatchEnabled, true,
      "a skipped startup run must not leave local watch paused")
  } finally {
    ui.cleanup()
  }
})

test("D418 changing the repository retires stale startup and interval callbacks", async () => {
  const ui = setupUi()
  try {
    ui.setMode("resolve")
    await ui.plugin.onload()
    const startup = [...ui.timers.values()].find(timer => timer.kind === "timeout")?.callback
    const scheduled = [...ui.timers.values()].find(timer => timer.kind === "interval")?.callback
    assert.ok(startup)
    assert.ok(scheduled)
    await ui.plugin.saveSettings({ ...ui.plugin.settings, githubRepo: "other-disposable-repository" })
    startup()
    scheduled()
    await tick()
    assert.deepEqual(ui.attempts, [],
      "old callbacks must not send data to a newly selected repository")
    const replacement = [...ui.timers.values()].find(timer => timer.kind === "interval")?.callback
    assert.ok(replacement)
    replacement()
    await tick()
    assert.deepEqual(ui.attempts, ["scheduled"],
      "a new timer registered for saved settings must still work")
  } finally {
    ui.cleanup()
  }
})

test("D418 a pending Settings save cannot race a queued automatic GitHub write", async () => {
  const ui = setupUi()
  let finishSave: (() => void) | undefined
  try {
    ui.setMode("resolve")
    await ui.plugin.onload()
    const startup = [...ui.timers.values()].find(timer => timer.kind === "timeout")?.callback
    const scheduled = [...ui.timers.values()].find(timer => timer.kind === "interval")?.callback
    assert.ok(startup)
    assert.ok(scheduled)
    ui.plugin.persistData = async () => {
      await new Promise<void>(resolve => { finishSave = resolve })
    }
    const saving = ui.plugin.saveSettings({ ...ui.plugin.settings, githubRepo: "pending-change" })
    startup()
    scheduled()
    await tick()
    assert.deepEqual(ui.attempts, [], "no remote work while a Settings save is unresolved")
    finishSave?.()
    await saving
    assert.deepEqual(ui.attempts, [], "resolving a save must not replay old scheduled work")
  } finally {
    finishSave?.()
    ui.cleanup()
  }
})

test("D418 a failed Settings save retires uncertain automatic callbacks until restart", async () => {
  const ui = setupUi()
  try {
    ui.setMode("resolve")
    await ui.plugin.onload()
    const startup = [...ui.timers.values()].find(timer => timer.kind === "timeout")?.callback
    const scheduled = [...ui.timers.values()].find(timer => timer.kind === "interval")?.callback
    assert.ok(startup)
    assert.ok(scheduled)
    ui.plugin.persistData = async () => { throw new Error("simulated-disk-save-failure") }
    await assert.rejects(
      () => ui.plugin.saveSettings({ ...ui.plugin.settings, githubRepo: "uncommitted-repository" }),
      /simulated-disk-save-failure/u,
    )
    startup()
    scheduled()
    await tick()
    assert.deepEqual(ui.attempts, [],
      "uncertain durable Settings must not trigger an automatic GitHub write")
  } finally {
    ui.cleanup()
  }
})

test("D478 Ribbon reflects saved Sync readiness across startup and Settings repair", async () => {
  const invalid = [
    { patch: { githubBranch: "" }, fixed: { githubBranch: "repaired-branch" } },
    { patch: { vault: " \t " }, fixed: { vault: "repaired-device" } },
    { patch: { githubToken: " \t " }, fixed: { githubToken: "repaired-token" } },
    { patch: { githubOwner: "" }, fixed: { githubOwner: "repaired-owner" } },
    { patch: { githubRepo: "" }, fixed: { githubRepo: "repaired-repo" } },
    { patch: { githubToken: "" }, fixed: { githubToken: "repaired-token" } },
    { patch: { encryptionMode: "encrypted" as const, encryptionPassphrase: "" },
      fixed: { encryptionPassphrase: "repaired-passphrase" } },
  ]
  for (const scenario of invalid) {
    const ui = setupUi()
    try {
      ui.setMode("resolve")
      const loadSettings = ui.plugin.loadSettings.bind(ui.plugin)
      ui.plugin.loadSettings = async () => {
        await loadSettings()
        ui.plugin.settings = { ...ui.plugin.settings, ...scenario.patch }
      }
      ui.plugin.updateRibbonIcon = FastSync.prototype.updateRibbonIcon.bind(ui.plugin)
      await ui.plugin.onload()
      const ribbon = ui.plugin.ribbonIcon as unknown as ElementStub
      assert.match(ribbon.attributes["aria-label"] ?? "", /\(Not Configured\)/u,
        "the ribbon must never claim a broken saved configuration is ready")
      await ui.plugin.saveSettings({ ...ui.plugin.settings, ...scenario.fixed })
      assert.match(ribbon.attributes["aria-label"] ?? "", /\(Configured\)/u,
        "saving a corrected configuration should visibly restore the ready ribbon")
      assert.deepEqual(ui.attempts, [], "readiness indicators do not start Sync")
    } finally {
      ui.cleanup()
    }
  }
})

test("D477 whitespace-only saved GitHub token refuses manual and Force Sync without a doomed request", async () => {
  const ui = setupUi()
  resetModalTestState()
  Notice.messages.length = 0
  try {
    ui.setMode("resolve")
    await ui.plugin.onload()
    ui.plugin.settings = { ...ui.plugin.settings, githubToken: " \t " }
    ui.plugin.settingTab.tempSettings = null
    ui.plugin.settingTab.display()
    const view = new V4SyncCenterView(new WorkspaceLeaf(ui.plugin.app), ui.plugin)
    await view.onOpen()
    const center = (view.contentEl as unknown as ElementStub).findByText("Sync now")
    const settings = (ui.plugin.settingTab.containerEl as unknown as ElementStub).findByText("Sync now")
    assert.ok(center && settings)
    const actions: Array<() => void> = [
      ui.ribbons.get("GitHub Sync: Sync")!,
      ui.commands.get("sync-all-files")!,
      () => { ui.plugin.updateStatusBar(); ui.statusRoot.children[0]?.onclick?.() },
      () => center.onclick?.(),
      () => settings.onclick?.(),
      ui.ribbons.get("GitHub Sync: Force Push")!,
      ui.commands.get("force-pull-all-files")!,
    ]
    const initialModals = modalButtons.length
    for (const action of actions) {
      const before = Notice.messages.length
      action()
      await tick()
      assert.deepEqual(ui.attempts, [], "blank token must not start Runtime")
      assert.equal(modalButtons.length, initialModals, "Force confirmation must not open")
      assert.equal(Notice.messages.length, before + 1)
      assert.match(Notice.messages.at(-1)!, /GitHub token.*Settings.*Save changes/u)
      assert.doesNotMatch(Notice.messages.at(-1)!, /secret-token/u)
    }
    ui.plugin.settings = { ...ui.plugin.settings, githubToken: "repaired-token" }
    ui.plugin.settingTab.tempSettings = null
    ui.plugin.settingTab.display()
    ui.commands.get("sync-all-files")!()
    await tick()
    assert.deepEqual(ui.attempts, ["manual"], "a repaired token allows ordinary manual Sync")
    await view.onClose()
  } finally {
    ui.cleanup()
    resetModalTestState()
    Notice.messages.length = 0
  }
})

test("D476 saved empty GitHub branch refuses manual and Force Sync until corrected", async () => {
  const ui = setupUi()
  resetModalTestState()
  Notice.messages.length = 0
  try {
    ui.setMode("resolve")
    await ui.plugin.onload()
    ui.plugin.settings = { ...ui.plugin.settings, githubBranch: "" }
    ui.plugin.settingTab.tempSettings = null
    ui.plugin.settingTab.display()
    const view = new V4SyncCenterView(new WorkspaceLeaf(ui.plugin.app), ui.plugin)
    await view.onOpen()
    const center = (view.contentEl as unknown as ElementStub).findByText("Sync now")
    const settingsSync = (ui.plugin.settingTab.containerEl as unknown as ElementStub).findByText("Sync now")
    assert.ok(center && settingsSync)
    const actions: Array<() => void> = [
      ui.ribbons.get("GitHub Sync: Sync")!,
      ui.commands.get("sync-all-files")!,
      () => { ui.plugin.updateStatusBar(); ui.statusRoot.children[0]?.onclick?.() },
      () => center.onclick?.(),
      () => settingsSync.onclick?.(),
      ui.ribbons.get("GitHub Sync: Force Push")!,
      ui.commands.get("force-pull-all-files")!,
    ]
    const initialModals = modalButtons.length
    for (const action of actions) {
      const before = Notice.messages.length
      action()
      await tick()
      assert.deepEqual(ui.attempts, [], "empty branch must not start any Runtime operation")
      assert.equal(modalButtons.length, initialModals, "Force confirmation must not open for a blank branch")
      assert.equal(Notice.messages.length, before + 1)
      assert.match(Notice.messages.at(-1)!, /GitHub branch.*Settings.*Save changes/u)
      assert.doesNotMatch(Notice.messages.at(-1)!, /secret-token/u)
    }
    ui.plugin.settings = { ...ui.plugin.settings, githubBranch: "main" }
    ui.plugin.settingTab.tempSettings = null
    ui.plugin.settingTab.display()
    ui.commands.get("sync-all-files")!()
    await tick()
    assert.deepEqual(ui.attempts, ["manual"],
      "once repaired the explicit branch must still allow ordinary Sync")
    await view.onClose()
  } finally {
    ui.cleanup()
    resetModalTestState()
    Notice.messages.length = 0
  }
})

test("D475 a blank persisted Device ID refuses manual and Force Sync with an actionable Settings notice", async () => {
  const ui = setupUi()
  resetModalTestState()
  Notice.messages.length = 0
  try {
    ui.setMode("resolve")
    await ui.plugin.onload()
    ui.plugin.settings = { ...ui.plugin.settings, vault: "   " }
    ui.plugin.settingTab.tempSettings = null
    ui.plugin.settingTab.display()
    const view = new V4SyncCenterView(new WorkspaceLeaf(ui.plugin.app), ui.plugin)
    await view.onOpen()
    const centerSync = (view.contentEl as unknown as ElementStub).findByText("Sync now")
    const settingsSync = (ui.plugin.settingTab.containerEl as unknown as ElementStub).findByText("Sync now")
    assert.ok(centerSync && settingsSync)
    const actions: Array<() => void> = [
      ui.ribbons.get("GitHub Sync: Sync")!,
      ui.commands.get("sync-all-files")!,
      () => { ui.plugin.updateStatusBar(); ui.statusRoot.children[0]?.onclick?.() },
      () => centerSync.onclick?.(),
      () => settingsSync.onclick?.(),
      ui.ribbons.get("GitHub Sync: Force Push")!,
      ui.commands.get("force-pull-all-files")!,
    ]
    const initialModals = modalButtons.length
    for (const action of actions) {
      const before = Notice.messages.length
      action()
      await tick()
      assert.deepEqual(ui.attempts, [], "blank Device ID must not invoke Runtime")
      assert.equal(modalButtons.length, initialModals, "Force action must not open a destructive modal")
      assert.equal(Notice.messages.length, before + 1)
      assert.match(Notice.messages.at(-1)!, /Device ID.*Settings.*Save changes/u)
      assert.doesNotMatch(Notice.messages.at(-1)!, /secret-token/u)
    }
    ui.plugin.settings = { ...ui.plugin.settings, vault: "repaired-device" }
    ui.plugin.settingTab.tempSettings = null
    ui.plugin.settingTab.display()
    ui.commands.get("sync-all-files")!()
    await tick()
    assert.deepEqual(ui.attempts, ["manual"], "repaired Device ID permits normal manual Sync")
    await view.onClose()
  } finally {
    ui.cleanup()
    resetModalTestState()
    Notice.messages.length = 0
  }
})

test("D472 first-use Sync controls refuse a missing token without starting or pausing Runtime", async () => {
  const ui = setupUi()
  resetModalTestState()
  Notice.messages.length = 0
  try {
    ui.setMode("resolve")
    await ui.plugin.onload()
    ui.plugin.settings = { ...ui.plugin.settings, githubToken: "" }
    ui.plugin.settingTab.display()
    const view = new V4SyncCenterView(new WorkspaceLeaf(ui.plugin.app), ui.plugin)
    await view.onOpen()
    const center = (view.contentEl as unknown as ElementStub).findByText("Sync now")
    const settingsSync = (ui.plugin.settingTab.containerEl as unknown as ElementStub).findByText("Sync now")
    const settingsForce = (ui.plugin.settingTab.containerEl as unknown as ElementStub).findByText("Force push")
    assert.ok(center && settingsSync && settingsForce)
    const actions: Array<() => void> = [
      ui.ribbons.get("GitHub Sync: Sync")!,
      ui.commands.get("sync-all-files")!,
      () => { ui.plugin.updateStatusBar(); ui.statusRoot.children[0]?.onclick?.() },
      () => center.onclick?.(),
      () => settingsSync.onclick?.(),
      ui.ribbons.get("GitHub Sync: Force Push")!,
      ui.commands.get("force-pull-all-files")!,
      () => settingsForce.onclick?.(),
    ]
    const modalCount = modalButtons.length
    for (const action of actions) {
      const before = Notice.messages.length
      action()
      await tick()
      assert.deepEqual(ui.attempts, [], "missing credentials must not start any Runtime operation")
      assert.equal(modalButtons.length, modalCount,
        "unconfigured Force operations must not open a destructive confirmation dialog")
      assert.equal(Notice.messages.length, before + 1,
        "each attempt must explain why Sync cannot start")
      assert.match(Notice.messages.at(-1)!, /GitHub token.*Settings.*Save changes/u)
      assert.doesNotMatch(Notice.messages.at(-1)!, /secret-token|private-token/u)
    }

    ui.plugin.settings = { ...ui.plugin.settings, githubToken: "restored-test-token" }
    ui.plugin.settingTab.tempSettings = null
    ui.plugin.settingTab.display()
    ui.ribbons.get("GitHub Sync: Sync")!()
    await tick()
    assert.deepEqual(ui.attempts, ["manual"],
      "after configuration, the ordinary Sync entrypoint must still execute")
    await view.onClose()
  } finally {
    ui.cleanup()
    resetModalTestState()
    Notice.messages.length = 0
  }
})

test("D472 first-use Sync names the missing owner, repository or encrypted passphrase", async () => {
  const cases = [
    { missing: { githubOwner: "" }, guidance: /GitHub owner/u },
    { missing: { githubRepo: "" }, guidance: /GitHub repository/u },
    { missing: { encryptionMode: "encrypted" as const, encryptionPassphrase: "" }, guidance: /encryption passphrase/u },
  ]
  for (const scenario of cases) {
    const ui = setupUi()
    Notice.messages.length = 0
    try {
      ui.setMode("resolve")
      await ui.plugin.onload()
      ui.plugin.settings = { ...ui.plugin.settings, ...scenario.missing }
      ui.commands.get("sync-all-files")!()
      await tick()
      assert.deepEqual(ui.attempts, [], "incomplete saved configuration must not reach Runtime")
      assert.equal(Notice.messages.length, 1)
      assert.match(Notice.messages[0]!, scenario.guidance)
      assert.match(Notice.messages[0]!, /Settings.*Save changes/u)
      assert.doesNotMatch(Notice.messages[0]!, /secret-token|private-token/u)
    } finally {
      ui.cleanup()
      Notice.messages.length = 0
    }
  }
})

test("D428 unsaved Settings block manual Sync and Force across the installed UI while preserving saved Sync", async () => {
  const ui = setupUi()
  resetModalTestState()
  Notice.messages.length = 0
  try {
    ui.setMode("resolve")
    await ui.plugin.onload()
    ui.plugin.settingTab.display()
    ui.plugin.settingTab.tempSettings!.githubRepo = "different-not-yet-saved-repository"
    ui.plugin.settingTab.updateDirtyState()

    const view = new V4SyncCenterView(new WorkspaceLeaf(ui.plugin.app), ui.plugin)
    await view.onOpen()
    const centerSync = (view.contentEl as unknown as ElementStub).findByText("Sync now")
    assert.ok(centerSync)

    const actions = [
      ui.ribbons.get("GitHub Sync: Sync")!,
      ui.commands.get("sync-all-files")!,
      () => { ui.plugin.updateStatusBar(); ui.statusRoot.children[0]?.onclick?.() },
      () => centerSync.onclick?.(),
    ]
    const noticeStart = Notice.messages.length
    const buttonsBefore = modalButtons.length
    for (const action of actions) action()
    ui.ribbons.get("GitHub Sync: Force Push")!()
    ui.commands.get("force-pull-all-files")!()
    await tick()
    assert.deepEqual(ui.attempts, [], "every UI must refuse the old remote while a different target is drafted")
    assert.equal(modalButtons.length, buttonsBefore, "force actions must not open a confirmation for an outdated repository")
    const notices = Notice.messages.slice(noticeStart)
    assert.equal(notices.length, 6, "each skipped user action needs an explicit instruction")
    assert.ok(notices.every(message => /Save or discard pending settings changes/u.test(message)))

    ui.plugin.settingTab.tempSettings = { ...ui.plugin.settings }
    ui.plugin.settingTab.display()
    for (const action of actions) { action(); await tick() }
    assert.deepEqual(ui.attempts, ["manual", "manual", "manual", "manual"],
      "all four manual Sync controls work after the draft is discarded")
    await view.onClose()
  } finally {
    ui.cleanup()
    resetModalTestState()
    Notice.messages.length = 0
  }
})

test("D428 in-progress Settings persistence also blocks non-Settings manual Sync", async () => {
  const ui = setupUi()
  Notice.messages.length = 0
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let entered = false
  try {
    ui.setMode("resolve")
    await ui.plugin.onload()
    ui.plugin.persistData = async () => { entered = true; await gate }
    const saving = ui.plugin.saveSettings({ ...ui.plugin.settings, githubRepo: "new-saved-repository" })
    await tick()
    assert.equal(entered, true, "the Settings disk write is pending")
    const before = Notice.messages.length
    ui.ribbons.get("GitHub Sync: Sync")!()
    ui.commands.get("sync-all-files")!()
    await tick()
    assert.deepEqual(ui.attempts, [])
    assert.equal(Notice.messages.length - before, 2)
    release()
    await saving
    ui.ribbons.get("GitHub Sync: Sync")!()
    await tick()
    assert.deepEqual(ui.attempts, ["manual"], "a committed Settings target is usable")
  } finally {
    release()
    ui.cleanup()
    Notice.messages.length = 0
  }
})

test("D156 actual Ribbon/Command/Status Bar/Startup/Scheduler and Sync Center callbacks contain detached rejection", async () => {
  const ui = setupUi()
  resetModalTestState()
  Notice.messages.length = 0
  try {
    await ui.plugin.onload()
    const clicks: Array<() => void> = [
      ui.ribbons.get("GitHub Sync: Sync")!,
      ui.commands.get("sync-all-files")!,
      () => ui.plugin.updateStatusBar() || ui.statusRoot.children[0]?.onclick?.(),
      [...ui.timers.values()].find(t => t.kind === "timeout")!.callback,
      [...ui.timers.values()].find(t => t.kind === "interval")!.callback,
    ]
    const view = new V4SyncCenterView(new WorkspaceLeaf(ui.plugin.app), ui.plugin)
    await view.onOpen()
    const priorNotices = Notice.messages.length
    const syncCenterButton = (view.contentEl as unknown as ElementStub).findByText("Sync now")
    assert.ok(syncCenterButton)
    clicks.push(() => syncCenterButton.onclick?.())
    for (const callback of clicks) {
      callback()
      await tick()
    }
    assert.deepEqual(ui.attempts, ["manual", "manual", "manual", "startup", "scheduled", "manual"])
    assert.equal(Notice.messages.length - priorNotices, clicks.length)
    for (const text of Notice.messages.slice(priorNotices)) {
      assert.match(text, /Sync stopped unexpectedly/)
      assert.doesNotMatch(text, /secret|network failure|vault|token/i)
    }
    await view.onClose()
    ui.setMode("resolve")
    ui.ribbons.get("GitHub Sync: Sync")!()
    await tick()
    assert.equal(Notice.messages.length - priorNotices, clicks.length, "successful runs have no failure notice")
    assert.equal(ui.attempts.length, clicks.length + 1, "no hidden retry after rejection")
  } finally { ui.cleanup(); resetModalTestState(); Notice.messages.length = 0 }
})

test("D156 unexpected synchronous executor throw stays within UI event and unloaded callbacks are ignored", async () => {
  const ui = setupUi()
  Notice.messages.length = 0
  try {
    await ui.plugin.onload()
    ui.setMode("throw")
    assert.doesNotThrow(() => ui.commands.get("sync-all-files")!())
    await tick()
    assert.deepEqual(ui.attempts, ["manual"])
    assert.equal(Notice.messages.length, 1)
    assert.doesNotMatch(Notice.messages[0]!, /secret|network failure/i)
    const callbacks = [
      ui.ribbons.get("GitHub Sync: Sync")!,
      ui.commands.get("sync-all-files")!,
      [...ui.timers.values()].find(t => t.kind === "interval")!.callback,
      [...ui.timers.values()].find(t => t.kind === "timeout")!.callback,
    ]
    ui.plugin.onunload()
    for (const callback of callbacks) assert.doesNotThrow(callback)
    await tick()
    assert.deepEqual(ui.attempts, ["manual"])
    assert.equal(Notice.messages.length, 1)
  } finally { ui.cleanup(); Notice.messages.length = 0 }
})


test("D156 after deliberate slider confirmation Force Push/Pull failures are contained without duplicate remote operations", async () => {
  const ui = setupUi()
  resetModalTestState()
  Notice.messages.length = 0
  try {
    await ui.plugin.onload()
    for (const kind of ["forcePush", "forcePull"] as const) {
      resetModalTestState()
      const dialog = ui.plugin.showForceConfirm(kind)
      const confirm = modalButtons.find(b => b.text === (kind === "forcePush" ? "Force push" : "Force pull"))
      const slider = Modal.lastCreated?.contentEl.findByClass("github-sync-force-confirm-slider")
      assert.ok(confirm && slider)
      confirm.click()
      assert.equal(ui.attempts.length, kind === "forcePush" ? 0 : 1)
      slider.onpointerdown?.({ pointerId: 1, clientX: 300 } as PointerEvent)
      confirm.click()
      confirm.click()
      await dialog
      await tick()
    }
    assert.deepEqual(ui.attempts, ["forcePush", "forcePull"], "one authorized operation per confirmation")
    assert.equal(Notice.messages.length, 2, "unexpected rejects each show only a safe notice")
    assert.ok(Notice.messages.every(message => !/secret|network failure|token/i.test(message)))
  } finally { ui.cleanup(); resetModalTestState(); Notice.messages.length = 0 }
})



test("D451 Force confirmation refuses unavailable or malformed local file metadata before opening", async () => {
  for (const kind of ["forcePush", "forcePull"] as const) {
    const ui = setupUi()
    resetModalTestState()
    Notice.messages.length = 0
    try {
      await ui.plugin.onload()
      ui.setMode("resolve")
      for (const list of [
        () => { throw new Error("private directory failure") },
        () => [{ path: "Notes/important.md", stat: { mtime: Number.NaN, size: 10 } }],
      ]) {
        ui.plugin.app.vault.getFiles = list
        const previousNoticeCount = Notice.messages.length
        await assert.doesNotReject(() => ui.plugin.showForceConfirm(kind))
        assert.deepEqual(ui.attempts, [], "Force is never attempted without a valid local file inventory")
        assert.equal(Notice.messages.length, previousNoticeCount + 1)
        assert.match(Notice.messages.at(-1) ?? "", /Could not inspect local vault files/u)
        assert.ok(Notice.messages.every(message => !/private directory failure/u.test(message)))
      }
    } finally {
      ui.cleanup()
      resetModalTestState()
      Notice.messages.length = 0
    }
  }
})

test("D451 Force confirmation expires when a same-path local note changes before approval", async () => {
  for (const kind of ["forcePush", "forcePull"] as const) {
    const ui = setupUi()
    resetModalTestState()
    Notice.messages.length = 0
    try {
      await ui.plugin.onload()
      ui.setMode("resolve")
      let saved = { path: "Notes/important.md", stat: { mtime: 1000, size: 12 } }
      ui.plugin.app.vault.getFiles = () => [saved]
      const label = kind === "forcePush" ? "Force push" : "Force pull"
      for (const edited of [
        { path: "Notes/important.md", stat: { mtime: 1001, size: 12 } },
        { path: "Notes/important.md", stat: { mtime: 1000, size: 13 } },
      ]) {
        resetModalTestState()
        const pending = ui.plugin.showForceConfirm(kind)
        const confirm = modalButtons.find(button => button.text === label)
        const slider = Modal.lastCreated?.contentEl.findByClass("github-sync-force-confirm-slider")
        assert.ok(confirm && slider)
        assert.match(Modal.lastCreated!.contentEl.flattenText(), /Local vault files: 1/u)
        slider.onpointerdown?.({ pointerId: 1, clientX: 300 } as PointerEvent)
        saved = edited
        confirm.click()
        await pending
        await tick()
        assert.deepEqual(ui.attempts, [], "an edited note must not be overwritten or uploaded from a stale confirmation")
        assert.match(Notice.messages.at(-1) ?? "", /Force confirmation expired.*local vault files changed/u)
      }
      resetModalTestState()
      const valid = ui.plugin.showForceConfirm(kind)
      const confirm = modalButtons.find(button => button.text === label)
      const slider = Modal.lastCreated?.contentEl.findByClass("github-sync-force-confirm-slider")
      assert.ok(confirm && slider)
      slider.onpointerdown?.({ pointerId: 1, clientX: 300 } as PointerEvent)
      confirm.click()
      await valid
      await tick()
      assert.deepEqual(ui.attempts, [kind], "a new approval for the changed note remains possible")
    } finally {
      ui.cleanup()
      resetModalTestState()
      Notice.messages.length = 0
    }
  }
})

test("D158 Force confirmation refuses a swapped GitHub client or a changed visible vault inventory", async () => {
  for (const kind of ["forcePush", "forcePull"] as const) {
    const ui = setupUi()
    resetModalTestState()
    Notice.messages.length = 0
    try {
      await ui.plugin.onload()
      ui.setMode("resolve")
      const originalClient = { id: "first-connection" }
      ui.plugin.githubClient = originalClient
      const actionLabel = kind === "forcePush" ? "Force push" : "Force pull"
      const withStats = (path: string) => [{ path, stat: { mtime: 1000, size: 12 } }]
      const startDialog = () => {
        resetModalTestState()
        const done = ui.plugin.showForceConfirm(kind)
        const action = modalButtons.find(button => button.text === actionLabel)
        const slider = Modal.lastCreated?.contentEl.findByClass("github-sync-force-confirm-slider")
        assert.ok(action && slider)
        slider.onpointerdown?.({ pointerId: 1, clientX: 300 } as PointerEvent)
        return { done, action }
      }

      // The textual owner/branch/token is unchanged, but a new GitHubClient
      // has replaced the one to which the original approval was bound.
      const swapped = startDialog()
      ui.plugin.githubClient = { id: "second-connection" }
      swapped.action.click()
      await swapped.done
      assert.deepEqual(ui.attempts, [], kind + " must reject a replaced client with identical settings")
      assert.match(Notice.messages.at(-1) ?? "", /confirmation expired/u)
      assert.doesNotMatch(Notice.messages.at(-1) ?? "", /first-connection|second-connection/u)

      // Count change: the displayed vault inventory was no longer accurate.
      ui.plugin.githubClient = originalClient
      const changedCount = startDialog()
      ui.plugin.app.vault.getFiles = () => withStats("added.md")
      changedCount.action.click()
      await changedCount.done
      assert.deepEqual(ui.attempts, [], kind + " must reject a changed file count")

      // Even a same-count rename is a distinct visible vault inventory.
      ui.plugin.app.vault.getFiles = () => withStats("original.md")
      const changedPaths = startDialog()
      assert.match(Modal.lastCreated!.contentEl.flattenText(), /Local vault files: 1/u)
      ui.plugin.app.vault.getFiles = () => withStats("renamed.md")
      changedPaths.action.click()
      await changedPaths.done
      assert.deepEqual(ui.attempts, [], kind + " must reject changed file paths at equal count")

      // A read failure must fail closed, not authorize destructive writes.
      ui.plugin.app.vault.getFiles = () => withStats("recover.md")
      const unavailableInventory = startDialog()
      ui.plugin.app.vault.getFiles = () => { throw new Error("private path enumeration failure") }
      unavailableInventory.action.click()
      await unavailableInventory.done
      assert.deepEqual(ui.attempts, [])
      assert.doesNotMatch(Notice.messages.at(-1) ?? "", /private path enumeration failure/u)

      // Opening fresh confirmation against the current client and inventory
      // still allows a single intentionally authorized force operation.
      ui.plugin.app.vault.getFiles = () => withStats("recover.md")
      const valid = startDialog()
      valid.action.click()
      valid.action.click()
      await valid.done
      await tick()
      assert.deepEqual(ui.attempts, [kind])
      assert.equal(Notice.messages.length, 4, "the four invalid confirmations each produce one sanitized notice")
    } finally {
      ui.cleanup()
      resetModalTestState()
      Notice.messages.length = 0
    }
  }
})

test("D157 stale Force confirmation cannot switch repository, branch, credentials, encryption, vault or scope", async () => {
  const scenarios = [
    { name: "repository replacement", apply: (s: typeof DEFAULT_SETTINGS) => ({ ...s, githubRepo: "different-repository" }) },
    { name: "owner replacement", apply: (s: typeof DEFAULT_SETTINGS) => ({ ...s, githubOwner: "other-owner" }) },
    { name: "in-place branch mutation", apply: (s: typeof DEFAULT_SETTINGS) => { s.githubBranch = "unapproved-branch"; return s } },
    { name: "credential rotation", apply: (s: typeof DEFAULT_SETTINGS) => ({ ...s, githubToken: "new-token-hidden" }) },
    { name: "encryption mode", apply: (s: typeof DEFAULT_SETTINGS) => ({ ...s, encryptionMode: "encrypted" as const }) },
    { name: "new passphrase", apply: (s: typeof DEFAULT_SETTINGS) => ({ ...s, encryptionPassphrase: "hidden-passphrase" }) },
    { name: "different vault", apply: (s: typeof DEFAULT_SETTINGS) => ({ ...s, vault: "differentVault" }) },
    { name: "ignore regex", apply: (s: typeof DEFAULT_SETTINGS) => ({ ...s, ignorePathRegex: "^secret/" }) },
    { name: "config sync scope", apply: (s: typeof DEFAULT_SETTINGS) => ({ ...s, syncPlugins: !s.syncPlugins }) },
    { name: "conflict policy", apply: (s: typeof DEFAULT_SETTINGS) => ({ ...s, conflictPolicy: "ask" as const }) },
  ]
  for (const kind of ["forcePush", "forcePull"] as const) {
    const ui = setupUi()
    resetModalTestState()
    Notice.messages.length = 0
    try {
      await ui.plugin.onload()
      ui.setMode("resolve")
      for (const scenario of scenarios) {
        const before = { ...ui.plugin.settings }
        resetModalTestState()
        const dialog = ui.plugin.showForceConfirm(kind)
        const modal = Modal.lastCreated!
        const action = modalButtons.find(b => b.text === (kind === "forcePush" ? "Force push" : "Force pull"))
        const slider = modal.contentEl.findByClass("github-sync-force-confirm-slider")
        assert.ok(action && slider, scenario.name)
        assert.match(modal.contentEl.flattenText(), /Repository: owner\/vault/)
        assert.match(modal.contentEl.flattenText(), /Branch: main/)
        slider.onpointerdown?.({ pointerId: 1, clientX: 300 } as PointerEvent)
        ui.plugin.settings = scenario.apply(ui.plugin.settings)
        action.click()
        await dialog
        await tick()
        assert.deepEqual(ui.attempts, [], kind + " " + scenario.name)
        assert.match(Notice.messages.at(-1) ?? "", /Force confirmation expired/)
        assert.doesNotMatch(Notice.messages.at(-1) ?? "", /new-token-hidden|hidden-passphrase|unapproved-branch/)
        action.click()
        assert.equal(ui.attempts.length, 0, "stale confirmation must not start again after close")
        ui.plugin.settings = before
      }
      // Cosmetic progress updates must not invalidate an otherwise valid target.
      resetModalTestState()
      const valid = ui.plugin.showForceConfirm(kind)
      const action = modalButtons.find(b => b.text === (kind === "forcePush" ? "Force push" : "Force pull"))
      const slider = Modal.lastCreated?.contentEl.findByClass("github-sync-force-confirm-slider")
      assert.ok(action && slider)
      slider.onpointerdown?.({ pointerId: 1, clientX: 300 } as PointerEvent)
      ui.plugin.settings.lastSyncTime += 1
      ui.plugin.settings.statusBarStatusEnabled = !ui.plugin.settings.statusBarStatusEnabled
      action.click()
      action.click()
      await valid
      await tick()
      assert.deepEqual(ui.attempts, [kind], "fresh, unchanged target executes exactly once")
    } finally {
      ui.cleanup()
      Notice.messages.length = 0
      resetModalTestState()
    }
  }
})

test("D157 closing or cancelling an unlocked Force confirmation revokes stale button capability", async () => {
  const ui = setupUi()
  resetModalTestState()
  try {
    await ui.plugin.onload()
    ui.setMode("resolve")
    for (const mode of ["cancel", "close"] as const) {
      resetModalTestState()
      const dialog = ui.plugin.showForceConfirm("forcePull")
      const action = modalButtons.find(b => b.text === "Force pull")
      const slider = Modal.lastCreated?.contentEl.findByClass("github-sync-force-confirm-slider")
      assert.ok(action && slider)
      slider.onpointerdown?.({ pointerId: 1, clientX: 300 } as PointerEvent)
      if (mode === "cancel") {
        modalButtons.find(b => b.text === "Cancel")!.click()
      } else {
        Modal.lastCreated!.close()
      }
      await dialog
      action.click()
      await tick()
      assert.deepEqual(ui.attempts, [], "closed or cancelled dialogs never authorize a destructive operation")
    }
  } finally { ui.cleanup(); resetModalTestState() }
})

test("D156 Force action is still disabled until deliberate confirmation, even with a rejecting Sync executor", async () => {
  const ui = setupUi()
  resetModalTestState()
  try {
    await ui.plugin.onload()
    const dialog = ui.plugin.showForceConfirm("forcePush")
    const confirm = modalButtons.find(b => b.text === "Force push")
    const cancel = modalButtons.find(b => b.text === "Cancel")
    assert.ok(confirm && cancel)
    confirm.click()
    assert.deepEqual(ui.attempts, [], "cannot run Force Push without unlocking")
    cancel.click()
    await dialog
    assert.deepEqual(ui.attempts, [])
  } finally { ui.cleanup(); resetModalTestState() }
})
