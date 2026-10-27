import { writeFile } from "node:fs/promises"
import { isAbsolute, join, relative, resolve, sep } from "node:path"

import { acquireV4DesktopRekeyWalStorage } from "../../../src/lib/v4/reencryption-desktop-wal"
import { createV4ReencryptionRecoveryJournal } from "../../../src/lib/v4/reencryption-recovery-journal"

// D117: an independent executable bundled from the actual production Desktop WAL.
// It may only mutate a disposable directory under the CURRENT repository's .tmp.
// No user vault, GitHub token, network transport or branch-publication capability.
const directory = process.argv[2] ?? ""
const phase = process.argv[3] ?? ""
const sandboxRoot = resolve(process.cwd(), ".tmp")
const relativeRoot = relative(sandboxRoot, directory)
if (!isAbsolute(directory) || !relativeRoot || relativeRoot === ".."
  || relativeRoot.startsWith(".." + sep) || isAbsolute(relativeRoot)) {
  throw new Error("D117 kill worker refuses any path outside the disposable .tmp root.")
}
if (!["backup-intent", "blob-intent", "prepared-candidate", "destination-intent", "destination-readback"].includes(phase)) {
  throw new Error("D117 kill worker refused unknown WAL checkpoint.")
}
const root = "rekey/wal"
const sourceCommitSha = "a".repeat(40)
const destinationRepoId = "owner/repo#rekey/d117"
const backup = {
  role: "backup" as const, repoId: "owner/repo#backup/d117",
  commitSha: sourceCommitSha, treeSha: "b".repeat(40),
}
const destination = {
  role: "destination" as const, repoId: destinationRepoId,
  commitSha: "c".repeat(40), treeSha: "d".repeat(40), manifestSha256: "e".repeat(64),
}
const staged = {
  path: `.obsidian-github-sync-v4/data/aa/${"f".repeat(64)}.enc`,
  sha: "f".repeat(40), byteLength: 123,
}
const store = await acquireV4DesktopRekeyWalStorage({ rootAbsolute: directory, journalRoot: root })
const journal = createV4ReencryptionRecoveryJournal({
  adapter: store.adapter, root, sourceCommitSha, destinationRepoId,
  journalKey: new Uint8Array(32).fill(0x47), runId: "d117-process-kill",
})
let state = await journal.begin()
state = await journal.recordRefIntent(backup, state.generation)
if (phase !== "backup-intent") {
  state = await journal.markRefReadbackObserved(backup, state.generation)
  state = await journal.recordStagingHandoff(backup, state.generation)
  state = await journal.recordUploadIntent(staged, state.generation)
  if (phase !== "blob-intent") {
    state = await journal.appendReceipt(staged, state.generation)
    state = await journal.recordCandidatePreparationIntent("1".repeat(64), state.generation)
    state = await journal.recordPreparedCandidateReceipt({
      commitSha: destination.commitSha, treeSha: destination.treeSha,
      manifestSha256: destination.manifestSha256,
    }, state.generation)
    if (phase === "destination-intent" || phase === "destination-readback") {
      state = await journal.recordRefIntent(destination, state.generation)
      if (phase === "destination-readback") {
        state = await journal.markRefReadbackObserved(destination, state.generation)
      }
    }
  }
}
await journal.assertHealthySnapshot(state.generation)
await store.assertExclusiveStageLease()
// Write a non-sensitive *test-only* checkpoint outside the encrypted WAL.
// Do not release or unlink the lease. Forcefully terminate the real process.
await writeFile(join(directory, "d117-child-checkpoint.txt"), String(state.generation), "utf8")
process.kill(process.pid, "SIGKILL")
throw new Error("D117 SIGKILL did not terminate the child process.")
