import assert from "node:assert/strict"
import test from "node:test"
import { Platform } from "obsidian"

import { utf8ToBytes } from "../../src/lib/bytes"
import { V4PluginRuntime } from "../../src/lib/v4/runtime"
import { planV4PluginPrivateWalLocation } from "../../src/lib/v4/reencryption-plugin-wal-location"
import { openV4MobilePluginWalForRecovery } from "../../src/lib/v4/reencryption-mobile-wal-recovery"
import { createV4ReencryptionRecoveryJournal } from "../../src/lib/v4/reencryption-recovery-journal"
import type { V4LocalIndexAdapter } from "../../src/lib/v4/local-index"

const configDir = ".obsidian"
const pluginId = "mobile-runtime-rekey"
const runId = "d245-mobile-runtime-run-123"
const destinationRepoId = "owner/repo#rekey/mobile"
const sourceCommitSha = "a".repeat(40)
const journalKey = new Uint8Array(32).fill(0x72)

async function fixture() {
  const layout = await planV4PluginPrivateWalLocation({ configDir, pluginId, runId })
  const directories = new Set([configDir, configDir + "/plugins", layout.pluginStorageRoot])
  const files = new Map<string, { text: string; mtime: number }>()
  let stamp = 20
  let leaseLive = true
  const adapter = {
    async stat(name: string) {
      if (directories.has(name)) return { type: "folder" as const, size: 0, mtime: 1 }
      const file = files.get(name)
      return file ? { type: "file" as const,
        size: utf8ToBytes(file.text).length, mtime: file.mtime } : null
    },
    async list(name: string) {
      if (!directories.has(name)) throw Error("missing folder")
      const prefix = name + "/"
      return {
        files: [...files.keys()].filter(n => n.startsWith(prefix)
          && !n.slice(prefix.length).includes("/")),
        folders: [...directories].filter(n => n.startsWith(prefix)
          && !n.slice(prefix.length).includes("/")),
      }
    },
    async read(name: string) {
      const value = files.get(name)
      if (!value) throw Error("not found")
      return value.text
    },
    async write(name: string, value: string) {
      files.set(name, { text: value, mtime: ++stamp })
    },
    async mkdir(name: string) {
      if (directories.has(name)) throw Error("already exists")
      directories.add(name)
    },
    async exists(name: string) { return directories.has(name) || files.has(name) },
  }
  const settings = {
    githubOwner: "owner", githubRepo: "repo", githubBranch: "main",
    githubToken: "test-token", githubTokenSecretId: "token-secret",
    encryptionMode: "encrypted", encryptionPassphrase: "old-key",
    encryptionPassphraseSecretId: "old-pass-secret", vault: "mobile-device",
    ignorePathRegex: "", syncObsidianConfig: false,
    syncBookmarks: false, syncPlugins: false,
  }
  let watchDisabled = false
  const plugin = {
    app: { vault: { configDir, adapter } }, manifest: { id: pluginId },
    settings, isSyncInProgress: false,
    isSettingsSaveInProgress: () => false,
    disableWatch: () => { watchDisabled = true },
    addIgnoredFile() {}, removeIgnoredFile() {},
  }
  const runtime = new V4PluginRuntime(plugin as never)
  const lease = async () => { if (!leaseLive) throw Error("initiating Mobile lease lost") }
  return {
    adapter, files, directories, layout, settings, plugin, runtime,
    loseLease() { leaseLive = false },
    get watchDisabled() { return watchDisabled },
    arm: () => runtime.armReencryptionSyncFence({
      runId, destinationRepoId, assertExclusiveInitiatorLease: lease,
    }),
  }
}

