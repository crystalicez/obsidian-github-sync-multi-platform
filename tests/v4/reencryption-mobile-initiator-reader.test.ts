import assert from "node:assert/strict"
import test from "node:test"
import { Platform } from "obsidian"
import { sha256Hex, utf8ToBytes } from "../../src/lib/bytes"
import type { V4IndexFileRecord } from "../../src/lib/v4/local-index"
import { verifyV4ReencryptionInitiatorLocalParity } from "../../src/lib/v4/reencryption-initiator-parity"
import { createV4MobileInitiatorLocalReader } from "../../src/lib/v4/reencryption-mobile-initiator-reader"
import { V4PluginRuntime } from "../../src/lib/v4/runtime"
import type { V4ScopeSettings } from "../../src/lib/v4/scope"

const sha = "a".repeat(40)
const scope: V4ScopeSettings = {
  configDir: ".obsidian", pluginId: "mobile-rekey-test", ignorePathRegex: "",
  syncObsidianConfig: false, syncBookmarks: false, syncPlugins: false,
}
const bytes = (text: string) => utf8ToBytes(text)

class MobileAdapter {
  readonly files = new Map<string, { data: Uint8Array; mtime: number }>()
  reads = 0
  writes = 0
  onRead?: (path: string) => void
  onList?: (path: string) => void

  set(path: string, data: Uint8Array, mtime = 40) {
    this.files.set(path, { data, mtime })
  }
  async list(dir: string) {
    this.onList?.(dir)
    const prefix = dir === "/" || !dir ? "" : dir + "/"
    const files = new Set<string>()
    const folders = new Set<string>()
    for (const path of this.files.keys()) {
      if (!path.startsWith(prefix)) continue
      const tail = path.slice(prefix.length)
      if (tail.includes("/")) folders.add(prefix + tail.split("/")[0])
      else files.add(path)
    }
    return { files: [...files], folders: [...folders] }
  }
  async stat(path: string) {
    const file = this.files.get(path)
    if (file) return { type: "file" as const, size: file.data.byteLength, mtime: file.mtime }
    if ([...this.files.keys()].some(p => p.startsWith(path + "/"))) {
      return { type: "folder" as const, size: 0, mtime: 1 }
    }
    return null
  }
  async readBinary(path: string): Promise<ArrayBuffer> {
    this.reads++
    this.onRead?.(path)
    const data = this.files.get(path)?.data
    if (!data) throw new Error("Mobile file not found")
    return data.slice().buffer as ArrayBuffer
  }
  async writeBinary() { this.writes++ }
}

function guards() {
  let opened: string[] = []
  let lease = true
  let active = false
  let scopeValid = true
  return {
    async assertExclusiveInitiatorLease() { if (!lease) throw Error("lease lost") },
    async assertIdleAndNoPendingEdits() { if (active) throw Error("sync not idle") },
    async assertSourceConfigurationUnchanged() { if (!scopeValid) throw Error("scope changed") },
    async listOpenEditorPaths() { return opened },
    setOpen(paths: string[]) { opened = paths },
    setLease(value: boolean) { lease = value },
    setActive(value: boolean) { active = value },
    setScopeValid(value: boolean) { scopeValid = value },
  }
}

async function source(known: ReadonlyArray<{ path: string; data: Uint8Array }>) {
  const sourceRecords: V4IndexFileRecord[] = []
  for (const [index, f] of known.entries()) {
    sourceRecords.push({
      path: f.path, pathId: "b".repeat(64), fileId: String(index),
      plaintextSha256: await sha256Hex(f.data), size: f.data.byteLength, mtime: 20,
      remoteVersion: "v1", remotePath: "opaque/" + index, storage: "single",
    })
  }
  return {
    pinnedSourceCommitSha: sha, sourceRecords,
    verifiedSource: {
      integrityScope: "all-live-objects" as const, pinnedSourceCommitSha: sha,
      verifiedFileCount: sourceRecords.length, verifiedRemoteObjectCount: sourceRecords.length,
      totalVerifiedPlaintextBytes: sourceRecords.reduce((n, r) => n + BigInt(r.size), 0n).toString(),
    },
  }
}

