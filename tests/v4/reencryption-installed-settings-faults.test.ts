import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { createEmptyV4LocalIndex, saveV4LocalIndex } from "../../src/lib/v4/local-index"
import { V4_RUNTIME_INDEX_ROOT } from "../../src/lib/v4/reencryption-index-root"
import { planV4ReencryptionSeparatedRoots } from "../../src/lib/v4/reencryption-separated-selector"
import { armV4ReencryptionSyncFence, assertV4ReencryptionSyncFenceClear } from "../../src/lib/v4/reencryption-sync-fence"
import { stageV4InstalledDestinationSecret } from "../../src/lib/v4/reencryption-installed-secret"
import { inspectV4InstalledSettingsCutover, V4_INSTALLED_CUTOVER_INTENT_PATH, writeV4InstalledDestinationSettings } from "../../src/lib/v4/reencryption-installed-settings-cutover"

// Real filesystem data.json and index/intent artifacts; deterministic injected
// I/O errors are not evidence of native Obsidian or actual power-loss behavior.
test("D520 Settings intent survives errors before, during and after physical data.json write", async () => {
  for (const fault of ["intent-checkpoint", "before-save", "torn-save", "after-save"] as const) {
    await mkdir(".tmp", { recursive: true })
    const root = await mkdtemp(path.resolve(".tmp", "d520-settings-fault-"))
    const abs = (p: string) => path.join(root, p)
    const adapter = {
      read: (p: string) => readFile(abs(p), "utf8"),
      write: (p: string, text: string) => writeFile(abs(p), text),
      mkdir: async (p: string) => { await mkdir(abs(p), { recursive: true }) },
      exists: (p: string) => stat(abs(p)).then(() => true, () => false),
    }
    const identity = {
      runId: "d520-settings-fault", deviceId: "device",
      sourceRepoId: "owner/repo#source", backupRepoId: "owner/repo#backup", destinationRepoId: "owner/repo#destination",
      pinnedSourceCommitSha: "a".repeat(40), sourceTreeSha: "b".repeat(40),
      destinationCommitSha: "c".repeat(40), destinationTreeSha: "d".repeat(40),
      finalWalGeneration: 12, verifiedFileCount: 0, verifiedPlaintextBytes: "0",
      physicalRepositoryId: 1, defaultBranch: "main",
    }
    const secrets = new Map([["old", "old-secret"], ["token", "token-value"]])
    const storage = { getSecret: (id: string) => secrets.get(id) ?? null, setSecret: (id: string, value: string) => { secrets.set(id, value) } }
    const owner = { storage, sourcePassphraseSecretId: "old", githubTokenSecretId: "token",
      oldPassphrase: "old-secret", token: "token-value", assertOwner: () => {} }
    const key = new Uint8Array(32).fill(7)
    try {
      await armV4ReencryptionSyncFence({ adapter, ...identity, assertExclusiveInitiatorLease: async () => {} })
      const roots = planV4ReencryptionSeparatedRoots(V4_RUNTIME_INDEX_ROOT, identity.runId)
      for (const [indexRoot, repoId] of [[roots.sourceIndexRoot, identity.sourceRepoId], [roots.shadowIndexRoot, identity.destinationRepoId]] as const) {
        await saveV4LocalIndex(adapter, indexRoot, createEmptyV4LocalIndex({ repoId, deviceId: identity.deviceId, mode: "encrypted" }))
      }
      const staged = await stageV4InstalledDestinationSecret({ adapter, identity, owner, key, newPassphrase: "new-secret",
        assertLease: async () => {}, checkpoint: async () => {} })
      const original = JSON.stringify({ settings: { githubOwner: "owner", githubRepo: "repo", githubBranch: "source",
        encryptionMode: "encrypted", vault: identity.deviceId, githubTokenSecretId: "token", encryptionPassphraseSecretId: "old",
        pbkdf2Iterations: 600_000, syncOnStart: false } })
      await writeFile(abs("data.json"), original)
      let writes = 0
      const io = {
        read: async () => JSON.parse(await readFile(abs("data.json"), "utf8")) as unknown,
        write: async (value: unknown) => {
          writes++
          assert.equal(await adapter.exists(V4_INSTALLED_CUTOVER_INTENT_PATH), true)
          if (fault === "before-save") throw Error("save refused")
          await writeFile(abs("data.json"), fault === "torn-save" ? '{"settings":' : JSON.stringify(value))
          throw Error("save acknowledgement lost")
        },
      }
      const input = { adapter, identity, owner, key, io, originalData: original, destinationIterations: 700_000,
        assertProof: async () => { await assert.rejects(() => assertV4ReencryptionSyncFenceClear(adapter)) },
        checkpoint: async () => { if (fault === "intent-checkpoint") throw Error("intent checkpoint failed") },
      }
      await assert.rejects(() => writeV4InstalledDestinationSettings(input))
      const intent = await adapter.read(V4_INSTALLED_CUTOVER_INTENT_PATH)
      assert.equal(writes, fault === "intent-checkpoint" ? 0 : 1)
      const observation = await inspectV4InstalledSettingsCutover({ adapter, identity, key, sourceSecretId: "old", io })
      assert.equal(observation, fault === "torn-save" ? "manual-recovery-required" :
        fault === "after-save" ? "destination-settings-observed-fenced" : "source-settings-intent-pending")
      await assert.rejects(() => writeV4InstalledDestinationSettings(input))
      assert.equal(writes, fault === "intent-checkpoint" ? 0 : 1)
      assert.equal(await adapter.read(V4_INSTALLED_CUTOVER_INTENT_PATH), intent)
      assert.equal(secrets.get("old"), "old-secret")
      assert.equal(secrets.get("token"), "token-value")
      assert.equal(secrets.get(staged.destinationPassphraseSecretId), "new-secret")
      await assert.rejects(() => assertV4ReencryptionSyncFenceClear(adapter))
    } finally {
      key.fill(0)
      await rm(root, { recursive: true, force: true })
    }
  }
})
