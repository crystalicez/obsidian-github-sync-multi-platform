// Test-only independent Windows process. It intentionally exits by SIGKILL
// with an open O_DSYNC file handle, never a graceful close/cleanup.
// The parent supplies only a newly created disposable directory.
import { constants, closeSync, ftruncateSync, fsyncSync, openSync, writeSync } from "node:fs"
import { join, resolve, sep } from "node:path"

const [root, slot, phase, ciphertext] = process.argv.slice(2)
const disposableParent = resolve(process.cwd(), ".tmp") + sep
if (!root || !resolve(root).startsWith(disposableParent)
  || !["slot-a.bin", "slot-b.bin", "slot-0.json", "slot-1.json"].includes(slot)
  || !["before-open", "after-open", "after-truncate", "after-partial",
    "after-full", "after-sync"].includes(phase)
  || typeof ciphertext !== "string" || ciphertext.length < 100 || ciphertext.length > 8192) {
  throw new Error("Invalid D149 isolated crash child arguments")
}

const killAt = stage => {
  if (phase !== stage) return
  // Reaches this point only after the intended synchronous operation ended.
  const marker = openSync(join(root, "reached-phase.txt"), "wx")
  try {
    writeSync(marker, stage)
    fsyncSync(marker)
  } finally { closeSync(marker) }
  process.kill(process.pid, "SIGKILL")
  throw new Error("D149 SIGKILL failed")
}

killAt("before-open")
const fd = openSync(join(root, slot), constants.O_RDWR | constants.O_DSYNC)
killAt("after-open")
ftruncateSync(fd, 0)
killAt("after-truncate")
const bytes = Buffer.from(ciphertext, "utf8")
const portion = phase === "after-partial" ? Math.min(17, bytes.length - 1) : bytes.length
const count = writeSync(fd, bytes, 0, portion, 0)
if (count !== portion) throw new Error("D149 incomplete synchronous test write")
killAt("after-partial")
killAt("after-full")
fsyncSync(fd)
killAt("after-sync")
throw new Error("D149 unsupported phase")
