import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { TFile } from "obsidian"
import { sha256Hex } from "../../src/lib/bytes"
import { V4PluginRuntime } from "../../src/lib/v4/runtime"

const encode = (value: string) => new TextEncoder().encode(value)

async function fixture(run: (ctx: {
  vault: ReturnType<V4PluginRuntime["sessionVault"]>
  setEditorText: (text: string) => void
  closeEditor: () => void
  originalPath: string
  root: string
  originalBytes: Uint8Array
  stage: { stageId: string; size: number; hash: string }
}) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "v4-native-open-editor-"))
  const originalPath = "Open.md"
  const originalBytes = encode("# original note\n")
  const stagedBytes = encode("# remote overwrite\n")
  const pluginId = "v4-open-editor-test"
  const stageId = "pending"
  const stageDir = path.join(root, ".obsidian", "plugins", pluginId, "github-sync-v4-stage")
  await mkdir(stageDir, { recursive: true })
  await writeFile(path.join(root, originalPath), originalBytes)
  await writeFile(path.join(stageDir, stageId + ".bin"), stagedBytes)
  const file = new TFile(originalPath, originalBytes)
  let editorText = new TextDecoder().decode(originalBytes)
  let isOpen = true
  const leaf = { view: { file, getViewType: () => "markdown", editor: { getValue: () => editorText } } }
  const fakeVault = {
    configDir: ".obsidian",
    adapter: {
      getFullPath(logical: string) { return path.join(root, logical) },
      async read() { return "" }, async write() {}, async exists() { return false }, async mkdir() {},
    },
    getAbstractFileByPath(logical: string) { return logical === originalPath ? file : null },
    getFiles() { return [file] },
    async readBinary() { return originalBytes.buffer },
  }
  const runtime = new V4PluginRuntime({
    app: { vault: fakeVault, workspace: { iterateAllLeaves: (cb: (leaf: unknown) => void) => { if (isOpen) cb(leaf) } } },
    manifest: { id: pluginId },
    addIgnoredFile() {}, removeIgnoredFile() {},
    settings: { githubOwner: "disposable", githubRepo: "repo", githubBranch: "main" },
  } as never)
  try {
    const vault = (runtime as unknown as { sessionVault(scope: (path: string) => boolean): {
      commitStage(input: { stage: { stageId: string; size: number; hash: string }; path: string; precondition: { path: string; exists: boolean; size: number; mtime: number; hash: string } }): Promise<void>
      trash(path: string): Promise<void>
      write(path: string, bytes: Uint8Array): Promise<void>
    } }).sessionVault(() => true)
    await run({
      vault, root, originalPath, originalBytes,
      stage: { stageId, size: stagedBytes.byteLength, hash: await sha256Hex(stagedBytes) },
      setEditorText: text => { editorText = text },
      closeEditor: () => { isOpen = false },
    })
  } finally {
    runtime.dispose()
    await rm(root, { recursive: true, force: true })
  }
}

test("D8 fail-first: staged replay must not overwrite an unsaved active editor", async () => {
  await fixture(async ({vault,root,originalPath,originalBytes,stage,setEditorText}) => {
    setEditorText("# unsaved editor content\n")
    const before = await readFile(path.join(root,originalPath))
    const stat = (await import("node:fs/promises")).stat
    const info = await stat(path.join(root,originalPath))
    await assert.rejects(
      vault.commitStage({
        stage, path: originalPath,
        precondition: {path: originalPath, exists: true, size: info.size, mtime: Math.round(info.mtimeMs), hash: await sha256Hex(originalBytes)},
      }),
      /editor|unsaved|conflict|open/i,
    )
    assert.deepEqual(await readFile(path.join(root,originalPath)), before)
    assert.deepEqual(new Uint8Array(await readFile(path.join(root,".obsidian","plugins","v4-open-editor-test","github-sync-v4-stage","pending.bin"))), encode("# remote overwrite\n"))
  })
})

test("D8 fail-first: a still-open clean editor is deferred rather than risking a new edit between awaits", async () => {
  await fixture(async ({vault,root,originalPath,originalBytes,stage}) => {
    const info = await (await import("node:fs/promises")).stat(path.join(root,originalPath))
    await assert.rejects(vault.commitStage({
      stage, path: originalPath,
      precondition: {path:originalPath,exists:true,size:info.size,mtime:Math.round(info.mtimeMs),hash:await sha256Hex(originalBytes)},
    }), /editor|open|conflict/i)
    assert.deepEqual(new Uint8Array(await readFile(path.join(root,originalPath))), originalBytes)
  })
})

test("D8: closing the note releases the fail-closed guard without losing staged recovery data", async () => {
  await fixture(async ({vault,root,originalPath,originalBytes,stage,closeEditor}) => {
    const info = await (await import("node:fs/promises")).stat(path.join(root,originalPath))
    closeEditor()
    await vault.commitStage({
      stage, path:originalPath,
      precondition:{path:originalPath,exists:true,size:info.size,mtime:Math.round(info.mtimeMs),hash:await sha256Hex(originalBytes)},
    })
    assert.deepEqual(new Uint8Array(await readFile(path.join(root,originalPath))), encode("# remote overwrite\n"))
  })
})

test("D8 fail-first: a pending deletion must not trash a note with an open editor", async () => {
  await fixture(async ({vault,root,originalPath,originalBytes,setEditorText}) => {
    setEditorText("# edited but not persisted\n")
    await assert.rejects(vault.trash(originalPath), /editor|open|conflict/i)
    assert.deepEqual(new Uint8Array(await readFile(path.join(root,originalPath))), originalBytes)
  })
})
