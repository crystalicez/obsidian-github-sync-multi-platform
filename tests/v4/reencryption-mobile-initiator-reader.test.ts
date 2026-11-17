import assert from "node:assert/strict"
import test from "node:test"
import { Platform } from "obsidian"
import { sha256Hex, utf8ToBytes } from "../../src/lib/bytes"
import type { V4IndexFileRecord } from "../../src/lib/v4/local-index"
import { verifyV4ReencryptionInitiatorLocalParity } from "../../src/lib/v4/reencryption-initiator-parity"
import { createV4MobileInitiatorLocalReader, inspectV4MobileReencryptionFileSizePreflight } from "../../src/lib/v4/reencryption-mobile-initiator-reader"
import { V4PluginRuntime } from "../../src/lib/v4/runtime"
import { V4SyncCoordinator } from "../../src/lib/v4/sync-coordinator"
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

test("D363 capability scan allows the exact 32 MiB boundary, ignores excluded oversized files, and never allocates content", async () => {
  const adapter = new MobileAdapter()
  adapter.set("exact.md", bytes("virtual metadata"))
  adapter.set("private/hidden.bin", bytes("excluded metadata"))
  const originalStat = adapter.stat.bind(adapter)
  adapter.stat = async path => {
    const value = await originalStat(path)
    return value && value.type === "file"
      ? { ...value, size: path === "exact.md" ? 32 * 1024 * 1024 : 32 * 1024 * 1024 + 1 }
      : value
  }
  let guards = 0
  const report = await inspectV4MobileReencryptionFileSizePreflight({
    adapter, scope: { ...scope, ignorePathRegex: "^private/" },
    assertPreviewStable: async () => { guards++ },
  })
  assert.equal(report.checkedFileCount, 1)
  assert.ok(guards > 1, "scan checks authority at asynchronous metadata boundaries")
  assert.equal(adapter.reads, 0)
  assert.equal(adapter.writes, 0)
})

test("D363 capability scan rejects a changed metadata owner after awaited listing", async () => {
  const adapter = new MobileAdapter()
  adapter.set("valid.md", bytes("metadata"))
  const originalList = adapter.list.bind(adapter)
  adapter.list = async path => {
    const result = await originalList(path)
    adapter.stat = async () => ({ type: "file" as const, size: 0, mtime: 1 })
    return result
  }
  await assert.rejects(() => inspectV4MobileReencryptionFileSizePreflight({
    adapter, scope, assertPreviewStable: async () => {},
  }), /adapter.*changed/i)
  assert.equal(adapter.reads, 0)
  assert.equal(adapter.writes, 0)
})

test("D364 Mobile remote-only >32 MiB authenticated Source refuses Preview even when local Vault is empty", async () => {
  const adapter = new MobileAdapter()
  await assert.rejects(() => inspectV4MobileReencryptionFileSizePreflight({
    adapter, scope,
    expectedSourceFiles: [{ path: "remote-only.bin", size: 32 * 1024 * 1024 + 1 }],
    assertPreviewStable: async () => {},
  }), /32 MiB.*Desktop/i)
  assert.equal(adapter.reads, 0, "remote-only oversized file must be blocked without any local binary read")
  assert.equal(adapter.writes, 0)
})

test("D364 Mobile authenticated Source inventory must match physical included files by exact path and size", async () => {
  const adapter = new MobileAdapter()
  adapter.set("a.md", bytes("a"))
  adapter.set("private/ignored.bin", bytes("excluded"))
  const selectedScope = { ...scope, ignorePathRegex: "^private/" }
  const check = (expectedSourceFiles: readonly { path: string; size: number }[]) =>
    inspectV4MobileReencryptionFileSizePreflight({
      adapter, scope: selectedScope, expectedSourceFiles,
      assertPreviewStable: async () => {},
    })
  assert.equal((await check([{ path: "a.md", size: 1 }])).checkedFileCount, 1,
    "matching included Source inventory passes despite unrelated excluded file")
  for (const inventory of [
    [{ path: "a.md", size: 2 }],
    [{ path: "other.md", size: 1 }],
    [],
    [{ path: "a.md", size: 1 }, { path: "missing.md", size: 1 }],
    [{ path: "a.md", size: 1 }, { path: "private/ignored.bin", size: 8 }],
  ]) {
    await assert.rejects(check(inventory), /authenticated.*Source|Source.*inventory|Source.*physical/i)
  }
  assert.equal(adapter.reads, 0)
  assert.equal(adapter.writes, 0)
})

