import assert from "node:assert/strict"
import test from "node:test"

import { planV4PluginPrivateWalLocation } from "../../src/lib/v4/reencryption-plugin-wal-location"
import { openV4MobilePluginWalForRecovery } from "../../src/lib/v4/reencryption-mobile-wal-recovery"
import { tryReserveV4MobileRecoveryAdapter } from "../../src/lib/v4/reencryption-mobile-recovery-reservation"

test("D294 stale Mobile Recovery release must not evict a newer adapter reservation", () => {
  const adapter = {}
  const first = tryReserveV4MobileRecoveryAdapter(adapter)
  assert.ok(first)
  assert.equal(tryReserveV4MobileRecoveryAdapter(adapter), null,
    "another cooperative holder must not enter during the first reservation")

  first()
  const second = tryReserveV4MobileRecoveryAdapter(adapter)
  assert.ok(second)
  try {
    first() // stale caller must not release the second owner's reservation
    assert.equal(tryReserveV4MobileRecoveryAdapter(adapter), null,
      "releasing an old reservation twice must never free the new holder")
  } finally {
    second()
  }

  const third = tryReserveV4MobileRecoveryAdapter(adapter)
  assert.ok(third, "the current owner can release normally")
  third()
})

const configDir = ".obsidian"
const pluginId = "obsidian-encrypted-github-sync"
const runId = "d242-mobile-wal-run"

async function fixture() {
  const layout = await planV4PluginPrivateWalLocation({ configDir, pluginId, runId })
  const directory = layout.vaultLogicalWalRoot
  const files = new Map([
    [directory + "/slot-0.json", "encrypted mobile slot zero"],
    [directory + "/slot-1.json", "encrypted mobile slot one"],
  ])
  const folders = new Set<string>()
  for (const [index] of directory.split("/").entries()) {
    folders.add(directory.split("/").slice(0, index + 1).join("/"))
  }
  let reads = 0
  let live = true
  const adapter = {
    async stat(path: string) {
      if (folders.has(path)) return { type: "folder" as const, size: 0, mtime: 1 }
      const data = files.get(path)
      return data === undefined ? null
        : { type: "file" as const, size: new TextEncoder().encode(data).length, mtime: 1 }
    },
    async list(path: string) {
      if (path !== directory) throw Error("unexpected directory")
      return { files: Array.from(files.keys()), folders: [] as string[] }
    },
    async read(path: string) {
      reads++
      const value = files.get(path)
      if (value === undefined) throw Error("missing WAL")
      return value
    },
  }
  return {
    files, folders, layout, adapter,
    input: {
      adapter, configDir, pluginId, runId,
      assertLiveOwner: () => { if (!live) throw Error("lost mobile owner") },
    },
    loseOwner() { live = false },
    getReads() { return reads },
  }
}

test("D242 Mobile uses exactly the same plugin-private WAL root and exposes no writer or OS-lease claim", async () => {
  const f = await fixture()
  const snapshot = new Map(f.files)
  const reader = await openV4MobilePluginWalForRecovery(f.input)
  assert.equal(reader.journalRoot, f.layout.journalRoot)
  assert.equal(reader.cooperativeOsLeaseProven, false)
  assert.equal(reader.powerLossDurabilityProven, false)
  assert.equal(reader.resumeSyncAuthorized, false)
  assert.equal(reader.localCutoverAuthorized, false)
  assert.equal(Object.hasOwn(reader.adapter, "write"), false)
  assert.equal(Object.hasOwn(reader.adapter, "mkdir"), false)
  assert.equal(Object.isFrozen(reader.adapter), true)
  for (const slot of ["slot-0.json", "slot-1.json"]) {
    const logical = f.layout.journalRoot + "/" + slot
    assert.equal(await reader.adapter.exists(logical), true)
    assert.equal(await reader.adapter.read(logical),
      f.files.get(f.layout.vaultLogicalWalRoot + "/" + slot))
  }
  assert.ok(f.getReads() >= 8)
  assert.deepEqual(f.files, snapshot)
})

