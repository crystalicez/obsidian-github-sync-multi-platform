import assert from "node:assert/strict"
import test from "node:test"
import { runInNewContext } from "node:vm"

import { buildNativePluginReadyExpression } from "../../scripts/native-obsidian-plugin-ready.mjs"

const id = "encrypted-github-sync-multi-platform"

async function runScenario(options = {}) {
  const plugin = { version: "test-only" }
  let enabled = options.enabled ?? true
  const manager = {
    plugins: options.loaded ? { [id]: plugin } : {},
    manifests: options.manifest === false ? {} : { [id]: {} },
    enabledPlugins: new Set(options.registered === false ? [] : [id]),
    loadingPluginId: options.loading ? id : undefined,
    isEnabled() { return enabled },
    async setEnable(value) { enabled = value },
    async enablePluginAndSave(pluginId) {
      assert.equal(pluginId, id)
      result.enableCalls++
      manager.enabledPlugins.add(pluginId)
      if (options.autoEnableLoads) manager.plugins[id] = plugin
    },
    async loadPlugin(pluginId) {
      assert.equal(pluginId, id)
      result.manualLoads++
      if (options.rejectLoad) throw new Error("synthetic plugin loading failed")
      if (!options.delayedManualLoad) manager.plugins[id] = plugin
    },
  }
  const result = { manager, manualLoads: 0, enableCalls: 0, ticks: 0 }
  const sandbox = {
    app: { plugins: manager },
    setTimeout(callback, delay) {
      assert.equal(delay, 200)
      result.ticks++
      if (options.autoCompletesAt === result.ticks) {
        manager.plugins[id] = plugin
        manager.loadingPluginId = undefined
      }
      if (options.delayedManualLoad && result.manualLoads && result.ticks === 5) {
        manager.plugins[id] = plugin
      }
      callback()
    },
  }
  result.promise = Promise.resolve().then(() =>
    runInNewContext(buildNativePluginReadyExpression(id), sandbox))
  return result
}

test("D349 Native Obsidian ready plugin is not loaded twice", async () => {
  const seen = await runScenario({ loaded: true })
  assert.equal(await seen.promise, true)
  assert.equal(seen.manualLoads, 0)
  assert.equal(seen.ticks, 0)
})

test("D349 Native Obsidian enablePluginAndSave completing startup never double-loads", async () => {
  const seen = await runScenario({ registered: false, autoEnableLoads: true })
  assert.equal(await seen.promise, true)
  assert.equal(seen.enableCalls, 1)
  assert.equal(seen.manualLoads, 0)
})

test("D349 Native Obsidian waits for an in-flight platform load without racing it", async () => {
  const seen = await runScenario({ loading: true, autoCompletesAt: 4 })
  assert.equal(await seen.promise, true)
  assert.equal(seen.manualLoads, 0)
  assert.equal(seen.ticks, 4)
})

test("D349 Native Obsidian invokes manual loading at most once if startup is late", async () => {
  const seen = await runScenario({ delayedManualLoad: true })
  assert.equal(await seen.promise, true)
  assert.equal(seen.manualLoads, 1)
  assert.equal(seen.ticks, 5)
})

test("D349 Native Obsidian missing manifest fails closed without loading", async () => {
  const seen = await runScenario({ manifest: false })
  assert.equal(await seen.promise, false)
  assert.equal(seen.manualLoads, 0)
  assert.equal(seen.ticks, 40)
})

test("D349 Native Obsidian load failure is not mistaken for success", async () => {
  const seen = await runScenario({ rejectLoad: true })
  await assert.rejects(seen.promise, /synthetic plugin loading failed/)
  assert.equal(seen.manualLoads, 1)
})
