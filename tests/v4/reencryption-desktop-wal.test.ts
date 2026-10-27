import assert from "node:assert/strict"
import test from "node:test"
import { execFileSync } from "node:child_process"
import { link, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { createV4ReencryptionRecoveryJournal } from "../../src/lib/v4/reencryption-recovery-journal"
import { acquireV4DesktopRekeyWalStorage, V4DesktopRekeyWalLockError, V4RekeyWalDirectorySyncProof } from "../../src/lib/v4/reencryption-desktop-wal"

const pinned = "a".repeat(40)
const dest = "owner/repo#rekey/d86"
const key = new Uint8Array(32).fill(0x46)
const journalRoot = "rekey/wal"
const receipt = {
  path: `.obsidian-github-sync-v4/data/aa/${"a".repeat(64)}.enc`,
  sha: "b".repeat(40), byteLength: 100,
}

function makeJournal(adapter: Parameters<typeof createV4ReencryptionRecoveryJournal>[0]["adapter"]) {
  return createV4ReencryptionRecoveryJournal({
    adapter, root: journalRoot, sourceCommitSha: pinned,
    destinationRepoId: dest, journalKey: key, runId: "d86-rekey-run",
  })
}

async function sandbox() {
  const testRoot = join(process.cwd(), ".tmp")
  await mkdir(testRoot, { recursive: true })
  const root = await mkdtemp(join(testRoot, "d86-desktop-wal-"))
  return { root, async cleanup() { await rm(root, { recursive: true, force: true }) } }
}

test("D119 a failed WAL leaf fsync revokes earlier confirmed crash durability before propagating", async () => {
  const proof = new V4RekeyWalDirectorySyncProof()
  assert.throws(() => proof.assertConfirmed(), /fsync|durability/i)
  let calls = 0
  const successfulSync = async () => { calls += 1; return true }
  await proof.refresh(true, successfulSync)
  proof.assertConfirmed()
  await assert.rejects(
    () => proof.refresh(true, async () => {
      calls += 1
      throw Object.assign(new Error("simulated disk I/O fault"), { code: "EIO" })
    }),
    /simulated disk I\/O fault/,
  )
  assert.throws(() => proof.assertConfirmed(), /fsync|durability/i,
    "the prior successful leaf fsync cannot certify a later failed rename")
  await proof.refresh(true, async () => false)
  assert.throws(() => proof.assertConfirmed(), /fsync|durability/i)
  await proof.refresh(false, successfulSync)
  assert.throws(() => proof.assertConfirmed(), /fsync|durability/i,
    "even a successful leaf fsync cannot overcome missing parent durability")
  await proof.refresh(true, successfulSync)
  proof.assertConfirmed()
  assert.equal(calls, 4)
})

test("D119 consecutive concurrent directory sync attempts cannot retain stale-positive evidence", async () => {
  const proof = new V4RekeyWalDirectorySyncProof()
  await proof.refresh(true, async () => true)
  proof.assertConfirmed()
  let rejectPending: (error: Error) => void = () => {
    throw new Error("fault injector not armed")
  }
  const fault = new Promise<boolean>((_resolve, reject) => {
    rejectPending = reject
  })
  const refreshing = proof.refresh(true, () => fault)
  assert.throws(() => proof.assertConfirmed(), /fsync|durability/i,
    "a pending flush invalidates the old proof immediately")
  rejectPending(new Error("simulated async directory flush failure"))
  await assert.rejects(refreshing, /async directory flush failure/)
  assert.throws(() => proof.assertConfirmed(), /fsync|durability/i)
})

test("D119 overlapping leaf flushes fail closed in either completion order until a fresh serialized flush", async () => {
  for (const resolveNewestFirst of [true, false]) {
    const proof = new V4RekeyWalDirectorySyncProof()
    let completeOld: (value: boolean) => void = () => { throw new Error("old unresolved") }
    let completeNew: (value: boolean) => void = () => { throw new Error("new unresolved") }
    const oldPromise = new Promise<boolean>(resolve => { completeOld = resolve })
    const newPromise = new Promise<boolean>(resolve => { completeNew = resolve })
    const oldFlush = proof.refresh(true, () => oldPromise)
    const newFlush = proof.refresh(true, () => newPromise)
    assert.throws(() => proof.assertConfirmed(), /fsync|durability/i)
    if (resolveNewestFirst) {
      completeNew(true)
      await newFlush
      assert.throws(() => proof.assertConfirmed(), /fsync|durability/i)
      completeOld(true)
      await oldFlush
    } else {
      completeOld(true)
      await oldFlush
      assert.throws(() => proof.assertConfirmed(), /fsync|durability/i)
      completeNew(true)
      await newFlush
    }
    assert.throws(() => proof.assertConfirmed(), /fsync|durability/i,
      "overlapping fsyncs cannot certify WAL rename ordering")
    await proof.refresh(true, async () => true)
    proof.assertConfirmed()
  }
})

test("D86 real disk journal intent+receipt survive new instances and leave no plain receipt", async () => {
  const t = await sandbox()
  try {
    const store = await acquireV4DesktopRekeyWalStorage({ rootAbsolute: t.root, journalRoot })
    const j = makeJournal(store.adapter)
    const start = await j.begin()
    const intent = await j.recordUploadIntent(receipt, start.generation)
    assert.equal(intent.pendingIntents.length, 1)
    const final = await j.appendReceipt(receipt, intent.generation)
    assert.equal(final.receipts.length, 1)
    const persisted = await readFile(join(t.root, "rekey", "wal", "slot-1.json"), "utf8")
    assert.ok(!persisted.includes(receipt.path))
    assert.ok(!persisted.includes(receipt.sha))
    assert.deepEqual((await readdir(join(t.root, "rekey", "wal"))).sort(),
      [".exclusive.lock", "slot-0.json", "slot-1.json"])
    // Directory sync is not uniformly available through Node on Windows.
    // A missing capability must not silently become a crash-durability claim.
    try { await store.assertCrashDurable() }
    catch (e) { assert.match(String(e), /fsync|durability/i) }
    await store.release()
    const another = await acquireV4DesktopRekeyWalStorage({ rootAbsolute: t.root, journalRoot })
    try {
      const loaded = await makeJournal(another.adapter).load()
      assert.ok(loaded)
      assert.equal(loaded.generation, 3)
      assert.equal(loaded.receipts[0]!.path, receipt.path)
      assert.equal(loaded.requiresRemoteRevalidation, true)
      assert.equal(loaded.permissionToPublish, false)
    } finally { await another.release() }
  } finally { await t.cleanup() }
})

test("D103 real Node OS filesystem persists encrypted Backup + Destination ref intents through release/reacquire, without cutover permission", async () => {
  const t = await sandbox()
  try {
    const store = await acquireV4DesktopRekeyWalStorage({ rootAbsolute: t.root, journalRoot })
    const journal = makeJournal(store.adapter)
    let state = await journal.begin()
    const backup = {
      role: "backup" as const,
      repoId: "owner/repo#backup/old-snapshot",
      commitSha: pinned,
      treeSha: "b".repeat(40),
    }
    const destination = {
      role: "destination" as const, repoId: dest,
      commitSha: "c".repeat(40), treeSha: "d".repeat(40),
      manifestSha256: "e".repeat(64),
    }
    state = await journal.recordRefIntent(backup, state.generation)
    state = await journal.markRefReadbackObserved(backup, state.generation)
    state = await journal.recordStagingHandoff(backup, state.generation)
    state = await journal.recordCandidatePreparationIntent("1".repeat(64), state.generation)
    state = await journal.recordPreparedCandidateReceipt({
      commitSha: destination.commitSha, treeSha: destination.treeSha,
      manifestSha256: destination.manifestSha256,
    }, state.generation)
    state = await journal.recordRefIntent(destination, state.generation)
    const storedBytes = [
      await readFile(join(t.root, "rekey", "wal", "slot-0.json"), "utf8"),
      await readFile(join(t.root, "rekey", "wal", "slot-1.json"), "utf8"),
    ].join("")
    assert.ok(!storedBytes.includes(backup.repoId))
    // Destination repo/branch identity is intentionally stored in the existing authenticated WAL slot header.
    assert.ok(storedBytes.includes(destination.repoId))
    assert.ok(!storedBytes.includes(destination.commitSha))
    assert.ok(!storedBytes.includes(destination.manifestSha256))
    assert.ok(!storedBytes.includes("1".repeat(64)), "candidate phase hash stays encrypted")
    await store.release()

    const reopened = await acquireV4DesktopRekeyWalStorage({ rootAbsolute: t.root, journalRoot })
    try {
      const recovered = await makeJournal(reopened.adapter).load()
      assert.ok(recovered)
      assert.deepEqual(recovered.pendingRefIntents, [destination])
      assert.equal(recovered.pendingRefIntents[0]?.manifestSha256, destination.manifestSha256)
      assert.equal(recovered.candidatePreparationSha256, "1".repeat(64))
      assert.deepEqual(recovered.verifiedRefObservations, [backup])
      assert.equal(recovered.permissionToPublish, false)
      assert.equal(recovered.cutoverAuthorized, false)
      assert.equal(recovered.requiresRemoteRevalidation, true)
      const noAutoRetry = makeJournal(reopened.adapter)
      await assert.rejects(() => noAutoRetry.recordRefIntent(destination, recovered.generation), /duplicate/i)
    } finally { await reopened.release() }
  } finally { await t.cleanup() }
})

test("D115 newly-created nested WAL parents are included in the directory durability gate", async () => {
  const t = await sandbox()
  const nestedRoot = "rekey/extra/nested/wal"
  try {
    const store = await acquireV4DesktopRekeyWalStorage({
      rootAbsolute: t.root, journalRoot: nestedRoot,
    })
    try {
      const journal = createV4ReencryptionRecoveryJournal({
        adapter: store.adapter, root: nestedRoot, sourceCommitSha: pinned,
        destinationRepoId: dest, journalKey: key, runId: "d115-rekey-run",
      })
      const begun = await journal.begin()
      assert.equal(begun.generation, 1)
      const directoryPaths = [
        t.root,
        join(t.root, "rekey"),
        join(t.root, "rekey", "extra"),
        join(t.root, "rekey", "extra", "nested"),
        join(t.root, "rekey", "extra", "nested", "wal"),
      ]
      const fs = await import("node:fs/promises")
      let fullySupported = true
      for (const candidate of directoryPaths) {
        let handle: Awaited<ReturnType<typeof fs.open>> | undefined
        try {
          handle = await fs.open(candidate, "r")
          await handle.sync()
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          if (!["EPERM", "EACCES", "EINVAL", "ENOTSUP", "EISDIR"].includes(code ?? "")) throw error
          fullySupported = false
        } finally {
          await handle?.close()
        }
      }
      if (fullySupported) await store.assertCrashDurable()
      else await assert.rejects(() => store.assertCrashDurable(), /fsync|durability/i)
      assert.deepEqual((await readdir(directoryPaths[directoryPaths.length - 1]!)).sort(),
        [".exclusive.lock", "slot-1.json"])
      assert.equal((await makeJournalForRoot(store.adapter, nestedRoot).load())?.generation, 1)
    } finally {
      await store.release()
    }
  } finally {
    await t.cleanup()
  }
})

function makeJournalForRoot(
  adapter: Parameters<typeof createV4ReencryptionRecoveryJournal>[0]["adapter"],
  root: string,
) {
  return createV4ReencryptionRecoveryJournal({
    adapter, root, sourceCommitSha: pinned, destinationRepoId: dest,
    journalKey: key, runId: "d115-rekey-run",
  })
}

test("D116 each WAL phase survives a fresh real filesystem lease before the next transition", async () => {
  const t = await sandbox()
  const backup = {
    role: "backup" as const, repoId: "owner/repo#backup/d116",
    commitSha: pinned, treeSha: "c".repeat(40),
  }
  const destination = {
    role: "destination" as const, repoId: dest,
    commitSha: "d".repeat(40), treeSha: "e".repeat(40),
    manifestSha256: "f".repeat(64),
  }
  type Journal = ReturnType<typeof makeJournal>
  type Snapshot = Awaited<ReturnType<Journal["begin"]>>
  let generation = 0
  let previous: Snapshot | null = null
  const advance = async (mutate: (journal: Journal, currentGeneration: number) => Promise<Snapshot>) => {
    const storage = await acquireV4DesktopRekeyWalStorage({ rootAbsolute: t.root, journalRoot })
    try {
      const journal = makeJournal(storage.adapter)
      if (previous) {
        assert.deepEqual(await journal.assertHealthySnapshot(generation), previous)
      } else {
        assert.equal(await journal.load(), null)
      }
      const next = await mutate(journal, generation)
      assert.equal(next.generation, generation + 1)
      assert.deepEqual(await journal.assertHealthySnapshot(next.generation), next)
      assert.equal(next.requiresRemoteRevalidation, true)
      assert.equal(next.permissionToPublish, false)
      assert.equal(next.cutoverAuthorized, false)
      generation = next.generation
      previous = next
    } finally {
      await storage.release()
    }
  }

  try {
    await advance(journal => journal.begin())
    await advance((journal, g) => journal.recordRefIntent(backup, g))
    await advance((journal, g) => journal.markRefReadbackObserved(backup, g))
    await advance((journal, g) => journal.recordStagingHandoff(backup, g))
    await advance((journal, g) => journal.recordUploadIntent(receipt, g))
    await advance((journal, g) => journal.appendReceipt(receipt, g))
    await advance((journal, g) => journal.recordCandidatePreparationIntent("1".repeat(64), g))
    await advance((journal, g) => journal.recordPreparedCandidateReceipt({
      commitSha: destination.commitSha, treeSha: destination.treeSha,
      manifestSha256: destination.manifestSha256,
    }, g))
    await advance((journal, g) => journal.recordRefIntent(destination, g))
    await advance((journal, g) => journal.markRefReadbackObserved(destination, g))
    assert.equal(generation, 10)
    const storage = await acquireV4DesktopRekeyWalStorage({ rootAbsolute: t.root, journalRoot })
    try {
      const reopened = await makeJournal(storage.adapter).assertHealthySnapshot(generation)
      assert.deepEqual(reopened, previous)
      assert.deepEqual(reopened.verifiedRefObservations, [backup, destination])
      const bytes = (await Promise.all(["slot-0.json", "slot-1.json"].map(name =>
        readFile(join(t.root, "rekey", "wal", name), "utf8")))).join("")
      assert.ok(!bytes.includes(backup.repoId))
      assert.ok(!bytes.includes(destination.commitSha))
      assert.ok(!bytes.includes(receipt.path))
    } finally {
      await storage.release()
    }
  } finally {
    await t.cleanup()
  }
})

test("D116 lost storage write acknowledgment persists encrypted intent but never permits blind upload retry", async () => {
  const t = await sandbox()
  try {
    const storage = await acquireV4DesktopRekeyWalStorage({ rootAbsolute: t.root, journalRoot })
    try {
      const started = await makeJournal(storage.adapter).begin()
      let loseAcknowledgment = true
      const adapter = {
        ...storage.adapter,
        async write(path: string, value: string) {
          await storage.adapter.write(path, value)
          if (loseAcknowledgment) {
            loseAcknowledgment = false
            throw new Error("simulated lost WAL write acknowledgment after atomic rename")
          }
        },
      }
      const journal = makeJournal(adapter)
      await assert.rejects(
        () => journal.recordUploadIntent(receipt, started.generation),
        /lost WAL write acknowledgment/,
      )
      const actual = await makeJournal(storage.adapter).assertHealthySnapshot(2)
      assert.deepEqual(actual.pendingIntents, [receipt])
      assert.equal(actual.permissionToPublish, false)
    } finally {
      await storage.release()
    }
    const reopened = await acquireV4DesktopRekeyWalStorage({ rootAbsolute: t.root, journalRoot })
    try {
      const journal = makeJournal(reopened.adapter)
      const pending = await journal.assertHealthySnapshot(2)
      const bytesBefore = await Promise.all(["slot-0.json", "slot-1.json"].map(name =>
        readFile(join(t.root, "rekey", "wal", name), "utf8")))
      await assert.rejects(() => journal.recordUploadIntent(receipt, pending.generation), /duplicate/i)
      await assert.rejects(
        () => journal.appendReceipt({ ...receipt, sha: "f".repeat(40) }, pending.generation),
        /does not match/i,
      )
      assert.deepEqual(pending.pendingIntents, [receipt])
      assert.equal(pending.requiresRemoteRevalidation, true)
      assert.equal(pending.permissionToPublish, false)
      assert.equal(pending.cutoverAuthorized, false)
      assert.deepEqual(await Promise.all(["slot-0.json", "slot-1.json"].map(name =>
        readFile(join(t.root, "rekey", "wal", name), "utf8"))), bytesBefore)
    } finally {
      await reopened.release()
    }
  } finally {
    await t.cleanup()
  }
})

test("D86 does not certify power-loss durability when Windows directory fsync is unsupported", async () => {
  const t = await sandbox()
  try {
    const store = await acquireV4DesktopRekeyWalStorage({ rootAbsolute: t.root, journalRoot })
    try {
      const fs = await import("node:fs/promises")
      let supported = true
      try {
        const dir = await fs.open(join(t.root, "rekey", "wal"), "r")
        try { await dir.sync() }
        finally { await dir.close() }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (!["EPERM", "EACCES", "EINVAL", "ENOTSUP", "EISDIR"].includes(code ?? "")) throw error
        supported = false
      }
      if (supported) await store.assertCrashDurable()
      else await assert.rejects(() => store.assertCrashDurable(), /fsync|durability/i)
    } finally { await store.release() }
  } finally { await t.cleanup() }
})

test("D86 rejects second concurrent lease even from a real independent Node process", async () => {
  const t = await sandbox()
  try {
    const held = await acquireV4DesktopRekeyWalStorage({ rootAbsolute: t.root, journalRoot })
    try {
      await assert.rejects(
        () => acquireV4DesktopRekeyWalStorage({ rootAbsolute: t.root, journalRoot }),
        V4DesktopRekeyWalLockError,
      )
      const lockPath = join(t.root, "rekey", "wal", ".exclusive.lock")
      const child = execFileSync(process.execPath, ["-e",
        "const fs=require('fs'); try { const fd=fs.openSync(process.argv[1],'wx'); fs.closeSync(fd); process.exit(3) } catch(e) { process.exit(e.code==='EEXIST'?0:4) }",
        lockPath,
      ])
      assert.equal(child.length, 0)
      await held.assertExclusiveStageLease()
    } finally { await held.release() }
    const again = await acquireV4DesktopRekeyWalStorage({ rootAbsolute: t.root, journalRoot })
    await again.release()
  } finally { await t.cleanup() }
})

test("D86 stale lock is NOT automatically stolen or deleted after interrupted owner", async () => {
  const t = await sandbox()
  try {
    const owner = await acquireV4DesktopRekeyWalStorage({ rootAbsolute: t.root, journalRoot })
    // Deliberately simulate loss of process without calling release.
    await assert.rejects(
      () => acquireV4DesktopRekeyWalStorage({ rootAbsolute: t.root, journalRoot }),
      V4DesktopRekeyWalLockError,
    )
    await owner.release()
  } finally { await t.cleanup() }
})

test("D86 lock abandoned by a terminated independent Node process stays blocked for manual review", async () => {
  const t = await sandbox()
  try {
    const initial = await acquireV4DesktopRekeyWalStorage({ rootAbsolute: t.root, journalRoot })
    const lock = initial.lockPath
    await initial.release()
    // The child intentionally exits without unlinking its exclusive lock.
    // There is no TTL, PID or heuristic stale-lock takeover.
    execFileSync(process.execPath, ["-e",
      "const fs=require('fs');const fd=fs.openSync(process.argv[1],'wx');fs.writeSync(fd,'dead-run');fs.fsyncSync(fd);process.exit(0)",
      lock,
    ])
    await assert.rejects(
      () => acquireV4DesktopRekeyWalStorage({ rootAbsolute: t.root, journalRoot }),
      V4DesktopRekeyWalLockError,
    )
    assert.equal(await readFile(lock, "utf8"), "dead-run")
  } finally { await t.cleanup() }
})

test("D86 rejects traversal and unsupported WAL filenames before filesystem mutation", async () => {
  const t = await sandbox()
  try {
    await assert.rejects(
      () => acquireV4DesktopRekeyWalStorage({ rootAbsolute: t.root, journalRoot: "../escape" }),
      /invalid|unsafe|relative/i,
    )
    const store = await acquireV4DesktopRekeyWalStorage({ rootAbsolute: t.root, journalRoot })
    try {
      await assert.rejects(() => store.adapter.write("../another/file", "{}"), /path|slot|unsafe/i)
      await assert.rejects(() => store.adapter.write("rekey/wal/other.json", "{}"), /path|slot|unsafe/i)
      await assert.rejects(() => store.adapter.read("rekey/wal/../../sensitive"), /path|slot|unsafe/i)
      await assert.rejects(() => store.adapter.mkdir("another/path"), /path|directory|unsafe/i)
    } finally { await store.release() }
  } finally { await t.cleanup() }
})

test("D86 refuses symbolic-link/junction directory and does not follow a slot symlink", async () => {
  const t = await sandbox()
  const elsewhere = await sandbox()
  try {
    await mkdir(join(t.root, "rekey"), { recursive: true })
    await symlink(elsewhere.root, join(t.root, "rekey", "wal"), "junction")
    await assert.rejects(
      () => acquireV4DesktopRekeyWalStorage({ rootAbsolute: t.root, journalRoot }),
      /symlink|junction|unsafe/i,
    )
    await rm(join(t.root, "rekey", "wal"), { force: true })
    const store = await acquireV4DesktopRekeyWalStorage({ rootAbsolute: t.root, journalRoot })
    try {
      const victim = join(elsewhere.root, "protected.json")
      await writeFile(victim, "protected")
      await symlink(victim, join(t.root, "rekey", "wal", "slot-1.json"), "file")
      await assert.rejects(() => makeJournal(store.adapter).begin(), /symlink|junction|unsafe|recovery/i)
      assert.equal(await readFile(victim, "utf8"), "protected")
    } finally { await store.release() }
  } finally { await t.cleanup(); await elsewhere.cleanup() }
})

test("D118 refuses external hardlinked WAL slot for exists, read and write without disclosing data", async t => {
  const area = await sandbox()
  const outside = await sandbox()
  try {
    const protectedFile = join(outside.root, "protected.json")
    const secret = "outside private WAL-like bytes"
    await writeFile(protectedFile, secret)
    const storage = await acquireV4DesktopRekeyWalStorage({
      rootAbsolute: area.root, journalRoot,
    })
    try {
      const linked = join(area.root, "rekey", "wal", "slot-1.json")
      try {
        await link(protectedFile, linked)
      } catch (error) {
        if (["EPERM", "EACCES", "ENOTSUP", "EXDEV"].includes((error as NodeJS.ErrnoException).code ?? "")) {
          t.diagnostic("Hardlink creation is unsupported for this Windows volume/user.")
          return
        }
        throw error
      }
      await assert.rejects(() => storage.adapter.exists("rekey/wal/slot-1.json"), /hardlink|unsafe/i)
      await assert.rejects(() => storage.adapter.read("rekey/wal/slot-1.json"), /hardlink|unsafe/i)
      await assert.rejects(() => storage.adapter.write("rekey/wal/slot-1.json", "{}"), /hardlink|unsafe/i)
      await assert.rejects(() => makeJournal(storage.adapter).begin(), /hardlink|unsafe|recovery/i)
      assert.equal(await readFile(protectedFile, "utf8"), secret)
      assert.equal(await readFile(linked, "utf8"), secret)
    } finally {
      await storage.release()
    }
  } finally {
    await area.cleanup()
    await outside.cleanup()
  }
})

test("D118 refuses hardlinked exclusive lock and keeps its token intact for manual review", async t => {
  const area = await sandbox()
  const outside = await sandbox()
  try {
    const storage = await acquireV4DesktopRekeyWalStorage({
      rootAbsolute: area.root, journalRoot,
    })
    const alias = join(outside.root, "lock-alias")
    let linked = false
    try {
      const tokenBefore = await readFile(storage.lockPath, "utf8")
      try {
        await link(storage.lockPath, alias)
        linked = true
      } catch (error) {
        if (["EPERM", "EACCES", "ENOTSUP", "EXDEV"].includes((error as NodeJS.ErrnoException).code ?? "")) {
          t.diagnostic("Lock hardlink creation is unsupported on this Windows volume/account.")
          return
        }
        throw error
      }
      await assert.rejects(() => storage.assertExclusiveStageLease(), /lock|lease/i)
      await assert.rejects(() => makeJournal(storage.adapter).begin(), /lock|lease/i)
      await assert.rejects(() => storage.release(), /lock|lease/i)
      assert.equal(await readFile(storage.lockPath, "utf8"), tokenBefore)
      assert.equal(await readFile(alias, "utf8"), tokenBefore)
    } finally {
      if (linked) await rm(alias)
      await storage.release()
    }
  } finally {
    await area.cleanup()
    await outside.cleanup()
  }
})

test("D118 bounded descriptor-based WAL read keeps valid encrypted slot reopenable", async () => {
  const area = await sandbox()
  try {
    const storage = await acquireV4DesktopRekeyWalStorage({
      rootAbsolute: area.root, journalRoot,
    })
    try {
      const begun = await makeJournal(storage.adapter).begin()
      assert.equal(begun.generation, 1)
      const slot = await storage.adapter.read("rekey/wal/slot-1.json")
      assert.equal(typeof slot, "string")
      assert.ok(!slot.includes(receipt.path))
      assert.equal((await makeJournal(storage.adapter).assertHealthySnapshot(1)).generation, 1)
      const tooBig = "x".repeat(2 * 1024 * 1024 + 1)
      await writeFile(join(area.root, "rekey", "wal", "slot-1.json"), tooBig)
      await assert.rejects(() => storage.adapter.read("rekey/wal/slot-1.json"), /size limit/i)
      await assert.rejects(() => makeJournal(storage.adapter).load(), /recovery/i)
    } finally {
      await storage.release()
    }
  } finally {
    await area.cleanup()
  }
})

test("D86 interrupted slot temp residue forces manual recovery rather than silently resuming", async () => {
  const t = await sandbox()
  try {
    const first = await acquireV4DesktopRekeyWalStorage({ rootAbsolute: t.root, journalRoot })
    const before = await makeJournal(first.adapter).begin()
    assert.equal(before.generation, 1)
    await first.release()
    const residue = join(t.root, "rekey", "wal", ".slot-torn.tmp")
    await writeFile(residue, "possibly newer WAL content")
    await assert.rejects(() =>
      acquireV4DesktopRekeyWalStorage({ rootAbsolute: t.root, journalRoot }),
      /manual recovery|interrupted|temp/i)
    assert.equal(await readFile(residue, "utf8"), "possibly newer WAL content")
    assert.deepEqual((await readdir(join(t.root, "rekey", "wal"))).sort(),
      [".slot-torn.tmp", "slot-1.json"])
  } finally { await t.cleanup() }
})

test("D86 lost lock invalidates journal mutation; cannot silently continue with an old lease", async () => {
  const t = await sandbox()
  try {
    const store = await acquireV4DesktopRekeyWalStorage({ rootAbsolute: t.root, journalRoot })
    const j = makeJournal(store.adapter)
    const started = await j.begin()
    const lock = join(t.root, "rekey", "wal", ".exclusive.lock")
    // Test-only sabotage: remove the owner's lock to emulate external interference.
    await rm(lock)
    await assert.rejects(() => store.assertExclusiveStageLease(), /lock|lease/i)
    await assert.rejects(() => j.recordUploadIntent(receipt, started.generation), /lock|lease/i)
    await assert.rejects(() => store.release(), /lock|lease/i)
    const second = await acquireV4DesktopRekeyWalStorage({ rootAbsolute: t.root, journalRoot })
    await second.release()
  } finally { await t.cleanup() }
})
