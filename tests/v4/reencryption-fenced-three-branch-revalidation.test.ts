import assert from "node:assert/strict"
import test from "node:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { acquireV4DesktopRekeyWalStorage } from "../../src/lib/v4/reencryption-desktop-wal"
import { createV4ReencryptionRecoveryJournal } from "../../src/lib/v4/reencryption-recovery-journal"
import type { V4LocalIndexAdapter } from "../../src/lib/v4/local-index"
import { armV4ReencryptionSyncFence, assertV4ReencryptionSyncFenceClear, V4_REENCRYPTION_SYNC_FENCE_ROOT } from "../../src/lib/v4/reencryption-sync-fence"
import { inspectV4FencedThreeBranchPublicationAfterRestart, type V4FencedThreeBranchRevalidationInput } from "../../src/lib/v4/reencryption-fenced-three-branch-revalidation"
import type { V4ReencryptionJournalSnapshot } from "../../src/lib/v4/reencryption-recovery-journal"
import type { V4ReencryptionProposedCommitIdentity } from "../../src/lib/v4/reencryption-proposed-commit-receipt"
import type { V4ThreeBranchPublicationReport } from "../../src/lib/v4/reencryption-three-branch-publish"

const identity: V4ReencryptionProposedCommitIdentity = {
  runId: "d177_fenced_run", walGeneration: 8, indexRoot: "github-sync-v4-index",
  deviceId: "device177",
  sourceRepoId: "owner/vault#main",
  backupRepoId: "owner/vault#backup/rekey",
  destinationRepoId: "owner/vault#rekey/2026",
  sourceCommitSha: "a".repeat(40), sourceTreeSha: "c".repeat(40),
  destinationCommitSha: "b".repeat(40), destinationTreeSha: "d".repeat(40),
  manifestSha256: "e".repeat(64),
  sourcePassphraseSecretId: "old-secret", destinationPassphraseSecretId: "new-secret",
}

const published: V4ThreeBranchPublicationReport = {
  integrityScope: "three-branch-verified-backup-and-destination-remote-only",
  sourceRepoId: identity.sourceRepoId, backupRepoId: identity.backupRepoId,
  destinationRepoId: identity.destinationRepoId,
  originalSourceCommitSha: identity.sourceCommitSha,
  destinationCommitSha: identity.destinationCommitSha,
  verifiedFileCount: 8, verifiedPlaintextBytes: "1024",
  backupContentsReadbackVerified: true, backupScratchRoundTripVerified: true,
  destinationContentsReadbackVerified: true, oldBranchSyncRemainsIndependent: true,
  powerLossDurabilityIndependentlyAudited: false,
  initiatingDeviceCutoverAuthorized: false,
}

const manual = {
  integrityScope: "read-only-current-git-refs-and-authenticated-uncommitted-wal",
  observation: "manual-recovery-required",
  evidence: "best-effort-wal-readback-not-power-loss-durable",
  completeRemoteContentReverified: false,
  localCutoverAuthorized: false, resumeSyncAuthorized: false,
  rollbackAuthorized: false, remoteWritesAuthorized: false,
  oldPassphraseCleanupAuthorized: false,
}
const observed = { ...manual, observation: "three-refs-match-pinned-wal-uncommitted" }