test("D364 Mobile remote Source inventory changes during awaited list fail closed", async () => {
  const adapter = new MobileAdapter()
  adapter.set("a.md", bytes("a"))
  const expectedSourceFiles = [{ path: "a.md", size: 1 }]
  const original = adapter.list.bind(adapter)
  let changed = false
  adapter.list = async path => {
    const listed = await original(path)
    if (!changed) { changed = true; expectedSourceFiles[0]!.size = 2 }
    return listed
  }
  await assert.rejects(() => inspectV4MobileReencryptionFileSizePreflight({
    adapter, scope, expectedSourceFiles, assertPreviewStable: async () => {},
  }), /authenticated.*Source|Source.*changed|Source.*inventory/i)
  assert.equal(changed, true)
  assert.equal(adapter.reads, 0)
  assert.equal(adapter.writes, 0)
})

test("D359 Mobile rechecks Sync, lease and Source scope after async editor enumeration before a whole-file read", async () => {
  for (const changed of ["sync", "lease", "scope"] as const) {
    const adapter = new MobileAdapter()
    adapter.set("a.md", bytes("immutable content"), 41)
    const originalStat = adapter.stat.bind(adapter)
    let stats = 0
    adapter.stat = async path => { stats++; return originalStat(path) }
    const g = guards()
    let injectOnEditor = false
    let injected = false
    const input = {
      adapter, scope,
      assertExclusiveInitiatorLease: g.assertExclusiveInitiatorLease,
      assertIdleAndNoPendingEdits: g.assertIdleAndNoPendingEdits,
      assertSourceConfigurationUnchanged: g.assertSourceConfigurationUnchanged,
      async listOpenEditorPaths() {
        await Promise.resolve()
        if (injectOnEditor && !injected) {
          injected = true
          if (changed === "sync") g.setActive(true)
          else if (changed === "lease") g.setLease(false)
          else g.setScopeValid(false)
        }
        return []
      },
    }
    const reader = createV4MobileInitiatorLocalReader(input)
    const file = await reader.openFile("a.md")
    const statBefore = stats
    injectOnEditor = true
    await assert.rejects(async () => {
      for await (const _chunk of file.chunks(8)) {}
    }, changed === "sync" ? /sync/i : changed === "lease" ? /lease/i : /scope/i,
    "a completed editor enumeration must not mask a lost " + changed + " guard")
    assert.equal(injected, true, "exercise state change during awaited editor check")
    assert.equal(stats, statBefore,
      "reject before any post-editor physical stat after the owner changed")
    assert.equal(adapter.reads, 0, "never allocate Mobile readBinary after lost " + changed + " authority")
    assert.equal(adapter.writes, 0)
  }
})

test("D359 Mobile refuses a whole-file allocation when an awaited stat loses Sync, lease or Source authority", async () => {
  for (const changed of ["sync", "lease", "scope"] as const) {
    const adapter = new MobileAdapter()
    adapter.set("a.md", bytes("fixed content"), 31)
    const g = guards()
    const originalStat = adapter.stat.bind(adapter)
    let injectDuringStat = false
    let injected = false
    adapter.stat = async path => {
      const observed = await originalStat(path)
      if (injectDuringStat && !injected) {
        injected = true
        if (changed === "sync") g.setActive(true)
        else if (changed === "lease") g.setLease(false)
        else g.setScopeValid(false)
      }
      return observed
    }
    const reader = createV4MobileInitiatorLocalReader({ adapter, scope, ...g })
    const file = await reader.openFile("a.md")
    injectDuringStat = true
    await assert.rejects(async () => {
      for await (const _chunk of file.chunks(8)) {}
    }, changed === "sync" ? /sync/i : changed === "lease" ? /lease/i : /scope/i)
    assert.equal(injected, true, "exercise authority loss during the in-flight stat")
    assert.equal(adapter.reads, 0, "cannot begin Mobile whole-buffer readBinary after stale " + changed + " stat")
    assert.equal(adapter.writes, 0)
  }
})

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

