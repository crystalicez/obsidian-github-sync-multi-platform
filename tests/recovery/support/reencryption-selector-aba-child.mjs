// D151 disposable Windows cross-process selector swap/ABA writer.
// No live Obsidian vault, GitHub or plugin data may be written.
import { constants, closeSync, ftruncateSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, writeSync } from "node:fs"
import { basename, resolve, sep } from "node:path"

const [candidate, oldCiphertext, newCiphertext, mode] = process.argv.slice(2)
const scratch = resolve(process.cwd(), ".tmp") + sep
if (!candidate || !resolve(candidate).startsWith(scratch)
  || basename(candidate) !== "selector.json"
  || !["replace", "restore"].includes(mode)
  || typeof oldCiphertext !== "string" || typeof newCiphertext !== "string"
  || oldCiphertext.length < 100 || newCiphertext.length < 100
  || oldCiphertext.length > 8192 || newCiphertext.length > 8192
  || oldCiphertext === newCiphertext) {
  throw new Error("D151 foreign writer refused unsafe inputs")
}

const target = resolve(candidate)
const stat = lstatSync(target)
if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
  || !realpathSync(target).startsWith(scratch)
  || readFileSync(target, "utf8") !== oldCiphertext) {
  throw new Error("D151 foreign writer refused changed or redirected file")
}

const fd = openSync(target, constants.O_RDWR | constants.O_DSYNC)
try {
  for (const contents of mode === "restore"
    ? [newCiphertext, oldCiphertext] : [newCiphertext]) {
    const bytes = Buffer.from(contents, "utf8")
    ftruncateSync(fd, 0)
    const written = writeSync(fd, bytes, 0, bytes.length, 0)
    if (written !== bytes.length) throw new Error("D151 incomplete writer step")
    fsyncSync(fd)
    if (readFileSync(target, "utf8") !== contents) {
      throw new Error("D151 writer did not observe staged contents")
    }
  }
} finally {
  closeSync(fd)
}
process.stdout.write(mode === "restore" ? "d151-aba-restored" : "d151-replaced")
