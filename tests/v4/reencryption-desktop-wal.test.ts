import assert from "node:assert/strict"
import test from "node:test"
import { execFileSync } from "node:child_process"
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { createV4ReencryptionRecoveryJournal } from "../../src/lib/v4/reencryption-recovery-journal"
import { acquireV4DesktopRekeyWalStorage, V4DesktopRekeyWalLockError } from "../../src/lib/v4/reencryption-desktop-wal"

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
    }
    state = await journal.recordRefIntent(backup, state.generation)
    state = await journal.markRefReadbackObserved(backup, state.generation)
    state = await journal.recordRefIntent(destination, state.generation)
    const storedBytes = [
      await readFile(join(t.root, "rekey", "wal", "slot-0.json"), "utf8"),
      await readFile(join(t.root, "rekey", "wal", "slot-1.json"), "utf8"),
    ].join("")
    assert.ok(!storedBytes.includes(backup.repoId))
    // Destination repo/branch identity is intentionally stored in the existing authenticated WAL slot header.
    assert.ok(storedBytes.includes(destination.repoId))
    assert.ok(!storedBytes.includes(destination.commitSha))
    await store.release()

    const reopened = await acquireV4DesktopRekeyWalStorage({ rootAbsolute: t.root, journalRoot })
    try {
      const recovered = await makeJournal(reopened.adapter).load()
      assert.ok(recovered)
      assert.deepEqual(recovered.pendingRefIntents, [destination])
      assert.deepEqual(recovered.verifiedRefObservations, [backup])
      assert.equal(recovered.permissionToPublish, false)
      assert.equal(recovered.cutoverAuthorized, false)
      assert.equal(recovered.requiresRemoteRevalidation, true)
      const noAutoRetry = makeJournal(reopened.adapter)
      await assert.rejects(() => noAutoRetry.recordRefIntent(destination, recovered.generation), /duplicate/i)
    } finally { await reopened.release() }
  } finally { await t.cleanup() }
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
