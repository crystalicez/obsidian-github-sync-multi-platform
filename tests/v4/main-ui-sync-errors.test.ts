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
    enqueueModify() {}, enqueueDelete() {}, enqueueRename() {},
    enqueueFolderDelete() {}, enqueueFolderRename() {},
  }
  plugin.app = {
    secretStorage: {},
    vault: { configDir: ".obsidian", getFiles: () => [], on: () => ({}) },
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
