import assert from "node:assert/strict"
import { readFile, stat } from "node:fs/promises"
import { isAbsolute, join, relative, resolve, sep } from "node:path"

import { createV4ReencryptionRecoveryJournal } from "../../../src/lib/v4/reencryption-recovery-journal"
import type { V4LocalIndexAdapter } from "../../../src/lib/v4/local-index"

// Separate fresh process. Read-only forensic evidence inspection is NOT
// a stale-lock takeover or authorization to resume a migration.
const rootAbsolute = process.argv[2] ?? ""
const expected = Number(process.argv[3])
const root = resolve(process.cwd(), ".tmp")
const subpath = relative(root, rootAbsolute)
if (!isAbsolute(rootAbsolute) || !subpath || subpath === ".."
  || subpath.startsWith(".." + sep) || isAbsolute(subpath)
  || !Number.isInteger(expected) || expected < 2 || expected > 10) {
  throw new Error("D117 forensic reader requires a disposable test root and expected generation.")
}
const slotPath = (logical: string) => {
  if (logical !== "rekey/wal/slot-0.json" && logical !== "rekey/wal/slot-1.json") {
    throw new Error("D117 forensic read denied unknown path.")
  }
  return join(rootAbsolute, ...logical.split("/"))
}
const adapter: V4LocalIndexAdapter = {
  async exists(logical) {
    try { return (await stat(slotPath(logical))).isFile() }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
      throw error
    }
  },
  read: async logical => readFile(slotPath(logical), "utf8"),
  async write() { throw new Error("D117 forensic reader is read-only.") },
  async mkdir() { throw new Error("D117 forensic reader is read-only.") },
}
const journal = createV4ReencryptionRecoveryJournal({
  adapter, root: "rekey/wal",
  sourceCommitSha: "a".repeat(40), destinationRepoId: "owner/repo#rekey/d117",
  journalKey: new Uint8Array(32).fill(0x47), runId: "d117-process-kill",
})
const snapshot = await journal.assertHealthySnapshot(expected)
assert.equal(snapshot.generation, expected)
assert.equal(snapshot.permissionToPublish, false)
assert.equal(snapshot.cutoverAuthorized, false)
assert.equal(snapshot.requiresRemoteRevalidation, true)
await assert.rejects(() => journal.recordUploadIntent({
  path: `.obsidian-github-sync-v4/data/aa/${"b".repeat(64)}.enc`,
  sha: "e".repeat(40), byteLength: 1,
}, expected), /read-only|after candidate|duplicate|ref publication/i)
console.log(`forensic-read-only-ok:${expected}`)
