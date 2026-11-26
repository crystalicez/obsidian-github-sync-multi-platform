import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { createEmptyV4LocalIndex, loadV4LocalIndex, saveV4LocalIndex } from "../../src/lib/v4/local-index"
import { V4_RUNTIME_INDEX_ROOT, V4_REENCRYPTION_RUNTIME_ROUTE_ROOT } from "../../src/lib/v4/reencryption-index-root"
import { planV4ReencryptionSeparatedRoots } from "../../src/lib/v4/reencryption-separated-selector"
import { armV4ReencryptionSyncFence, assertV4ReencryptionSyncFenceClear } from "../../src/lib/v4/reencryption-sync-fence"
import { V4_INSTALLED_CUTOVER_INTENT_PATH } from "../../src/lib/v4/reencryption-installed-settings-cutover"
import { activateV4InstalledDestinationIndex, resolveV4InstalledActiveIndexRoot, V4_INSTALLED_ACTIVE_ROUTE_PATH } from "../../src/lib/v4/reencryption-installed-active-route"

// Physical artifacts with deterministic I/O fault injection; trusted recovery
// proof is a fixture here, independently exercised by the installed Runtime test.
test("D521 selector and active route fail closed at every physical write boundary", async () => {
  for (const fault of ["selector-torn", "selector-checkpoint", "route-torn", "route-ack-lost", "none"] as const) {
    await mkdir(".tmp", { recursive: true })
    const root = await mkdtemp(path.resolve(".tmp", "d521-active-route-"))
    const abs = (p: string) => path.join(root, p)
    const identity = {
      runId: "d521-selector-fault", deviceId: "device",
      sourceRepoId: "owner/repo#source", backupRepoId: "owner/repo#backup", destinationRepoId: "owner/repo#destination",
      pinnedSourceCommitSha: "a".repeat(40), sourceTreeSha: "b".repeat(40),
      destinationCommitSha: "c".repeat(40), destinationTreeSha: "d".repeat(40),
      finalWalGeneration: 12, verifiedFileCount: 0, verifiedPlaintextBytes: "0",
      physicalRepositoryId: 1, defaultBranch: "main",
    }
    const roots = planV4ReencryptionSeparatedRoots(V4_RUNTIME_INDEX_ROOT, identity.runId)
    let inject = false
    let checkpoints = 0
    const adapter = {
      read: (p: string) => readFile(abs(p), "utf8"),
      write: async (p: string, text: string) => {
        if (inject && ((fault === "selector-torn" && p === roots.selectorPath) || (fault === "route-torn" && p === V4_INSTALLED_ACTIVE_ROUTE_PATH))) {
          await writeFile(abs(p), text.slice(0, 12))
          throw Error("Torn test write")
        }
        await writeFile(abs(p), text)
        if (inject && fault === "route-ack-lost" && p === V4_INSTALLED_ACTIVE_ROUTE_PATH) throw Error("Lost test acknowledgement")
      },
      mkdir: async (p: string) => { await mkdir(abs(p), { recursive: true }) },
      exists: (p: string) => stat(abs(p)).then(() => true, () => false),
    }
    const key = new Uint8Array(32).fill(9)
    const data = { settings: { githubBranch: "destination", encryptionPassphraseSecretId: "destination-id" } }
    let settings: unknown = data
    const input = {
      adapter, identity, key, repoId: identity.destinationRepoId, deviceId: identity.deviceId, physicalRepositoryId: 1,
      destinationSecretId: "destination-id", tokenSecretId: "token-id", readSettings: async () => settings,
      assertOwner: () => {}, assertProof: async () => { await assert.rejects(() => assertV4ReencryptionSyncFenceClear(adapter)) },
      checkpoint: async () => { if (++checkpoints === 1 && inject && fault === "selector-checkpoint") throw Error("Lost selector checkpoint") },
    }
    try {
      await armV4ReencryptionSyncFence({ adapter, ...identity, assertExclusiveInitiatorLease: async () => {} })
      await adapter.mkdir(V4_REENCRYPTION_RUNTIME_ROUTE_ROOT)
      await adapter.write(V4_INSTALLED_CUTOVER_INTENT_PATH, "fixture-authenticated-intent")
      for (const [indexRoot, repoId, sha] of [[roots.sourceIndexRoot, identity.sourceRepoId, identity.pinnedSourceCommitSha],
        [roots.shadowIndexRoot, identity.destinationRepoId, identity.destinationCommitSha]] as const) {
        const index = createEmptyV4LocalIndex({ repoId, deviceId: identity.deviceId, mode: "encrypted" })
        index.remoteCommitSha = sha
        index.epoch = 1
        index.generation = 1
        await saveV4LocalIndex(adapter, indexRoot, index)
      }
      const sourceBefore = await loadV4LocalIndex(adapter, roots.sourceIndexRoot)
      inject = true
      if (fault === "none") assert.equal(await activateV4InstalledDestinationIndex(input), roots.shadowIndexRoot)
      else await assert.rejects(() => activateV4InstalledDestinationIndex(input))
      inject = false
      if (fault === "selector-checkpoint") {
        assert.equal(await adapter.exists(V4_INSTALLED_ACTIVE_ROUTE_PATH), false)
        await assert.rejects(() => resolveV4InstalledActiveIndexRoot(input))
        assert.equal(await activateV4InstalledDestinationIndex(input), roots.shadowIndexRoot)
      } else if (fault === "selector-torn" || fault === "route-torn") {
        await assert.rejects(() => resolveV4InstalledActiveIndexRoot(input))
        await assert.rejects(() => activateV4InstalledDestinationIndex(input))
        assert.deepEqual(await loadV4LocalIndex(adapter, roots.sourceIndexRoot), sourceBefore)
        continue
      }
      // Complete identical selector + commit record is the commit point, even
      // if the write returned an error. Re-observe; never blindly rewrite it.
      assert.equal(await resolveV4InstalledActiveIndexRoot(input), roots.shadowIndexRoot)
      await assert.rejects(() => activateV4InstalledDestinationIndex(input))
      await assert.rejects(() => resolveV4InstalledActiveIndexRoot({ ...input, key: new Uint8Array(32) }))
      await assert.rejects(() => resolveV4InstalledActiveIndexRoot({ ...input, physicalRepositoryId: 2 }))
      settings = { settings: { githubBranch: "source" } }
      await assert.rejects(() => resolveV4InstalledActiveIndexRoot(input))
      settings = data
      const originalSelector = await adapter.read(roots.selectorPath)
      await adapter.write(roots.selectorPath, originalSelector.slice(0, -2))
      await assert.rejects(() => resolveV4InstalledActiveIndexRoot(input))
      await adapter.write(roots.selectorPath, originalSelector)
      assert.equal(await resolveV4InstalledActiveIndexRoot(input), roots.shadowIndexRoot)
      assert.deepEqual(await loadV4LocalIndex(adapter, roots.sourceIndexRoot), sourceBefore)
      await assert.rejects(() => assertV4ReencryptionSyncFenceClear(adapter))
    } finally {
      key.fill(0)
      await rm(root, { recursive: true, force: true })
    }
  }
})
