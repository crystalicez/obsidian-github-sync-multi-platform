import assert from "node:assert/strict"
import test from "node:test"

import { deriveV4BootstrapRecoveryKey, deriveV4Keyring } from "../../src/lib/v4/crypto"
import type { V4LocalIndexAdapter } from "../../src/lib/v4/local-index"
import { createV4RecoveryStore, V4RecoveryRequiredError } from "../../src/lib/v4/recovery-store"

class MemoryAdapter implements V4LocalIndexAdapter {
  readonly values = new Map<string, string>()
  async read(path: string) { return this.values.get(path)! }
  async write(path: string, value: string) { this.values.set(path, value) }
  async exists(path: string) { return this.values.has(path) }
  async mkdir() {}
}

const salt = (seed: number) => Uint8Array.from({ length: 16 }, (_, index) => (seed + index) & 0xff)

test("speculative encrypted recovery key is stable across competing remote KDF salts", async () => {
  const repoId = "owner/repo#main"
  const passphrase = "bootstrap-race-passphrase"
  const [loser, winner, bootstrapOne, bootstrapTwo] = await Promise.all([
    deriveV4Keyring({ passphrase, repoId, salt: salt(1), iterations: 1_000 }),
    deriveV4Keyring({ passphrase, repoId, salt: salt(101), iterations: 1_000 }),
    deriveV4BootstrapRecoveryKey({ passphrase, repoId, iterations: 1_000 }),
    deriveV4BootstrapRecoveryKey({ passphrase, repoId, iterations: 1_000 }),
  ])

  assert.notDeepEqual(loser.journalKey, winner.journalKey)
  assert.deepEqual(bootstrapOne, bootstrapTwo)

  const adapter = new MemoryAdapter()
  const speculative = createV4RecoveryStore({ adapter, root: "recovery", repoId, payloadKey: bootstrapOne })
  await speculative.save({
    runId: "run-bootstrap",
    journalId: "journal-bootstrap",
    phase: "publish-intent",
    expectedRemoteHead: "bootstrap",
    candidateCommitSha: "candidate",
    payload: { mutations: [], completedMutationIds: [] },
  })

  const winnerKeyStore = createV4RecoveryStore({ adapter, root: "recovery", repoId, payloadKey: winner.journalKey })
  await assert.rejects(() => winnerKeyStore.load(), V4RecoveryRequiredError)

  const bootstrapFallback = createV4RecoveryStore({ adapter, root: "recovery", repoId, payloadKey: bootstrapTwo })
  const recovered = await bootstrapFallback.load()
  assert.equal(recovered?.header.runId, "run-bootstrap")
  assert.deepEqual(recovered?.payload, { mutations: [], completedMutationIds: [] })
})

test("a newer bootstrap-encrypted recovery generation cannot be hidden behind an older payloadless terminal", async () => {
  const repoId = "owner/repo#main"
  const passphrase = "generation-authority-passphrase"
  const [winner, bootstrap] = await Promise.all([
    deriveV4Keyring({ passphrase, repoId, salt: salt(201), iterations: 1_000 }),
    deriveV4BootstrapRecoveryKey({ passphrase, repoId, iterations: 1_000 }),
  ])
  const adapter = new MemoryAdapter()
  const bootstrapStore = createV4RecoveryStore({ adapter, root: "generation-recovery", repoId, payloadKey: bootstrap })

  for (let generation = 1; generation <= 10; generation++) {
    const saved = await bootstrapStore.save({
      runId: `terminal-${generation}`,
      journalId: `journal-${generation}`,
      phase: "index-committed",
      expectedRemoteHead: `head-${generation}`,
    })
    assert.equal(saved.header.generation, generation)
  }

  const pending = await bootstrapStore.save({
    runId: "pending-11",
    journalId: "journal-11",
    phase: "publish-intent",
    expectedRemoteHead: "head-10",
    candidateCommitSha: "candidate-11",
    payload: { mutations: [], completedMutationIds: [] },
  })
  assert.equal(pending.header.generation, 11)

  const winnerKeyStore = createV4RecoveryStore({ adapter, root: "generation-recovery", repoId, payloadKey: winner.journalKey })
  let recovered
  try {
    recovered = await winnerKeyStore.load()
  } catch (error) {
    assert.equal(error instanceof V4RecoveryRequiredError, true)
    recovered = await bootstrapStore.load()
  }

  assert.equal(recovered?.header.generation, 11)
  assert.equal(recovered?.header.runId, "pending-11")
  assert.deepEqual(recovered?.payload, { mutations: [], completedMutationIds: [] })
})