function fixture() {
  const files = new Map<string, string>()
  const dirs = new Set<string>()
  let held = false
  let writes = 0
  let githubReads = 0
  let generationReads = 0
  let checkpointReads = 0
  let mutateRef: (() => void) | null = null
  const adapter: V4LocalIndexAdapter = {
    async read(path) {
      const raw = files.get(path)
      if (raw === undefined) throw Error("missing " + path)
      return raw
    },
    async write(path, content) { writes++; files.set(path, content) },
    async exists(path) { return files.has(path) || dirs.has(path) },
    async mkdir(path) { dirs.add(path) },
  }
  let snapshot: V4ReencryptionJournalSnapshot = {
    generation: 8, receipts: [], pendingIntents: [], pendingRefIntents: [],
    verifiedRefObservations: [
      { role: "backup", repoId: identity.backupRepoId,
        commitSha: identity.sourceCommitSha, treeSha: identity.sourceTreeSha },
      { role: "destination", repoId: identity.destinationRepoId,
        commitSha: identity.destinationCommitSha, treeSha: identity.destinationTreeSha,
        manifestSha256: identity.manifestSha256 },
    ],
    preparedCandidateReceipt: {
      commitSha: identity.destinationCommitSha,
      treeSha: identity.destinationTreeSha,
      manifestSha256: identity.manifestSha256,
    },
    candidatePreparationSha256: "f".repeat(64),
    stageHandoffStarted: true, requiresRemoteRevalidation: true,
    cutoverAuthorized: false, permissionToPublish: false,
  }
  const journal = {
    sourceCommitSha: identity.sourceCommitSha,
    destinationRepoId: identity.destinationRepoId,
    async assertHealthySnapshot(generation: number) {
      assert.equal(held, true)
      assert.equal(generation, 8)
      generationReads++
      return structuredClone(snapshot)
    },
  }
  const wal = {
    async assertExclusiveStageLease() { assert.equal(held, true) },
    async assertBestEffortCheckpoint() {
      assert.equal(held, true)
      checkpointReads++
      return "best-effort-readback-only" as const
    },
  }
  const lease = async () => { assert.equal(held, true) }
  const holder = async <T>(body: () => Promise<T>): Promise<T> => {
    assert.equal(held, false)
    held = true
    try { return await body() } finally { held = false }
  }
  type Reader = V4FencedThreeBranchRevalidationInput["readers"]["source"]
  const states = {
    source: { repoId: identity.sourceRepoId, sha: identity.sourceCommitSha,
      tree: identity.sourceTreeSha, parents: ["1".repeat(40)] },
    backup: { repoId: identity.backupRepoId, sha: identity.sourceCommitSha,
      tree: identity.sourceTreeSha, parents: ["1".repeat(40)] },
    destination: { repoId: identity.destinationRepoId, sha: identity.destinationCommitSha,
      tree: identity.destinationTreeSha, parents: [] as string[] },
  }
  const makeReader = (role: keyof typeof states): Reader => {
    const state = states[role]
    const branchName = state.repoId.split("#")[1]!
    const client = {
      branchName,
      async getRepositoryIdentity() {
        assert.equal(held, true); githubReads++
        return { id: 177, fullName: "owner/vault" }
      },
      async getRepositoryDefaultBranch() {
        assert.equal(held, true); githubReads++
        return "main"
      },
      async getGitRefOrNull() {
        assert.equal(held, true); githubReads++
        mutateRef?.()
        return { ref: "refs/heads/" + branchName,
          type: "commit" as const, sha: state.sha }
      },
      async getGitCommit(sha: string) {
        assert.equal(held, true); githubReads++
        return { sha, treeSha: state.tree, parentShas: [...state.parents], message: "" }
      },
    }
    return client as unknown as Reader
  }
  const readers = {
    source: makeReader("source"),
    backup: makeReader("backup"),
    destination: makeReader("destination"),
  }
  const input = (): V4FencedThreeBranchRevalidationInput => ({
    identity: { ...identity },
    publication: { ...published },
    physicalRepositoryId: 177,
    adapter, wal, journal, readers,
    acknowledgement: "accept-best-effort-power-loss-recovery-risk",
    assertExclusiveInitiatorLease: lease,
    withExclusiveInitiatorLease: holder,
  })
  const arm = async () => holder(async () => armV4ReencryptionSyncFence({
    adapter, runId: identity.runId,
    sourceRepoId: identity.sourceRepoId,
    destinationRepoId: identity.destinationRepoId,
    assertExclusiveInitiatorLease: lease,
  }))
  return {
    arm, input, files, dirs, adapter, readers, states, holder,
    get writes() { return writes },
    get githubReads() { return githubReads },
    get generationReads() { return generationReads },
    get checkpointReads() { return checkpointReads },
    setSnapshot(next: V4ReencryptionJournalSnapshot) { snapshot = next },
    snapshot: () => snapshot,
    setMutateRef(fn: (() => void) | null) { mutateRef = fn },
  }
}

test("D177 current three Git refs + exact fence + authenticated WAL match without any mutation or Cutover", async () => {
  const s = fixture()
  await s.arm()
  const before = new Map(s.files)
  const writeCount = s.writes
  const result = await inspectV4FencedThreeBranchPublicationAfterRestart(s.input())
  assert.deepEqual(result, observed)
  assert.equal(Object.isFrozen(result), true)
  assert.deepEqual(s.files, before)
  assert.equal(s.writes, writeCount)
  assert.equal(s.githubReads >= 24, true)
  assert.equal(s.generationReads >= 6, true)
  assert.equal(s.checkpointReads >= 6, true)
  await assert.rejects(() => assertV4ReencryptionSyncFenceClear(s.adapter))
})

