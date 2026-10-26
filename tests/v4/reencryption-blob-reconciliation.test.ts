import assert from "node:assert/strict"
import test from "node:test"

import { computeV4GitBlobSha1 } from "../../src/lib/v4/git-blob-identity"
import { createV4ReencryptionRecoveryJournal } from "../../src/lib/v4/reencryption-recovery-journal"
import { verifyStagedV4ReencryptionGitBlobs } from "../../src/lib/v4/reencryption-blob-reconciliation"
import type { V4LocalIndexAdapter } from "../../src/lib/v4/local-index"
import { planV4OrphanReencryptionDestination } from "../../src/lib/v4/reencryption-orphan-branch"
import { utf8ToBytes } from "../../src/lib/bytes"

const sourceSha = "a".repeat(40)
const destination = "owner/repo#rekey/new-branch"
const bytes = utf8ToBytes
const plan = planV4OrphanReencryptionDestination({
  sourceRepoId: "owner/repo#main",
  destinationRepoId: destination,
  sourceCommitSha: sourceSha,
  sourcePhysicalRepositoryId: 91,
  destinationPhysicalRepositoryId: 91,
  expectedPhysicalRepositoryId: 91,
  defaultBranch: "main",
})
class MemoryAdapter implements V4LocalIndexAdapter {
  files = new Map<string, string>()
  async read(path: string) { const text = this.files.get(path); if (!text) throw new Error("missing"); return text }
  async write(path: string, text: string) { this.files.set(path, text) }
  async exists(path: string) { return this.files.has(path) }
  async mkdir(_path: string) {}
}
function wal(adapter = new MemoryAdapter()) {
  return createV4ReencryptionRecoveryJournal({
    adapter, root: ".obsidian/plugins/d82/rekey",
    destinationRepoId: destination, sourceCommitSha: sourceSha,
    runId: "d82-rekey-run", journalKey: new Uint8Array(32).fill(0x12),
  })
}
function receipt(n: number) {
  const ciphertext = bytes("encrypted synthetic blob " + n)
  return {
    path: `.obsidian-github-sync-v4/data/aa/aa${n.toString(16).padStart(62, "0")}.enc`,
    sha: computeV4GitBlobSha1(ciphertext),
    byteLength: ciphertext.byteLength,
    ciphertext,
  }
}
async function setup() {
  const adapter = new MemoryAdapter()
  const journal = wal(adapter)
  let current = await journal.begin()
  const verified = receipt(1)
  const pending = receipt(2)
  for (const item of [verified, pending]) {
    current = await journal.recordUploadIntent(item, current.generation)
    if (item === verified) current = await journal.appendReceipt(item, current.generation)
  }
  const blobs = new Map<string, Uint8Array>([
    [verified.sha, verified.ciphertext], [pending.sha, pending.ciphertext],
  ])
  let reads = 0
  let repoChecks = 0
  const github = {
    async getRepositoryIdentity() { repoChecks++; return { id: 91, fullName: "owner/repo" } },
    async getBlob(sha: string) { reads++; const v = blobs.get(sha); if (!v) throw new Error("HTTP 404"); return v.slice() },
  }
  return { adapter, journal, github, blobs, verified, pending, get reads() { return reads }, get repoChecks() { return repoChecks } }
}
function args(f: Awaited<ReturnType<typeof setup>>) {
  return { plan, journal: f.journal, github: f.github }
}

test("D82 read-only verifier checks both confirmed and pending Git blob SHA bytes but never upgrades WAL", async () => {
  const f = await setup()
  const before = new Map(f.adapter.files)
  const report = await verifyStagedV4ReencryptionGitBlobs(args(f))
  assert.deepEqual(report, {
    integrityScope: "git-blob-by-sha-only",
    status: "verified",
    confirmedReceiptCount: 1,
    pendingIntentCount: 1,
    verifiedObjectCount: 2,
    inconclusiveObjectCount: 0,
    requiresRemoteRevalidation: true,
    destinationContentVerified: false,
    permissionToPublish: false,
    cutoverAuthorized: false,
  })
  assert.ok(Object.isFrozen(report))
  assert.equal(f.reads, 2)
  assert.ok(f.repoChecks >= 2)
  assert.deepEqual(f.adapter.files, before)
  assert.equal((await f.journal.load())!.pendingIntents.length, 1,
    "verified object bytes do not authorize WAL receipt promotion or ref publication")
  assert.ok(!JSON.stringify(report).includes(f.verified.path))
})

test("D82 Git 404 or timeout remain inconclusive and NEVER imply a missing upload", async () => {
  for (const message of ["HTTP 404", "GitHub API timeout", "HTTP 429", "HTTP 500"]) {
    const f = await setup()
    const original = f.github.getBlob
    f.github.getBlob = async (sha) => {
      if (sha === f.pending.sha) throw new Error(message)
      return original(sha)
    }
    const report = await verifyStagedV4ReencryptionGitBlobs(args(f))
    assert.equal(report.status, "inconclusive", message)
    assert.equal(report.verifiedObjectCount, 1)
    assert.equal(report.inconclusiveObjectCount, 1)
    assert.equal(report.permissionToPublish, false)
    assert.equal((await f.journal.load())!.pendingIntents.length, 1)
  }
})

