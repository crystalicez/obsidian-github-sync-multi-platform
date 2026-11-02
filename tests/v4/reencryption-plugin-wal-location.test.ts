import assert from "node:assert/strict"
import test from "node:test"
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"

import { acquireV4DesktopRekeyWalStorage } from "../../src/lib/v4/reencryption-desktop-wal"
import { planV4PluginPrivateWalLocation } from "../../src/lib/v4/reencryption-plugin-wal-location"
import { openV4DesktopPluginWalForRecovery } from "../../src/lib/v4/reencryption-desktop-plugin-wal-recovery"

const configDir = ".obsidian"
const pluginId = "obsidian-encrypted-github-sync"
const runId = "d242-wal-run-123456"

function mockOwner(root: string) {
  let live = true
  const adapter = {
    getFullPath(logical: string) {
      return path.join(root, ...logical.split("/").filter(Boolean))
    },
  }
  const input = {
    adapter, configDir, pluginId, runId,
    assertLiveOwner: () => {
      if (!live) throw Error("owner no longer live")
    },
  }
  return { input, invalidate: () => { live = false } }
}

async function fixture() {
  await mkdir(path.join(process.cwd(), ".tmp"), { recursive: true })
  const root = await mkdtemp(path.join(process.cwd(), ".tmp", "d242-private-wal-"))
  const layout = await planV4PluginPrivateWalLocation({ configDir, pluginId, runId })
  const privateRoot = path.join(root, ...layout.pluginStorageRoot.split("/"))
  await mkdir(privateRoot, { recursive: true })
  return { root, privateRoot, layout, ...mockOwner(root) }
}

test("D242 owner policy A has one stable mobile/desktop plugin-private logical WAL layout", async () => {
  const one = await planV4PluginPrivateWalLocation({ configDir, pluginId, runId })
  const two = await planV4PluginPrivateWalLocation({ configDir, pluginId, runId })
  const different = await planV4PluginPrivateWalLocation({
    configDir, pluginId, runId: "different-rekey-run-123",
  })
  assert.deepEqual(one, two)
  assert.equal(one.pluginStorageRoot, ".obsidian/plugins/" + pluginId)
  assert.match(one.journalRoot, /^reencryption-wal\/[a-f0-9]{64}$/u)
  assert.equal(one.vaultLogicalWalRoot, one.pluginStorageRoot + "/" + one.journalRoot)
  assert.notEqual(one.journalRoot, different.journalRoot)
  assert.equal(Object.isFrozen(one), true)
  const nested = await planV4PluginPrivateWalLocation({
    configDir: "settings/.obsidian", pluginId, runId,
  })
  assert.equal(nested.pluginStorageRoot, "settings/.obsidian/plugins/" + pluginId)
  const unicode = await planV4PluginPrivateWalLocation({
    configDir: "設定/.obsidian", pluginId, runId,
  })
  assert.equal(unicode.pluginStorageRoot, "設定/.obsidian/plugins/" + pluginId)
})

test("D242 refuses traversal, Windows device names, absolute paths and foreign plugin identities", async () => {
  for (const [key, values] of [
    ["configDir", ["", "..", ".", "../.obsidian", "/.obsidian", "C:/private", "e\u0301",
      ".obsidian\\evil", ".obsidian//vault", "CON", "settings/NUL", "settings/."]],
    ["pluginId", ["", "../other", "..", ".", "evil/../other", "CON", "foo.", "x\\y", "x:y"]],
    ["runId", ["", "short", "x/../migration", "..", "A".repeat(129)]],
  ] as const) {
    for (const value of values) {
      await assert.rejects(planV4PluginPrivateWalLocation({
        configDir, pluginId, runId, [key]: value,
      }), undefined, key + "=" + value)
    }
  }
})

