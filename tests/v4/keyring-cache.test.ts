import test from "node:test"
import assert from "node:assert/strict"
import { V4KeyringCache, type V4KeyringCacheKey } from "../../src/lib/v4/keyring-cache"
import type { V4Keyring } from "../../src/lib/v4/crypto"

function key(generation = 1): V4KeyringCacheKey {
  return { repoId: "owner/repo#main", salt: "salt-token", iterations: 600_000, mode: "encrypted", credentialGeneration: generation }
}

function makeKeyring(seed: number): V4Keyring {
  const bytes = (offset: number) => new Uint8Array(32).fill(seed + offset)
  return { masterKey: bytes(0), pathKey: bytes(1), contentKey: bytes(2), indexKey: bytes(3), journalKey: bytes(4) }
}

test("v4 keyring cache shares one in-flight derivation for the same non-secret configuration key", async () => {
  const cache = new V4KeyringCache()
  let derives = 0
  let release!: () => void
  const blocker = new Promise<void>(resolve => { release = resolve })
  const derive = async () => { derives++; await blocker; return makeKeyring(10) }
  const a = cache.get(key(), derive)
  const b = cache.get(key(), derive)
  assert.equal(derives, 1)
  release()
  assert.equal(await a, await b)
  assert.equal(derives, 1)
})

test("v4 keyring cache reuses a derived keyring across CAS attempts and invalidates by credential generation", async () => {
  const cache = new V4KeyringCache()
  let derives = 0
  const derive = async () => makeKeyring(++derives)
  const first = await cache.get(key(4), derive)
  const second = await cache.get(key(4), derive)
  const changed = await cache.get(key(5), derive)
  assert.equal(first, second)
  assert.notEqual(first, changed)
  assert.equal(derives, 2)
})

test("v4 keyring cache keys never require passphrase text", () => {
  const cacheKey = key()
  assert.deepEqual(Object.keys(cacheKey).sort(), ["credentialGeneration", "iterations", "mode", "repoId", "salt"])
  assert.equal("passphrase" in cacheKey, false)
})

test("v4 keyring cache best-effort clears owned key bytes when disposed", async () => {
  const cache = new V4KeyringCache()
  const keyring = makeKeyring(20)
  await cache.get(key(), async () => keyring)
  cache.dispose()
  for (const bytes of Object.values(keyring)) assert.deepEqual([...bytes], new Array(32).fill(0))
})
