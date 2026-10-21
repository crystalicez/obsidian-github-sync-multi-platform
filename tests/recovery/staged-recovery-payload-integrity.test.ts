import assert from "node:assert/strict"
import test from "node:test"

import { sha256Hex, toBase64, utf8ToBytes } from "../../src/lib/bytes"
import { createV4RecoveryStore, V4RecoveryRequiredError } from "../../src/lib/v4/recovery-store"

function memoryAdapter() {
  const values = new Map<string, string>()
  return {
    values,
    async read(path: string) {
      const value = values.get(path)
      if (value === undefined) throw new Error(`missing: ${path}`)
      return value
    },
    async write(path: string, value: string) { values.set(path, value) },
    async exists(path: string) { return values.has(path) },
    async mkdir() {},
  }
}

function intent() {
  return { runId: "safety-run", phase: "remote-verified" as const, expectedRemoteHead: "prior", verifiedRemoteHead: "current" }
}

async function plantIntegrityValidPayload(values: Map<string, string>, payload: unknown): Promise<void> {
  const withoutIntegrity = {
    schemaVersion: 1,
    generation: 1,
    runId: "safety-run",
    journalId: undefined,
    phase: "remote-verified",
    expectedRemoteHead: "prior",
    candidateCommitSha: undefined,
    verifiedRemoteHead: "current",
    payloadCiphertext: toBase64(utf8ToBytes(JSON.stringify(payload))),
  }
  const integrity = await sha256Hex(utf8ToBytes(JSON.stringify(withoutIntegrity)))
  values.set("recovery/slot-1.json", JSON.stringify({ ...withoutIntegrity, integrity }))
}

const trash = (id: string, path: string) => ({
  id, kind: "trash" as const, path, precondition: { path, exists: false },
})

test("Stage D0: integrity-valid recovery WAL rejects unsafe paths, duplicates and forged receipts before replay", async () => {
  const malformed = [
    { label: "traversal", mutations: [trash("a", "../secrets.md")], completedMutationIds: [] },
    { label: "normalized alias", mutations: [trash("a", "dir//note.md")], completedMutationIds: [] },
    { label: "duplicate identities", mutations: [trash("duplicate", "a.md"), trash("duplicate", "b.md")], completedMutationIds: [] },
    { label: "unknown completion", mutations: [trash("a", "a.md")], completedMutationIds: ["unknown"] },
    { label: "duplicate completion", mutations: [trash("a", "a.md")], completedMutationIds: ["a", "a"] },
    { label: "missing stat safety evidence", mutations: [{ ...trash("a", "a.md"), precondition: { path: "a.md", exists: true } }], completedMutationIds: [] },
    { label: "bad stage reference", mutations: [{
      id: "a", kind: "stage-write", path: "a.md", precondition: { path: "a.md", exists: false },
      stage: { stageId: "../escape", hash: "bad", size: -1, mtime: -1 },
    }], completedMutationIds: [] },
  ]
  for (const { label, ...payload } of malformed) {
    const adapter = memoryAdapter()
    await plantIntegrityValidPayload(adapter.values, payload)
    const store = createV4RecoveryStore({ adapter, root: "recovery", repoId: "o/r#main" })
    await assert.rejects(() => store.load(), V4RecoveryRequiredError, label)
  }
})

test("Stage D0: writer rejects unsafe recovery payload without persisting a slot", async () => {
  const adapter = memoryAdapter()
  const store = createV4RecoveryStore({ adapter, root: "recovery", repoId: "o/r#main" })
  await assert.rejects(
    () => store.save({ ...intent(), payload: { mutations: [trash("bad", "../outside.md")], completedMutationIds: [] } }),
    V4RecoveryRequiredError,
  )
  assert.equal(adapter.values.size, 0)
})

test("Stage D0: generation overflow refuses to overwrite earlier WAL data", async () => {
  const adapter = memoryAdapter()
  const previous = {
    schemaVersion: 1 as const,
    generation: Number.MAX_SAFE_INTEGER,
    runId: "previous",
    journalId: undefined,
    phase: "index-committed" as const,
    expectedRemoteHead: "old",
    candidateCommitSha: undefined,
    verifiedRemoteHead: "old",
    payloadCiphertext: undefined,
  }
  const integrity = await sha256Hex(utf8ToBytes(JSON.stringify(previous)))
  adapter.values.set("recovery/slot-1.json", JSON.stringify({ ...previous, integrity }))
  const before = new Map(adapter.values)
  const store = createV4RecoveryStore({ adapter, root: "recovery", repoId: "o/r#main" })
  await assert.rejects(() => store.save(intent()), V4RecoveryRequiredError)
  assert.deepEqual(adapter.values, before)
})

test("Stage D0: normal persisted payload and receipt remain compatible", async () => {
  const adapter = memoryAdapter()
  const store = createV4RecoveryStore({ adapter, root: "recovery", repoId: "o/r#main" })
  const payload = { mutations: [trash("delete:one", "notes/one.md")], completedMutationIds: ["delete:one"] }
  const saved = await store.save({ ...intent(), payload })
  assert.equal(saved.header.generation, 1)
  assert.deepEqual((await store.load())?.payload, payload)
})
