import assert from "node:assert/strict"
import test from "node:test"
import { link, mkdtemp, mkdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sha256Hex, utf8ToBytes } from "../../src/lib/bytes"
import { createV4DesktopInitiatorLocalReader } from "../../src/lib/v4/reencryption-desktop-initiator-reader"
import { verifyV4ReencryptionInitiatorLocalParity } from "../../src/lib/v4/reencryption-initiator-parity"
import { V4PluginRuntime } from "../../src/lib/v4/runtime"
import { V4SyncCoordinator } from "../../src/lib/v4/sync-coordinator"
import type { V4IndexFileRecord } from "../../src/lib/v4/local-index"
import type { V4ScopeSettings } from "../../src/lib/v4/scope"

const sha = "a".repeat(40)
const scope: V4ScopeSettings = {
  configDir: ".obsidian",
  pluginId: "github-sync-test",
  ignorePathRegex: "",
  syncObsidianConfig: false,
  syncBookmarks: false,
  syncPlugins: false,
}
async function sandbox() {
  const root = await mkdtemp(join(tmpdir(), "v4-d106-rekey-"))
  const write = async (path: string, text: string) => {
    const parts = path.split("/")
    await mkdir(join(root, ...parts.slice(0, -1)), { recursive: true })
    await writeFile(join(root, ...parts), text, "utf8")
  }
  const guard = {
    async assertExclusiveInitiatorLease() {},
    async assertIdleAndNoPendingEdits() {},
    async assertSourceConfigurationUnchanged() {},
    async listOpenEditorPaths() { return [] as string[] },
  }
  const reader = () => createV4DesktopInitiatorLocalReader({ rootAbsolute: root, scope, ...guard })
  return { root, write, reader, guard, cleanup: () => rm(root, { recursive: true, force: true }) }
}

async function exactSource(paths: ReadonlyArray<{ path: string; bytes: Uint8Array }>) {
  const records: V4IndexFileRecord[] = []
  for (const [i, { path, bytes }] of paths.entries()) {
    records.push({
      path, pathId: "b".repeat(64), fileId: "f-" + i,
      plaintextSha256: await sha256Hex(bytes),
      size: bytes.length, mtime: 10,
      remoteVersion: "v1", remotePath: "objects/" + i, storage: "single",
    })
  }
  return {
    sourceRecords: records,
    pinnedSourceCommitSha: sha,
    verifiedSource: {
      integrityScope: "all-live-objects" as const,
      pinnedSourceCommitSha: sha,
      verifiedFileCount: records.length,
      verifiedRemoteObjectCount: records.length,
      totalVerifiedPlaintextBytes: records.reduce((total, r) => total + BigInt(r.size), BigInt(0)).toString(),
    },
  }
}

test("D361 Desktop physical reader fails closed on live Sync, lease and Source loss before direct disk access", async () => {
  const f = await sandbox()
  try {
    await f.write("notes/a.md", "immutable physical content")
    for (const changed of ["sync", "lease", "source"] as const) {
      let syncing = false
      let lease = true
      let sourceValid = true
      const reader = createV4DesktopInitiatorLocalReader({
        rootAbsolute: f.root,
        scope,
        async assertExclusiveInitiatorLease() { if (!lease) throw new Error("lease lost") },
        async assertIdleAndNoPendingEdits() { if (syncing) throw new Error("sync active") },
        async assertSourceConfigurationUnchanged() { if (!sourceValid) throw new Error("source changed") },
        async listOpenEditorPaths() { return [] },
      })
      if (changed === "sync") syncing = true
      else if (changed === "lease") lease = false
      else sourceValid = false
      const expected = changed === "source" ? /source/i : changed === "lease" ? /lease/i : /sync/i
      await assert.rejects(() => reader.listFiles(), expected,
        "a standalone Desktop inventory must not bypass live " + changed + " guard")
      await assert.rejects(() => reader.openFile("notes/a.md"), expected,
        "a standalone Desktop file handle must not bypass live " + changed + " guard")
    }
  } finally {
    await f.cleanup()
  }
})