test("D393 Mobile stops yielding buffered chunks as soon as live initiation authority is lost", async () => {
  for (const changed of ["lease", "sync", "scope", "editor", "adapter"] as const) {
    const adapter = new MobileAdapter()
    adapter.set("a.md", bytes("multiple bounded mobile chunks"), 44)
    const g = guards()
    const input = { adapter, scope, ...g }
    const reader = createV4MobileInitiatorLocalReader(input)
    const file = await reader.openFile("a.md")
    const iterator = file.chunks(4)[Symbol.asyncIterator]()
    const first = await iterator.next()
    assert.equal(first.done, false)
    assert.equal(first.value?.byteLength, 4)
    assert.equal(adapter.reads, 1)

    if (changed === "lease") g.setLease(false)
    else if (changed === "sync") g.setActive(true)
    else if (changed === "scope") g.setScopeValid(false)
    else if (changed === "editor") g.setOpen(["a.md"])
    else input.assertExclusiveInitiatorLease = async () => {}

    const expected = changed === "lease" ? /lease/i
      : changed === "sync" ? /sync/i
        : changed === "scope" ? /scope/i
          : changed === "editor" ? /editor/i
            : /Adapter or live guard changed/i
    await assert.rejects(iterator.next(), expected,
      "Mobile must not yield a second buffered chunk after " + changed + " authority loss")
    assert.equal(adapter.reads, 1, "do not allocate another whole-file read")
    assert.equal(adapter.writes, 0)
    await iterator.return?.()
  }
})

test("D393 Mobile exact 32 MiB file streams all four bounded chunks under a live lease", async () => {
  const size = 32 * 1024 * 1024
  const data = new Uint8Array(size)
  data[0] = 17
  data[size - 1] = 42
  const adapter = new MobileAdapter()
  adapter.set("full-boundary.bin", data, 45)
  const g = guards()
  const reader = createV4MobileInitiatorLocalReader({ adapter, scope, ...g })
  const file = await reader.openFile("full-boundary.bin")
  assert.equal(file.size, size)
  let chunkCount = 0
  for await (const chunk of file.chunks(8 * 1024 * 1024)) {
    assert.equal(chunk.byteLength, 8 * 1024 * 1024)
    if (chunkCount === 0) assert.equal(chunk[0], 17)
    if (chunkCount === 3) assert.equal(chunk[chunk.byteLength - 1], 42)
    chunkCount++
  }
  assert.equal(chunkCount, 4)
  assert.equal(adapter.reads, 1, "bounded iteration must not reallocate the full 32 MiB file")
  assert.equal(adapter.writes, 0)
})

test("D215 reused mutable Mobile stat object cannot conceal an on-read mtime change", async () => {
  const adapter = new MobileAdapter()
  adapter.set("a.md", bytes("original"), 21)
  const shared = { type: "file" as const, size: 8, mtime: 21 }
  adapter.stat = async () => shared
  const reader = createV4MobileInitiatorLocalReader({ adapter, scope, ...guards() })
  adapter.onRead = () => { shared.mtime = 22 }
  await assert.rejects(async () => {
    const file = await reader.openFile("a.md")
    for await (const _chunk of file.chunks(8)) {}
  }, /changed during read/i, "metadata returned earlier must not be mutated retroactively")
  assert.equal(adapter.writes, 0)
})

test("D215 mutable Mobile stat cannot redefine a bounded openFile size during readBinary", async () => {
  const adapter = new MobileAdapter()
  adapter.set("a.md", bytes("original"), 21)
  const shared = { type: "file" as const, size: 8, mtime: 21 }
  adapter.stat = async () => shared
  const reader = createV4MobileInitiatorLocalReader({ adapter, scope, ...guards() })
  adapter.onRead = () => {
    shared.size = 9
    adapter.set("a.md", bytes("different"), 21)
  }
  const file = await reader.openFile("a.md")
  assert.equal(file.size, 8)
  await assert.rejects(async () => {
    for await (const _chunk of file.chunks(8)) {}
  }, /changed|invalid bytes/i, "readBinary cannot silently return more bytes than the original declared size")
  assert.equal(adapter.writes, 0)
})

