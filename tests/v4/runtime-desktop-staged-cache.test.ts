import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { TFile } from "obsidian"
import { V4PluginRuntime } from "../../src/lib/v4/runtime"
import { sha256Hex } from "../../src/lib/bytes"


// Obsidian's FileSystemAdapter rounds its native mtime to the nearest ms.
// The V4 desktop scan historically truncated fs.stat().mtimeMs, so the same
// unchanged note differed by 1ms across the two APIs and blocked Pull.
test("D10 fail-first: fractional Windows mtime is normalized like Obsidian's adapter", async () => {
  const { stat, utimes } = await import("node:fs/promises")
  const root = await mkdtemp(path.join(os.tmpdir(), "v4-obsidian-mtime-"))
  try {
    const target = path.join(root, "rounded.md")
    const bytes = new TextEncoder().encode("native mtime")
    await writeFile(target, bytes)
    // Numeric seconds preserve sub-millisecond precision on NTFS, unlike a Date.
    await utimes(target, 1_760_000_000.0008, 1_760_000_000.0008)
    const raw = await stat(target)
    assert.ok(raw.mtimeMs - Math.floor(raw.mtimeMs) > 0.5,
      "This test requires a representable >0.5ms filesystem mtime fraction")
    const file = new TFile("rounded.md", bytes)
    file.stat.mtime = Math.round(raw.mtimeMs)
    const fakeVault = {
      configDir: ".obsidian",
      adapter: { getFullPath: (logical: string) => path.join(root,logical),
        async read() { return "" }, async write() {}, async exists() { return false }, async mkdir() {} },
      getAbstractFileByPath: (logical: string) => logical === file.path ? file : null,
      getFiles: () => [file],
    }
    const runtime = new V4PluginRuntime({
      app: { vault: fakeVault },
      manifest: { id: "v4-mtime" },
      addIgnoredFile() {}, removeIgnoredFile() {},
      settings: { githubOwner: "disposable", githubRepo: "repo", githubBranch: "main" },
    } as never)
    try {
      const local = (runtime as unknown as {
        sessionVault(scope: (path: string) => boolean): {
          stat(p: string): Promise<{mtime: number,size: number} | null>
          commitStage(args: {
            path: string
            stage: {stageId:string,size:number,hash:string}
            precondition: {path:string,exists:boolean,size:number,mtime:number,hash:string}
          }): Promise<void>
        }
        stagingStore: { pathFor(id: string): string }
      }).sessionVault(() => true)
      const measured = await local.stat("rounded.md")
      assert.equal(measured?.mtime, file.stat.mtime,
        "Desktop scan must agree with Obsidian adapter for an unchanged NTFS timestamp")
      const stageData = new TextEncoder().encode("verified remote")
      const stageFile = path.join(root, ".obsidian", "plugins", "v4-mtime", "github-sync-v4-stage", "rounded.bin")
      await mkdir(path.dirname(stageFile), {recursive:true})
      await writeFile(stageFile, stageData)
      await local.commitStage({
        stage: {stageId:"rounded",size:stageData.length,hash:await sha256Hex(stageData)},
        path:"rounded.md",
        precondition: {path:"rounded.md",exists:true,size:bytes.length,mtime:file.stat.mtime,hash:await sha256Hex(bytes)}
      })
      assert.deepEqual(new Uint8Array(await readFile(target)),stageData)
    } finally { runtime.dispose() }
  } finally { await rm(root,{recursive:true,force:true}) }
})

test("D6 desktop recovered target bytes/stat come from disk, not a stale Obsidian TFile cache", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v4-staged-obsidian-cache-"))
  const first = new Uint8Array([1, 2, 3])
  const replaced = new Uint8Array([9, 8, 7, 6])
  let readBinaryCalls = 0
  try {
    await mkdir(path.join(root, "Notes"), { recursive: true })
    await writeFile(path.join(root, "Notes", "note.md"), replaced)
    await writeFile(path.join(root, "Notes", "new.md"), replaced)
    const oldObsidianFile = new TFile("Notes/note.md", first)
    oldObsidianFile.stat.mtime = 1 // Simulates a watcher not yet processing external rename.
    const fakeVault = {
      configDir: ".obsidian",
      adapter: {
        getFullPath(logical: string) { return path.join(root, logical) },
        async read() { return "" }, async write() {}, async exists() { return false }, async mkdir() {},
      },
      getAbstractFileByPath(logical: string) { return logical === "Notes/note.md" ? oldObsidianFile : null },
      getFiles() { return [oldObsidianFile] },
      async readBinary() { readBinaryCalls++; return first.buffer },
    }
    const runtime = new V4PluginRuntime({
      app: { vault: fakeVault },
      manifest: { id: "v4-d6-cache" },
      addIgnoredFile() {}, removeIgnoredFile() {},
      settings: { githubOwner: "disposable", githubRepo: "repo", githubBranch: "main" },
    } as never)
    try {
      const vault = (runtime as unknown as { sessionVault(scope: (path: string) => boolean): {
        preferStagedCommit?: boolean
        stat(path: string): Promise<{ size: number } | null>
        read(path: string): Promise<Uint8Array>
        listFiles(): Promise<Array<{ path: string; size: number }>>
        commitStage(input: { stage: { stageId: string; size: number; hash: string }; path: string; precondition: { path: string; exists: boolean } }): Promise<void>
      } }).sessionVault(() => true)
      assert.equal(vault.preferStagedCommit, true)
      assert.equal((await vault.listFiles())[0].size, replaced.byteLength, "stale Obsidian listing must not hide disk changes")
      assert.equal((await vault.stat("Notes/note.md"))?.size, replaced.byteLength)
      assert.equal((await vault.stat("Notes/new.md"))?.size, replaced.byteLength)
      assert.deepEqual(await vault.read("Notes/note.md"), replaced)
      assert.deepEqual(await vault.read("Notes/new.md"), replaced)
      assert.equal(readBinaryCalls, 0, "Desktop recovery must not use stale Vault cache for byte identity")
      assert.deepEqual(new Uint8Array(await readFile(path.join(root, "Notes", "note.md"))), replaced)
      const stagingFolder = path.join(root, ".obsidian", "plugins", "v4-d6-cache", "github-sync-v4-stage")
      await mkdir(stagingFolder, { recursive: true })
      await writeFile(path.join(stagingFolder, "newstage.bin"), replaced)
      await vault.commitStage({
        path: "Notes/unindexed.md",
        stage: { stageId: "newstage", size: replaced.byteLength, hash: await sha256Hex(replaced) },
        precondition: { path: "Notes/unindexed.md", exists: false },
      })
      assert.deepEqual(new Uint8Array(await readFile(path.join(root, "Notes", "unindexed.md"))), replaced)
      assert.equal(fakeVault.getFiles().some(file => file.path === "Notes/unindexed.md"), false)
      assert.equal((await vault.listFiles()).some(file => file.path === "Notes/unindexed.md"), true,
        "a newly committed staged file must stay visible to the next scan while Obsidian indexing lags")
    } finally { runtime.dispose() }
  } finally { await rm(root, { recursive: true, force: true }) }
})