test("D361 Desktop physical reader refuses the next bounded chunk after live authority is lost", async () => {
  const f = await sandbox()
  try {
    await f.write("notes/a.md", "read this content in several small bounded chunks")
    for (const changed of ["sync", "lease", "source"] as const) {
      let syncing = false
      let lease = true
      let sourceValid = true
      const reader = createV4DesktopInitiatorLocalReader({
        rootAbsolute: f.root,
        scope,
        async assertExclusiveInitiatorLease() { if (!lease) throw new Error("lease lost") },
        async assertIdleAndNoPendingEdits() { if (syncing) throw new Error("sync active") },
        async assertSourceConfigurationUnchanged() { if (!sourceValid) throw new Error("source changed") },
        async listOpenEditorPaths() { return [] },
      })
      const file = await reader.openFile("notes/a.md")
      const iterator = file.chunks(4)[Symbol.asyncIterator]()
      assert.equal((await iterator.next()).done, false)
      if (changed === "sync") syncing = true
      else if (changed === "lease") lease = false
      else sourceValid = false
      await assert.rejects(() => iterator.next(),
        changed === "source" ? /source/i : changed === "lease" ? /lease/i : /sync/i,
        "a direct physical stream must refuse all subsequent chunks after " + changed + " loss")
      await iterator.return?.()
    }
  } finally {
    await f.cleanup()
  }
})

test("D361 Desktop rechecks live authority after async editor enumeration", async () => {
  const f = await sandbox()
  try {
    await f.write("notes/a.md", "safe physical note")
    for (const changed of ["sync", "lease", "source"] as const) {
      let syncing = false
      let lease = true
      let sourceValid = true
      let injected = false
      const reader = createV4DesktopInitiatorLocalReader({
        rootAbsolute: f.root, scope,
        async assertExclusiveInitiatorLease() { if (!lease) throw new Error("lease lost") },
        async assertIdleAndNoPendingEdits() { if (syncing) throw new Error("sync active") },
        async assertSourceConfigurationUnchanged() { if (!sourceValid) throw new Error("source changed") },
        async listOpenEditorPaths() {
          await Promise.resolve()
          if (!injected) {
            injected = true
            if (changed === "sync") syncing = true
            else if (changed === "lease") lease = false
            else sourceValid = false
          }
          return []
        },
      })
      await assert.rejects(() => reader.openFile("notes/a.md"),
        changed === "source" ? /source/i : changed === "lease" ? /lease/i : /sync/i,
        "an async editor check must not mask a revoked " + changed + " owner")
      assert.equal(injected, true)
    }
  } finally {
    await f.cleanup()
  }
})

test("D343 completed Sync revokes old Desktop parity reader without preventing fresh verification", async () => {
  const f = await sandbox()
  const coordinator = new V4SyncCoordinator({ execute: async () => ({ changedFiles: 0 }) })
  try {
    const content = utf8ToBytes("unchanged physical Desktop note")
    await f.write("notes/a.md", new TextDecoder().decode(content))
    const plugin = {
      settings: {
        githubOwner: "owner", githubRepo: "vault", githubBranch: "main",
        githubToken: "offline-only", encryptionMode: "encrypted", encryptionPassphrase: "offline-only",
        ignorePathRegex: "", syncObsidianConfig: false, syncBookmarks: false, syncPlugins: false,
      },
      manifest: { id: scope.pluginId },
      app: {
        vault: {
          configDir: ".obsidian",
          adapter: {
            getFullPath(path: string) { return join(f.root, ...path.split("/")) },
            async read() { return "" }, async write() {}, async mkdir() {}, async exists() { return false },
          },
          getFiles() { return [] },
        },
        workspace: { activeEditor: null, iterateAllLeaves(_visitor: unknown) {} },
      },
      isSyncInProgress: false,
      isSettingsSaveInProgress() { return false },
      settingsSaveGeneration: 0,
      addIgnoredFile() {}, removeIgnoredFile() {},
    }
    const runtime = new V4PluginRuntime(plugin as never)
    try {
      ;(runtime as unknown as { coordinator: V4SyncCoordinator }).coordinator = coordinator
      const oldReader = runtime.createReencryptionInitiatorLocalReader(async () => {})
      const pinned = await exactSource([{ path: "notes/a.md", bytes: content }])
      assert.equal((await verifyV4ReencryptionInitiatorLocalParity({
        ...pinned, reader: oldReader,
      })).checkedFileCount, 1)
      assert.equal((await coordinator.run({ operation: "normal", trigger: "manual" })).status, "completed")
      assert.equal(coordinator.isSyncing, false)
      assert.equal(coordinator.syncExecutionGeneration, 1)
      await assert.rejects(
        () => verifyV4ReencryptionInitiatorLocalParity({ ...pinned, reader: oldReader }),
        /Sync.*(started|changed|generation)/i,
        "Desktop must reject completed intervening Sync even when files did not change",
      )
      const freshReader = runtime.createReencryptionInitiatorLocalReader(async () => {})
      assert.equal((await verifyV4ReencryptionInitiatorLocalParity({
        ...pinned, reader: freshReader,
      })).checkedFileCount, 1)
    } finally { runtime.dispose() }
  } finally {
    coordinator.dispose()
    await f.cleanup()
  }
})

