import assert from "node:assert/strict"
import test from "node:test"
import { createHash } from "node:crypto"
import { createEmptyV4LocalIndex, loadV4LocalIndex, saveV4LocalIndex, type V4LocalIndexAdapter } from "../../src/lib/v4/local-index"
import { prepareV4ReencryptionLocalCutoverIntent } from "../../src/lib/v4/reencryption-local-cutover-intent"

const source = "owner/repo#main"
const backup = "owner/repo#backup/run12345"
const destination = "owner/repo#rekey/run12345"
const oldSha = "a".repeat(40)
const newSha = "b".repeat(40)
const root = "private/v4-index"
const runId = "run12345"
const shadow = root + "-rekey-" + runId
const intentRoot = root + "-rekey-intent-" + runId

function store() {
  const files = new Map<string, string>()
  const dirs = new Set<string>()
  const writes: string[] = []
  const adapter: V4LocalIndexAdapter = {
    async read(path) { const text = files.get(path); if (text === undefined) throw Error("file not found"); return text },
    async write(path, value) { writes.push(path); files.set(path, value) },
    async exists(path) { return files.has(path) || dirs.has(path) },
    async mkdir(path) { dirs.add(path) },
  }
  const makeIndex = (repoId: string, sha: string) => {
    const index = createEmptyV4LocalIndex({ repoId, deviceId: "device1", mode: "encrypted" })
    index.remoteCommitSha = sha
    return index
  }
  const seed = async () => {
    await saveV4LocalIndex(adapter, root, makeIndex(source, oldSha))
    await saveV4LocalIndex(adapter, shadow, makeIndex(destination, newSha))
  }
  const input = () => ({
    adapter, activeIndexRoot: root, runId,
    sourceRepoId: source, backupRepoId: backup, destinationRepoId: destination,
    sourceCommitSha: oldSha, destinationCommitSha: newSha,
    sourcePassphraseSecretId: "old-secret-id", destinationPassphraseSecretId: "new-secret-id",
    deviceId: "device1", walGeneration: 7,
    assertExclusiveInitiatorLease: async () => {},
    assertCrashDurable: async () => {},
  })
  return { files, dirs, writes, adapter, seed, input }
}

test("D135 prepares nonsecret intent independently, retaining both local indices and denying cutover", async () => {
  const s = store()
  await s.seed()
  const originals = new Map(s.files)
  const start = s.writes.length
  const result = await prepareV4ReencryptionLocalCutoverIntent(s.input())
  assert.deepEqual(result, {
    status: "local-cutover-intent-prepared-uncommitted",
    intentPath: intentRoot + "/intent.json",
    recordSha256: result.recordSha256,
    localCutoverAuthorized: false,
    resumeSyncAuthorized: false,
    oldPassphraseCleanupAuthorized: false,
  })
  assert.deepEqual(s.writes.slice(start), [intentRoot + "/intent.json"])
  for (const [path, text] of originals) assert.equal(s.files.get(path), text, path)
  const stored = JSON.parse(s.files.get(result.intentPath)!) as Record<string, unknown>
  assert.equal(stored.phase, "prepared-uncommitted")
  assert.equal(stored.sourceRepoId, source)
  assert.equal(stored.backupRepoId, backup)
  assert.equal(stored.destinationRepoId, destination)
  assert.equal(stored.sourceIndexRoot, root)
  assert.equal(stored.destinationIndexRoot, shadow)
  assert.equal(stored.sourceCommitSha, oldSha)
  assert.equal(stored.destinationCommitSha, newSha)
  assert.equal(stored.sourcePassphraseSecretId, "old-secret-id")
  assert.equal(stored.destinationPassphraseSecretId, "new-secret-id")
  assert.equal(stored.walGeneration, 7)
  assert.equal(stored.recordSha256, result.recordSha256)
  const { recordSha256: _digest, ...payload } = stored
  assert.equal(result.recordSha256, createHash("sha256").update(JSON.stringify(payload)).digest("hex"))
  assert.equal((await loadV4LocalIndex(s.adapter, root)).repoId, source)
  assert.equal((await loadV4LocalIndex(s.adapter, shadow)).repoId, destination)
  await assert.rejects(() => prepareV4ReencryptionLocalCutoverIntent(s.input()), /existing|manual recovery/i)
})

test("D135 lost write acknowledgement makes intent ambiguous and never reusable", async () => {
  const s = store()
  await s.seed()
  const base = s.adapter
  const adapter: V4LocalIndexAdapter = {
    ...base,
    async write(path, value) {
      await base.write(path, value)
      if (path === intentRoot + "/intent.json") throw Error("lost acknowledgement")
    },
  }
  await assert.rejects(() => prepareV4ReencryptionLocalCutoverIntent({ ...s.input(), adapter }), /lost acknowledgement/)
  assert.equal(await s.adapter.exists(intentRoot), true)
  await assert.rejects(() => prepareV4ReencryptionLocalCutoverIntent(s.input()), /existing|manual recovery/i)
  assert.equal((await loadV4LocalIndex(s.adapter, root)).repoId, source)
})

