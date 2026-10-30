import assert from "node:assert/strict"
import test from "node:test"
import { mkdir, mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import { V4ReencryptionSyncFencedError, V4_REENCRYPTION_SYNC_FENCE_ROOT,
  armV4ReencryptionSyncFence, assertV4ReencryptionSyncFenceClear } from "../../src/lib/v4/reencryption-sync-fence"
import type { V4LocalIndexAdapter } from "../../src/lib/v4/local-index"

const root = V4_REENCRYPTION_SYNC_FENCE_ROOT
const path = root + "/active.json"

function fixture() {
  const files = new Map<string, string>()
  const dirs = new Set<string>()
  const writes: string[] = []
  let leases = 0
  const adapter: V4LocalIndexAdapter = {
    async exists(candidate) { return dirs.has(candidate) || files.has(candidate) },
    async mkdir(candidate) { dirs.add(candidate) },
    async read(candidate) {
      const content = files.get(candidate)
      if (content === undefined) throw new Error("missing")
      return content
    },
    async write(candidate, bytes) { writes.push(candidate); files.set(candidate, bytes) },
  }
  const input = () => ({
    adapter, runId: "d173_run_123", sourceRepoId: "owner/vault#main",
    destinationRepoId: "owner/vault#rekey/2026",
    assertExclusiveInitiatorLease: async () => { leases++ },
  })
  return { files, dirs, writes, adapter, input, get leases() { return leases } }
}

test("D173 clean vault permits Sync; one-shot migration fence blocks all future Sync on restart", async () => {
  const f = fixture()
  await assertV4ReencryptionSyncFenceClear(f.adapter)
  const receipt = await armV4ReencryptionSyncFence(f.input())
  assert.deepEqual(receipt, {
    status: "reencryption-sync-fence-armed-uncommitted",
    localCutoverAuthorized: false, resumeSyncAuthorized: false,
    rollbackAuthorized: false, oldPassphraseCleanupAuthorized: false,
  })
  assert.deepEqual(f.writes, [path])
  assert.equal(f.dirs.has(root), true)
  assert.deepEqual(JSON.parse(f.files.get(path)!), {
    schemaVersion: 1, phase: "migration-fenced-uncommitted", runId: "d173_run_123",
    sourceRepoId: "owner/vault#main", destinationRepoId: "owner/vault#rekey/2026",
  })
  assert.equal(f.leases, 3)
  await assert.rejects(() => assertV4ReencryptionSyncFenceClear(f.adapter), V4ReencryptionSyncFencedError)
  await assert.rejects(() => armV4ReencryptionSyncFence(f.input()), V4ReencryptionSyncFencedError)
  assert.deepEqual(f.writes, [path])
})

test("D173 torn mkdir, missing marker, corrupted record, and failed exists all block Sync without parsing", async () => {
  const f = fixture()
  f.dirs.add(root)
  await assert.rejects(() => assertV4ReencryptionSyncFenceClear(f.adapter), /Re-encryption is pending/)
  f.files.set(path, "{damaged")
  await assert.rejects(() => assertV4ReencryptionSyncFenceClear(f.adapter), /Re-encryption is pending/)
  f.dirs.delete(root)
  await assert.rejects(() => assertV4ReencryptionSyncFenceClear(f.adapter), /Re-encryption is pending/)
  f.files.delete(path)
  await assert.rejects(() => assertV4ReencryptionSyncFenceClear({
    async exists() { throw new Error("filesystem read failed") },
  }), V4ReencryptionSyncFencedError)
  await assert.rejects(() => assertV4ReencryptionSyncFenceClear({
    async exists() { return undefined as never },
  }), V4ReencryptionSyncFencedError)
  await assertV4ReencryptionSyncFenceClear(f.adapter)
})

test("D173 uncertain marker write remains a permanent Sync fence and never retries automatically", async () => {
  const f = fixture()
  const originalWrite = f.adapter.write
  f.adapter.write = async (candidate, bytes) => {
    await originalWrite(candidate, bytes)
    throw Error("write acknowledgement missing")
  }
  await assert.rejects(() => armV4ReencryptionSyncFence(f.input()), /write acknowledgement missing/)
  assert.equal(f.files.has(path), true)
  await assert.rejects(() => assertV4ReencryptionSyncFenceClear(f.adapter), V4ReencryptionSyncFencedError)
  await assert.rejects(() => armV4ReencryptionSyncFence(f.input()), V4ReencryptionSyncFencedError)
  assert.deepEqual(f.writes, [path])
})

test("D173 invalid repository identity refuses any fence or directory write", async () => {
  const f = fixture()
  for (const candidate of [
    { runId: "../cross" }, { sourceRepoId: "owner/vault#main", destinationRepoId: "other/vault#rekey/2026" },
    { destinationRepoId: "owner/vault#main" }, { sourceRepoId: "" },
  ]) {
    await assert.rejects(() => armV4ReencryptionSyncFence({ ...f.input(), ...candidate }), /Invalid/)
  }
  assert.deepEqual(f.writes, [])
  assert.equal(f.dirs.size, 0)
})

test("D173 real Windows filesystem: independently reopened adapter blocks Sync after interrupted fence write", async () => {
  const parent = join(process.cwd(), ".tmp")
  await mkdir(parent, { recursive: true })
  const directory = await mkdtemp(join(parent, "d173-sync-fence-"))
  const makeAdapter = (): V4LocalIndexAdapter => ({
    async exists(candidate) {
      try {
        await stat(join(directory, candidate))
        return true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
        throw error
      }
    },
    async mkdir(candidate) { await mkdir(join(directory, candidate)) },
    async write(candidate, value) {
      await writeFile(join(directory, candidate), value)
      throw Error("simulated lost Windows file write acknowledgement")
    },
    async read(candidate) { return readFile(join(directory, candidate), "utf8") },
  })
  try {
    await assert.rejects(() => armV4ReencryptionSyncFence({
      ...fixture().input(), adapter: makeAdapter(),
    }), /acknowledgement/)
    const reopened = makeAdapter()
    assert.equal(await readFile(join(directory, path), "utf8").then(value => JSON.parse(value).runId), "d173_run_123")
    await assert.rejects(() => assertV4ReencryptionSyncFenceClear(reopened), V4ReencryptionSyncFencedError)
    await assert.rejects(() => armV4ReencryptionSyncFence({
      ...fixture().input(), adapter: reopened,
    }), V4ReencryptionSyncFencedError)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("D173 in-process overlap has exactly one fence writer", async () => {
  const f = fixture()
  let entered!: () => void
  let release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  const input = f.input()
  let first = true
  input.assertExclusiveInitiatorLease = async () => {
    if (first) { first = false; entered(); await held }
  }
  const inFlight = armV4ReencryptionSyncFence(input)
  await started
  try {
    await assert.rejects(() => armV4ReencryptionSyncFence(f.input()), V4ReencryptionSyncFencedError)
  } finally { release() }
  assert.equal((await inFlight).status, "reencryption-sync-fence-armed-uncommitted")
  assert.deepEqual(f.writes, [path])
})