test("D342 desktop parity revokes a replaced input owner and checks in-flight hash chunks", async () => {
  const f = await sandbox()
  try {
    const data = utf8ToBytes("physical bytes for a pinned owner")
    await f.write("notes/a.md", new TextDecoder().decode(data))
    const proof = await exactSource([{ path: "notes/a.md", bytes: data }])
    for (const replaced of ["lease", "idle", "source", "editors", "root", "scope", "scope-in-place"] as const) {
      const input = { rootAbsolute: f.root, scope: { ...scope }, ...f.guard }
      const reader = createV4DesktopInitiatorLocalReader(input)
      const stable = await verifyV4ReencryptionInitiatorLocalParity({ ...proof, reader })
      assert.equal(stable.checkedFileCount, 1)
      if (replaced === "lease") input.assertExclusiveInitiatorLease = async () => {}
      else if (replaced === "idle") input.assertIdleAndNoPendingEdits = async () => {}
      else if (replaced === "source") input.assertSourceConfigurationUnchanged = async () => {}
      else if (replaced === "editors") input.listOpenEditorPaths = async () => []
      else if (replaced === "root") input.rootAbsolute = f.root + "-replaced"
      else if (replaced === "scope") input.scope = { ...scope, syncBookmarks: true }
      else input.scope.syncBookmarks = true
      await assert.rejects(() => verifyV4ReencryptionInitiatorLocalParity({ ...proof, reader }),
        /Desktop.*owner.*changed/i, "a changed " + replaced + " must revoke proof")
    }

    const input = { rootAbsolute: f.root, scope, ...f.guard }
    const reader = createV4DesktopInitiatorLocalReader(input)
    const opened = await reader.openFile("notes/a.md")
    const iterator = opened.chunks(4)[Symbol.asyncIterator]()
    assert.equal((await iterator.next()).done, false)
    input.assertExclusiveInitiatorLease = async () => {}
    await assert.rejects(async () => {
      while (!(await iterator.next()).done) {}
    }, /Desktop.*owner.*changed/i, "owner replacement between yielded chunks must abort hashing")
  } finally { await f.cleanup() }
})

test("D106 REAL local Windows/Node disk reader lists scoped files and verifies complete SHA256 without writes", async () => {
  const f = await sandbox()
  try {
    const a = utf8ToBytes("a.md: actual physical disk")
    const b = utf8ToBytes("🪄 Unicode physical file")
    await f.write("notes/a.md", new TextDecoder().decode(a))
    await f.write("notes/🪄.md", new TextDecoder().decode(b))
    await f.write(".obsidian/workspace.json", "must not be synced")
    await f.write(".obsidian/plugins/github-sync-test/settings.json", "plugin private data")
    const reader = f.reader()
    const listed = await reader.listFiles()
    assert.deepEqual(new Set(listed.map(x => x.path)), new Set(["notes/a.md", "notes/🪄.md"]))
    const verified = await verifyV4ReencryptionInitiatorLocalParity({
      ...await exactSource([{ path: "notes/a.md", bytes: a }, { path: "notes/🪄.md", bytes: b }]),
      reader,
    })
    assert.equal(verified.checkedFileCount, 2)
    assert.equal(verified.checkedPlaintextBytes, String(a.length + b.length))
    assert.equal(verified.initiatorLocalCutoverAuthorized, false)
    assert.equal((await readFile(join(f.root, "notes/a.md"), "utf8")), new TextDecoder().decode(a))
    await assert.rejects(() => reader.openFile(".obsidian/workspace.json"), /excluded/i)
  } finally { await f.cleanup() }
})

test("D106 physical inventory refuses newly added unsynced file even when Obsidian cache would not list it", async () => {
  const f = await sandbox()
  try {
    await f.write("notes/a.md", "known")
    const proof = await exactSource([{ path: "notes/a.md", bytes: utf8ToBytes("known") }])
    const reader = f.reader()
    await f.write("notes/created-outside-obsidian.md", "unsynced")
    await assert.rejects(() => verifyV4ReencryptionInitiatorLocalParity({
      ...proof, reader,
    }), /unexpected|missing|changed/i)
  } finally { await f.cleanup() }
})

