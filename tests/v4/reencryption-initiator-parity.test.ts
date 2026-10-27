import assert from "node:assert/strict"
import test from "node:test"
import { sha256Hex, utf8ToBytes } from "../../src/lib/bytes"
import type { V4IndexFileRecord } from "../../src/lib/v4/local-index"
import {
  verifyV4ReencryptionInitiatorLocalParity,
  type V4ReencryptionInitiatorParityInput,
} from "../../src/lib/v4/reencryption-initiator-parity"

const sourceSha = "a".repeat(40)
type F = { bytes: Uint8Array; mtime: number }
async function fixture(names: string[] = ["notes/a.md", "notes/🪄.md"]) {
  const files = new Map<string, F>()
  const sourceRecords: V4IndexFileRecord[] = []
  for (const [i, path] of names.entries()) {
    const bytes = utf8ToBytes("note " + i + " private content")
    files.set(path, { bytes, mtime: 1700000000000 + i })
    sourceRecords.push({
      path, pathId: "b".repeat(64), fileId: "ID-" + i,
      plaintextSha256: await sha256Hex(bytes),
      size: bytes.byteLength, mtime: 12345 + i,
      remoteVersion: "v1", remotePath: "opaque/" + i, storage: "single",
    })
  }
  let extraEditor: string[] = []
  let onList: (() => void) | null = null
  let onOpen: ((path: string) => void) | null = null
  let checks = 0
  let syncActive = false
  let settingsChanged = false
  let lockLost = false
  const reader = {
    async listFiles() {
      onList?.()
      return [...files.entries()].map(([path, file]) => ({
        path, size: file.bytes.length, mtime: file.mtime,
      }))
    },
    async openFile(path: string) {
      onOpen?.(path)
      const file = files.get(path)
      if (!file) throw new Error("File missing during scan")
      return {
        size: file.bytes.length,
        async *chunks(chunkSize: number, _signal?: AbortSignal) {
          assert.equal(chunkSize, 8 * 1024 * 1024)
          for (let i = 0; i < file.bytes.length; i += 5) {
            yield file.bytes.subarray(i, i + 5)
          }
        },
      }
    },
    async listOpenEditorPaths() { return extraEditor },
    async assertIdleAndNoPendingEdits() {
      checks++
      if (syncActive) throw new Error("Active sync/edit queue")
    },
    async assertSourceConfigurationUnchanged() {
      if (settingsChanged) throw new Error("Captured scope or GitHub connection changed")
    },
    async assertExclusiveInitiatorLease() {
      if (lockLost) throw new Error("Initiating-device lease lost")
    },
  }
  const input: V4ReencryptionInitiatorParityInput = {
    pinnedSourceCommitSha: sourceSha,
    verifiedSource: {
      integrityScope: "all-live-objects", pinnedSourceCommitSha: sourceSha,
      verifiedFileCount: sourceRecords.length,
      verifiedRemoteObjectCount: sourceRecords.length,
      totalVerifiedPlaintextBytes: sourceRecords.reduce((sum, r) => sum + BigInt(r.size), 0n).toString(),
    },
    sourceRecords, reader,
  }
  return {
    input, files, get checks() { return checks },
    openEditor(value: string[]) { extraEditor = value },
    setOnList(fn: () => void) { onList = fn },
    setOnOpen(fn: (p: string) => void) { onOpen = fn },
    activateSync() { syncActive = true },
    modifySettings() { settingsChanged = true },
    loseLease() { lockLost = true },
  }
}

test("D105 whole initiating vault is compared byte-for-byte to immutable remote plaintext source, without changing the vault", async () => {
  const f = await fixture()
  const result = await verifyV4ReencryptionInitiatorLocalParity(f.input)
  assert.equal(result.integrityScope, "initiator-live-vault-exact-pinned-source-parity")
  assert.equal(result.checkedFileCount, 2)
  assert.equal(result.checkedPlaintextBytes, f.input.verifiedSource.totalVerifiedPlaintextBytes)
  assert.equal(result.allFilesContentVerified, true)
  assert.equal(result.noUnexpectedLocalFiles, true)
  assert.equal(result.noOpenEditorsObserved, true)
  assert.equal(result.initiatorLocalCutoverAuthorized, false)
  assert.ok(f.checks >= 4)
  assert.ok(Object.isFrozen(result))
})

test("D105 empty encrypted source and truly empty local vault pass read-only parity without granting cutover", async () => {
  const f = await fixture([])
  const result = await verifyV4ReencryptionInitiatorLocalParity(f.input)
  assert.equal(result.checkedFileCount, 0)
  assert.equal(result.checkedPlaintextBytes, "0")
  assert.equal(result.initiatorLocalCutoverAuthorized, false)
})

