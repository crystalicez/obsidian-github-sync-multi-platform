import assert from "node:assert/strict"
import test from "node:test"
import { Notice, ElementStub, Platform } from "obsidian"
import FastSync from "../../src/main"
import { DEFAULT_SETTINGS } from "../../src/setting"
import { hasGitHubSyncConfig, shouldRunScheduledSync, shouldRunStartupSync } from "../../src/lib/sync-policy"
import { V4PluginRuntime } from "../../src/lib/v4/runtime"

const plaintext = { ...DEFAULT_SETTINGS, githubOwner: "owner", githubRepo: "notes",
  githubToken: "token", encryptionMode: "plaintext" as const, scheduledSyncEnabled: true }
const encrypted = { ...plaintext, encryptionMode: "encrypted" as const, encryptionPassphrase: "passphrase" }

test("D416 incomplete credentials never arm startup or interval Sync; valid plaintext and encrypted configs still do", () => {
  for (const incomplete of [
    { ...DEFAULT_SETTINGS, scheduledSyncEnabled: true },
    { ...plaintext, githubToken: "" },
    { ...encrypted, encryptionPassphrase: "" },
  ]) {
    assert.equal(hasGitHubSyncConfig(incomplete), false)
    assert.equal(shouldRunStartupSync(incomplete), false)
    assert.equal(shouldRunScheduledSync(incomplete), false)
  }
  assert.equal(shouldRunStartupSync(plaintext), true)
  assert.equal(shouldRunScheduledSync(plaintext), true)
  assert.equal(shouldRunStartupSync(encrypted), true)
  assert.equal(shouldRunScheduledSync(encrypted), true)
})

test("D476 a blank saved GitHub branch blocks startup and scheduled Sync despite valid credentials", () => {
  for (const githubBranch of ["", " ", "  \t  "]) {
    const invalid = { ...plaintext, githubBranch }
    assert.equal(hasGitHubSyncConfig(invalid), false)
    assert.equal(shouldRunStartupSync(invalid), false)
    assert.equal(shouldRunScheduledSync(invalid), false)
  }
  assert.equal(hasGitHubSyncConfig(plaintext), true,
    "an explicit branch still permits normal Sync")
})

test("D479 incomplete saved settings never create a GitHub client or silently target main", () => {
  const broken = [
    { ...plaintext, githubBranch: "" },
    { ...plaintext, githubBranch: " \t " },
    { ...plaintext, vault: "" },
    { ...plaintext, vault: " \t " },
    { ...plaintext, githubToken: " \t " },
    { ...plaintext, githubOwner: "" },
    { ...plaintext, githubRepo: "" },
    { ...encrypted, encryptionPassphrase: "" },
  ]
  const plugin = new FastSync()
  const desktop = Platform.isDesktopApp
  Platform.isDesktopApp = false // Exercise the real client policy without Node-only Desktop timer imports.
  try {
    for (const settings of broken) {
      plugin.settings = settings
      plugin.initGitHubClient()
      assert.equal(plugin.githubClient, undefined,
        "a missing Sync prerequisite must not create an authenticated GitHub client")
    }
    plugin.settings = { ...plaintext, githubBranch: "notes-v4" }
    plugin.initGitHubClient()
    assert.ok(plugin.githubClient,
      "a complete plaintext configuration must still create a usable GitHub client")
    assert.equal((plugin.githubClient as unknown as { config: { branch: string } }).config.branch,
      "notes-v4", "a valid explicit branch must be used without fallback")
    plugin.settings = encrypted
    plugin.initGitHubClient()
    assert.ok(plugin.githubClient,
      "a complete encrypted configuration must still create a usable GitHub client")
    plugin.settings = { ...plaintext, githubBranch: "" }
    plugin.initGitHubClient()
    assert.equal(plugin.githubClient, undefined,
      "clearing a formerly valid branch must revoke the existing client, never retarget main")
  } finally {
    Platform.isDesktopApp = desktop
  }
})

test("D477 whitespace-only GitHub tokens do not arm unattended Sync", () => {
  for (const githubToken of [" ", " \t\r\n "]) {
    const invalid = { ...plaintext, githubToken }
    assert.equal(hasGitHubSyncConfig(invalid), false)
    assert.equal(shouldRunStartupSync(invalid), false)
    assert.equal(shouldRunScheduledSync(invalid), false)
  }
  assert.equal(hasGitHubSyncConfig(plaintext), true,
    "a nonblank saved token still permits normal Sync")
})

