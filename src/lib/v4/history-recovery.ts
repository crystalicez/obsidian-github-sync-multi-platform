import type { Vault } from "obsidian"

type RecoveryVault = Pick<Vault, "getAbstractFileByPath" | "create">

/**
 * Recovery is deliberately additive: never overwrite or remove any existing Vault file.
 * The atomic Vault.create call must also refuse a path claimed after the pre-check.
 */
export async function createV4HistoricalMarkdownCopy(
  vault: RecoveryVault,
  originalPath: string,
  commitSha: string,
  bytes: Uint8Array,
): Promise<string> {
  const basename = originalPath.split("/").at(-1) ?? ""
  if (!/\.md$/iu.test(basename)) throw new Error("Only Markdown history can be restored as a note.")

  let content: string
  try {
    content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    throw new Error("Historical Markdown is not valid UTF-8; no recovery file was created.")
  }

  const safeName = basename.slice(0, -3).normalize("NFC")
    .replace(/[^\p{L}\p{N}\p{M}_-]/gu, "-")
    .replace(/^-+|-+$/gu, "")
  // Iterate by Unicode scalar, not UTF-16 units: slicing can split a
  // supplementary CJK letter into an invalid lone surrogate. Bound UTF-8
  // bytes as well so recovered Markdown names work on Windows and mobile.
  const encoder = new TextEncoder()
  let stem = ""
  let stemBytes = 0
  let characters = 0
  for (const character of safeName) {
    const bytes = encoder.encode(character).byteLength
    if (characters === 64 || stemBytes + bytes > 192) break
    stem += character
    stemBytes += bytes
    characters++
  }
  stem ||= "note"
  const commitLabel = commitSha.replace(/[^A-Za-z0-9]/gu, "").slice(0, 8) || "history"

  for (let index = 1; index <= 100; index++) {
    const suffix = index === 1 ? "" : `-${index}`
    const path = `Recovered-${stem}-${commitLabel}${suffix}.md`
    if (vault.getAbstractFileByPath(path)) continue
    // A concurrent create is allowed to fail, but is never retried with the
    // same content on another path: a failed write may have partially succeeded.
    await vault.create(path, content)
    return path
  }
  throw new Error("No unused recovery filename remains.")
}