test("D106 actual physical file SHA mismatch with identical size/mtime fails even if old metadata is forged", async () => {
  const f = await sandbox()
  try {
    await f.write("notes/a.md", "Hello!")
    const path = join(f.root, "notes/a.md")
    const reader = f.reader()
    const proof = await exactSource([{ path: "notes/a.md", bytes: utf8ToBytes("Hello!") }])
    const before = await reader.listFiles()
    await f.write("notes/a.md", "Jello!")
    await utimes(path, new Date(before[0]!.mtime), new Date(before[0]!.mtime))
    await assert.rejects(() => verifyV4ReencryptionInitiatorLocalParity({
      ...proof, reader,
    }), /SHA-256/i)
  } finally { await f.cleanup() }
})

test("D106 physical file modified or replaced during streaming read fails closed", async () => {
  const f = await sandbox()
  try {
    const text = "1234567890".repeat(1000)
    await f.write("notes/a.md", text)
    const original = f.reader()
    const reader = {
      ...original,
      async openFile(path: string) {
        const opened = await original.openFile(path)
        return {
          size: opened.size,
          async *chunks(bytes: number, signal?: AbortSignal) {
            let touched = false
            for await (const chunk of opened.chunks(bytes, signal)) {
              if (!touched) {
                touched = true
                await f.write("notes/a.md", "X".repeat(text.length))
              }
              yield chunk
            }
          },
        }
      },
    }
    const proof = await exactSource([{ path: "notes/a.md", bytes: utf8ToBytes(text) }])
    await assert.rejects(() => verifyV4ReencryptionInitiatorLocalParity({
      ...proof, reader,
    }), /physical file changed|SHA-256|changed during/i)
  } finally { await f.cleanup() }
})

test("D107 physical disk first-hashed note changed while later note is read is rejected on the second SHA pass", async () => {
  const f = await sandbox()
  try {
    const first = "first physical note"
    const second = "second physical note"
    await f.write("notes/first.md", first)
    await f.write("notes/second.md", second)
    const original = f.reader()
    let changedAfterFirstHash = false
    const reader = {
      ...original,
      async openFile(path: string) {
        if (path === "notes/second.md" && !changedAfterFirstHash) {
          changedAfterFirstHash = true
          // External writer changes a previously hashed note, with same size.
          await f.write("notes/first.md", "X".repeat(first.length))
        }
        return original.openFile(path)
      },
    }
    const proof = await exactSource([
      { path: "notes/first.md", bytes: utf8ToBytes(first) },
      { path: "notes/second.md", bytes: utf8ToBytes(second) },
    ])
    await assert.rejects(() => verifyV4ReencryptionInitiatorLocalParity({
      ...proof, reader,
    }), /SHA-256|changed during/i)
    assert.equal(changedAfterFirstHash, true)
  } finally { await f.cleanup() }
})

test("D106 desktop reader rejects traversal/absolute paths, unsafe root and missing guard functions", async () => {
  const f = await sandbox()
  try {
    const reader = f.reader()
    for (const path of ["../etc/passwd", "/notes/a.md", "notes\\a.md", "notes//a.md",
      "C:/windows/test", "notes/a.md ", "notes/./a.md"]) {
      await assert.rejects(() => reader.openFile(path))
    }
    assert.throws(() => createV4DesktopInitiatorLocalReader({
      rootAbsolute: f.root, scope,
      ...f.guard, assertExclusiveInitiatorLease: undefined as never,
    }), /requires all/i)
    const relative = createV4DesktopInitiatorLocalReader({
      rootAbsolute: "relative-vault", scope, ...f.guard,
    })
    await assert.rejects(() => relative.listFiles(), /canonical absolute/i)
  } finally { await f.cleanup() }
})

test("D106 desktop reader refuses file symlink, directory junction and external path redirection", async t => {
  const f = await sandbox()
  const external = await mkdtemp(join(tmpdir(), "v4-d106-external-"))
  try {
    await f.write("notes/a.md", "normal")
    await writeFile(join(external, "outside.md"), "outside")
    try {
      await symlink(join(external, "outside.md"), join(f.root, "escaped.md"), "file")
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        t.diagnostic("Windows user does not have symlink privilege; refusing junction case is only statically covered.")
        return
      }
      throw error
    }
    await assert.rejects(() => f.reader().listFiles(), /symlink|junction/i)
    await assert.rejects(() => f.reader().openFile("escaped.md"), /symbolic|junction/i)
    await rm(join(f.root, "escaped.md"))
    await symlink(external, join(f.root, "mounted"), process.platform === "win32" ? "junction" : "dir")
    await assert.rejects(() => f.reader().listFiles(), /symlink|junction/i)
    await assert.rejects(() => f.reader().openFile("mounted/outside.md"), /symlink|junction/i)
  } finally {
    await f.cleanup()
    await rm(external, { recursive: true, force: true })
  }
})