test("D242 Mobile refuses a missing plugin root, absent or foreign WAL slots, without creating files", async () => {
  for (const cause of ["missing-root", "missing-slot", "extra-slot", "foreign-folder"] as const) {
    const f = await fixture()
    if (cause === "missing-root") f.folders.delete(f.layout.pluginStorageRoot)
    if (cause === "missing-slot") f.files.delete(f.layout.vaultLogicalWalRoot + "/slot-1.json")
    if (cause === "extra-slot") f.files.set(f.layout.vaultLogicalWalRoot + "/.slot-torn.tmp", "evidence")
    if (cause === "foreign-folder") {
      const list = f.adapter.list
      f.adapter.list = async path => ({
        ...await list(path), folders: [f.layout.vaultLogicalWalRoot + "/unknown"],
      })
    }
    const snapshot = new Map(f.files)
    await assert.rejects(openV4MobilePluginWalForRecovery(f.input), undefined, cause)
    assert.deepEqual(f.files, snapshot, cause)
  }
})

test("D242 Mobile detects an altered reader, lost owner or concurrent slot mutation", async () => {
  const f = await fixture()
  const reader = await openV4MobilePluginWalForRecovery(f.input)
  const logical = f.layout.journalRoot + "/slot-0.json"
  f.loseOwner()
  await assert.rejects(reader.adapter.read(logical), /lost mobile owner/u)

  const modified = await fixture()
  const opened = await openV4MobilePluginWalForRecovery(modified.input)
  modified.files.set(modified.layout.vaultLogicalWalRoot + "/slot-0.json", "longer malicious WAL")
  await assert.rejects(opened.adapter.read(modified.layout.journalRoot + "/slot-0.json"),
    /slot changed/u)

  const swapped = await fixture()
  const existing = await openV4MobilePluginWalForRecovery(swapped.input)
  const original = swapped.adapter.read
  swapped.adapter.read = async name => original(name)
  await assert.rejects(existing.adapter.read(swapped.layout.journalRoot + "/slot-1.json"),
    /owner or reader changed/u)
})

test("D242 Mobile does not silently accept a same-size changed slot on two successive reads", async () => {
  const f = await fixture()
  const original = f.adapter.read
  let active = false
  let count = 0
  f.adapter.read = async file => {
    const value = await original(file)
    if (!active) return value
    count++
    return count % 2 === 0 ? value.replace("slot", "sloT") : value
  }
  const opened = await openV4MobilePluginWalForRecovery(f.input)
  active = true
  await assert.rejects(opened.adapter.read(f.layout.journalRoot + "/slot-0.json"),
    /changed during readback/u)
})

test("D306 Mobile Recovery refuses a slot replaced after open with identical size and mtime", async () => {
  const f = await fixture()
  const reader = await openV4MobilePluginWalForRecovery(f.input)
  const full = f.layout.vaultLogicalWalRoot + "/slot-0.json"
  const logical = f.layout.journalRoot + "/slot-0.json"
  const original = f.files.get(full)
  assert.ok(original)
  const replacement = original.replace("zero", "ZERO")
  assert.notEqual(replacement, original)
  assert.equal(new TextEncoder().encode(replacement).length,
    new TextEncoder().encode(original).length,
    "replacement must preserve stat.size so only content evidence can detect drift")
  f.files.set(full, replacement)
  assert.equal((await f.adapter.stat(full))?.mtime, 1)

  await assert.rejects(reader.adapter.read(logical), /slot changed/u)
  await assert.rejects(reader.adapter.exists(logical), /slot changed/u)
  assert.equal(f.files.get(full), replacement,
    "Recovery detection must never replace or delete ambiguous WAL evidence")
})

test("D306 Mobile Recovery refuses a stable Adapter stat size that disagrees with read bytes", async () => {
  const f = await fixture()
  const originalStat = f.adapter.stat
  const full = f.layout.vaultLogicalWalRoot + "/slot-0.json"
  f.adapter.stat = async path => {
    const info = await originalStat(path)
    return info && path === full ? { ...info, size: info.size + 1 } : info
  }
  const snapshot = new Map(f.files)
  await assert.rejects(openV4MobilePluginWalForRecovery(f.input),
    /invalid or inconsistent data/u)
  assert.deepEqual(f.files, snapshot,
    "Inconsistent Adapter metadata must leave the original WAL untouched")
})

test("D242 Mobile refuses unknown requested paths rather than reading arbitrary vault data", async () => {
  const f = await fixture()
  const opened = await openV4MobilePluginWalForRecovery(f.input)
  await assert.rejects(opened.adapter.read("../secret.json"), /outside its two slots/u)
  await assert.rejects(opened.adapter.exists(f.layout.journalRoot + "/slot-2.json"),
    /outside its two slots/u)
})