test("D105 unexpected local addition, missing file or size drift refuses migration", async () => {
  const cases = [
    (f: Awaited<ReturnType<typeof fixture>>) => f.files.set("extra/unsynced.md", {
      bytes: utf8ToBytes("unsynced"), mtime: 123,
    }),
    (f: Awaited<ReturnType<typeof fixture>>) => { f.files.delete("notes/a.md") },
    (f: Awaited<ReturnType<typeof fixture>>) => f.files.set("notes/a.md", {
      bytes: utf8ToBytes("longer changed content"), mtime: 123,
    }),
  ]
  for (const mutate of cases) {
    const f = await fixture()
    mutate(f)
    await assert.rejects(() => verifyV4ReencryptionInitiatorLocalParity(f.input), /unexpected|missing|changed|SHA-256/i)
  }
})

test("D105 same-size same-mtime unsynced edit is detected by SHA-256, not stat heuristics", async () => {
  const f = await fixture()
  const old = f.files.get("notes/a.md")!
  f.files.set("notes/a.md", { mtime: old.mtime, bytes: utf8ToBytes("x".repeat(old.bytes.byteLength)) })
  await assert.rejects(() => verifyV4ReencryptionInitiatorLocalParity(f.input), /SHA-256/i)
})

test("D105 Unicode case-fold local path collision, and remote path ambiguity are rejected", async () => {
  const f = await fixture()
  f.files.set("NOTES/A.md", { ...f.files.get("notes/a.md")! })
  await assert.rejects(() => verifyV4ReencryptionInitiatorLocalParity(f.input), /ambiguous/i)
  const original = await fixture()
  const wrong = { ...original.input, sourceRecords: [
    original.input.sourceRecords[0]!,
    { ...original.input.sourceRecords[1]!, path: "notes/A.md" },
  ] }
  await assert.rejects(() => verifyV4ReencryptionInitiatorLocalParity(wrong), /ambiguous/i)
})

test("D105 dirty/open editor, active sync, settings drift, or lost exclusive lease block read-only success", async () => {
  for (const change of [
    (f: Awaited<ReturnType<typeof fixture>>) => f.openEditor(["notes/a.md"]),
    (f: Awaited<ReturnType<typeof fixture>>) => f.activateSync(),
    (f: Awaited<ReturnType<typeof fixture>>) => f.modifySettings(),
    (f: Awaited<ReturnType<typeof fixture>>) => f.loseLease(),
  ]) {
    const f = await fixture()
    change(f)
    await assert.rejects(() => verifyV4ReencryptionInitiatorLocalParity(f.input))
  }
})

test("D105 detects local file writes during full-vault scan even if original content was hashed correctly", async () => {
  const f = await fixture()
  let changed = false
  f.setOnOpen(path => {
    if (path === "notes/🪄.md" && !changed) {
      changed = true
      const original = f.files.get("notes/a.md")!
      f.files.set("notes/a.md", { bytes: original.bytes, mtime: original.mtime + 1 })
    }
  })
  await assert.rejects(() => verifyV4ReencryptionInitiatorLocalParity(f.input), /changed during/i)
})

test("D107 second SHA-256 pass detects an intervening same-size same-mtime edit to an already-hashed note", async () => {
  const f = await fixture()
  let poisoned = false
  // Once a.md has been fully hashed, poison it immediately before reading
  // the later note. Restore identical metadata so inventory comparison alone
  // cannot detect the stale SHA proof from the first pass.
  f.setOnOpen(path => {
    if (path === "notes/🪄.md" && !poisoned) {
      poisoned = true
      const original = f.files.get("notes/a.md")!
      f.files.set("notes/a.md", {
        bytes: utf8ToBytes("X".repeat(original.bytes.length)), mtime: original.mtime,
      })
    }
  })
  await assert.rejects(
    () => verifyV4ReencryptionInitiatorLocalParity(f.input),
    /SHA-256/i,
  )
  assert.equal(poisoned, true)
  assert.equal(f.files.get("notes/a.md")!.mtime, 1700000000000)
})

test("D105 rejects forged inventory totals and aborts before reading local bytes", async () => {
  const f = await fixture()
  const input = { ...f.input, verifiedSource: {
    ...f.input.verifiedSource, totalVerifiedPlaintextBytes: "0",
  } }
  await assert.rejects(() => verifyV4ReencryptionInitiatorLocalParity(input), /authenticated totals/i)
  const abort = new AbortController()
  abort.abort(new Error("cancelled pre-cutover"))
  await assert.rejects(() => verifyV4ReencryptionInitiatorLocalParity({
    ...f.input, signal: abort.signal,
  }), /cancelled pre-cutover/)
  assert.equal(f.checks, 0)
})
