import assert from "node:assert/strict"
import test from "node:test"
import { link, mkdtemp, mkdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sha256Hex, utf8ToBytes } from "../../src/lib/bytes"
import { createV4DesktopInitiatorLocalReader } from "../../src/lib/v4/reencryption-desktop-initiator-reader"
import { verifyV4ReencryptionInitiatorLocalParity } from "../../src/lib/v4/reencryption-initiator-parity"
import { V4PluginRuntime } from "../../src/lib/v4/runtime"
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
    const workspace = {
      get activeEditor() { return openEditor ? { file: { path: openEditor } } : null },
      iterateAllLeaves(visitor: (leaf: { view: { file?: { path: string } } }) => void) {
        visitor({ view: openEditor ? { file: { path: openEditor } } : {} })
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
      openEditor = null

      mutableSettings.githubBranch = "different"
      await assert.rejects(() => verifyV4ReencryptionInitiatorLocalParity({ ...proof, reader }), /connection|scope/i)
      mutableSettings.githubBranch = "main"

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
