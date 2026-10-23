import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { build } from "esbuild"

const root = process.cwd()
const tmp = path.join(root, ".tmp")
const original = Buffer.from([1, 2, 3, 4, 5, 6])
const staged = Buffer.from([6, 5, 4, 3, 2, 1, 0])

async function fileExists(filename) {
  try { await stat(filename); return true }
  catch (error) {
    if (error.code === "ENOENT") return false
    throw error
  }
}

test("D11: real child-process kill at each synchronous staged rename boundary preserves bytes and WAL", { timeout: 90000 }, async () => {
  await mkdir(tmp, { recursive: true })
  const fixture = await mkdtemp(path.join(tmp, "native-kill-d11-"))
  const child = path.join(fixture, "crash-child.cjs")
  try {
    // Child bundle uses actual production filesystem/recovery code in a fresh
    // Node process. It is not a mocked rename sequence in this test process.
    await build({
      entryPoints: [path.join(root, "tests/recovery/support/staged-process-kill-child.ts")],
      outfile: child, bundle: true, platform: "node", format: "cjs",
      target: "node22", logLevel: "silent",
    })
    function invoke(mode, subdir, cut = "") {
      const childResult = spawnSync(process.execPath, [child, mode, subdir, cut], {
        cwd: root, encoding: "utf8", timeout: 17000, windowsHide: true,
      })
      assert.equal(childResult.signal, null, `${mode}: unexpected signal ${childResult.signal}`)
      if (childResult.error) throw childResult.error
      return childResult
    }
    for (const [cut, expectedExit, recoveryMode] of [
      ["1", 91, "discard"],
      ["2", 92, "resume"],
    ]) {
      const dir = path.join(fixture, "case-" + cut)
      const prepared = invoke("prepare", dir)
      assert.equal(prepared.status, 0, prepared.stderr)
      assert.equal(await fileExists(path.join(dir, "wal", "slot-1.json")), true)

      const killed = invoke("crash", dir, cut)
      assert.equal(killed.status, expectedExit,
        `Expected real process.exit after rename #${cut}, got ${killed.status}: ${killed.stderr}`)
      const target = path.join(dir, "note.md")
      const backup = path.join(dir, "stage.bin.target-backup")
      const stageFile = path.join(dir, "stage.bin")
      const pendingWal = await fileExists(path.join(dir, "wal", "slot-1.json"))
      assert.equal(pendingWal, true, "No durable WAL after abrupt child exit")
      assert.equal(await fileExists(backup), true, "Original backup lost at crash boundary")
      assert.deepEqual(await readFile(backup), original)

      if (cut === "1") {
        assert.equal(await fileExists(target), false, "First rename should park old target")
        assert.deepEqual(await readFile(stageFile), staged)
      } else {
        assert.deepEqual(await readFile(target), staged, "Replacement exists before WAL receipt")
        assert.equal(await fileExists(stageFile), false, "Stage was already renamed into place")
      }

      // Fresh child process, no in-memory snapshot or special cleanup callback
      // inherited from the terminated process.
      const result = invoke(recoveryMode, dir)
      assert.equal(result.status, 0,
        `Fresh process could not ${recoveryMode}: ${result.stderr}`)
      assert.deepEqual(await readFile(target), cut === "1" ? original : staged)
      assert.equal(await fileExists(backup), false)
      assert.equal(await fileExists(path.join(dir, "stage.bin.replacement-residue")), false)
      assert.match(result.stdout, cut === "1" ? /original-restored/ : /remote-recovered/)
    }
    // A process can also die AFTER a successful commitStage returns but
    // BEFORE the caller records a durable WAL completion receipt. The
    // original backup must still exist so this transaction can be aborted.
    for (const recoveryMode of ["discard", "resume"]) {
      const dir = path.join(fixture, "after-commit-" + recoveryMode)
      assert.equal(invoke("prepare", dir).status, 0)
      const died = invoke("after-commit-crash", dir)
      assert.equal(died.status, 93, died.stderr)
      const originalBackup = path.join(dir, "stage.bin.target-backup")
      assert.deepEqual(await readFile(originalBackup), original,
        "Original backup was prematurely removed before WAL receipt")
      assert.deepEqual(await readFile(path.join(dir, "note.md")), staged)
      assert.equal(await fileExists(path.join(dir, "wal", "slot-1.json")), true)
      const restart = invoke(recoveryMode, dir)
      assert.equal(restart.status, 0, restart.stderr)
      assert.deepEqual(await readFile(path.join(dir, "note.md")),
        recoveryMode === "discard" ? original : staged)
      assert.equal(await fileExists(originalBackup), false)
    }
    // Simulate a crash while rolling back a previously swapped staged target.
    // Cut #2 is especially important: the backup was already restored but
    // the replacement still exists as residue when the process disappears.
    for (const [cut, expectedExit] of [["1",91],["2",92]]) {
      const dir = path.join(fixture, "rollback-" + cut)
      assert.equal(invoke("prepare-rollback", dir).status, 0)
      const crash = invoke("rollback-crash", dir, cut)
      assert.equal(crash.status, expectedExit,
        `Expected rollback crash #${cut}, got ${crash.status}: ${crash.stderr}`)
      const target = path.join(dir, "note.md")
      const backup = path.join(dir, "stage.bin.target-backup")
      const residue = path.join(dir, "stage.bin.replacement-residue")
      assert.deepEqual(await readFile(residue), staged, "Staged candidate lost after rollback kill")
      assert.equal(await fileExists(backup), cut === "1")
      if (cut === "1") assert.equal(await fileExists(target), false)
      else assert.deepEqual(await readFile(target), original)
      assert.equal(await fileExists(path.join(dir, "wal", "slot-1.json")), true)
      const resumed = invoke("discard", dir)
      assert.equal(resumed.status, 0,
        `Fresh process failed to complete partial rollback: ${resumed.stderr}`)
      assert.deepEqual(await readFile(target), original)
      assert.equal(await fileExists(backup), false)
      assert.equal(await fileExists(residue), false)
    }

    // Deliberately mutate one proof-bearing file *after* a hard process
    // exit. A replay must leave all evidence intact, never opportunistically
    // discard a changed target, restored backup, or parked replacement.
    for (const [tamper, cut] of [
      ["restored-original", "2"],
      ["parked-replacement", "2"],
      ["original-backup", "1"],
    ]) {
      const dir = path.join(fixture, "tampered-" + tamper)
      assert.equal(invoke("prepare-rollback", dir).status, 0)
      assert.equal(invoke("rollback-crash", dir, cut).status, 90 + Number(cut))
      const target = path.join(dir, "note.md")
      const backup = path.join(dir, "stage.bin.target-backup")
      const residue = path.join(dir, "stage.bin.replacement-residue")
      const protectedFile = tamper === "restored-original" ? target
        : tamper === "parked-replacement" ? residue : backup
      const tampered = Buffer.from("external-user-edit:" + tamper)
      await writeFile(protectedFile, tampered)
      const before = await Promise.all(
        [target, backup, residue].map(async filename => await fileExists(filename)
          ? readFile(filename) : null),
      )
      const refused = invoke("discard", dir)
      assert.notEqual(refused.status, 0,
        `Unsafe rollback discarded ${tamper} after a real process kill`)
      assert.match(refused.stderr, /manual|backup|original|residue|review|hash/i)
      const after = await Promise.all(
        [target, backup, residue].map(async filename => await fileExists(filename)
          ? readFile(filename) : null),
      )
      assert.deepEqual(after, before, `Fail-closed cleanup changed evidence for ${tamper}`)
      assert.equal(await fileExists(path.join(dir, "wal", "slot-1.json")), true)
    }
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})