test("D242 real Windows Desktop vault mapping opens existing WAL without exposing writes", async () => {
  const f = await fixture()
  let creator: Awaited<ReturnType<typeof acquireV4DesktopRekeyWalStorage>> | undefined
  let recovered: Awaited<ReturnType<typeof openV4DesktopPluginWalForRecovery>> | undefined
  try {
    creator = await acquireV4DesktopRekeyWalStorage({
      rootAbsolute: f.privateRoot, journalRoot: f.layout.journalRoot,
    })
    const data = new Map([
      [f.layout.journalRoot + "/slot-0.json", "encrypted WAL zero"],
      [f.layout.journalRoot + "/slot-1.json", "encrypted WAL one"],
    ])
    for (const [slot, value] of data) await creator.adapter.write(slot, value)
    await creator.release()
    creator = undefined
    recovered = await openV4DesktopPluginWalForRecovery(f.input)
    assert.equal(Object.hasOwn(recovered.adapter, "write"), false)
    assert.equal(Object.hasOwn(recovered.adapter, "mkdir"), false)
    assert.equal(Object.isFrozen(recovered.adapter), true)
    await recovered.assertExclusiveStageLease()
    assert.equal(await recovered.assertBestEffortCheckpoint(), "best-effort-readback-only")
    for (const [slot, value] of data) {
      assert.equal(await recovered.adapter.exists(slot), true)
      assert.equal(await recovered.adapter.read(slot), value)
    }
    await recovered.release()
    recovered = undefined
    assert.deepEqual((await readdir(path.join(f.privateRoot, ...f.layout.journalRoot.split("/")))).sort(),
      ["slot-0.json", "slot-1.json"])
    for (const [slot, value] of data) {
      const full = path.join(f.privateRoot, ...slot.split("/"))
      assert.equal(await readFile(full, "utf8"), value)
    }
  } finally {
    await recovered?.release()
    await creator?.release()
    await rm(f.root, { recursive: true, force: true })
  }
})

test("D242 missing private plugin directory or WAL never creates recovery data", async () => {
  const f = await fixture()
  try {
    await assert.rejects(openV4DesktopPluginWalForRecovery(f.input))
    assert.deepEqual(await readdir(f.privateRoot), [])
    await rm(f.privateRoot, { recursive: true })
    await assert.rejects(openV4DesktopPluginWalForRecovery(f.input))
    assert.equal(await stat(f.privateRoot).then(() => true, () => false), false)
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test("D242 rejects redirected Obsidian getFullPath and changed adapter ownership", async () => {
  const f = await fixture()
  try {
    const foreign = {
      ...f.input,
      adapter: {
        getFullPath(logical: string) {
          return logical ? path.join(f.root, "other-plugin", ...logical.split("/")) : f.root
        },
      },
    }
    await assert.rejects(openV4DesktopPluginWalForRecovery(foreign), /redirected/u)
    assert.deepEqual(await readdir(f.privateRoot), [])
    const mapped = f.input.adapter.getFullPath
    f.input.adapter.getFullPath = function (logical: string) {
      return mapped.call(f.input.adapter, logical)
    }
    await assert.rejects(openV4DesktopPluginWalForRecovery({
      ...f.input, assertLiveOwner: () => {
        f.input.adapter.getFullPath = mapped
      },
    }), /owner or path changed/u)
    assert.deepEqual(await readdir(f.privateRoot), [])
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test("D242 lost owner after opening rejects reads and keeps WAL slot evidence", async () => {
  const f = await fixture()
  let creator: Awaited<ReturnType<typeof acquireV4DesktopRekeyWalStorage>> | undefined
  let recovered: Awaited<ReturnType<typeof openV4DesktopPluginWalForRecovery>> | undefined
  try {
    creator = await acquireV4DesktopRekeyWalStorage({
      rootAbsolute: f.privateRoot, journalRoot: f.layout.journalRoot,
    })
    await creator.adapter.write(f.layout.journalRoot + "/slot-0.json", "retained-0")
    await creator.adapter.write(f.layout.journalRoot + "/slot-1.json", "retained-1")
    await creator.release()
    creator = undefined
    recovered = await openV4DesktopPluginWalForRecovery(f.input)
    f.invalidate()
    await assert.rejects(recovered.adapter.read(f.layout.journalRoot + "/slot-0.json"),
      /owner no longer live/u)
    await assert.rejects(recovered.assertBestEffortCheckpoint(), /owner no longer live/u)
    await recovered.release()
    recovered = undefined
    assert.equal(await readFile(path.join(f.privateRoot,
      ...f.layout.journalRoot.split("/"), "slot-0.json"), "utf8"), "retained-0")
  } finally {
    await recovered?.release()
    await creator?.release()
    await rm(f.root, { recursive: true, force: true })
  }
})

test("D242 interrupted WAL evidence is never cleaned up by the plugin-private Recovery opener", async () => {
  const f = await fixture()
  try {
    const directory = path.join(f.privateRoot, ...f.layout.journalRoot.split("/"))
    await mkdir(directory, { recursive: true })
    await writeFile(path.join(directory, "slot-0.json"), "a")
    await writeFile(path.join(directory, "slot-1.json"), "b")
    await writeFile(path.join(directory, ".slot-interrupted.tmp"), "manual recovery")
    await assert.rejects(openV4DesktopPluginWalForRecovery(f.input))
    assert.deepEqual((await readdir(directory)).sort(),
      [".slot-interrupted.tmp", "slot-0.json", "slot-1.json"].sort())
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})