test("D335 Mobile parity refuses Adapter method replacement during a pending read", async () => {
  for (const replaced of ["list", "stat", "readBinary", "lease", "adapter"] as const) {
    const adapter = new MobileAdapter()
    const content = bytes("unchanged mobile note")
    adapter.set("a.md", content)
    const proof = await source([{ path: "a.md", data: content }])
    const originalList = adapter.list
    const originalStat = adapter.stat
    const originalReadBinary = adapter.readBinary
    const input = { adapter, scope, ...guards() }
    let replacedDuringRead = false
    const replaceOnce = () => {
      if (replacedDuringRead) return
      replacedDuringRead = true
      if (replaced === "list") {
        adapter.list = async dir => originalList.call(adapter, dir)
      } else if (replaced === "stat") {
        adapter.stat = async path => originalStat.call(adapter, path)
      } else if (replaced === "readBinary") {
        adapter.readBinary = async path => originalReadBinary.call(adapter, path)
      } else if (replaced === "lease") {
        input.assertExclusiveInitiatorLease = async () => {}
      } else {
        input.adapter = new MobileAdapter()
      }
    }
    if (replaced === "list") adapter.onList = replaceOnce
    else adapter.onRead = replaceOnce
    const reader = createV4MobileInitiatorLocalReader(input)
    await assert.rejects(async () => {
      await verifyV4ReencryptionInitiatorLocalParity({ ...proof, reader })
    }, /Mobile.*Adapter.*changed/i,
    "a replaced " + replaced + " method must revoke the in-flight local parity proof")
    assert.equal(replacedDuringRead, true)
    assert.equal(adapter.writes, 0)

    adapter.onList = undefined
    adapter.onRead = undefined
    const reopened = createV4MobileInitiatorLocalReader({ adapter, scope, ...guards() })
    const result = await verifyV4ReencryptionInitiatorLocalParity({ ...proof, reader: reopened })
    assert.equal(result.allFilesContentVerified, true,
      "the current stable Adapter can be explicitly revalidated")
  }
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

test("D343 completed Sync revokes a previously opened Mobile initiating-vault parity reader", async () => {
  const priorDesktop = Platform.isDesktopApp
  Platform.isDesktopApp = false
  const adapter = new MobileAdapter()
  const content = bytes("unchanged local note after completed Sync")
  adapter.set("notes/a.md", content)
  const plugin = {
    settings: {
      githubOwner: "owner", githubRepo: "vault", githubBranch: "main",
      githubToken: "offline-only", encryptionMode: "encrypted", encryptionPassphrase: "offline-only",
      ignorePathRegex: "", syncObsidianConfig: false, syncBookmarks: false, syncPlugins: false,
    },
    manifest: { id: scope.pluginId },
    app: {
      vault: { configDir: ".obsidian", adapter, getFiles() { return [] } },
      workspace: { activeEditor: null, iterateAllLeaves(_visitor: unknown) {} },
    },
    isSyncInProgress: false,
    isSettingsSaveInProgress() { return false },
    settingsSaveGeneration: 0,
    addIgnoredFile() {}, removeIgnoredFile() {},
  }
  let finishSecond!: () => void
  const holdSecond = new Promise<void>(resolve => { finishSecond = resolve })
  let runs = 0
  const coordinator = new V4SyncCoordinator({
    execute: async () => {
      if (++runs === 2) await holdSecond
      return { changedFiles: 0 }
    },
  })
  try {
    const runtime = new V4PluginRuntime(plugin as never)
    try {
      // The simulated coordinator executes no remote or Vault operations, but
      // uses the same synchronous generation transition as production Sync.
      ;(runtime as unknown as { coordinator: V4SyncCoordinator }).coordinator = coordinator
      const reader = runtime.createReencryptionInitiatorLocalReader(async () => {})
      const pinned = await source([{ path: "notes/a.md", data: content }])
      const verified = await verifyV4ReencryptionInitiatorLocalParity({ ...pinned, reader })
      assert.equal(verified.allFilesContentVerified, true)
      const openFile = await reader.openFile("notes/a.md")
      const pendingChunks = openFile.chunks(4)[Symbol.asyncIterator]()
      assert.equal((await pendingChunks.next()).done, false)
      const readsBeforeSync = adapter.reads
      const result = await coordinator.run({ operation: "normal", trigger: "manual" })
      assert.equal(result.status, "completed")
      assert.equal(coordinator.isSyncing, false)
      assert.equal(coordinator.syncExecutionGeneration, 1)
      assert.equal(plugin.isSyncInProgress, false)
      await assert.rejects(() => pendingChunks.next(),
        /Sync.*(changed|started|generation)/i,
        "Mobile must refuse the next buffered chunk after an intervening completed Sync")
      await pendingChunks.return?.()
      await assert.rejects(
        () => verifyV4ReencryptionInitiatorLocalParity({ ...pinned, reader }),
        /Sync.*(changed|started|generation)/i,
        "a Sync that already finished must still invalidate an old parity reader",
      )
      assert.equal(adapter.reads, readsBeforeSync, "stale Mobile reader must reject before re-reading content")
      // A fresh reader binds to the current completed Sync generation; the
      // old reader is invalid, but independent revalidation remains possible.
      const fresh = runtime.createReencryptionInitiatorLocalReader(async () => {})
      assert.equal((await verifyV4ReencryptionInitiatorLocalParity({
        ...pinned, reader: fresh,
      })).checkedFileCount, 1)

      // Creating a reader in the middle of Sync must not legitimize it merely
      // because the generation was already advanced before construction.
      const inProgress = coordinator.run({ operation: "normal", trigger: "manual" })
      assert.equal(coordinator.isSyncing, true)
      try {
        assert.throws(
          () => runtime.createReencryptionInitiatorLocalReader(async () => {}),
          /Re-encryption.*Sync.*active/i,
          "new readers must refuse an active Sync at construction time",
        )
      } finally {
        finishSecond()
        await inProgress
      }
      plugin.isSyncInProgress = true
      try {
        assert.throws(
          () => runtime.createReencryptionInitiatorLocalReader(async () => {}),
          /Re-encryption.*Sync.*active/i,
          "plugin-level active Sync must also refuse a reader before coordinator activity",
        )
      } finally { plugin.isSyncInProgress = false }
      assert.equal(adapter.writes, 0)
    } finally { runtime.dispose() }
  } finally {
    coordinator.dispose()
    Platform.isDesktopApp = priorDesktop
  }
})

test("D329 installed Mobile initiator reader rejects replaced Vault identity even with the same adapter", async () => {
  const priorDesktop = Platform.isDesktopApp
  Platform.isDesktopApp = false
  const adapter = new MobileAdapter()
  const fileData = bytes("verified file on original vault")
  adapter.set("notes/a.md", fileData)
  const plugin = {
    settings: {
      githubOwner: "owner", githubRepo: "vault", githubBranch: "main",
      githubToken: "secret", encryptionMode: "encrypted", encryptionPassphrase: "old-secret",
      ignorePathRegex: "", syncObsidianConfig: false, syncBookmarks: false, syncPlugins: false,
    },
    manifest: { id: scope.pluginId },
    app: {
      vault: {
        configDir: ".obsidian", adapter,
        getFiles() { return [] },
      },
      workspace: { activeEditor: null, iterateAllLeaves(_visitor: unknown) {} },
    },
    isSyncInProgress: false,
    isSettingsSaveInProgress() { return false },
    settingsSaveGeneration: 0,
    addIgnoredFile() {}, removeIgnoredFile() {},
  }
  try {
    const runtime = new V4PluginRuntime(plugin as never)
    try {
      const reader = runtime.createReencryptionInitiatorLocalReader(async () => {})
      const proof = await source([{ path: "notes/a.md", data: fileData }])
      const initial = await verifyV4ReencryptionInitiatorLocalParity({ ...proof, reader })
      assert.equal(initial.checkedFileCount, 1)
      const originalVault = plugin.app.vault
      plugin.app.vault = { ...originalVault }
      // Same adapter and configDir; the old implementation only compared those
      // properties and wrongly permitted a stale Vault context.
      await assert.rejects(
        () => verifyV4ReencryptionInitiatorLocalParity({ ...proof, reader }),
        /Vault|scope|connection|identity/i,
        "a replaced Obsidian Vault must invalidate the initiating authority",
      )
      plugin.app.vault = originalVault
      plugin.isSyncInProgress = true
      await assert.rejects(
        () => verifyV4ReencryptionInitiatorLocalParity({ ...proof, reader }),
        /Sync|idle|mutation/i,
        "plugin-level Sync must block local parity even before the coordinator starts",
      )
      plugin.isSyncInProgress = false
      plugin.isSettingsSaveInProgress = () => true
      await assert.rejects(
        () => verifyV4ReencryptionInitiatorLocalParity({ ...proof, reader }),
        /Settings|idle|mutation/i,
        "an in-flight plugin Settings save cannot certify the initiating Vault",
      )
      plugin.isSettingsSaveInProgress = () => false
      plugin.settingsSaveGeneration++
      await assert.rejects(
        () => verifyV4ReencryptionInitiatorLocalParity({ ...proof, reader }),
        /Settings|connection|scope|identity/i,
        "a completed Settings save must invalidate stale Mobile parity even when settings values are unchanged",
      )
      assert.equal(adapter.writes, 0)
    } finally {
      runtime.dispose()
    }
  } finally {
    Platform.isDesktopApp = priorDesktop
  }
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