test("D106 installed-runtime adapter binds real physical files, live scope, connection and editor guards without changing settings", async () => {
  const f = await sandbox()
  try {
    await f.write("notes/a.md", "known physical bytes")
    await f.write(".obsidian/workspace.json", "excluded")
    const mutableSettings = {
      githubOwner: "sample", githubRepo: "repo", githubBranch: "main",
      githubToken: "local-test-token", githubTokenSecretId: "id1",
      encryptionMode: "encrypted", encryptionPassphrase: "old-test-key",
      encryptionPassphraseSecretId: "id2", vault: "device-test",
      ignorePathRegex: "", syncObsidianConfig: false, syncBookmarks: false, syncPlugins: false,
    }
    let openEditor: string | null = null
    let unboundMarkdownEditor = false
    let unboundActiveEditor = false
    const workspace = {
      get activeEditor() {
        return unboundActiveEditor ? { file: null }
          : openEditor ? { file: { path: openEditor } } : null
      },
      iterateAllLeaves(visitor: (leaf: { view: { file?: { path: string }; getViewType?: () => string } }) => void) {
        visitor({ view: unboundMarkdownEditor
          ? { getViewType: () => "markdown" }
          : openEditor ? { file: { path: openEditor } } : {} })
      },
    }
    const plugin = {
      settings: mutableSettings,
      manifest: { id: scope.pluginId },
      app: { workspace, vault: {
        configDir: ".obsidian",
        adapter: {
          getFullPath(logical: string) { return join(f.root, ...logical.split("/")) },
          async read() { return "" }, async write() {}, async mkdir() {}, async exists() { return false },
        },
        getFiles() { return [] }, // Intentionally stale Obsidian metadata cache.
      } },
      isSyncInProgress: false,
      isSettingsSaveInProgress() { return false },
      settingsSaveGeneration: 0,
      addIgnoredFile() {}, removeIgnoredFile() {},
    }
    const runtime = new V4PluginRuntime(plugin as never)
    try {
      let leaseOwned = true
      const reader = runtime.createReencryptionInitiatorLocalReader(async () => {
        if (!leaseOwned) throw new Error("exclusive migration WAL lease lost")
      })
      const proof = await exactSource([{ path: "notes/a.md", bytes: utf8ToBytes("known physical bytes") }])
      const verified = await verifyV4ReencryptionInitiatorLocalParity({ ...proof, reader })
      assert.equal(verified.checkedFileCount, 1)
      assert.equal(verified.initiatorLocalCutoverAuthorized, false)

      openEditor = "notes/a.md"
      await assert.rejects(() => verifyV4ReencryptionInitiatorLocalParity({ ...proof, reader }), /editor/i)
      openEditor = "draft/unsaved-new.md"
      await assert.rejects(() => verifyV4ReencryptionInitiatorLocalParity({ ...proof, reader }), /editor/i,
        "a new editor outside the authenticated source inventory must still block migration parity")
      openEditor = null
      unboundMarkdownEditor = true
      await assert.rejects(() => verifyV4ReencryptionInitiatorLocalParity({ ...proof, reader }), /editor|markdown|unbound/i,
        "a Markdown editor with no saved file path cannot be treated as no editor")
      unboundMarkdownEditor = false
      unboundActiveEditor = true
      await assert.rejects(() => verifyV4ReencryptionInitiatorLocalParity({ ...proof, reader }), /editor|unsaved/i,
        "an active editor without a bound file must fail closed")
      unboundActiveEditor = false

      mutableSettings.githubBranch = "different"
      await assert.rejects(() => verifyV4ReencryptionInitiatorLocalParity({ ...proof, reader }), /connection|scope/i)
      mutableSettings.githubBranch = "main"

      const originalVault = plugin.app.vault
      plugin.app.vault = { ...originalVault }
      await assert.rejects(
        () => verifyV4ReencryptionInitiatorLocalParity({ ...proof, reader }),
        /Vault|connection|scope|identity/i,
        "desktop physical reader cannot certify a replaced Obsidian Vault with the same adapter",
      )
      plugin.app.vault = originalVault
      plugin.isSyncInProgress = true
      await assert.rejects(
        () => verifyV4ReencryptionInitiatorLocalParity({ ...proof, reader }),
        /Sync|idle|mutation/i,
        "plugin-level Sync must block desktop parity before the coordinator reports it",
      )
      plugin.isSyncInProgress = false
      plugin.isSettingsSaveInProgress = () => true
      await assert.rejects(
        () => verifyV4ReencryptionInitiatorLocalParity({ ...proof, reader }),
        /Settings|idle|mutation/i,
        "in-progress plugin Settings save must block desktop parity",
      )
      plugin.isSettingsSaveInProgress = () => false
      plugin.settingsSaveGeneration++
      await assert.rejects(
        () => verifyV4ReencryptionInitiatorLocalParity({ ...proof, reader }),
        /Settings|connection|scope|identity/i,
        "a completed Settings save must invalidate stale Desktop parity with unchanged Settings values",
      )

      leaseOwned = false
      await assert.rejects(() => verifyV4ReencryptionInitiatorLocalParity({ ...proof, reader }), /lease lost/i)
    } finally { runtime.dispose() }
  } finally { await f.cleanup() }
})

