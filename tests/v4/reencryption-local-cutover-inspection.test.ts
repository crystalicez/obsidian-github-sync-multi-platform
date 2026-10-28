import assert from "node:assert/strict"
import test from "node:test"
import {
  createEmptyV4LocalIndex, saveV4LocalIndex, type V4LocalIndexAdapter,
} from "../../src/lib/v4/local-index"
import { inspectV4ReencryptionLocalCutoverAfterRestart } from "../../src/lib/v4/reencryption-local-cutover-inspection"

const source = "owner/vault#main"
const destination = "owner/vault#rekey/2026-10-28"
const commitSha = "a".repeat(40)
const sourceSecretId = "passphrase-old-pinned"
const destinationSecretId = "passphrase-new-pinned"
const expected = Object.freeze({
  sourceRepoId: source,
  destinationRepoId: destination,
  destinationCommitSha: commitSha,
  sourcePassphraseSecretId: sourceSecretId,
  destinationPassphraseSecretId: destinationSecretId,
  deviceId: "device-1",
})
const oldSettings = () => ({
  githubOwner: "owner", githubRepo: "vault", githubBranch: "main",
  encryptionMode: "encrypted", encryptionPassphraseSecretId: sourceSecretId,
  vault: "device-1",
})
const newSettings = () => ({
  ...oldSettings(), githubBranch: "rekey/2026-10-28",
  encryptionPassphraseSecretId: destinationSecretId,
})
function sandbox() {
  const stored = new Map<string, string>()
  let writes = 0
  const adapter: V4LocalIndexAdapter = {
    async read(path) {
      const value = stored.get(path)
      if (value === undefined) throw new Error("missing test file")
      return value
    },
    async write(path, text) { writes++; stored.set(path, text) },
    async exists(path) { return stored.has(path) },
    async mkdir() {},
  }
  const secrets = new Map([
    [sourceSecretId, "old-only-never-echo"],
    [destinationSecretId, "new-only-never-echo"],
  ])
  const inspect = (settings: ReturnType<typeof oldSettings>, custom = adapter) =>
    inspectV4ReencryptionLocalCutoverAfterRestart({
      expected, settings, indexAdapter: custom, indexRoot: ".rekey-index",
      getSecret: (id: string) => secrets.get(id) ?? null,
    })
  const persist = async (repoId: string, remoteCommitSha: string) => {
    const index = createEmptyV4LocalIndex({ repoId, mode: "encrypted", deviceId: expected.deviceId })
    index.remoteCommitSha = remoteCommitSha
    await saveV4LocalIndex(adapter, ".rekey-index", index)
  }
  return { stored, adapter, inspect, persist, secrets, getWrites: () => writes }
}

test("D131 read-only restart observer distinguishes old and new consistent snapshots without authorizing Sync or cutover", async () => {
  const box = sandbox()
  await box.persist(source, "b".repeat(40))
  const initialWrites = box.getWrites()
  const old = await box.inspect(oldSettings())
  assert.equal(old.observation, "source-observed")
  assert.equal(old.localCutoverAuthorized, false)
  assert.equal(old.resumeSyncAuthorized, false)
  assert.equal(old.rollbackAuthorized, false)
  assert.equal(old.secretValuesExposed, false)
  assert.equal(box.getWrites(), initialWrites)
  assert.doesNotMatch(JSON.stringify(old), /old-only-never-echo|new-only-never-echo/)
  await box.persist(destination, commitSha)
  const finalWrites = box.getWrites()
  const done = await box.inspect(newSettings())
  assert.equal(done.observation, "destination-observed-unconfirmed")
  assert.equal(done.localCutoverAuthorized, false)
  assert.equal(done.resumeSyncAuthorized, false)
  assert.equal(box.getWrites(), finalWrites)
  assert.doesNotMatch(JSON.stringify(done), /old-only-never-echo|new-only-never-echo/)
})

