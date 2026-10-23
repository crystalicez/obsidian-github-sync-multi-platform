import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import test from "node:test"

test("TypeScript compiler keeps strict source checks and maximum migration gate", () => {
  const root = process.cwd()
  const read = (path) => JSON.parse(readFileSync(resolve(root, path), "utf8"))
  const active = read("tsconfig.json")
  const maximum = read("tsconfig.maximum-strict.json")
  for (const option of [
    "strict", "noImplicitOverride", "noPropertyAccessFromIndexSignature",
    "noFallthroughCasesInSwitch", "noImplicitReturns", "noUnusedLocals",
    "noUnusedParameters", "noUncheckedSideEffectImports",
    "forceConsistentCasingInFileNames",
  ]) {
    assert.equal(active.compilerOptions[option], true, `active TypeScript check ${option} must remain enabled`)
  }
  assert.equal(active.compilerOptions.allowUnreachableCode, false)
  assert.equal(active.compilerOptions.allowUnusedLabels, false)
  assert.equal(maximum.extends, "./tsconfig.json")
  assert.equal(maximum.compilerOptions.noUncheckedIndexedAccess, true)
  assert.equal(maximum.compilerOptions.exactOptionalPropertyTypes, true)
  assert.deepEqual(active.include, ["src/**/*.ts"])
})