test("D177 missing or foreign Fence, wrong run, stale reports and missing acknowledgement deny all remote inspection", async () => {
  const s = fixture()
  assert.deepEqual(await inspectV4FencedThreeBranchPublicationAfterRestart(s.input()), manual)
  await s.arm()
  const before = s.writes
  const marker = V4_REENCRYPTION_SYNC_FENCE_ROOT + "/active.json"
  const original = s.files.get(marker)!
  for (const broken of [original.slice(0, -1), original.replace(identity.runId, "run_foreign_177"),
    original.replace(identity.destinationRepoId, "owner/vault#foreign"),
    original + "\n"]) {
    s.files.set(marker, broken)
    assert.deepEqual(await inspectV4FencedThreeBranchPublicationAfterRestart(s.input()), manual)
  }
  s.files.set(marker, original)
  for (const alter of [
    (v: V4FencedThreeBranchRevalidationInput) => { (v as { identity: V4ReencryptionProposedCommitIdentity }).identity = { ...v.identity, runId: "run_foreign_177" } },
    (v: V4FencedThreeBranchRevalidationInput) => { (v as { physicalRepositoryId: number }).physicalRepositoryId = 99 },
    (v: V4FencedThreeBranchRevalidationInput) => { (v as { acknowledgement: string }).acknowledgement = "no" },
    (v: V4FencedThreeBranchRevalidationInput) => { (v as { publication: V4ThreeBranchPublicationReport }).publication = { ...published, destinationRepoId: identity.backupRepoId } },
  ]) {
    const input = s.input()
    alter(input)
    assert.deepEqual(await inspectV4FencedThreeBranchPublicationAfterRestart(input), manual)
  }
  assert.equal(s.writes, before)
})

test("D177 moved Source/Backup/Destination ref and wrong orphan tree/parents always require manual recovery", async () => {
  for (const role of ["source", "backup", "destination"] as const) {
    const s = fixture()
    await s.arm()
    s.states[role].sha = "9".repeat(40)
    assert.deepEqual(await inspectV4FencedThreeBranchPublicationAfterRestart(s.input()), manual)
  }
  for (const edit of ["tree", "parent", "default", "repo"] as const) {
    const s = fixture()
    await s.arm()
    if (edit === "tree") s.states.destination.tree = "8".repeat(40)
    if (edit === "parent") s.states.destination.parents = ["a".repeat(40)]
    if (edit === "default") {
      s.readers.destination.getRepositoryDefaultBranch = async () => "rekey/2026"
    }
    if (edit === "repo") {
      s.readers.backup.getRepositoryIdentity = async () => ({ id: 999, fullName: "owner/vault" })
    }
    assert.deepEqual(await inspectV4FencedThreeBranchPublicationAfterRestart(s.input()), manual)
  }
})

test("D177 moved ref or swapped reader method during awaited Git read never reports observed", async () => {
  for (const action of ["move", "swap"] as const) {
    const s = fixture()
    await s.arm()
    let changed = false
    s.setMutateRef(() => {
      if (changed) return
      changed = true
      if (action === "move") s.states.destination.sha = "7".repeat(40)
      else s.readers.backup.getGitRefOrNull = async () => null
    })
    const before = s.writes
    assert.deepEqual(await inspectV4FencedThreeBranchPublicationAfterRestart(s.input()), manual)
    assert.equal(changed, true)
    assert.equal(s.writes, before)
  }
})

test("D177 stale WAL generation, missing receipt or incomplete remote-intent state fails closed", async () => {
  for (const failure of ["generation", "destination", "pending", "candidate", "lease"] as const) {
    const s = fixture()
    await s.arm()
    const original = s.snapshot()
    if (failure === "generation") s.setSnapshot({ ...original, generation: 7 })
    if (failure === "destination") s.setSnapshot({ ...original, verifiedRefObservations: original.verifiedRefObservations.slice(0, 1) })
    if (failure === "pending") s.setSnapshot({ ...original, pendingRefIntents: [original.verifiedRefObservations[1]!] })
    if (failure === "candidate") s.setSnapshot({ ...original, preparedCandidateReceipt: null })
    const input = s.input()
    if (failure === "lease") {
      input.wal.assertExclusiveStageLease = async () => { throw Error("lease lost") }
    }
    const before = s.writes
    assert.deepEqual(await inspectV4FencedThreeBranchPublicationAfterRestart(input), manual)
    assert.equal(s.writes, before)
  }
})

