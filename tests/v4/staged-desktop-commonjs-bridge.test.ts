import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

test("built Obsidian CommonJS bundle uses synchronous Node builtins for desktop bounded IO", async () => {
  const bundle = await readFile("main.js", "utf8")
  assert.match(bundle, /require\(["']node:fs\/promises["']\)/u)
  assert.match(bundle, /require\(["']node:path["']\)/u)
})
