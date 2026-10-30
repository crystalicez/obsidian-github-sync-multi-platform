import assert from "node:assert/strict"
import test from "node:test"
import { Notice } from "obsidian"
import { isV4UncVaultPath, V4_NETWORK_VAULT_WARNING } from "../../src/lib/v4/network-storage"
import { V4PluginRuntime } from "../../src/lib/v4/runtime"
import { DEFAULT_SETTINGS, SettingTab } from "../../src/setting"

test("D13 identifies UNC vault paths without guessing mapped drives or local paths", () => {
  for (const path of ["\\\\server\\share\\vault", "//server/share/vault", "\\\\?\\UNC\\server\\share\\vault"]) {
    assert.equal(isV4UncVaultPath(path), true, path)
  }
  for (const path of ["C:\\Vault", "Z:\\MappedNetworkDrive", "/mnt/nas/vault", "\\\\?\\C:\\Vault", "\\\\server", "", undefined]) {
    assert.equal(isV4UncVaultPath(path), false, String(path))
  }
})

test("D13 Desktop settings keep a visible best-effort storage warning without requiring a toggle", () => {
  const tab = new SettingTab({} as never, {
    settings: { ...DEFAULT_SETTINGS },
    manifest: { version: "1.0.8" },
    clipboardReadTip: "",
  } as never)
  tab.display()
  assert.match(tab.containerEl.flattenText(), /Network, mapped-drive and cloud-mounted Desktop vaults run best-effort/)
  assert.match(tab.containerEl.flattenText(), /stops if integrity checks fail/)
})

test("D13 known UNC vault warns only once while allowing sync to reach ordinary checks", async () => {
  Notice.messages.length = 0
  const plugin = {
    app: { vault: {
      configDir: ".obsidian",
      adapter: {
        getFullPath: () => "\\\\server\\share\\vault",
        async exists() { return false },
      },
    } },
    manifest: { id: "network-warning-test" },
    settings: { ...DEFAULT_SETTINGS, githubOwner: "owner", githubRepo: "repo" },
    githubClient: undefined,
    isSyncInProgress: false,
    enableWatch() {},
    addIgnoredFile() {},
    removeIgnoredFile() {},
  }
  const runtime = new V4PluginRuntime(plugin as never)
  try {
    await runtime.manualSync()
    await runtime.manualSync()
    const warnings = Notice.messages.filter(message => message.includes(V4_NETWORK_VAULT_WARNING))
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /UNC network vault detected/)
    assert.equal(Notice.messages.filter(message => message.includes("GitHub connection is not configured.")).length, 2)
  } finally {
    runtime.dispose()
    Notice.messages.length = 0
  }
})