test("D475 an empty saved Device ID pauses startup and scheduled Sync even with valid credentials", () => {
  for (const vault of ["", " ", "  \t  "]) {
    const invalid = { ...plaintext, vault }
    assert.equal(hasGitHubSyncConfig(invalid), false)
    assert.equal(shouldRunStartupSync(invalid), false)
    assert.equal(shouldRunScheduledSync(invalid), false)
  }
  assert.equal(hasGitHubSyncConfig(plaintext), true,
    "ordinary nonempty identities must continue to synchronize")
})

test("D416 file-change auto Sync skips incomplete credentials without scheduling a doomed run", () => {
  for (const settings of [
    { ...DEFAULT_SETTINGS, syncEnabled: true, syncOnLocalChange: true },
    { ...encrypted, encryptionPassphrase: "", syncOnLocalChange: true },
    { ...plaintext, vault: "  ", syncOnLocalChange: true },
    { ...plaintext, githubBranch: "", syncOnLocalChange: true },
    { ...plaintext, githubToken: " \t ", syncOnLocalChange: true },
  ]) {
    const plugin = {
      settings, isWatchEnabled: true, ignoredFiles: new Set<string>(),
      app: { vault: { configDir: ".obsidian", adapter: { async exists() { return false } } } },
      manifest: { id: "test" },
    }
    const runtime = new V4PluginRuntime(plugin as never)
    try {
      runtime.enqueueRescan()
      assert.equal(runtime.progressSnapshot.lifecycle, "idle",
        "an unconfigured automatic event must not enter a retry/debounce state")
    } finally {
      runtime.dispose()
    }
  }
  const readyPlugin = {
    settings: { ...plaintext, syncOnLocalChange: true },
    isWatchEnabled: true, ignoredFiles: new Set<string>(),
    app: { vault: { configDir: ".obsidian", adapter: { async exists() { return false } } } },
    manifest: { id: "test" },
  }
  const readyRuntime = new V4PluginRuntime(readyPlugin as never)
  try {
    readyRuntime.enqueueRescan()
    assert.equal(readyRuntime.progressSnapshot.lifecycle, "waiting",
      "a complete connection must still queue local changes normally")
  } finally {
    readyRuntime.dispose()
  }
})

test("D416 restart warns about unavailable saved credentials without touching SecretStorage or plugin data", async () => {
  const stored = new Map<string, string>()
  const diskWrites: unknown[] = []
  const credentialWrites: string[] = []
  const plugin = new FastSync() as FastSync & Record<string, any>
  const saved = {
    ...encrypted, githubToken: "", encryptionPassphrase: "",
    githubTokenSecretId: "token-existing", encryptionPassphraseSecretId: "pass-existing",
  }
  plugin.app = {
    secretStorage: {
      getSecret: (id: string) => stored.get(id) ?? null,
      setSecret: (id: string, value: string) => { credentialWrites.push(id); stored.set(id, value) },
    },
    vault: { configDir: ".obsidian", getFiles: () => [], on: () => ({}),
      adapter: { async exists() { return false }, async read() { throw Error("not used") } } },
    workspace: { onLayoutReady: (cb: () => void) => cb() },
  } as never
  plugin.manifest = { id: "test" } as never
  plugin.loadData = async () => ({ settings: saved })
  plugin.saveData = async value => { diskWrites.push(value) }
  plugin.initGitHubClient = () => {}
  plugin.registerScheduledSync = () => {}
  plugin.updateRibbonIcon = () => {}
  plugin.addSettingTab = () => {}
  plugin.registerView = () => {}
  plugin.addCommand = () => {}
  plugin.registerEvent = () => {}
  plugin.register = () => {}
  plugin.addRibbonIcon = () => new ElementStub() as never
  plugin.createV4Runtime = () => ({
    subscribeProgress: () => () => {}, dispose() {},
  }) as never
  const before = Notice.messages.length
  try {
    await plugin.onload()
    const messages = Notice.messages.slice(before)
    assert.ok(messages.some(message => /GitHub token.*unavailable.*Settings/iu.test(message)),
      "a missing stored token must give an actionable restart notice")
    assert.ok(messages.some(message => /passphrase.*unavailable.*Settings/iu.test(message)),
      "a missing stored key must not leave the user guessing about encrypted Sync")
    assert.deepEqual(credentialWrites, [], "restart detection never rewrites a missing credential")
    assert.deepEqual(diskWrites, [], "restart detection does not mutate plugin settings")
    assert.equal(plugin.settings.encryptionPassphrase, "")
    assert.equal(plugin.settings.githubToken, "")
  } finally {
    plugin.onunload()
    Notice.messages.length = before
  }
})
