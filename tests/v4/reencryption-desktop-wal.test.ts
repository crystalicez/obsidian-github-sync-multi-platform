import assert from "node:assert/strict"
import test from "node:test"
import { execFileSync } from "node:child_process"
import { createRequire, syncBuiltinESMExports } from "node:module"
import { link, mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises"
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

test("D402 WAL initialization failure cleans up its own unchanged lock", async () => {
  const t = await sandbox()
  const directory = join(t.root, "rekey", "wal")
  const lock = join(directory, ".exclusive.lock")
  const unexpected = join(directory, "interrupted-evidence.tmp")
  const fs = createRequire(import.meta.url)("node:fs/promises") as {
    readdir: (...args: unknown[]) => Promise<unknown>
  }
  const originalReaddir = fs.readdir
  let injected = false
  try {
    fs.readdir = async (...args: unknown[]) => {
      if (!injected && args[0] === directory) {
        injected = true
        await writeFile(unexpected, "retain incomplete WAL evidence", "utf8")
      }
      return originalReaddir(...args)
    }
    syncBuiltinESMExports()
    await assert.rejects(
      acquireV4DesktopRekeyWalStorage({ rootAbsolute: t.root, journalRoot }),
      /pre-existing or interrupted recovery evidence/i,
    )
    assert.equal(injected, true)
    await assert.rejects(readFile(lock, "utf8"), { code: "ENOENT" },
      "the initializer may clean up only its own unchanged lock")
    assert.equal(await readFile(unexpected, "utf8"), "retain incomplete WAL evidence")
  } finally {
    fs.readdir = originalReaddir
    syncBuiltinESMExports()
    await t.cleanup()
  }
})

test("D402 WAL initialization failure preserves a foreign replacement lock", async () => {
  const t = await sandbox()
  const directory = join(t.root, "rekey", "wal")
  const lock = join(directory, ".exclusive.lock")
  const displaced = join(directory, "displaced-original-lock")
  const unexpected = join(directory, "interrupted-evidence.tmp")
  let foreignToken = ""
  const fs = createRequire(import.meta.url)("node:fs/promises") as {
    readdir: (...args: unknown[]) => Promise<unknown>
  }
  const originalReaddir = fs.readdir
  let swapped = false
  try {
    fs.readdir = async (...args: unknown[]) => {
      if (!swapped && args[0] === directory) {
        swapped = true
        // During initialization, the initial owner loses its pathname. A
        // different owner then establishes a new lock at the same pathname.
        await rename(lock, displaced)
        // A new owner could reproduce the original token bytes. Pathname
        // identity must be checked independently of token contents.
        foreignToken = await readFile(displaced, "utf8")
        await writeFile(lock, foreignToken, "utf8")
        await writeFile(unexpected, "preserve possible interrupted WAL evidence", "utf8")
      }
      return originalReaddir(...args)
    }
    syncBuiltinESMExports()
    await assert.rejects(
      acquireV4DesktopRekeyWalStorage({ rootAbsolute: t.root, journalRoot }),
      /pre-existing or interrupted recovery evidence/i,
    )
    assert.equal(swapped, true, "test must replace the lock during initialization")
    assert.equal(await readFile(lock, "utf8"), foreignToken,
      "initialization cleanup must not unlink another owner's lock")
    assert.equal(await readFile(unexpected, "utf8"),
      "preserve possible interrupted WAL evidence",
      "interrupted evidence must remain available for Manual Recovery")
    assert.equal((await readFile(displaced, "utf8")).length, 32)
  } finally {
    fs.readdir = originalReaddir
    syncBuiltinESMExports()
    await t.cleanup()
  }
})

test("D404 releasing a displaced lock preserves a foreign same-token replacement", async () => {
  const t = await sandbox()
  const directory = join(t.root, "rekey", "wal")
  const lockPath = join(directory, ".exclusive.lock")
  const displaced = join(directory, "original-lock-displaced-after-token")
  const fs = createRequire(import.meta.url)("node:fs/promises") as {
    lstat: typeof import("node:fs/promises").lstat
  }
  const originalLstat = fs.lstat
  let lockChecks = 0
  let swapped = false
  let store: Awaited<ReturnType<typeof acquireV4DesktopRekeyWalStorage>> | undefined
  try {
    store = await acquireV4DesktopRekeyWalStorage({ rootAbsolute: t.root, journalRoot })
    await makeJournal(store.adapter).begin()
    const token = await readFile(lockPath, "utf8")
    fs.lstat = (async (...args: Parameters<typeof originalLstat>) => {
      const observed = await originalLstat(...args)
      if (args[0] === lockPath && ++lockChecks === 2) {
        // The second lock pathname stat is assertHeld's post-token check.
        // The lock is replaced after that observation, before release unlinks.
        await rename(lockPath, displaced)
        await writeFile(lockPath, token, "utf8")
        swapped = true
      }
      return observed
    }) as typeof originalLstat
    syncBuiltinESMExports()
    await assert.rejects(store.release(), V4DesktopRekeyWalLockError,
      "release must not unlink a foreign lock installed after its token check")
    assert.equal(swapped, true, "the real Windows lock must change at the release boundary")
    assert.equal(await readFile(lockPath, "utf8"), token,
      "the new owner's same-token lock must remain for Manual Recovery")
    assert.equal(await readFile(displaced, "utf8"), token,
      "the detached original owner's evidence must be preserved")
    // Once the original lock is restored, its owner can still release it.
    // A failed first release must not corrupt its in-process lease state.
    fs.lstat = originalLstat
    syncBuiltinESMExports()
    await rm(lockPath, { force: true })
    await rename(displaced, lockPath)
    swapped = false
    await store.release()
    await assert.rejects(readFile(lockPath, "utf8"), { code: "ENOENT" })
  } finally {
    fs.lstat = originalLstat
    syncBuiltinESMExports()
    if (swapped) {
      await rm(lockPath, { force: true })
      await rename(displaced, lockPath)
    }
    try { await store?.release() } catch {
      // Original (RED) behavior may already have released the lease.
    }
    await t.cleanup()
  }
})

test("D403 temporary-slot replacement cannot overwrite a valid WAL checkpoint", async () => {
  const t = await sandbox()
  const directory = join(t.root, "rekey", "wal")
  const target = join(directory, "slot-1.json")
  const foreign = join(directory, "foreign-temp")
  const fs = createRequire(import.meta.url)("node:fs/promises") as {
    lstat: typeof import("node:fs/promises").lstat
  }
  const previousLstat = fs.lstat
  let checks = 0
  let replaced = ""
  let store: Awaited<ReturnType<typeof acquireV4DesktopRekeyWalStorage>> | undefined
  try {
    store = await acquireV4DesktopRekeyWalStorage({ rootAbsolute: t.root, journalRoot })
    await makeJournal(store.adapter).begin()
    const before = await readFile(target, "utf8")
    fs.lstat = (async (...args: Parameters<typeof previousLstat>) => {
      if (args[0] === target && ++checks === 2) {
        const name = (await readdir(directory)).find(s => s.startsWith(".slot-") && s.endsWith(".tmp"))
        assert.ok(name)
        replaced = join(directory, name)
        await rename(replaced, foreign)
        await writeFile(replaced, "foreign file", "utf8")
      }
      return previousLstat(...args)
    }) as typeof previousLstat
    syncBuiltinESMExports()
    await assert.rejects(store.adapter.write(journalRoot + "/slot-1.json", before), /temporary|changed|identity|replaced/i)
    assert.equal(checks, 2)
    assert.equal(await readFile(target, "utf8"), before)
    assert.equal(await readFile(replaced, "utf8"), "foreign file")
  } finally {
    fs.lstat = previousLstat
    syncBuiltinESMExports()
    await store?.release()
    await t.cleanup()
  }
})

test("D403 failed WAL rename preserves another owner's temporary file", async () => {
  const t = await sandbox()
  const directory = join(t.root, "rekey", "wal")
  const target = join(directory, "slot-1.json")
  const displaced = join(directory, "displaced-original-temp")
  const fs = createRequire(import.meta.url)("node:fs/promises") as {
    rename: typeof import("node:fs/promises").rename
  }
  const previousRename = fs.rename
  let foreignTemp = ""
  let store: Awaited<ReturnType<typeof acquireV4DesktopRekeyWalStorage>> | undefined
  try {
    store = await acquireV4DesktopRekeyWalStorage({ rootAbsolute: t.root, journalRoot })
    await makeJournal(store.adapter).begin()
    const before = await readFile(target, "utf8")
    fs.rename = (async (...args: Parameters<typeof previousRename>) => {
      const source = String(args[0])
      if (!foreignTemp && source.startsWith(join(directory, ".slot-")) && args[1] === target) {
        foreignTemp = source
        await previousRename(source, displaced)
        await writeFile(source, "foreign interrupted evidence", "utf8")
        throw new Error("injected rename error after foreign replacement")
      }
      return previousRename(...args)
    }) as typeof previousRename
    syncBuiltinESMExports()
    await assert.rejects(store.adapter.write(journalRoot + "/slot-1.json", before),
      /injected rename error after foreign replacement/)
    assert.ok(foreignTemp, "the test must replace a real temporary WAL file")
    assert.equal(await readFile(target, "utf8"), before)
    assert.equal(await readFile(foreignTemp, "utf8"), "foreign interrupted evidence")
  } finally {
    fs.rename = previousRename
    syncBuiltinESMExports()
    await store?.release()
    await t.cleanup()
  }
})

test("D403 failed WAL rename cleans up an unchanged writer-owned temporary file", async () => {
  const t = await sandbox()
  const directory = join(t.root, "rekey", "wal")
  const target = join(directory, "slot-1.json")
  const fs = createRequire(import.meta.url)("node:fs/promises") as {
    rename: typeof import("node:fs/promises").rename
  }
  const previousRename = fs.rename
  let injected = false
  let store: Awaited<ReturnType<typeof acquireV4DesktopRekeyWalStorage>> | undefined
  try {
    store = await acquireV4DesktopRekeyWalStorage({ rootAbsolute: t.root, journalRoot })
    await makeJournal(store.adapter).begin()
    const before = await readFile(target, "utf8")
    fs.rename = (async (...args: Parameters<typeof previousRename>) => {
      if (!injected && String(args[0]).startsWith(join(directory, ".slot-")) && args[1] === target) {
        injected = true
        throw new Error("injected transient WAL rename error")
      }
      return previousRename(...args)
    }) as typeof previousRename
    syncBuiltinESMExports()
    await assert.rejects(store.adapter.write(journalRoot + "/slot-1.json", before),
      /injected transient WAL rename error/)
    assert.equal(injected, true)
    assert.equal(await readFile(target, "utf8"), before)
    assert.deepEqual((await readdir(directory)).sort(), [".exclusive.lock", "slot-1.json"],
      "an unchanged writer-owned temporary file may be cleaned safely")
  } finally {
    fs.rename = previousRename
    syncBuiltinESMExports()
    await store?.release()
    await t.cleanup()
  }
})

test("D401 Desktop WAL lease refuses a detached or same-token replacement lock during token read", async () => {
  for (const mode of ["detached", "same-token-replaced"] as const) {
  const t = await sandbox()
  const lockPath = join(t.root, "rekey", "wal", ".exclusive.lock")
  const displaced = join(t.root, "rekey", "wal", "displaced-lock")
  const fs = createRequire(import.meta.url)("node:fs/promises") as {
    open: typeof import("node:fs/promises").open
  }
  const originalOpen = fs.open
  let armed = false
  let intercepted = false
  let moved = false
  let entered!: () => void
  let resumeRead!: () => void
  const reading = new Promise<void>(resolve => { entered = resolve })
  const resumed = new Promise<void>(resolve => { resumeRead = resolve })
  let store: Awaited<ReturnType<typeof acquireV4DesktopRekeyWalStorage>> | undefined
  try {
    fs.open = (async (...args: Parameters<typeof originalOpen>) => {
      const handle = await originalOpen(...args)
      if (args[0] === lockPath && args[1] === "wx+") {
        const originalRead = handle.read.bind(handle)
        Object.defineProperty(handle, "read", {
          configurable: true,
          value: async (buffer: Buffer, offset: number, length: number, position: number) => {
            if (armed && !intercepted) {
              intercepted = true
              entered()
              await resumed
            }
            return originalRead(buffer, offset, length, position)
          },
        })
      }
      return handle
    }) as typeof originalOpen
    syncBuiltinESMExports()
    store = await acquireV4DesktopRekeyWalStorage({ rootAbsolute: t.root, journalRoot })
    armed = true
    const check = store.assertExclusiveStageLease()
    await reading
    // The descriptor still holds its original token, but the pathname no
    // longer identifies an exclusively owned lock at the end of this check.
    await rename(lockPath, displaced)
    moved = true
    if (mode === "same-token-replaced") {
      await writeFile(lockPath, await readFile(displaced, "utf8"))
    }
    resumeRead()
    await assert.rejects(check, /lock|lease/i,
      "a detached lock path must not certify an exclusive writer lease")
  } finally {
    resumeRead()
    fs.open = originalOpen
    syncBuiltinESMExports()
    if (moved) {
      if (mode === "same-token-replaced") await rm(lockPath)
      await rename(displaced, lockPath)
    }
    await store?.release()
    await t.cleanup()
  }
  }
})

test("D400 Desktop WAL read refuses external in-place modification after descriptor validation", async () => {
  const t = await sandbox()
  const fs = createRequire(import.meta.url)("node:fs/promises") as {
    open: typeof import("node:fs/promises").open
  }
  const originalOpen = fs.open
  const slot = join(t.root, "rekey", "wal", "slot-1.json")
  let readStarted!: () => void
  let resumeRead!: () => void
  const entered = new Promise<void>(resolve => { readStarted = resolve })
  const resume = new Promise<void>(resolve => { resumeRead = resolve })
  let intercepted = false
  let storage: Awaited<ReturnType<typeof acquireV4DesktopRekeyWalStorage>> | undefined
  try {
    storage = await acquireV4DesktopRekeyWalStorage({ rootAbsolute: t.root, journalRoot })
    await makeJournal(storage.adapter).begin()
    const prior = await storage.adapter.read(journalRoot + "/slot-1.json")
    fs.open = (async (...args: Parameters<typeof originalOpen>) => {
      const handle = await originalOpen(...args)
      if (!intercepted && args[0] === slot && args[1] === "r") {
        intercepted = true
        const read = handle.read.bind(handle)
        Object.defineProperty(handle, "read", {
          configurable: true,
          value: async (buffer: Buffer, offset: number, length: number, position: number) => {
            readStarted()
            await resume
            return read(buffer, offset, length, position)
          },
        })
      }
      return handle
    }) as typeof originalOpen
    syncBuiltinESMExports()

    const pending = storage.adapter.read(journalRoot + "/slot-1.json")
    await entered
    // A foreign, uncooperative actor writes the same number of bytes directly
    // through the OS path; it does not touch our cooperative WAL write epoch.
    await writeFile(slot, "Z".repeat(Buffer.byteLength(prior, "utf8")), "utf8")
    resumeRead()
    await assert.rejects(pending, /slot changed during read/i,
      "post-read slot metadata must reject foreign changes even when the FD stayed open")
  } finally {
    resumeRead()
    fs.open = originalOpen
    syncBuiltinESMExports()
    await storage?.release()
    await t.cleanup()
  }
})

test("D399 best-effort WAL readback rejects a completed write interleaved with its checkpoint", async () => {
  const t = await sandbox()
  const store = await acquireV4DesktopRekeyWalStorage({
    rootAbsolute: t.root, journalRoot,
  })
  // Node's built-in ESM fs exports are synced from the CJS module so the
  // actual WAL storage hits this test-controlled directory read barrier.
  const fs = createRequire(import.meta.url)("node:fs/promises") as {
    readdir: (...args: unknown[]) => Promise<unknown>
  }
  const originalReaddir = fs.readdir
  const walDirectory = join(t.root, "rekey", "wal")
  let entered!: () => void
  let continueRead!: () => void
  const intercepted = new Promise<void>(resolve => { entered = resolve })
  const resumed = new Promise<void>(resolve => { continueRead = resolve })
  let interceptedOnce = false
  try {
    await makeJournal(store.adapter).begin()
    const slot = journalRoot + "/slot-1.json"
    const persisted = await store.adapter.read(slot)
    fs.readdir = async (...args: unknown[]) => {
      if (!interceptedOnce && args[0] === walDirectory) {
        interceptedOnce = true
        entered()
        await resumed
      }
      return originalReaddir(...args)
    }
    syncBuiltinESMExports()

    const checkpoint = store.assertBestEffortCheckpoint()
    await intercepted
    // Complete a real create-only temporary-file write and rename while
    // the checkpoint is suspended. Both final reads then see stable bytes.
    await store.adapter.write(slot, persisted)
    continueRead()
    await assert.rejects(checkpoint, /WAL.*changed|checkpoint.*changed|readback.*changed/i,
      "a second real WAL write cannot be invisible merely because it completed between checks")
    assert.equal((await makeJournal(store.adapter).assertHealthySnapshot(1)).generation, 1)
    assert.equal(await store.assertBestEffortCheckpoint(), "best-effort-readback-only",
      "a fresh, non-overlapping readback still succeeds")
  } finally {
    continueRead()
    fs.readdir = originalReaddir
    syncBuiltinESMExports()
    await store.release()
    await t.cleanup()
  }
})

test("D164 best-effort WAL checkpoint verifies settled disk readback but never claims physical durability", async () => {
  const t = await sandbox()
  try {
    const store = await acquireV4DesktopRekeyWalStorage({ rootAbsolute: t.root, journalRoot })
    try {
      await assert.rejects(() => store.assertBestEffortCheckpoint(), /no saved recovery checkpoint/u)
      const journal = makeJournal(store.adapter)
      const started = await journal.begin()
      const uploaded = await journal.recordUploadIntent(receipt, started.generation)
      assert.equal(await store.assertBestEffortCheckpoint(), "best-effort-readback-only")
      const actual = await journal.assertHealthySnapshot(uploaded.generation)
      assert.equal(actual.generation, uploaded.generation)
      assert.deepEqual(actual.pendingIntents, [receipt])
      assert.equal(actual.cutoverAuthorized, false)
      assert.equal(actual.permissionToPublish, false)
    } finally {
      await store.release()
    }
  } finally {
    await t.cleanup()
  }
})

test("D164 best-effort WAL check refuses unrecognized residue and does not authenticate corrupt ciphertext", async () => {
  const t = await sandbox()
  try {
    const store = await acquireV4DesktopRekeyWalStorage({ rootAbsolute: t.root, journalRoot })
    try {
      await makeJournal(store.adapter).begin()
      const slot = join(t.root, "rekey", "wal", "slot-1.json")
      await writeFile(slot, "corrupted but stable")
      assert.equal(await store.assertBestEffortCheckpoint(), "best-effort-readback-only")
      await assert.rejects(() => makeJournal(store.adapter).assertHealthySnapshot(1), /invalid|malformed|journal|corrupt|Unexpected|JSON|snapshot/i)
      const residue = join(t.root, "rekey", "wal", ".slot-foreign.tmp")
      await writeFile(residue, "unexpected")
      await assert.rejects(() => store.assertBestEffortCheckpoint(), /manual recovery required/i)
    } finally {
      await store.release()
    }
    await assert.rejects(() => store.assertBestEffortCheckpoint(), V4DesktopRekeyWalLockError)
  } finally {
    await t.cleanup()
  }
})

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

test("D128 starting another WAL write synchronously revokes previous directory-sync proof", async () => {
  const proof = new V4RekeyWalDirectorySyncProof()
  await proof.refresh(true, async () => true)
  proof.assertConfirmed()
  proof.invalidate()
  assert.throws(() => proof.assertConfirmed(), /fsync|durability/i,
    "previous fsync is not proof for a newly started slot transition")
  await proof.refresh(true, async () => false)
  assert.throws(() => proof.assertConfirmed(), /fsync|durability/i)
  await proof.refresh(true, async () => true)
  proof.assertConfirmed()
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

test("D292 invalidation during a pending WAL leaf fsync cannot resurrect old crash-durability proof", async () => {
  const proof = new V4RekeyWalDirectorySyncProof()
  let resolveFlush!: (synced: boolean) => void
  const pending = new Promise<boolean>(resolve => { resolveFlush = resolve })
  const flushing = proof.refresh(true, () => pending)
  assert.throws(() => proof.assertConfirmed(), /fsync|durability/i)

  // A new WAL mutation can invalidate an in-flight directory flush.
  // Its later successful completion must NOT certify the newer generation.
  proof.invalidate()
  resolveFlush(true)
  await flushing
  assert.throws(() => proof.assertConfirmed(), /fsync|durability/i,
    "a completed stale fsync cannot reauthorize crash durability after invalidation")

  await proof.refresh(true, async () => true)
  proof.assertConfirmed()
})

test("D126 real Windows WAL lease serializes two journal instances sharing its live adapter", async () => {
  const t = await sandbox()
  try {
    const storage = await acquireV4DesktopRekeyWalStorage({ rootAbsolute: t.root, journalRoot })
    try {
      const start = await makeJournal(storage.adapter).begin()
      const alternative = {
        ...receipt,
        path: `.obsidian-github-sync-v4/data/bb/${"b".repeat(64)}.enc`,
        sha: "c".repeat(40),
      }
      const both = await Promise.allSettled([
        makeJournal(storage.adapter).recordUploadIntent(receipt, start.generation),
        makeJournal(storage.adapter).recordUploadIntent(alternative, start.generation),
      ])
      assert.equal(both[0]?.status, "fulfilled")
      assert.equal(both[1]?.status, "rejected",
        "same-process journal instances cannot contend under one OS WAL lease")
      const snapshot = await makeJournal(storage.adapter).assertHealthySnapshot(2)
      assert.deepEqual(snapshot.pendingIntents, [receipt])
      assert.equal(snapshot.requiresRemoteRevalidation, true)
      assert.equal(snapshot.permissionToPublish, false)
      assert.equal(snapshot.cutoverAuthorized, false)
    } finally {
      await storage.release()
    }
  } finally {
    await t.cleanup()
  }
})

test("D128 real Windows WAL adapter rejects simultaneous writes to distinct WAL slots", async () => {
  const t = await sandbox()
  try {
    const storage = await acquireV4DesktopRekeyWalStorage({ rootAbsolute: t.root, journalRoot })
    try {
      const initial = await makeJournal(storage.adapter).begin()
      const logical = journalRoot + "/slot-1.json"
      const sealed = await storage.adapter.read(logical)
      const [first, second] = await Promise.allSettled([
        storage.adapter.write(logical, sealed),
        storage.adapter.write(journalRoot + "/slot-0.json", sealed),
      ])
      assert.equal(first.status, "fulfilled", "first WAL writer must complete normally")
      assert.equal(second.status, "rejected",
        "one WAL lease must not allow two overlapping raw adapter writes")
      const after = await makeJournal(storage.adapter).assertHealthySnapshot(initial.generation)
      assert.equal(after.generation, initial.generation)
      assert.equal(after.permissionToPublish, false)
      assert.equal(after.cutoverAuthorized, false)
      assert.deepEqual((await readdir(join(t.root, "rekey", "wal"))).sort(),
        [".exclusive.lock", "slot-1.json"])
    } finally {
      await storage.release()
    }
  } finally {
    await t.cleanup()
  }
})

test("D127 cannot release the WAL lease while an adapter write is still in flight", async () => {
  const t = await sandbox()
  try {
    const storage = await acquireV4DesktopRekeyWalStorage({ rootAbsolute: t.root, journalRoot })
    let released = false
    try {
      const initial = await makeJournal(storage.adapter).begin()
      const logical = journalRoot + "/slot-1.json"
      const encrypted = await storage.adapter.read(logical)
      // Start a real Windows filesystem write but deliberately do NOT await
      // its first asynchronous lease/inode checks before trying release().
      const pendingWrite = storage.adapter.write(logical, encrypted)
      const releaseAfterDrain = storage.release()
      await assert.rejects(() => storage.adapter.exists(logical), V4DesktopRekeyWalLockError,
        "once release begins, new work must be refused until old I/O drains")
      await pendingWrite
      await releaseAfterDrain
      released = true
      const reopened = await acquireV4DesktopRekeyWalStorage({ rootAbsolute: t.root, journalRoot })
      try {
        assert.equal((await makeJournal(reopened.adapter).assertHealthySnapshot(initial.generation)).generation,
          initial.generation)
      } finally {
        await reopened.release()
      }
    } finally {
      if (!released) {
        try { await storage.release() } catch { /* preserve failure evidence on disposal */ }
      }
    }
  } finally {
    await t.cleanup()
  }
})

test("D127 two concurrent release calls cannot both unlink one WAL lease", async () => {
  const t = await sandbox()
  try {
    const storage = await acquireV4DesktopRekeyWalStorage({ rootAbsolute: t.root, journalRoot })
    const initial = await makeJournal(storage.adapter).begin()
    const firstRelease = storage.release()
    await assert.rejects(() => storage.release(), V4DesktopRekeyWalLockError)
    await assert.rejects(() => storage.adapter.exists(journalRoot + "/slot-1.json"),
      V4DesktopRekeyWalLockError, "no new adapter work after release began")
    await firstRelease
    await assert.rejects(() => storage.release(), V4DesktopRekeyWalLockError)
    const reopened = await acquireV4DesktopRekeyWalStorage({ rootAbsolute: t.root, journalRoot })
    try {
      assert.equal((await makeJournal(reopened.adapter).assertHealthySnapshot(initial.generation)).generation,
        initial.generation)
    } finally {
      await reopened.release()
    }
  } finally {
    await t.cleanup()
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
