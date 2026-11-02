import assert from "node:assert/strict"
import test from "node:test"
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"

import { V4PluginRuntime } from "../../src/lib/v4/runtime"
import { planV4PluginPrivateWalLocation } from "../../src/lib/v4/reencryption-plugin-wal-location"
import { openV4DesktopPluginWalForRecovery } from "../../src/lib/v4/reencryption-desktop-plugin-wal-recovery"
import { createV4ReencryptionRecoveryJournal } from "../../src/lib/v4/reencryption-recovery-journal"

const configDir = ".obsidian"
const pluginId = "github-sync-runtime-test"
const runId = "d244-owner-runtime-123"
const destinationRepoId = "owner/repo#rekey/new"
const sourceCommitSha = "a".repeat(40)
const journalKey = new Uint8Array(32).fill(0x73)

async function fixture() {
  await mkdir(path.join(process.cwd(), ".tmp"), { recursive: true })
  const root = await mkdtemp(path.join(process.cwd(), ".tmp", "d244-live-runtime-"))
  const layout = await planV4PluginPrivateWalLocation({ configDir, pluginId, runId })
  const pluginRoot = path.join(root, ...layout.pluginStorageRoot.split("/"))
  const walLeaf = path.join(pluginRoot, ...layout.journalRoot.split("/"))
  await mkdir(pluginRoot, { recursive: true })
  const file = (name: string) => path.join(root, ...name.split("/"))
  const adapter = {
    getFullPath: (name: string) => file(name),
    read: (name: string) => readFile(file(name), "utf8"),
    write: (name: string, value: string) => writeFile(file(name), value),
    async exists(name: string) {
      return stat(file(name)).then(() => true, (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false
        throw error
      })
    },
    mkdir: (name: string) => mkdir(file(name)),
  }
  const settings = {
    githubOwner: "owner", githubRepo: "repo", githubBranch: "main",
    githubToken: "test-token", githubTokenSecretId: "token-id",
    encryptionMode: "encrypted", encryptionPassphrase: "old-key",
    encryptionPassphraseSecretId: "old-secret-id", vault: "device-d244",
    ignorePathRegex: "", syncObsidianConfig: false,
    syncBookmarks: false, syncPlugins: false,
  }
  let leaseLive = true
  let watchEnabled = true
  const plugin = {
    app: { vault: { configDir, adapter } },
    manifest: { id: pluginId },
    settings,
    isSyncInProgress: false,
    isSettingsSaveInProgress: () => false,
    disableWatch: () => { watchEnabled = false },
    addIgnoredFile() {}, removeIgnoredFile() {},
  }
  const runtime = new V4PluginRuntime(plugin as never)
  const lease = async () => { if (!leaseLive) throw Error("initiating lease lost") }
  return {
    root, walLeaf, layout, adapter, settings, plugin, runtime, lease,
    revokeLease() { leaseLive = false },
    get watchEnabled() { return watchEnabled },
    async arm() {
      return runtime.armReencryptionSyncFence({
        runId, destinationRepoId,
        assertExclusiveInitiatorLease: lease,
      })
    },
    cleanup: async () => {
      runtime.dispose()
      await rm(root, { recursive: true, force: true })
    },
  }
}

test("D244 installed Runtime boundary rejects WAL authoring before successful same-session arming", async () => {
  const f = await fixture()
  try {
    await assert.rejects(f.runtime.openNewReencryptionDesktopWalForArmedRun(),
      /live initiating Runtime/u)
    assert.equal(await stat(f.walLeaf).then(() => true, () => false), false)
  } finally { await f.cleanup() }
})

