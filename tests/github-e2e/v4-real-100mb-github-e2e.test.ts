import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import test, { after } from "node:test"
import { setRequestUrlHandler } from "obsidian"

import { GitHubClient } from "../../src/lib/github-api"
import { toBase64Url } from "../../src/lib/bytes"
import { deriveV4Keyring } from "../../src/lib/v4/crypto"
import { createEmptyV4LocalIndex } from "../../src/lib/v4/local-index"
import { V4_FORMAT_VERSION, type V4RemoteConfig } from "../../src/lib/v4/protocol-types"
import { V4SyncSession } from "../../src/lib/v4/sync-session"
import { fetchGitHubE2EWithRetry } from "./support/request-retry"
import {
  readGitHubE2ETargetEnvironment,
  resetGitHubE2EDisposableBranch,
  resolveGitHubE2ETarget,
} from "./support/target-safety"
import { TEST_100MB_BYTES, generateTest100MBFile, hashFile100MB, TestDisk100MBVault } from "../helpers/file-backed-100mb-vault"

const targetEnvironment = readGitHubE2ETargetEnvironment()
if (!/^obsidian-sync-e2e\/local-[a-z0-9-]{8,80}$/u.test(targetEnvironment.branch)) {
  throw new Error("Live 100 MB test requires a disposable local test branch")
}
const target = await resolveGitHubE2ETarget(targetEnvironment)
let disposableBranchVerifiedAbsent = false

setRequestUrlHandler(async raw => {
  const request = raw as { url: string; method?: string; headers?: Record<string, string>; body?: string }
  const response = await fetchGitHubE2EWithRetry(request.url, {
    method: (request.method ?? "GET").toUpperCase(),
    headers: request.headers,
    body: request.body,
  })
  const arrayBuffer = await response.arrayBuffer()
  const text = new TextDecoder().decode(arrayBuffer)
  let json: unknown
  try { json = text ? JSON.parse(text) : undefined } catch { json = undefined }
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    text, json, arrayBuffer,
  }
})

after(async () => {
  try {
    if (disposableBranchVerifiedAbsent) {
      await resetGitHubE2EDisposableBranch(targetEnvironment)
      console.log("GitHub 100 MB E2E: verified disposable branch cleanup")
    }
  } finally {
    setRequestUrlHandler(null)
  }
})

test("GitHub: encrypted real 100 MB disk-file push, no-op, failed staged pull and verified retry", {
  timeout: 900_000,
}, async () => {
  // Recheck the exact ref without mutating: an occupied branch must never be deleted at startup.
  await resolveGitHubE2ETarget(targetEnvironment)
  const base = `https://api.github.com/repos/${encodeURIComponent(target.config.owner)}/${encodeURIComponent(target.config.repo)}`
  const refPath = target.config.branch.split("/").map(encodeURIComponent).join("/")
  const preexisting = await fetchGitHubE2EWithRetry(`${base}/git/ref/heads/${refPath}`, {
    headers: { Authorization: `Bearer ${target.config.token}`, Accept: "application/vnd.github+json" },
  })
  await preexisting.arrayBuffer()
  if (preexisting.status !== 404) throw new Error(`Refusing occupied or unverified test branch: HTTP ${preexisting.status}`)
  disposableBranchVerifiedAbsent = true
  const root = await mkdtemp(path.join(process.cwd(), ".tmp", "github-disk-100mb-"))
  const source = new TestDisk100MBVault(path.join(root, "source"))
  const receiver = new TestDisk100MBVault(path.join(root, "receiver"))
  await mkdir(source.root)
  await mkdir(receiver.root)

  try {
    const srcHash = await generateTest100MBFile(source.payloadPath())
    const client = new GitHubClient(target.config)
    const repoId = `${target.config.owner}/${target.config.repo}#${target.config.branch}`
    const salt = randomBytes(16)
    const remoteConfig: V4RemoteConfig = {
      formatVersion: V4_FORMAT_VERSION, mode: "encrypted", repoId,
      pathLayout: "opaque-stable-v1", algorithm: "AES-GCM", kdf: "PBKDF2-SHA-256",
      kdfParams: { iterations: 10_000, salt: toBase64Url(salt) },
    }
    const keyring = await deriveV4Keyring({ passphrase: "temporary-disposable-100mb-test",
      repoId, salt, iterations: 10_000 })
    const sourceIndex = createEmptyV4LocalIndex({ repoId, deviceId: "disk-source",
      mode: "encrypted", pathLayout: "opaque-stable-v1" })
    const pullIndex = createEmptyV4LocalIndex({ repoId, deviceId: "disk-pull",
      mode: "encrypted", pathLayout: "opaque-stable-v1" })
    const session = (vault: TestDisk100MBVault, index: typeof sourceIndex) =>
      new V4SyncSession({ github: client, vault, index, config: remoteConfig,
        keyring, conflictPolicy: "copy", abortChangePercent: 0 })
    const started = performance.now()
    const pushed = await session(source, sourceIndex).sync({
      operation: "forcePush", allowThresholdOverride: false,
    })
    assert.equal(pushed.mode, "force-push")
    assert.ok(sourceIndex.remoteCommitSha)
    console.log("GitHub 100 MB E2E: encrypted Force Push completed")
    const publishedSha = sourceIndex.remoteCommitSha
    const noOp = await session(source, sourceIndex).sync({
      operation: "normal", allowThresholdOverride: false,
    })
    assert.equal(noOp.mode, "noop")
    assert.equal(sourceIndex.remoteCommitSha, publishedSha)
    console.log("GitHub 100 MB E2E: no-op preserved published head")

    receiver.failAppendAt = 2
    await assert.rejects(
      () => session(receiver, pullIndex).sync({ operation: "forcePull", allowThresholdOverride: false }),
      /Synthetic bounded stage append interruption/u,
    )
    assert.equal(await receiver.stat("payload.bin"), null, "Interrupted pull must not create a partial final target")
    console.log("GitHub 100 MB E2E: interrupted staged pull left no final target")
    const pulled = await session(receiver, pullIndex).sync({
      operation: "forcePull", allowThresholdOverride: false,
    })
    assert.equal(pulled.mode, "force-pull")
    assert.equal((await receiver.stat("payload.bin"))?.size, TEST_100MB_BYTES)
    assert.equal(await hashFile100MB(receiver.payloadPath()), srcHash)
    assert.equal(source.wholeReads, 0)
    assert.equal(receiver.wholeReads, 0)
    assert.ok(source.boundedReads > 1)
    assert.ok(receiver.stagedWrites > 1)
    assert.equal(receiver.stagedCommits, 1)
    console.log(JSON.stringify({
      kind: "real-github-100mb-encrypted-verified",
      bytes: TEST_100MB_BYTES, sha256: srcHash,
      elapsedMs: Math.round(performance.now() - started),
      sourceBoundedReads: source.boundedReads,
      receiverStagedWrites: receiver.stagedWrites,
      recovered: true,
      branch: target.config.branch,
    }))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