test("D214 Mobile adapter enumerates actual scoped Vault paths and proves double-pass SHA-256 without writing", async () => {
  const adapter = new MobileAdapter()
  const a = bytes("🪄 unicode mobile note")
  const b = bytes("same content but another note")
  adapter.set("notes/🪄.md", a)
  adapter.set("notes/a.md", b)
  adapter.set(".obsidian/workspace-mobile.json", bytes("excluded"))
  adapter.set(".obsidian/plugins/mobile-rekey-test/config.json", bytes("private"))
  const pathsListed: string[] = []
  adapter.onList = path => pathsListed.push(path)
  const reader = createV4MobileInitiatorLocalReader({ adapter, scope, ...guards() })
  assert.deepEqual(new Set((await reader.listFiles()).map(f => f.path)), new Set(["notes/a.md", "notes/🪄.md"]))
  assert.equal(pathsListed[0], "/", "Obsidian DataAdapter root listing must use /")
  const verified = await verifyV4ReencryptionInitiatorLocalParity({
    ...await source([{ path: "notes/a.md", data: b }, { path: "notes/🪄.md", data: a }]),
    reader,
  })
  assert.equal(verified.checkedFileCount, 2)
  assert.equal(verified.allFilesContentVerified, true)
  assert.equal(verified.initiatorLocalCutoverAuthorized, false)
  assert.equal(adapter.reads, 4, "two separate complete hash passes")
  assert.equal(adapter.writes, 0)
  await assert.rejects(() => reader.openFile(".obsidian/workspace-mobile.json"), /excluded/i)
})

test("D214 Mobile detects an externally created file absent from cached Obsidian getFiles()", async () => {
  const adapter = new MobileAdapter()
  adapter.set("a.md", bytes("known"))
  const reader = createV4MobileInitiatorLocalReader({ adapter, scope, ...guards() })
  const proof = await source([{ path: "a.md", data: bytes("known") }])
  adapter.set("new-outside-obsidian.md", bytes("unsynced"))
  await assert.rejects(() => verifyV4ReencryptionInitiatorLocalParity({ ...proof, reader }), /unexpected|missing/i)
  assert.equal(adapter.writes, 0)
})

test("D214 Mobile rejects same-size same-mtime edits, active editors, lost leases and changed scope", async () => {
  const adapter = new MobileAdapter()
  adapter.set("a.md", bytes("correct"), 100)
  const proof = await source([{ path: "a.md", data: bytes("correct") }])
  const g = guards()
  const reader = createV4MobileInitiatorLocalReader({ adapter, scope, ...g })
  adapter.set("a.md", bytes("changed"), 100)
  await assert.rejects(() => verifyV4ReencryptionInitiatorLocalParity({ ...proof, reader }), /SHA-256/i)
  adapter.set("a.md", bytes("correct"), 100)
  g.setOpen(["untitled.md"])
  await assert.rejects(() => verifyV4ReencryptionInitiatorLocalParity({ ...proof, reader }), /editor/i)
  g.setOpen([])
  g.setActive(true)
  await assert.rejects(() => verifyV4ReencryptionInitiatorLocalParity({ ...proof, reader }), /sync/i)
  g.setActive(false)
  g.setLease(false)
  await assert.rejects(() => verifyV4ReencryptionInitiatorLocalParity({ ...proof, reader }), /lease/i)
  g.setLease(true)
  g.setScopeValid(false)
  await assert.rejects(() => verifyV4ReencryptionInitiatorLocalParity({ ...proof, reader }), /scope/i)
  assert.equal(adapter.writes, 0)
})

test("D214 Mobile refuses metadata drift during read and after chunk consumption", async () => {
  const adapter = new MobileAdapter()
  adapter.set("a.md", bytes("original"), 30)
  const reader = createV4MobileInitiatorLocalReader({ adapter, scope, ...guards() })
  adapter.onRead = () => adapter.set("a.md", bytes("modified"), 31)
  await assert.rejects(async () => {
    const handle = await reader.openFile("a.md")
    for await (const _chunk of handle.chunks(8)) {}
  }, /changed during read/i)
  adapter.onRead = undefined
  adapter.set("a.md", bytes("original"), 30)
  const handle = await reader.openFile("a.md")
  const iterator = handle.chunks(8)[Symbol.asyncIterator]()
  assert.equal((await iterator.next()).done, false)
  adapter.set("a.md", bytes("modified"), 31)
  await assert.rejects(async () => { await iterator.next() }, /changed during hashing/i)
})

