import assert from "node:assert/strict"
import test from "node:test"
import { V4PluginRuntime } from "../../src/lib/v4/runtime"
import { V4SyncCoordinator } from "../../src/lib/v4/sync-coordinator"
import { V4KeyringCache } from "../../src/lib/v4/keyring-cache"
import type { V4Keyring } from "../../src/lib/v4/crypto"
import { DEFAULT_SETTINGS } from "../../src/setting"

function deferred() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

function runtimeWithSecretAndCoordinator(mode: "reject" | "complete" | "idle") {
  const plugin = {
    app: { vault: { configDir: ".obsidian" } },
    manifest: { id: "runtime-dispose-test" },
    settings: { ...DEFAULT_SETTINGS },
    ignoredFiles: new Set<string>(),
    enableWatch() {},
    addIgnoredFile() {},
    removeIgnoredFile() {},
  }
  const runtime = new V4PluginRuntime(plugin as never)
  const internal = runtime as unknown as {
    coordinator: V4SyncCoordinator
    keyringCache: V4KeyringCache
  }
  const keys: V4Keyring = {
    masterKey: new Uint8Array([0x61]),
    pathKey: new Uint8Array([0x62]),
    contentKey: new Uint8Array([0x63]),
    indexKey: new Uint8Array([0x64]),
    journalKey: new Uint8Array([0x65]),
  }
  const barrier = deferred()
  let executions = 0
  internal.coordinator = new V4SyncCoordinator({
    execute: async () => {
      executions++
      await barrier.promise
      if (mode === "reject") throw new Error("unexpected fatal Sync executor error")
      return { changedFiles: 0 }
    },
  })
  const prepared = internal.keyringCache.get({
    repoId: "repo#main", salt: "salt", iterations: 600_000, mode: "encrypted", credentialGeneration: 0,
  }, async () => keys)
  const allSecrets = () => Object.values(keys).map(bytes => bytes[0])
  return { runtime, internal, prepared, barrier, allSecrets, get executions() { return executions } }
}

test("D159 shutdown observes unexpected active Sync rejection and zeros all keyring bytes only after settlement", async () => {
  const fixture = runtimeWithSecretAndCoordinator("reject")
  await fixture.prepared
  const running = fixture.internal.coordinator.run({ operation: "normal", trigger: "manual" })
  assert.equal(fixture.executions, 1)
  fixture.runtime.dispose()
  assert.equal(fixture.internal.coordinator.isSyncing, true)
  assert.deepEqual(fixture.allSecrets(), [0x61, 0x62, 0x63, 0x64, 0x65],
    "do not zero key material while active Sync may still need it")
  fixture.barrier.release()
  await assert.rejects(running, /unexpected fatal Sync executor error/u,
    "original explicitly requested operation still reports its own fatal error")
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(fixture.allSecrets(), [0, 0, 0, 0, 0],
    "post-failure shutdown must clear all five secret byte arrays")
  assert.equal((await fixture.internal.coordinator.run({ operation: "normal", trigger: "manual" })).status, "skipped")
  assert.equal(fixture.executions, 1, "shutdown never retries an unknown remote write")
})

test("D159 shutdown after successful in-flight Sync defers zeroization until the operation completes", async () => {
  const fixture = runtimeWithSecretAndCoordinator("complete")
  await fixture.prepared
  const running = fixture.internal.coordinator.run({ operation: "normal", trigger: "manual" })
  fixture.runtime.dispose()
  assert.deepEqual(fixture.allSecrets(), [0x61, 0x62, 0x63, 0x64, 0x65])
  fixture.barrier.release()
  assert.equal((await running).status, "completed")
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(fixture.allSecrets(), [0, 0, 0, 0, 0])
  fixture.runtime.dispose()
  assert.equal(fixture.executions, 1)
})

test("D159 shutdown when idle clears owned keys without starting a Sync", async () => {
  const fixture = runtimeWithSecretAndCoordinator("idle")
  await fixture.prepared
  fixture.runtime.dispose()
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(fixture.allSecrets(), [0, 0, 0, 0, 0])
  assert.equal(fixture.executions, 0)
})
