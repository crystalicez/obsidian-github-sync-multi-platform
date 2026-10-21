import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { join } from "node:path"

const root = fileURLToPath(new URL("../../", import.meta.url))
const read = name => readFileSync(join(root, name), "utf8")

test("soak execution and generated stream never exceed 100,000,000 bytes", () => {
  const runner = read("scripts/run-soak.mjs")
  const soak = read("tests/soak/v4-100mb-stream.test.ts")
  assert.match(runner, /MAX_TEST_BYTES = 100_000_000/u)
  assert.match(soak, /MAX_TEST_BYTES = 100_000_000/u)
  assert.doesNotMatch(runner + soak, /5 \* GiB|2 \* GiB|5gib-stream/u)
})

test("oversized and malformed soak sizes fail before any stream is created", () => {
  for (const value of ["100000001", "5368709120", "abc", "0", "1,100000001"]) {
    const result = spawnSync(process.execPath, ["scripts/run-soak.mjs", `--bytes=${value}`], {
      cwd: root, encoding: "utf8",
    })
    assert.equal(result.status, 2, `soak size ${value} must fail closed`)
    assert.match(result.stderr, /no larger than 100000000 bytes/u)
  }
})

test("test runner isolates temporary bundles per invocation", () => {
  const runner = read("scripts/run-tests.mjs")
  assert.match(runner, /mkdtemp\(/u)
  assert.match(runner, /lstat\(outputRoot\)/u)
  assert.doesNotMatch(runner, /rm\(outDir[^\n]*[\s\S]*?mkdir\(outDir/u)
})