test("D245 live Mobile Runtime arms persisted Fence, writes AES-GCM WAL and reopens with adapter-only Recovery", async () => {
  const previous = Platform.isDesktopApp
  Platform.isDesktopApp = false
  const f = await fixture()
  let writer: Awaited<ReturnType<V4PluginRuntime["openNewReencryptionMobileWalForArmedRun"]>> | undefined
  try {
    await assert.rejects(f.runtime.openNewReencryptionMobileWalForArmedRun(),
      /live initiating Runtime/u)
    const armed = await f.arm()
    assert.equal(armed.status, "reencryption-sync-fence-armed-uncommitted")
    assert.equal(f.watchDisabled, true)
    writer = await f.runtime.openNewReencryptionMobileWalForArmedRun()
    const journal = createV4ReencryptionRecoveryJournal({
      adapter: writer.adapter, root: writer.journalRoot, runId,
      sourceCommitSha, destinationRepoId, journalKey,
    })
    const initial = await journal.begin()
    const latest = await journal.recordRefIntent({
      role: "backup", repoId: "owner/repo#rekey/backup",
      commitSha: sourceCommitSha, treeSha: "b".repeat(40),
    }, initial.generation)
    assert.equal(writer.atomicSlotWritesProven, false)
    assert.equal(writer.resumeSyncAuthorized, false)
    assert.equal(writer.cutoverAuthorized, false)
    writer.release()
    writer = undefined
    const readonly = await openV4MobilePluginWalForRecovery({
      adapter: f.adapter, configDir, pluginId, runId, assertLiveOwner: () => {},
    })
    const readAdapter: V4LocalIndexAdapter = {
      read: readonly.adapter.read, exists: readonly.adapter.exists,
      async mkdir() { throw Error("forbidden") },
      async write() { throw Error("forbidden") },
    }
    const recovered = createV4ReencryptionRecoveryJournal({
      adapter: readAdapter, root: readonly.journalRoot, runId,
      sourceCommitSha, destinationRepoId, journalKey: Uint8Array.from(journalKey),
    })
    assert.deepEqual(await recovered.assertHealthySnapshot(latest.generation), latest)
    const restarted = new V4PluginRuntime(f.plugin as never)
    try {
      await assert.rejects(restarted.openNewReencryptionMobileWalForArmedRun(),
        /live initiating Runtime/u)
    } finally { restarted.dispose() }
    assert.equal(f.files.size, 3)
  } finally {
    writer?.release()
    f.runtime.dispose()
    Platform.isDesktopApp = previous
  }
})

test("D245 Mobile Runtime freezes WAL on lease, settings scope, vault identity or persisted Fence change", async () => {
  const previous = Platform.isDesktopApp
  Platform.isDesktopApp = false
  try {
    for (const loss of ["lease", "scope", "adapter", "fence", "disposed"] as const) {
      const f = await fixture()
      let writer: Awaited<ReturnType<V4PluginRuntime["openNewReencryptionMobileWalForArmedRun"]>> | undefined
      try {
        await f.arm()
        writer = await f.runtime.openNewReencryptionMobileWalForArmedRun()
        await writer.adapter.write(f.layout.journalRoot + "/slot-0.json", "preserve")
        if (loss === "lease") f.loseLease()
        if (loss === "scope") f.settings.ignorePathRegex = "^secret/"
        if (loss === "adapter") f.plugin.app.vault.adapter = { ...f.adapter }
        if (loss === "fence") {
          const marker = f.layout.pluginStorageRoot
            + "/github-sync-v4-rekey-sync-fence/active.json"
          await f.adapter.write(marker, "{truncated")
        }
        if (loss === "disposed") f.runtime.dispose()
        await assert.rejects(writer.adapter.write(f.layout.journalRoot + "/slot-1.json", "forbidden"))
        assert.equal(f.files.get(f.layout.vaultLogicalWalRoot + "/slot-0.json")?.text, "preserve")
        assert.equal(f.files.has(f.layout.vaultLogicalWalRoot + "/slot-1.json"), false)
      } finally {
        writer?.release()
        f.runtime.dispose()
      }
    }
  } finally { Platform.isDesktopApp = previous }
})

test("D245 Desktop method remains unavailable on Mobile and Mobile method unavailable on Desktop", async () => {
  const previous = Platform.isDesktopApp
  try {
    Platform.isDesktopApp = false
    const mobile = await fixture()
    try {
      await assert.rejects(mobile.runtime.openNewReencryptionDesktopWalForArmedRun(),
        /Desktop WAL requires/u)
    } finally { mobile.runtime.dispose() }
    Platform.isDesktopApp = true
    const desktop = await fixture()
    try {
      await assert.rejects(desktop.runtime.openNewReencryptionMobileWalForArmedRun(),
        /Mobile WAL requires/u)
    } finally { desktop.runtime.dispose() }
  } finally { Platform.isDesktopApp = previous }
})
