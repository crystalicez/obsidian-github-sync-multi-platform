import assert from "node:assert/strict"
import test from "node:test"
import { Notice, ElementStub } from "obsidian"
import FastSync from "../../src/main"
import { DEFAULT_SETTINGS } from "../../src/setting"
import { shouldRunScheduledSync, shouldRunStartupSync } from "../../src/lib/sync-policy"

for (const format of ["modern", "legacy", "legacy-write"] as const) {
  test(`D417 a ${format} vault opens safely when SecretStorage throws and recovers after a fresh restart`, async () => {
    const diskWrites: unknown[] = []
    const secretWrites: string[] = []
    const stored = new Map<string, string>(format === "modern"
      ? [["saved-token-id", "good-token"], ["saved-passphrase-id", "good-passphrase"]]
      : [])
    const original = {
      ...DEFAULT_SETTINGS,
      githubOwner: "owner", githubRepo: "notes",
      encryptionMode: "encrypted" as const,
      syncEnabled: true, syncOnStartup: true, scheduledSyncEnabled: true,
      githubTokenSecretId: format === "modern" ? "saved-token-id" : "",
      encryptionPassphraseSecretId: format === "modern" ? "saved-passphrase-id" : "",
      githubToken: format !== "modern" ? "legacy-token" : "",
      encryptionPassphrase: format !== "modern" ? "legacy-passphrase" : "",
    }
    let disk: unknown = { settings: original }
    let unavailable = true
    let watchCalls = 0
    let startupCalls = 0
    let intervalCalls = 0
    const setup = () => {
      const plugin = new FastSync() as FastSync & Record<string, any>
      plugin.app = {
        secretStorage: {
          getSecret(id: string) {
            if (unavailable && format !== "legacy-write") throw Error("os-credential-backend-fault-secret-content")
            return stored.get(id) ?? null
          },
          setSecret(id: string, value: string) {
            if (unavailable && format === "legacy-write") throw Error("os-credential-backend-fault-secret-content")
            secretWrites.push(id); stored.set(id, value)
          },
        },
        vault: {
          configDir: ".obsidian", adapter: { async exists() { return false } },
          getFiles: () => [], on: () => ({}),
        },
        workspace: { onLayoutReady: (cb: () => void) => cb() },
      } as never
      plugin.manifest = { id: "test" } as never
      plugin.loadData = async () => disk
      plugin.saveData = async value => { diskWrites.push(value); disk = value }
      plugin.initGitHubClient = () => {}
      plugin.updateRibbonIcon = () => {}
      plugin.registerScheduledSync = () => {
        if (shouldRunScheduledSync(plugin.settings)) intervalCalls++
      }
      plugin.addSettingTab = () => {}
      plugin.registerView = () => {}
      plugin.addCommand = () => {}
      plugin.registerEvent = () => {}
      plugin.register = () => {}
      plugin.addRibbonIcon = () => new ElementStub() as never
      plugin.createV4Runtime = () => ({
        subscribeProgress: () => () => {},
        startupSync() { startupCalls++; return Promise.resolve({ status: "completed" }) },
        dispose() {},
      }) as never
      plugin.enableWatch = () => { watchCalls++ }
      return plugin
    }
    const noticeBefore = Notice.messages.length
    const beforeDisk = structuredClone(disk)
    const offline = setup()
    try {
      await offline.onload()
      assert.ok(offline.settingTab, "Settings must remain accessible after a transient OS keychain failure")
      offline.settingTab.display()
      assert.match(offline.settingTab.containerEl.flattenText(), /GitHub token/u,
        "the real Settings tab must remain renderable for recovery instructions")
      assert.equal(offline.settings.githubToken, "")
      assert.equal(offline.settings.encryptionPassphrase, "")
      assert.equal(shouldRunStartupSync(offline.settings), false)
      assert.equal(shouldRunScheduledSync(offline.settings), false)
      assert.equal(intervalCalls, 0)
      assert.equal(startupCalls, 0)
      assert.deepEqual(diskWrites, [], "an unavailable keychain must not rewrite persisted settings")
      assert.deepEqual(secretWrites, [], "an unavailable keychain must not rotate or clear secrets")
      await assert.rejects(
        () => offline.saveSettings({ ...offline.settings, syncOnLocalChange: false }),
        /SecretStorage unavailable/u,
        "Settings must not erase legacy credentials while keychain reads are unavailable",
      )
      assert.deepEqual(disk, beforeDisk)
      assert.match(Notice.messages.slice(noticeBefore).join(" "), /SecretStorage.*unavailable.*restart/iu)
      assert.doesNotMatch(Notice.messages.slice(noticeBefore).join(" "), /os-credential-backend-fault-secret-content/u)
    } finally {
      offline.onunload()
    }

    unavailable = false
    const restored = setup()
    try {
      // Do not schedule a startup timer in the Node test host.
      restored.app.workspace.onLayoutReady = () => {}
      await restored.onload()
      assert.equal(restored.settings.githubToken, format === "modern" ? "good-token" : "legacy-token")
      assert.equal(restored.settings.encryptionPassphrase, format === "modern" ? "good-passphrase" : "legacy-passphrase")
      assert.equal(shouldRunScheduledSync(restored.settings), true)
      assert.ok(restored.settings.githubTokenSecretId)
      assert.ok(restored.settings.encryptionPassphraseSecretId)
      if (format === "modern") {
        assert.deepEqual(secretWrites, [], "a normal fresh read is read-only")
        assert.deepEqual(diskWrites, [], "modern settings need no migration")
      } else {
        assert.equal(diskWrites.length, 1, "deferred legacy migration should resume after SecretStorage recovers")
        const persisted = diskWrites[0] as { settings: Record<string, unknown> }
        assert.equal(persisted.settings.githubToken, undefined, "persisted config must never keep plaintext token after migration")
        assert.equal(persisted.settings.encryptionPassphrase, undefined)
      }
    } finally {
      restored.onunload()
      Notice.messages.length = noticeBefore
    }
  })
}
