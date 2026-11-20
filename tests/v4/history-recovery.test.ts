import assert from "node:assert/strict"
import test from "node:test"
import { createV4HistoricalMarkdownCopy } from "../../src/lib/v4/history-recovery"

test("D454 recovery creates a collision-free root Markdown note, never replacing the source", async () => {
  const files = new Map([
    ["Notes/current.md", "# Working version"],
    ["Recovered-current-abcd1234.md", "# Earlier recovered version"],
  ])
  const vault = {
    getAbstractFileByPath(path: string) { return files.has(path) ? { path } : null },
    async create(path: string, content: string) {
      assert.equal(files.has(path), false, "Vault.create must only receive a vacant path")
      files.set(path, content)
      return { path }
    },
  }
  const path = await createV4HistoricalMarkdownCopy(vault as never, "Notes/current.md", "abcd1234abcd", "# Historical text")
  assert.equal(path, "Recovered-current-abcd1234-2.md")
  assert.equal(files.get(path), "# Historical text")
  assert.equal(files.get("Notes/current.md"), "# Working version")
  assert.equal(files.get("Recovered-current-abcd1234.md"), "# Earlier recovered version")
})

test("D454 filenames from history cannot use traversal or directory names", async () => {
  const paths: string[] = []
  const vault = {
    getAbstractFileByPath() { return null },
    async create(path: string) { paths.push(path); return { path } },
  }
  await createV4HistoricalMarkdownCopy(vault as never, "../../private/secret note.md", "../../unsafe-ref", "historical")
  assert.deepEqual(paths, ["Recovered-secret-note-unsafere.md"])
  assert.ok(paths.every(path => !path.includes("/") && !path.includes("..")))
})

test("D454 a partially committed Vault.create failure is never automatically retried", async () => {
  const files = new Map<string, string>()
  let calls = 0
  const vault = {
    getAbstractFileByPath(path: string) { return files.has(path) ? { path } : null },
    async create(path: string, content: string) {
      calls++
      files.set(path, content)
      throw new Error("Ambiguous Vault writer failure")
    },
  }
  await assert.rejects(createV4HistoricalMarkdownCopy(vault as never, "note.md", "sha", "# historical"),
    /Ambiguous Vault writer failure/u)
  assert.equal(calls, 1)
  assert.equal(files.size, 1, "the helper must not try another name after an uncertain write")
})

test("D454 only Markdown history is eligible for a recovered note", async () => {
  let lookups = 0
  const vault = {
    getAbstractFileByPath() { lookups++; return null },
    async create() { throw new Error("must not create"); },
  }
  await assert.rejects(createV4HistoricalMarkdownCopy(vault as never, "settings.json", "abc", "{}"), /only Markdown/iu)
  assert.equal(lookups, 0)
})
