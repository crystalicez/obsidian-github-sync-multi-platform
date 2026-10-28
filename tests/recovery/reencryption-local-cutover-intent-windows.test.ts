import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { join, resolve, sep } from "node:path"
import {
  createEmptyV4LocalIndex, loadV4LocalIndex, saveV4LocalIndex,
  type V4LocalIndexAdapter,
} from "../../src/lib/v4/local-index"
import { prepareV4ReencryptionLocalCutoverIntent } from "../../src/lib/v4/reencryption-local-cutover-intent"

test("D135 Windows filesystem: lost intent write acknowledgement preserves Source/Shadow and denies restart replay", {
  skip: process.platform !== "win32",
}, async () => {
  const temp = await mkdtemp(join(process.cwd(), ".tmp", "d135-cutover-intent-"))
  const absolute = (path: string) => {
    const found = resolve(temp, path.replaceAll("/", sep))
    if (!found.startsWith(temp + sep)) throw Error("outside disposable test directory")
    return found
  }
  const root = "private/index"
  const runId = "winrun12345"
  const shadow = root + "-rekey-" + runId
  const intentPath = root + "-rekey-intent-" + runId + "/intent.json"
  const sourceSha = "a".repeat(40)
  const destinationSha = "b".repeat(40)
  const src = "owner/repo#main"
  const dst = "owner/repo#rekey/new"
  let loseAcknowledgement = false
  const adapter: V4LocalIndexAdapter = {
    async exists(path) {
      try { await stat(absolute(path)); return true }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error }
    },
    async mkdir(path) { await mkdir(absolute(path), { recursive: true }) },
    async write(path, value) {
      await writeFile(absolute(path), value, "utf8")
      if (loseAcknowledgement && path === intentPath) throw Error("simulated lost write acknowledgement")
    },
    async read(path) { return readFile(absolute(path), "utf8") },
  }
  const make = (repoId: string, sha: string) => {
    const index = createEmptyV4LocalIndex({ repoId, deviceId: "device1", mode: "encrypted" })
    index.remoteCommitSha = sha
    return index
  }
  const input = {
    adapter, activeIndexRoot: root, runId,
    sourceRepoId: src, backupRepoId: "owner/repo#backup/old", destinationRepoId: dst,
    sourceCommitSha: sourceSha, destinationCommitSha: destinationSha,
    sourcePassphraseSecretId: "old-secret", destinationPassphraseSecretId: "new-secret",
    deviceId: "device1", walGeneration: 4,
    assertExclusiveInitiatorLease: async () => {},
    assertCrashDurable: async () => {},
  }
  try {
    await saveV4LocalIndex(adapter, root, make(src, sourceSha))
    await saveV4LocalIndex(adapter, shadow, make(dst, destinationSha))
    const sourceBytes = await readFile(absolute(root + "/index.json"))
    const shadowBytes = await readFile(absolute(shadow + "/index.json"))
    loseAcknowledgement = true
    await assert.rejects(() => prepareV4ReencryptionLocalCutoverIntent(input), /lost write acknowledgement/)
    assert.deepEqual(await readFile(absolute(root + "/index.json")), sourceBytes)
    assert.deepEqual(await readFile(absolute(shadow + "/index.json")), shadowBytes)
    assert.equal((await loadV4LocalIndex(adapter, root)).repoId, src)
    assert.equal((await loadV4LocalIndex(adapter, shadow)).repoId, dst)
    assert.equal(await adapter.exists(intentPath), true)
    loseAcknowledgement = false
    await assert.rejects(() => prepareV4ReencryptionLocalCutoverIntent(input), /existing|manual recovery/i)
    assert.deepEqual(await readFile(absolute(root + "/index.json")), sourceBytes)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})