test("D82 byte size or Git SHA mismatch rejects inconsistent remote blob, rather than reporting an absent ref", async () => {
  for (const bad of [
    bytes("truncated"),
    bytes("synthetic altered blob with same length"),
    new Uint8Array(8 * 1024 * 1024 + 1),
  ]) {
    const f = await setup()
    f.blobs.set(f.verified.sha, bad)
    await assert.rejects(() => verifyStagedV4ReencryptionGitBlobs(args(f)), /identity|size|integrity/i)
    assert.equal((await f.journal.load())!.receipts.length, 1)
  }
})

test("D82 rejects mismatched GitHub numeric identity and case-insensitive fullName before reads", async () => {
  for (const identity of [
    { id: 92, fullName: "owner/repo" },
    { id: 91, fullName: "owner/another" },
    { id: 0, fullName: "owner/repo" },
  ]) {
    const f = await setup()
    f.github.getRepositoryIdentity = async () => identity
    await assert.rejects(() => verifyStagedV4ReencryptionGitBlobs(args(f)), /repository identity/i)
    assert.equal(f.reads, 0)
  }
})

test("D82 changed repository after a valid read invalidates the whole report", async () => {
  const f = await setup()
  let calls = 0
  f.github.getRepositoryIdentity = async () => ({ id: ++calls === 1 ? 91 : 92, fullName: "owner/repo" })
  await assert.rejects(() => verifyStagedV4ReencryptionGitBlobs(args(f)), /repository identity/i)
})

test("D82 wrong journal destination/source, absent WAL and cancelled signal fail closed", async () => {
  const f = await setup()
  await assert.rejects(() => verifyStagedV4ReencryptionGitBlobs({
    ...args(f), plan: { ...plan, pinnedSourceCommitSha: "b".repeat(40) },
  }), /journal|identity|source/i)
  const emptyJournal = wal()
  await assert.rejects(() => verifyStagedV4ReencryptionGitBlobs({
    ...args(f), journal: emptyJournal,
  }), /journal|missing|recovery/i)
  const controller = new AbortController()
  controller.abort(new Error("cancelled"))
  await assert.rejects(() => verifyStagedV4ReencryptionGitBlobs({
    ...args(f), signal: controller.signal,
  }), /cancelled|abort/i)
})

test("D82 rejects overly large WAL receipt batches before any network reads", async () => {
  const f = await setup()
  const report = await verifyStagedV4ReencryptionGitBlobs({
    ...args(f), maxObjects: 1,
  })
  assert.equal(report.status, "inconclusive")
  assert.equal(report.verifiedObjectCount, 0)
  assert.equal(report.inconclusiveObjectCount, 2)
  assert.equal(f.reads, 0)
  assert.equal(report.permissionToPublish, false)
})

test("D82 refuses a WAL generation change during the remote read rather than trusting stale evidence", async () => {
  const f = await setup()
  const original = f.journal.load.bind(f.journal)
  let loads = 0
  const reportJournal = {
    sourceCommitSha: f.journal.sourceCommitSha,
    destinationRepoId: f.journal.destinationRepoId,
    async load() {
      const snapshot = await original()
      if (!snapshot) return null
      return ++loads === 1 ? snapshot : { ...snapshot, generation: snapshot.generation + 1 }
    },
  }
  await assert.rejects(() => verifyStagedV4ReencryptionGitBlobs({
    ...args(f), journal: reportJournal,
  }), /WAL changed/i)
  assert.equal(f.reads, 2)
})

test("D82 refuses invalid opaque WAL object path before any Git API reads", async () => {
  const f = await setup()
  const original = f.journal.load.bind(f.journal)
  const reportJournal = {
    sourceCommitSha: f.journal.sourceCommitSha,
    destinationRepoId: f.journal.destinationRepoId,
    async load() {
      const snapshot = await original()
      if (!snapshot) return null
      return { ...snapshot,
        pendingIntents: [{ ...snapshot.pendingIntents[0]!, path: "../unsafe/secret" }],
      }
    },
  }
  await assert.rejects(() => verifyStagedV4ReencryptionGitBlobs({
    ...args(f), journal: reportJournal,
  }), /recovery journal|invalid/i)
  assert.equal(f.reads, 0)
})

test("D82 does not provide any Git mutation, WAL promotion, auto-retry or cutover method", async () => {
  const f = await setup()
  const report = await verifyStagedV4ReencryptionGitBlobs(args(f))
  assert.ok(!("publish" in report))
  assert.ok(!("retry" in report))
  assert.ok(!("markCompleted" in report))
})