test("D244 real Runtime D173 Fence opens create-only WAL on its actual Obsidian Vault adapter", async () => {
  const f = await fixture()
  let writer: Awaited<ReturnType<V4PluginRuntime["openNewReencryptionDesktopWalForArmedRun"]>> | undefined
  let reader: Awaited<ReturnType<typeof openV4DesktopPluginWalForRecovery>> | undefined
  try {
    const armed = await f.arm()
    assert.equal(armed.status, "reencryption-sync-fence-armed-uncommitted")
    assert.equal(f.watchEnabled, false)
    writer = await f.runtime.openNewReencryptionDesktopWalForArmedRun()
    assert.equal(writer.journalRoot, f.layout.journalRoot)
    const journal = createV4ReencryptionRecoveryJournal({
      adapter: writer.adapter, root: writer.journalRoot, runId,
      sourceCommitSha, destinationRepoId, journalKey,
    })
    const initial = await journal.begin()
    const state = await journal.recordRefIntent({
      role: "backup", repoId: "owner/repo#rekey/backup",
      commitSha: sourceCommitSha, treeSha: "b".repeat(40),
    }, initial.generation)
    await writer.release()
    writer = undefined
    reader = await openV4DesktopPluginWalForRecovery({
      adapter: f.adapter, configDir, pluginId, runId,
      assertLiveOwner: () => {},
    })
    const readonly = {
      read: (name: string) => reader!.adapter.read(name),
      exists: (name: string) => reader!.adapter.exists(name),
      async mkdir() { throw Error("forbidden") },
      async write() { throw Error("forbidden") },
    }
    const recovered = createV4ReencryptionRecoveryJournal({
      adapter: readonly, root: f.layout.journalRoot, runId,
      sourceCommitSha, destinationRepoId, journalKey: Uint8Array.from(journalKey),
    })
    assert.deepEqual(await recovered.assertHealthySnapshot(state.generation), state)
    await reader.release()
    reader = undefined
    assert.deepEqual((await readdir(f.walLeaf)).sort(), ["slot-0.json", "slot-1.json"])
    const restarted = new V4PluginRuntime(f.plugin as never)
    try {
      await assert.rejects(restarted.openNewReencryptionDesktopWalForArmedRun(),
        /live initiating Runtime/u)
    } finally { restarted.dispose() }
  } finally {
    await reader?.release()
    await writer?.release()
    await f.cleanup()
  }
})

test("D244 Runtime must stop new WAL generations after initiating lease or settings identity changes", async () => {
  for (const loss of ["lease", "settings", "settings-object", "scope", "config-dir", "adapter", "dispose"] as const) {
    const f = await fixture()
    let writer: Awaited<ReturnType<V4PluginRuntime["openNewReencryptionDesktopWalForArmedRun"]>> | undefined
    try {
      await f.arm()
      writer = await f.runtime.openNewReencryptionDesktopWalForArmedRun()
      await writer.adapter.write(f.layout.journalRoot + "/slot-0.json", "retained")
      if (loss === "lease") f.revokeLease()
      if (loss === "settings") f.settings.githubBranch = "changed"
      if (loss === "settings-object") f.plugin.settings = { ...f.settings }
      if (loss === "scope") f.settings.ignorePathRegex = "^private/"
      if (loss === "config-dir") f.plugin.app.vault.configDir = "different-config"
      if (loss === "adapter") {
        f.plugin.app.vault.adapter = { ...f.adapter }
      }
      if (loss === "dispose") f.runtime.dispose()
      await assert.rejects(writer.adapter.write(f.layout.journalRoot + "/slot-1.json", "forbidden"))
      await writer.release()
      writer = undefined
      assert.equal(await readFile(path.join(f.walLeaf, "slot-0.json"), "utf8"), "retained")
      assert.deepEqual(await readdir(f.walLeaf), ["slot-0.json"])
    } finally {
      await writer?.release()
      await f.cleanup()
    }
  }
})

test("D244 failed post-fence watcher shutdown cannot retain WAL authoring authority", async () => {
  const f = await fixture()
  try {
    f.plugin.disableWatch = () => { throw Error("watch shutdown failed") }
    await assert.rejects(f.arm(), /watch shutdown failed/u)
    const markerPath = path.join(f.root, configDir, "plugins", pluginId,
      "github-sync-v4-rekey-sync-fence", "active.json")
    assert.equal(await stat(markerPath).then(s => s.isFile()), true)
    await assert.rejects(f.runtime.openNewReencryptionDesktopWalForArmedRun(),
      /live initiating Runtime/u)
    assert.equal(await stat(f.walLeaf).then(() => true, () => false), false)
  } finally { await f.cleanup() }
})

test("D244 Runtime refuses writing after its persisted Sync Fence disappears or changes", async () => {
  const f = await fixture()
  let writer: Awaited<ReturnType<V4PluginRuntime["openNewReencryptionDesktopWalForArmedRun"]>> | undefined
  try {
    await f.arm()
    writer = await f.runtime.openNewReencryptionDesktopWalForArmedRun()
    await writer.adapter.write(f.layout.journalRoot + "/slot-0.json", "saved")
    const fencePath = path.join(f.root, configDir, "plugins", pluginId,
      "github-sync-v4-rekey-sync-fence", "active.json")
    await writeFile(fencePath, "{torn")
    await assert.rejects(writer.adapter.write(f.layout.journalRoot + "/slot-1.json", "forbidden"))
    await writer.release()
    writer = undefined
    assert.deepEqual(await readdir(f.walLeaf), ["slot-0.json"])
    assert.equal(await readFile(fencePath, "utf8"), "{torn")
  } finally {
    await writer?.release()
    await f.cleanup()
  }
})