test("D135 forged readback with a recomputed SHA256 cannot change intended Secret ID", async () => {
  const s = store()
  await s.seed()
  const base = s.adapter
  const adapter: V4LocalIndexAdapter = {
    ...base,
    async read(path) {
      const raw = await base.read(path)
      if (path !== intentRoot + "/intent.json") return raw
      const forged = JSON.parse(raw) as Record<string, unknown>
      forged.destinationPassphraseSecretId = "forged-secret"
      delete forged.recordSha256
      forged.recordSha256 = createHash("sha256").update(JSON.stringify(forged)).digest("hex")
      return JSON.stringify(forged)
    },
  }
  await assert.rejects(() => prepareV4ReencryptionLocalCutoverIntent({ ...s.input(), adapter }), /readback|mismatch|changed/i)
  assert.equal((await loadV4LocalIndex(s.adapter, root)).repoId, source)
})

test("D135 refuses wrong branches, wrong commits, missing indices and invalid intent scope before writes", async () => {
  const s = store()
  await s.seed()
  const base = s.input()
  for (const override of [
    { backupRepoId: source }, { destinationRepoId: backup },
    { destinationCommitSha: oldSha }, { sourceCommitSha: newSha },
    { walGeneration: 0 }, { walGeneration: 1.5 },
    { sourcePassphraseSecretId: "same", destinationPassphraseSecretId: "same" },
    { activeIndexRoot: "../escape" }, { runId: "bad/../run" }, { runId: undefined as never },
    { assertCrashDurable: undefined as never }, { assertExclusiveInitiatorLease: undefined as never },
  ]) {
    const start = s.writes.length
    await assert.rejects(() => prepareV4ReencryptionLocalCutoverIntent({ ...base, ...override }))
    assert.equal(s.writes.length, start)
  }
  const missing = store()
  await assert.rejects(() => prepareV4ReencryptionLocalCutoverIntent(missing.input()), /index|incomplete|missing/i)
  assert.equal(missing.writes.length, 0)
})

test("D135 missing lease, durability failure, and mutated input fail closed", async () => {
  const s = store()
  await s.seed()
  const before = new Map(s.files)
  await assert.rejects(() => prepareV4ReencryptionLocalCutoverIntent({
    ...s.input(), assertExclusiveInitiatorLease: async () => { throw Error("lease unavailable") },
  }), /lease unavailable/)
  assert.deepEqual(s.files, before)
  const broken = store()
  await broken.seed()
  await assert.rejects(() => prepareV4ReencryptionLocalCutoverIntent({
    ...broken.input(), assertCrashDurable: async () => { throw Error("fsync EPERM") },
  }), /EPERM/)
  assert.equal((await loadV4LocalIndex(broken.adapter, root)).repoId, source)
  const mutated = store()
  await mutated.seed()
  const input = mutated.input()
  input.assertExclusiveInitiatorLease = async () => { input.destinationPassphraseSecretId = "mutated-secret" }
  await assert.rejects(() => prepareV4ReencryptionLocalCutoverIntent(input), /changed|mutation/i)
  assert.equal(mutated.writes.length, 2)
})

test("D135 cannot switch persistence adapter or durability callback while an initial lease is awaited", async () => {
  const original = store()
  const redirect = store()
  await original.seed()
  await redirect.seed()
  const changedAdapter = original.input()
  let swapped = false
  changedAdapter.assertExclusiveInitiatorLease = async () => {
    if (!swapped) { swapped = true; changedAdapter.adapter = redirect.adapter }
  }
  await assert.rejects(
    () => prepareV4ReencryptionLocalCutoverIntent(changedAdapter),
    /changed|identity|contract/i,
  )
  assert.equal(original.files.has(intentRoot + "/intent.json"), false)
  assert.equal(redirect.files.has(intentRoot + "/intent.json"), false)

  const s = store()
  await s.seed()
  const changedDurability = s.input()
  let replaced = false
  changedDurability.assertExclusiveInitiatorLease = async () => {
    if (!replaced) {
      replaced = true
      changedDurability.assertCrashDurable = async () => {}
    }
  }
  await assert.rejects(
    () => prepareV4ReencryptionLocalCutoverIntent(changedDurability),
    /changed|identity|contract/i,
  )
  assert.equal(s.files.has(intentRoot + "/intent.json"), false)
})

test("D135 same-adapter overlapping intent attempts cannot both write", async () => {
  const s = store()
  await s.seed()
  let started!: () => void
  let release!: () => void
  const entered = new Promise<void>(resolve => { started = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  let first = true
  const running = prepareV4ReencryptionLocalCutoverIntent({
    ...s.input(),
    assertExclusiveInitiatorLease: async () => {
      if (first) { first = false; started(); await held }
    },
  })
  await entered
  try {
    const written = s.writes.length
    await assert.rejects(() => prepareV4ReencryptionLocalCutoverIntent(s.input()), /concurrent|active/i)
    assert.equal(s.writes.length, written)
  } finally { release() }
  const result = await running
  assert.equal(result.localCutoverAuthorized, false)
})