test("D214 Mobile rejects unsafe, duplicated, out-of-parent and incomplete adapter listings", async () => {
  for (const listing of [
    { files: ["../outside.md"], folders: [] },
    { files: ["AUX.md"], folders: [] },
    { files: ["a.md", "A.md"], folders: [] },
    { files: ["elsewhere/a.md"], folders: [] },
    { files: ["Notes/bad?.md"], folders: [] },
    { files: ["a.md"], folders: ["a.md"] },
    { files: "no-list", folders: [] },
  ]) {
    const adapter = new MobileAdapter()
    adapter.list = async () => listing as never
    const reader = createV4MobileInitiatorLocalReader({ adapter, scope, ...guards() })
    await assert.rejects(() => reader.listFiles())
  }
  const adapter = new MobileAdapter()
  adapter.set("a.md", bytes("ok"))
  const reader = createV4MobileInitiatorLocalReader({ adapter, scope, ...guards() })
  for (const path of ["../outside.md", "AUX.md", "notes//a.md", "notes\\a.md", "/absolute.md"]) {
    await assert.rejects(() => reader.openFile(path))
  }
  const wrongFolder = new MobileAdapter()
  wrongFolder.set("notes/a.md", bytes("note"))
  const originalStat = wrongFolder.stat.bind(wrongFolder)
  wrongFolder.stat = async path => path === "notes"
    ? { type: "file" as const, size: 0, mtime: 1 } : originalStat(path)
  await assert.rejects(
    () => createV4MobileInitiatorLocalReader({ adapter: wrongFolder, scope, ...guards() }).listFiles(),
    /invalid file or directory metadata/i,
  )
  assert.throws(() => createV4MobileInitiatorLocalReader({
    adapter: { list: adapter.list.bind(adapter), stat: adapter.stat.bind(adapter), readBinary: undefined as never },
    scope, ...guards(),
  }), /list\/stat\/readBinary/i)
})

test("D214 Mobile refuses an oversized file before allocating its whole content buffer", async () => {
  const adapter = new MobileAdapter()
  adapter.set("large.md", bytes("small"))
  adapter.stat = async () => ({ type: "file", size: 32 * 1024 * 1024 + 1, mtime: 10 })
  const reader = createV4MobileInitiatorLocalReader({ adapter, scope, ...guards() })
  await assert.rejects(() => reader.listFiles(), /whole-read limit/i)
  await assert.rejects(() => reader.openFile("large.md"), /whole-read limit/i)
  assert.equal(adapter.reads, 0)
})

test("D214 installed Mobile Runtime selects adapter-list reader instead of stale Obsidian getFiles()", async () => {
  const originalPlatform = Platform.isDesktopApp
  Platform.isDesktopApp = false
  const adapter = new MobileAdapter()
  adapter.set("notes/a.md", bytes("mobile source"))
  const plugin = {
    settings: {
      githubOwner: "o", githubRepo: "r", githubBranch: "main",
      githubToken: "token", encryptionMode: "encrypted", encryptionPassphrase: "pass",
      ignorePathRegex: "", syncObsidianConfig: false, syncBookmarks: false, syncPlugins: false,
    },
    manifest: { id: scope.pluginId },
    app: { vault: {
      configDir: ".obsidian", adapter,
      getFiles() { return [] },
    }, workspace: { activeEditor: null, iterateAllLeaves(_visitor: unknown) {} } },
    addIgnoredFile() {}, removeIgnoredFile() {},
  }
  try {
    const runtime = new V4PluginRuntime(plugin as never)
    try {
      const reader = runtime.createReencryptionInitiatorLocalReader(async () => {})
      const proof = await source([{ path: "notes/a.md", data: bytes("mobile source") }])
      const result = await verifyV4ReencryptionInitiatorLocalParity({ ...proof, reader })
      assert.equal(result.checkedFileCount, 1)
      assert.equal(result.initiatorLocalCutoverAuthorized, false)
      assert.equal(adapter.writes, 0)
      adapter.set("new-unindexed.md", bytes("external"))
      await assert.rejects(
        () => verifyV4ReencryptionInitiatorLocalParity({ ...proof, reader }),
        /unexpected|missing/i,
      )
      plugin.app.vault.adapter = new MobileAdapter()
      await assert.rejects(
        () => verifyV4ReencryptionInitiatorLocalParity({ ...proof, reader }),
        /connection|scope/i,
        "changing the Mobile DataAdapter must invalidate the captured Vault identity",
      )
    } finally { runtime.dispose() }
  } finally { Platform.isDesktopApp = originalPlatform }
})
