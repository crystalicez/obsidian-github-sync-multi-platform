import assert from "node:assert/strict"
import test from "node:test"
import { TFolder, type Vault } from "obsidian"

import { writeVaultFileBytes } from "../../src/lib/vault"

const bytes = new TextEncoder().encode("body")

function folder(path: string, children: TFolder[] = []): TFolder {
  const value = new TFolder()
  value.path = path
  value.children = children
  return value
}

function fakeVault(initial: TFolder) {
  const files = new Map<string, unknown>([[initial.path, initial]])
  const deleted: string[] = []
  const created: string[] = []
  const vault = {
    getAbstractFileByPath(path: string) { return files.get(path) ?? null },
    async delete(file: { path: string }) { deleted.push(file.path); files.delete(file.path) },
    async createBinary(path: string) { created.push(path) },
    async createFolder(path: string) { files.set(path, folder(path)) },
    async modifyBinary() { throw new Error("modifyBinary should not be called") },
  } as unknown as Vault
  return { vault, deleted, created }
}

test("vault writer replaces an empty folder target with a file", async () => {
  const fixture = fakeVault(folder("dir"))
  await writeVaultFileBytes(fixture.vault, "dir", bytes)

  assert.deepEqual(fixture.deleted, ["dir"])
  assert.deepEqual(fixture.created, ["dir"])
})

test("vault writer refuses to replace a non-empty folder target", async () => {
  const child = folder("dir/keep")
  const fixture = fakeVault(folder("dir", [child]))

  await assert.rejects(
    () => writeVaultFileBytes(fixture.vault, "dir", bytes),
    /non-empty folder/iu,
  )
  assert.deepEqual(fixture.deleted, [])
  assert.deepEqual(fixture.created, [])
})