test("D106 rejects hardlinked physical vault files that may alias content outside the vault", async t => {
  const f = await sandbox()
  const external = await mkdtemp(join(tmpdir(), "v4-d106-outside-hardlink-"))
  try {
    await writeFile(join(external, "original.md"), "sensitive external data")
    try {
      await link(join(external, "original.md"), join(f.root, "hardlink.md"))
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP", "EXDEV"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        t.diagnostic("Hardlink creation is unavailable on this Windows volume/user.")
        return
      }
      throw error
    }
    await assert.rejects(() => f.reader().listFiles(), /hardlinked/i)
    await assert.rejects(() => f.reader().openFile("hardlink.md"), /hardlinked/i)
  } finally {
    await f.cleanup()
    await rm(external, { recursive: true, force: true })
  }
})

test("D106 runtime rejects missing Obsidian editor enumeration and prevents silent acceptance", async () => {
  const f = await sandbox()
  try {
    await f.write("notes/a.md", "known")
    const settings = {
      githubOwner: "sample", githubRepo: "repo", githubBranch: "main",
      githubToken: "token", encryptionMode: "encrypted", encryptionPassphrase: "old",
      ignorePathRegex: "", syncObsidianConfig: false, syncBookmarks: false, syncPlugins: false,
    }
    const plugin = {
      settings, manifest: { id: scope.pluginId },
      app: { workspace: {}, vault: {
        configDir: ".obsidian",
        adapter: { getFullPath(logical: string) { return join(f.root, logical) },
          async read() { return "" }, async write() {}, async mkdir() {}, async exists() { return false } },
        getFiles() { return [] },
      } }, addIgnoredFile() {}, removeIgnoredFile() {},
    }
    const runtime = new V4PluginRuntime(plugin as never)
    try {
      const reader = runtime.createReencryptionInitiatorLocalReader(async () => {})
      const proof = await exactSource([{ path: "notes/a.md", bytes: utf8ToBytes("known") }])
      await assert.rejects(() => verifyV4ReencryptionInitiatorLocalParity({
        ...proof, reader,
      }), /editors are closed/i)
    } finally { runtime.dispose() }
  } finally { await f.cleanup() }
})

test("D106 read-only local parity fails if runtime editor or Sync/edit/lease guards refuse it", async () => {
  const f = await sandbox()
  try {
    await f.write("notes/a.md", "known")
    const proof = await exactSource([{ path: "notes/a.md", bytes: utf8ToBytes("known") }])
    for (const option of [
      { listOpenEditorPaths: async () => ["notes/a.md"] },
      { assertIdleAndNoPendingEdits: async () => { throw new Error("Sync active") } },
      { assertExclusiveInitiatorLease: async () => { throw new Error("lease lost") } },
      { assertSourceConfigurationUnchanged: async () => { throw new Error("scope changed") } },
    ]) {
      const reader = createV4DesktopInitiatorLocalReader({
        rootAbsolute: f.root, scope, ...f.guard, ...option,
      })
      await assert.rejects(() => verifyV4ReencryptionInitiatorLocalParity({ ...proof, reader }))
    }
  } finally { await f.cleanup() }
})
