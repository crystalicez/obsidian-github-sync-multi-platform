import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"

// D129 isolated, non-production Node-only Windows Vault writer-fence PoC.
// Every write is confined to this test's own .tmp tree. No Obsidian Vault,
// live GitHub repository, OS policy/ACL, or migration cutover is touched.
const tmp = path.join(process.cwd(), ".tmp")

function child(js, args) {
  const result = spawnSync(process.execPath, ["-e", js, ...args], {
    cwd: process.cwd(), encoding: "utf8", timeout: 15000, windowsHide: true,
  })
  if (result.error) throw result.error
  return result
}

test("D129 Windows: independent process can edit held note and create/rename new notes despite Node-only sentinel", {
  timeout: 40000,
}, async t => {
  if (process.platform !== "win32") return t.skip("Windows Node-only feasibility evidence")
  t.diagnostic(`D129 environment: ${process.platform} ${process.arch}, Node ${process.version}`)
  await mkdir(tmp, { recursive: true })
  const isolated = await mkdtemp(path.join(tmp, "d129-vault-fence-poc-"))
  const vault = path.join(isolated, "disposable-vault")
  const notes = path.join(vault, "notes")
  const note = path.join(notes, "pinned.md")
  const created = path.join(notes, "untracked.tmp")
  const renamed = path.join(notes, "unsaved-new.md")
  const sentinel = path.join(vault, ".migration-sentinel.lock")
  const before = "note-version-0001"
  const after = "note-version-0002"
  let noteHandle
  let sentinelHandle
  try {
    await mkdir(notes, { recursive: true })
    await writeFile(note, before, "utf8")
    const baseline = await stat(note)
    noteHandle = await open(note, "r")
    sentinelHandle = await open(sentinel, "wx+")
    await sentinelHandle.writeFile("test-only-owner", "utf8")
    await sentinelHandle.sync()

    // Another process can opt into the protocol. Its wx+ attempt fails,
    // but this says NOTHING about a non-cooperating filesystem writer.
    const cooperating = child(
      "const fs=require('node:fs');try{const fd=fs.openSync(process.argv[1],'wx+');fs.closeSync(fd);process.exit(9)}catch(e){process.exit(e.code==='EEXIST'?0:8)}",
      [sentinel],
    )
    assert.equal(cooperating.status, 0, "cooperating child must observe owner's sentinel")

    // Simulate an external editor that does NOT opt into the sentinel protocol.
    // Its writes occur WHILE the parent retains the note fd and lock fd.
    const independent = child(
      "const fs=require('node:fs');const [note,created,renamed,after,atime,mtime]=process.argv.slice(1);fs.writeFileSync(note,after,'utf8');fs.utimesSync(note,new Date(Number(atime)),new Date(Number(mtime)));fs.writeFileSync(created,'new-untracked-note','utf8');fs.renameSync(created,renamed);console.log('external-modifications-committed')",
      [note, created, renamed, after, String(baseline.atimeMs), String(baseline.mtimeMs)],
    )
    assert.equal(independent.status, 0,
      `external Node process could not mutate disposable Vault with existing handles: ${independent.stderr}`)
    assert.match(independent.stdout, /external-modifications-committed/)
    assert.equal((await readFile(note, "utf8")), after, "old content changed despite held read handle")
    assert.equal((await stat(note)).size, baseline.size, "overwritten note retains its original byte count")
    assert.equal((await readFile(renamed, "utf8")), "new-untracked-note",
      "a previously nonexistent note can be created and renamed while the sentinel exists")
    assert.deepEqual((await readdir(notes)).sort(), ["pinned.md", "unsaved-new.md"])
    assert.equal((await readFile(sentinel, "utf8")), "test-only-owner",
      "sentinel remains intact: its existence does not exclude non-cooperating writers")
    assert.equal((await noteHandle.stat()).size, baseline.size)
    assert.equal((await stat(sentinel)).isFile(), true)
  } finally {
    await noteHandle?.close()
    await sentinelHandle?.close()
    await rm(isolated, { recursive: true, force: true })
  }
})

test("D129 Windows: observing a stable note set cannot fence external post-scan edits", {
  timeout: 40000,
}, async t => {
  if (process.platform !== "win32") return t.skip("Windows Node-only feasibility evidence")
  t.diagnostic(`D129 environment: ${process.platform} ${process.arch}, Node ${process.version}`)
  await mkdir(tmp, { recursive: true })
  const isolated = await mkdtemp(path.join(tmp, "d129-post-scan-poc-"))
  const note = path.join(isolated, "same-size.md")
  const before = "A".repeat(64)
  const after = "B".repeat(64)
  let held
  try {
    await writeFile(note, before, "utf8")
    held = await open(note, "r")
    const baseline = await stat(note)
    const verifiedSnapshot = await readFile(note, "utf8")
    assert.equal(verifiedSnapshot, before)

    // Deliberately run after the last inspection. Even double hashing is a
    // point-in-time observation, not an OS-enforced no-writers guarantee.
    const external = child(
      "const fs=require('node:fs');const [name,bytes,atime,mtime]=process.argv.slice(1);fs.writeFileSync(name,bytes,'utf8');fs.utimesSync(name,new Date(Number(atime)),new Date(Number(mtime)))",
      [note, after, String(baseline.atimeMs), String(baseline.mtimeMs)],
    )
    assert.equal(external.status, 0, external.stderr)
    const observed = await readFile(note, "utf8")
    assert.equal(observed, after)
    assert.notEqual(observed, verifiedSnapshot)
    assert.equal((await stat(note)).size, baseline.size)
    // Windows timestamp precision depends on volume and filesystem; do not
    // claim exact mtime parity unless the OS actually observed it.
    const delta = Math.abs((await stat(note)).mtimeMs - baseline.mtimeMs)
    t.diagnostic(`Windows physical mtime delta after explicit restore: ${delta} ms`)
  } finally {
    await held?.close()
    await rm(isolated, { recursive: true, force: true })
  }
})
