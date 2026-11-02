import assert from "node:assert/strict"
import test from "node:test"

import { createV4PersistedWalFenceAssertion } from "../../src/lib/v4/reencryption-persisted-wal-fence"
import { armV4ReencryptionSyncFence, V4ReencryptionSyncFencedError,
  V4_REENCRYPTION_SYNC_FENCE_ROOT } from "../../src/lib/v4/reencryption-sync-fence"
import type { V4LocalIndexAdapter } from "../../src/lib/v4/local-index"

const root = V4_REENCRYPTION_SYNC_FENCE_ROOT
const marker = root + "/active.json"
const runId = "d244-persisted-fence-123"
const sourceRepoId = "owner/repo#main"
const destinationRepoId = "owner/repo#rekey/destination"

async function fixture() {
  const directories = new Set<string>()
  const files = new Map<string, string>()
  let writes = 0
  let alive = true
  const adapter: V4LocalIndexAdapter = {
    async exists(name) { return directories.has(name) || files.has(name) },
    async read(name) {
      const value = files.get(name)
      if (value === undefined) throw Error("missing")
      return value
    },
    async write(name, value) { writes++; files.set(name, value) },
    async mkdir(name) { directories.add(name) },
  }
  await armV4ReencryptionSyncFence({
    adapter, runId, sourceRepoId, destinationRepoId,
    assertExclusiveInitiatorLease: async () => {},
  })
  const input = {
    adapter, runId, sourceRepoId, destinationRepoId,
    assertLiveOwner() { if (!alive) throw Error("owner disposed") },
  }
  return { directories, files, adapter, input, get writes() { return writes }, dispose() { alive = false } }
}

test("D244 reopens an exact persisted same-run Sync Fence without writing or authorizing cutover", async () => {
  const f = await fixture()
  const observedWrites = f.writes
  const assertPersisted = createV4PersistedWalFenceAssertion(f.input)
  await assertPersisted()
  await assertPersisted()
  assert.equal(f.writes, observedWrites)
  assert.equal(Object.isFrozen(assertPersisted), true)
  assert.equal(await f.adapter.exists(marker), true)
})

test("D244 refuses wrong migration identity and tampered canonical marker, with no repair", async () => {
  for (const mismatch of [
    { runId: "other-migration-run-456" },
    { sourceRepoId: "owner/repo#different" },
    { destinationRepoId: "owner/repo#rekey/other" },
    { destinationRepoId: sourceRepoId },
  ]) {
    const f = await fixture()
    await assert.rejects(async () => {
      await createV4PersistedWalFenceAssertion({ ...f.input, ...mismatch })()
    }, V4ReencryptionSyncFencedError)
    assert.equal(f.writes, 1)
  }
  for (const malformed of [
    "{truncated",
    "[]",
    JSON.stringify({ schemaVersion: 1, runId }),
    JSON.stringify({ schemaVersion: 1, phase: "migration-fenced-uncommitted", runId,
      sourceRepoId, destinationRepoId, permissionToWrite: true }),
    " ".repeat(4100),
  ]) {
    const f = await fixture()
    f.files.set(marker, malformed)
    await assert.rejects(createV4PersistedWalFenceAssertion(f.input)(),
      V4ReencryptionSyncFencedError)
    assert.equal(f.files.get(marker), malformed)
    assert.equal(f.writes, 1)
  }
})

test("D244 missing root or torn marker never silently authorizes WAL", async () => {
  for (const missing of ["root", "marker", "both"]) {
    const f = await fixture()
    if (missing !== "marker") f.directories.delete(root)
    if (missing !== "root") f.files.delete(marker)
    await assert.rejects(createV4PersistedWalFenceAssertion(f.input)(),
      V4ReencryptionSyncFencedError)
    assert.equal(f.writes, 1)
  }
})

test("D244 loses authority when owner/adapter or caller identity changes after a successful read", async () => {
  const f = await fixture()
  const assertPersisted = createV4PersistedWalFenceAssertion(f.input)
  await assertPersisted()
  f.dispose()
  await assert.rejects(assertPersisted(), V4ReencryptionSyncFencedError)

  const swapped = await fixture()
  const assertSwapped = createV4PersistedWalFenceAssertion(swapped.input)
  const originalRead = swapped.adapter.read
  swapped.adapter.read = (name: string) => originalRead.call(swapped.adapter, name)
  await assert.rejects(assertSwapped(), V4ReencryptionSyncFencedError)

  const changed = await fixture()
  const assertChanged = createV4PersistedWalFenceAssertion(changed.input)
  changed.input.runId = "different-migration-run"
  await assert.rejects(assertChanged(), V4ReencryptionSyncFencedError)
})

test("D244 refuses marker or owner mutation during an awaited read, even with previously valid evidence", async () => {
  const f = await fixture()
  let firstRead = true
  const originalRead = f.adapter.read
  f.adapter.read = async name => {
    const value = await originalRead.call(f.adapter, name)
    if (firstRead) {
      firstRead = false
      f.files.set(marker, "changed-during-read")
    }
    return value
  }
  await assert.rejects(createV4PersistedWalFenceAssertion(f.input)(),
    V4ReencryptionSyncFencedError)
  assert.equal(f.files.get(marker), "changed-during-read")
  assert.equal(f.writes, 1)

  const second = await fixture()
  const read = second.adapter.read
  let changed = false
  second.adapter.read = async name => {
    const value = await read.call(second.adapter, name)
    if (!changed) { changed = true; second.dispose() }
    return value
  }
  await assert.rejects(createV4PersistedWalFenceAssertion(second.input)(),
    V4ReencryptionSyncFencedError)
})
