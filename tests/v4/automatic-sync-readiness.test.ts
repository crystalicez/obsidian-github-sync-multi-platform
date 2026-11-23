import assert from "node:assert/strict"
import test from "node:test"
import { Notice, ElementStub } from "obsidian"
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