test("D131 every settings / passphrase ID / index cross-generation split stays unconfirmed", async () => {
  const box = sandbox()
  for (const indexRepo of [source, destination]) {
    await box.persist(indexRepo, indexRepo === destination ? commitSha : "b".repeat(40))
    for (const settingsBranch of ["main", "rekey/2026-10-28"]) {
      for (const secretId of [sourceSecretId, destinationSecretId]) {
        const settings = { ...oldSettings(), githubBranch: settingsBranch, encryptionPassphraseSecretId: secretId }
        const observed = await box.inspect(settings)
        const sourceOk = indexRepo === source && settingsBranch === "main" && secretId === sourceSecretId
        const destOk = indexRepo === destination && settingsBranch === "rekey/2026-10-28" && secretId === destinationSecretId
        assert.equal(observed.observation,
          sourceOk ? "source-observed" : destOk ? "destination-observed-unconfirmed" : "mixed-or-unverifiable")
        assert.equal(observed.localCutoverAuthorized, false)
        assert.equal(observed.resumeSyncAuthorized, false)
        assert.equal(observed.rollbackAuthorized, false)
      }
    }
  }
})

test("D131 missing key, wrong destination commit and corrupted shard/header fail closed without repairing evidence", async () => {
  const box = sandbox()
  await box.persist(destination, commitSha)
  box.secrets.delete(destinationSecretId)
  assert.equal((await box.inspect(newSettings())).observation, "mixed-or-unverifiable")
  box.secrets.set(destinationSecretId, "new-only-never-echo")
  await box.persist(destination, "c".repeat(40))
  assert.equal((await box.inspect(newSettings())).observation, "mixed-or-unverifiable")
  box.stored.set(".rekey-index/index.json", "corrupt-json")
  const before = new Map(box.stored)
  assert.equal((await box.inspect(newSettings())).observation, "mixed-or-unverifiable")
  assert.deepEqual(box.stored, before, "the inspector must never self-heal/corrupt the durable index")
})

test("D131 concurrent settings mutation while index is being read is rejected on return", async () => {
  const box = sandbox()
  await box.persist(destination, commitSha)
  const mutable = newSettings()
  const reader: V4LocalIndexAdapter = {
    ...box.adapter,
    async read(path) {
      mutable.githubBranch = "main"
      return box.adapter.read(path)
    },
  }
  assert.equal((await box.inspect(mutable, reader)).observation, "mixed-or-unverifiable")
})

test("D131 secret lookup that changes live settings cannot leave a stale positive destination observation", async () => {
  const box = sandbox()
  await box.persist(destination, commitSha)
  const mutable = newSettings()
  const observed = await inspectV4ReencryptionLocalCutoverAfterRestart({
    expected, settings: mutable, indexAdapter: box.adapter, indexRoot: ".rekey-index",
    getSecret: id => {
      mutable.githubBranch = "main"
      return box.secrets.get(id) ?? null
    },
  })
  assert.equal(observed.observation, "mixed-or-unverifiable")
  assert.equal(observed.resumeSyncAuthorized, false)
})

test("D131 malformed candidate source / destination / pinned commit / reused key ID rejected before touching storage", async () => {
  const box = sandbox()
  for (const changed of [
    { destinationRepoId: source },
    { destinationRepoId: "elsewhere/vault#rekey/2026-10-28" },
    { destinationCommitSha: "HEAD" },
    { sourcePassphraseSecretId: destinationSecretId },
    { deviceId: "" },
  ]) {
    let calls = 0
    await assert.rejects(() => inspectV4ReencryptionLocalCutoverAfterRestart({
      expected: { ...expected, ...changed }, settings: newSettings(),
      indexAdapter: {
        ...box.adapter,
        async exists(path) { calls++; return box.adapter.exists(path) },
      },
      indexRoot: ".rekey-index",
      getSecret: (id: string) => box.secrets.get(id) ?? null,
    }))
    assert.equal(calls, 0, "invalid cutover evidence cannot probe storage")
  }
})

test("D131 storage I/O errors fail closed instead of silently assuming a clean source or destination", async () => {
  const box = sandbox()
  await box.persist(source, "b".repeat(40))
  await assert.rejects(() => box.inspect(oldSettings(), {
    ...box.adapter,
    async read() { throw new Error("injected disk I/O failure") },
  }), /disk I\/O failure/)
})
