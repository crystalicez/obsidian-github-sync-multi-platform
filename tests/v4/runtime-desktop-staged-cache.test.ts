import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { TFile } from "obsidian"
import { V4PluginRuntime } from "../../src/lib/v4/runtime"
import { sha256Hex } from "../../src/lib/bytes"

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