test("D177 a moved branch or changed default between complete read passes denies revalidation", async () => {
  for (const mutation of ["second-ref", "second-default"] as const) {
    const s = fixture()
    await s.arm()
    let count = 0
    if (mutation === "second-ref") {
      const original = s.readers.source.getGitRefOrNull
      s.readers.source.getGitRefOrNull = async () => {
        count++
        const ref = await original.call(s.readers.source)
        return count === 2 && ref ? { ...ref, sha: "8".repeat(40) } : ref
      }
    } else {
      const original = s.readers.source.getRepositoryDefaultBranch
      s.readers.source.getRepositoryDefaultBranch = async () => {
        count++
        await original.call(s.readers.source)
        return count === 2 ? "different-default" : "main"
      }
    }
    assert.deepEqual(await inspectV4FencedThreeBranchPublicationAfterRestart(s.input()), manual)
    assert.equal(count, 2)
  }
})

test("D177 real Windows encrypted WAL reopened on a new storage lease still binds all three remote refs", async () => {
  const parent = join(process.cwd(), ".tmp")
  await mkdir(parent, { recursive: true })
  const dir = await mkdtemp(join(parent, "d177-ref-reopen-"))
  const key = new Uint8Array(32).fill(0x72)
  const walRoot = "reencryption/journal"
  const makeJournal = (adapter: V4LocalIndexAdapter) =>
    createV4ReencryptionRecoveryJournal({
      adapter, root: walRoot, runId: identity.runId, journalKey: key,
      sourceCommitSha: identity.sourceCommitSha, destinationRepoId: identity.destinationRepoId,
    })
  try {
    const first = await acquireV4DesktopRekeyWalStorage({
      rootAbsolute: dir, journalRoot: walRoot,
    })
    try {
      const journal = makeJournal(first.adapter)
      let snap = await journal.begin()
      const backup = { role: "backup" as const, repoId: identity.backupRepoId,
        commitSha: identity.sourceCommitSha, treeSha: identity.sourceTreeSha }
      snap = await journal.recordRefIntent(backup, snap.generation)
      snap = await journal.markRefReadbackObserved(backup, snap.generation)
      snap = await journal.recordStagingHandoff(backup, snap.generation)
      snap = await journal.recordCandidatePreparationIntent("f".repeat(64), snap.generation)
      snap = await journal.recordPreparedCandidateReceipt({
        commitSha: identity.destinationCommitSha, treeSha: identity.destinationTreeSha,
        manifestSha256: identity.manifestSha256,
      }, snap.generation)
      const dest = { role: "destination" as const, repoId: identity.destinationRepoId,
        commitSha: identity.destinationCommitSha, treeSha: identity.destinationTreeSha,
        manifestSha256: identity.manifestSha256 }
      snap = await journal.recordRefIntent(dest, snap.generation)
      snap = await journal.markRefReadbackObserved(dest, snap.generation)
      assert.equal(snap.generation, identity.walGeneration)
    } finally { await first.release() }
    const reopened = await acquireV4DesktopRekeyWalStorage({
      rootAbsolute: dir, journalRoot: walRoot,
    })
    try {
      const s = fixture()
      await s.arm()
      const testInput = s.input()
      testInput.journal = makeJournal(reopened.adapter)
      testInput.wal = {
        assertExclusiveStageLease: () => reopened.assertExclusiveStageLease(),
        assertBestEffortCheckpoint: () => reopened.assertBestEffortCheckpoint(),
      }
      const before = new Map(s.files)
      const beforeWrites = s.writes
      assert.deepEqual(await inspectV4FencedThreeBranchPublicationAfterRestart(testInput), observed)
      assert.deepEqual(s.files, before)
      assert.equal(s.writes, beforeWrites)
    } finally { await reopened.release() }
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test("D177 holder that never runs callback cannot report matching branch evidence", async () => {
  const s = fixture()
  await s.arm()
  const input = s.input()
  input.withExclusiveInitiatorLease = async () => observed as never
  assert.deepEqual(await inspectV4FencedThreeBranchPublicationAfterRestart(input), manual)
})
