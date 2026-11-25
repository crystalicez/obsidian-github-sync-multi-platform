import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { setRequestUrlHandler } from "obsidian"

import { fromBase64, sha256Hex, toBase64, toBase64Url, utf8ToBytes } from "../../src/lib/bytes"
import { GitHubClient } from "../../src/lib/github-api"
import { V4PluginRuntime } from "../../src/lib/v4/runtime"
import { V4_RUNTIME_INDEX_ROOT } from "../../src/lib/v4/reencryption-index-root"
import { V4_REENCRYPTION_RUNTIME_ROUTE_PATH } from "../../src/lib/v4/reencryption-runtime-index-route"
import { V4_REENCRYPTION_SYNC_FENCE_ROOT } from "../../src/lib/v4/reencryption-sync-fence"
import { planV4PluginPrivateWalLocation } from "../../src/lib/v4/reencryption-plugin-wal-location"
import { verifyGitHubReencryptionForkSource, verifyGitHubReencryptionForkSourceWithTranscodeInventory } from "../../src/lib/v4/reencryption-trusted-loader"
import { createEmptyV4LocalIndex, saveV4LocalIndex, loadV4LocalIndex } from "../../src/lib/v4/local-index"
import { deriveV4Keyring } from "../../src/lib/v4/crypto"
import { stageV4InstalledDestinationSecret, readV4InstalledDestinationSecret, installedSecretReceiptRoot } from "../../src/lib/v4/reencryption-installed-secret"
import { createV4ReencryptionRecoveryJournal } from "../../src/lib/v4/reencryption-recovery-journal"
import { V4StorageCodec } from "../../src/lib/v4/storage-codec"
import { buildV4RemoteMetadata } from "../../src/lib/v4/remote-index"
import type { V4RemoteConfig, V4RemoteHead } from "../../src/lib/v4/protocol-types"

const OWNER = "owner"
const REPO = "vault-repo"
const SOURCE_BRANCH = "main"
const DEFAULT_BRANCH = "main"
const PHYSICAL_REPO_ID = 987654
const CONFIG_DIR = ".obsidian"
const PLUGIN_ID = "encrypted-github-sync-multi-platform"
const OLD_PASSPHRASE = "old-rehearsal-passphrase"
const NEW_PASSPHRASE = "new-rehearsal-passphrase"

interface MemoryTreeEntry {
  readonly path: string
  readonly mode: "040000" | "100644"
  readonly type: "tree" | "blob"
  readonly sha: string
}

function gitSha1(kind: "blob" | "tree" | "commit", payload: Uint8Array): string {
  return createHash("sha1").update(`${kind} ${payload.byteLength}\0`).update(payload).digest("hex")
}

function createMemoryGitHubServer() {
  const blobs = new Map<string, Uint8Array>()
  const trees = new Map<string, MemoryTreeEntry[]>()
  const commits = new Map<string, { sha: string; treeSha: string; parents: string[]; message: string }>()
  const refs = new Map<string, string>()

  function buildRecursiveTree(treeSha: string): MemoryTreeEntry[] {
    const entries = trees.get(treeSha) ?? []
    const result: MemoryTreeEntry[] = []
    for (const entry of entries) {
      result.push(entry)
      if (entry.type === "tree") {
        for (const child of buildRecursiveTree(entry.sha)) {
          result.push({ ...child, path: `${entry.path}/${child.path}` })
        }
      }
    }
    return result
  }

  function createTreeFromRecords(
    baseTreeSha: string | undefined,
    updates: ReadonlyArray<{ path: string; mode: string; type: "blob"; sha: string | null }>,
  ): string {
    const files = new Map<string, string>()
    if (baseTreeSha) {
      for (const entry of buildRecursiveTree(baseTreeSha)) {
        if (entry.type === "blob") files.set(entry.path, entry.sha)
      }
    }
    for (const update of updates) {
      if (update.sha === null) files.delete(update.path)
      else files.set(update.path, update.sha)
    }
    function writeSubtree(prefix: string): string {
      const children = new Map<string, { type: "blob" | "tree"; sha: string; mode: "100644" | "040000" }>()
      const subdirs = new Set<string>()
      for (const [fullPath, sha] of files) {
        if (prefix && !fullPath.startsWith(prefix + "/")) continue
        const rel = prefix ? fullPath.slice(prefix.length + 1) : fullPath
        const slash = rel.indexOf("/")
        if (slash < 0) children.set(rel, { type: "blob", sha, mode: "100644" })
        else subdirs.add(rel.slice(0, slash))
      }
      for (const dir of [...subdirs].sort()) {
        const childPrefix = prefix ? `${prefix}/${dir}` : dir
        children.set(dir, { type: "tree", sha: writeSubtree(childPrefix), mode: "040000" })
      }
      const entries: MemoryTreeEntry[] = [...children.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, info]) => ({ path: name, mode: info.mode, type: info.type, sha: info.sha }))
      const canonical = utf8ToBytes(JSON.stringify(entries))
      const treeSha = gitSha1("tree", canonical)
      trees.set(treeSha, entries)
      return treeSha
    }
    return writeSubtree("")
  }

  const handler = async (rawRequest: unknown) => {
    const req = rawRequest as { url: string; method?: string; body?: string }
    const parsed = new URL(req.url)
    const method = (req.method ?? "GET").toUpperCase()
    const pathName = parsed.pathname
    const repoPrefix = `/repos/${OWNER}/${REPO}`
    const ok = (json: unknown, status = 200) => ({ status, text: JSON.stringify(json), headers: {}, json })
    const err = (status: number, message: string) => ({ status, text: JSON.stringify({ message }), headers: {}, json: { message } })

    if (method === "GET" && pathName === repoPrefix) {
      return ok({ id: PHYSICAL_REPO_ID, full_name: `${OWNER}/${REPO}`, default_branch: DEFAULT_BRANCH })
    }
    if (method === "GET" && pathName.startsWith(`${repoPrefix}/git/ref/heads/`)) {
      const branch = decodeURIComponent(pathName.slice(`${repoPrefix}/git/ref/heads/`.length))
      const sha = refs.get(branch)
      if (!sha) return err(404, "Not Found")
      return ok({ ref: `refs/heads/${branch}`, object: { type: "commit", sha } })
    }
    if (method === "POST" && pathName === `${repoPrefix}/git/refs`) {
      const body = JSON.parse(req.body ?? "{}") as { ref: string; sha: string }
      const branch = body.ref.replace(/^refs\/heads\//u, "")
      if (refs.has(branch)) return err(422, "Reference already exists")
      refs.set(branch, body.sha)
      return ok({ ref: body.ref, object: { type: "commit", sha: body.sha } }, 201)
    }
    if (method === "PATCH" && pathName.startsWith(`${repoPrefix}/git/refs/heads/`)) {
      const branch = decodeURIComponent(pathName.slice(`${repoPrefix}/git/refs/heads/`.length))
      const body = JSON.parse(req.body ?? "{}") as { sha: string; force?: boolean }
      if (!refs.has(branch)) return err(404, "Not Found")
      refs.set(branch, body.sha)
      return ok({ ref: `refs/heads/${branch}`, object: { type: "commit", sha: body.sha } })
    }
    if (method === "POST" && pathName === `${repoPrefix}/git/blobs`) {
      const body = JSON.parse(req.body ?? "{}") as { content: string; encoding?: string }
      const data = body.encoding === "base64" ? fromBase64(body.content) : utf8ToBytes(body.content)
      const sha = gitSha1("blob", data)
      blobs.set(sha, data)
      return ok({ sha }, 201)
    }
    if (method === "GET" && pathName.startsWith(`${repoPrefix}/git/blobs/`)) {
      const sha = pathName.slice(`${repoPrefix}/git/blobs/`.length)
      const data = blobs.get(sha)
      if (!data) return err(404, "Blob not found")
      return {
        status: 200,
        text: "",
        headers: {},
        arrayBuffer: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
        json: { sha, size: data.byteLength, encoding: "base64", content: toBase64(data) },
      }
    }
    if (method === "POST" && pathName === `${repoPrefix}/git/trees`) {
      const body = JSON.parse(req.body ?? "{}") as { base_tree?: string; tree: Array<{ path: string; mode: string; type: "blob"; sha: string | null }> }
      const sha = createTreeFromRecords(body.base_tree, body.tree)
      return ok({ sha }, 201)
    }
    if (method === "GET" && pathName.startsWith(`${repoPrefix}/git/trees/`)) {
      const sha = pathName.slice(`${repoPrefix}/git/trees/`.length)
      if (!trees.has(sha)) return err(404, "Tree not found")
      const recursive = parsed.searchParams.get("recursive") === "1"
      const tree = recursive ? buildRecursiveTree(sha) : (trees.get(sha) ?? [])
      return ok({ sha, truncated: false, tree })
    }
    if (method === "POST" && pathName === `${repoPrefix}/git/commits`) {
      const body = JSON.parse(req.body ?? "{}") as { message: string; tree: string; parents?: string[] }
      const parents = body.parents ?? []
      const payload = utf8ToBytes(JSON.stringify({ message: body.message, tree: body.tree, parents }))
      const sha = gitSha1("commit", payload)
      commits.set(sha, { sha, treeSha: body.tree, parents, message: body.message })
      return ok({ sha, tree: { sha: body.tree }, parents: parents.map(p => ({ sha: p })), message: body.message }, 201)
    }
    if (method === "GET" && pathName.startsWith(`${repoPrefix}/git/commits/`)) {
      const sha = pathName.slice(`${repoPrefix}/git/commits/`.length)
      const commit = commits.get(sha)
      if (!commit) return err(404, "Commit not found")
      return ok({ sha: commit.sha, tree: { sha: commit.treeSha }, parents: commit.parents.map(p => ({ sha: p })), message: commit.message })
    }
    return err(404, `Unhandled ${method} ${pathName}`)
  }

  return { handler, refs, commits, blobs, createTreeFromRecords }
}

async function seedEncryptedSource(
  server: ReturnType<typeof createMemoryGitHubServer>,
  files: ReadonlyArray<{ path: string; bytes: Uint8Array; mtime: number }>,
): Promise<string> {
  const repoId = `${OWNER}/${REPO}#${SOURCE_BRANCH}`
  const salt = utf8ToBytes("d412-source-salt")
  const config: V4RemoteConfig = {
    formatVersion: 4,
    mode: "encrypted",
    repoId,
    pathLayout: "opaque-stable-v1",
    algorithm: "AES-GCM",
    kdf: "PBKDF2-SHA-256",
    kdfParams: { iterations: 600_000, salt: toBase64Url(salt) },
  }
  const keyring = await deriveV4Keyring({
    passphrase: OLD_PASSPHRASE,
    repoId,
    salt,
    iterations: 600_000,
  })
  const codec = new V4StorageCodec({
    mode: "encrypted",
    pathLayout: "opaque-stable-v1",
    keyring,
  })
  const prepared = await Promise.all(
    files.map((file, idx) => codec.prepare(file.path, file.bytes, `v${idx + 1}`, file.mtime, `d412-file-${idx + 1}`)),
  )
  const records = prepared.map((item, idx) => ({ ...item.record, path: files[idx]!.path }))
  const buckets = new Map<string, typeof records>()
  for (const record of records) {
    const bucket = record.pathId.slice(0, 2)
    const list = buckets.get(bucket) ?? []
    list.push(record)
    buckets.set(bucket, list)
  }
  const shardHashes: Record<string, string> = {}
  for (const [bucket, list] of buckets) {
    shardHashes[bucket] = await sha256Hex(utf8ToBytes(JSON.stringify([...list].sort((a, b) => a.pathId.localeCompare(b.pathId)))))
  }
  const head: V4RemoteHead = {
    formatVersion: 4,
    mode: "encrypted",
    epoch: 1,
    generation: 1,
    journalId: "d412-seed-journal",
    shardHashes,
    updatedAt: 1000,
    deviceId: "seed-device",
  }
  const metaFiles = await buildV4RemoteMetadata({ config, head, records, keyring })
  const updates: Array<{ path: string; mode: string; type: "blob"; sha: string }> = []
  for (const mf of metaFiles) {
    const sha = gitSha1("blob", mf.bytes)
    server.blobs.set(sha, mf.bytes)
    updates.push({ path: mf.path, mode: "100644", type: "blob", sha })
  }
  for (const item of prepared) {
    for (const obj of item.files) {
      const sha = gitSha1("blob", obj.bytes)
      server.blobs.set(sha, obj.bytes)
      updates.push({ path: obj.path, mode: "100644", type: "blob", sha })
    }
  }
  const treeSha = server.createTreeFromRecords(undefined, updates)
  const commitPayload = utf8ToBytes(JSON.stringify({ message: "seed source", tree: treeSha, parents: [] }))
  const commitSha = gitSha1("commit", commitPayload)
  server.commits.set(commitSha, { sha: commitSha, treeSha, parents: [], message: "seed source" })
  server.refs.set(SOURCE_BRANCH, commitSha)
  return commitSha
}

async function createInstalledVaultFixture(files: ReadonlyArray<{ path: string; bytes: Uint8Array }>) {
  await mkdir(path.join(process.cwd(), ".tmp"), { recursive: true })
  const root = await mkdtemp(path.join(process.cwd(), ".tmp", "d412-installed-rehearsal-"))
  const pluginDir = path.join(root, CONFIG_DIR, "plugins", PLUGIN_ID)
  await mkdir(pluginDir, { recursive: true })
  for (const file of files) {
    const abs = path.join(root, ...file.path.split("/"))
    await mkdir(path.dirname(abs), { recursive: true })
    await writeFile(abs, file.bytes)
  }
  const filePath = (rel: string) => path.join(root, ...rel.split("/"))
  const adapter = {
    getFullPath: (rel: string) => (rel ? filePath(rel) : root),
    read: (rel: string) => readFile(filePath(rel), "utf8"),
    write: (rel: string, value: string) => writeFile(filePath(rel), value),
    readBinary: async (rel: string) => {
      const buf = await readFile(filePath(rel))
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    },
    writeBinary: (rel: string, buf: ArrayBuffer) => writeFile(filePath(rel), new Uint8Array(buf)),
    appendBinary: async (rel: string, buf: ArrayBuffer) => {
      const prev = await readFile(filePath(rel)).catch(() => Buffer.alloc(0))
      await writeFile(filePath(rel), Buffer.concat([prev, Buffer.from(buf)]))
    },
    remove: (rel: string) => rm(filePath(rel), { force: true }),
    stat: async (rel: string) => {
      const info = await stat(filePath(rel)).catch(() => null)
      return info ? { size: info.size, mtime: Math.round(info.mtimeMs) } : null
    },
    exists: (rel: string) => stat(filePath(rel)).then(() => true, (e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return false
      throw e
    }),
    mkdir: (rel: string) => mkdir(filePath(rel), { recursive: true }).then(() => undefined),
  }
  const settings = {
    githubOwner: OWNER,
    githubRepo: REPO,
    githubBranch: SOURCE_BRANCH,
    githubToken: "test-token",
    githubTokenSecretId: "token-secret-id",
    encryptionMode: "encrypted" as const,
    encryptionPassphrase: OLD_PASSPHRASE,
    encryptionPassphraseSecretId: "old-passphrase-secret-id",
    pbkdf2Iterations: 600_000,
    vault: "installed-desktop-device",
    ignorePathRegex: "",
    syncObsidianConfig: false,
    syncBookmarks: false,
    syncPlugins: false,
  }
  let persistedData: Record<string, unknown> = {
    settings: {
      githubOwner: OWNER,
      githubRepo: REPO,
      githubBranch: SOURCE_BRANCH,
      encryptionMode: "encrypted",
      githubTokenSecretId: "token-secret-id",
      encryptionPassphraseSecretId: "old-passphrase-secret-id",
      vault: "installed-desktop-device",
    },
  }
  const secrets = new Map<string, string>([[settings.githubTokenSecretId, settings.githubToken], [settings.encryptionPassphraseSecretId, settings.encryptionPassphrase]])
  const secretStorage = { getSecret: (id: string) => secrets.get(id) ?? null, setSecret: (id: string, value: string) => { secrets.set(id, value) } }
  const makeRuntime = () => {
    let watchEnabled = true
    const plugin = {
      app: {
        vault: { configDir: CONFIG_DIR, adapter },
        workspace: { iterateAllLeaves: () => {}, activeEditor: null },
        secretStorage,
      },
      manifest: { id: PLUGIN_ID },
      settings: { ...settings },
      settingsSaveGeneration: 0,
      isSyncInProgress: false,
      isSettingsSaveInProgress: () => false,
      loadData: async () => structuredClone(persistedData),
      disableWatch: () => { watchEnabled = false },
      addIgnoredFile() {},
      removeIgnoredFile() {},
    }
    const runtime = new V4PluginRuntime(plugin as never)
    return {
      plugin,
      runtime,
      get watchEnabled() { return watchEnabled },
    }
  }
  return {
    root,
    pluginDir,
    adapter,
    settings,
    persistedData,
    secrets,
    makeRuntime,
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}

function makeClientFactory(branchPrefix?: string) {
  return (branch: string) => new GitHubClient(
    { token: "test-token", owner: OWNER, repo: REPO, branch: branchPrefix ? `${branchPrefix}${branch}` : branch },
    { transportPolicy: { mutationSpacingMs: 0 } },
  )
}

test("D412 installed Runtime orchestrates Source -> Backup -> Staging -> Scratch -> Destination without Cutover and recovers after restart", async () => {
  const server = createMemoryGitHubServer()
  setRequestUrlHandler(server.handler)
  const noteBytes = utf8ToBytes("# D412 Unicode note\nสวัสดีครับ 🌍\n")
  const binBytes = Uint8Array.from({ length: 4096 }, (_, i) => (i * 19 + 7) & 0xff)
  const fixtureFiles = [
    { path: "Notes/สวัสดี.md", bytes: noteBytes, mtime: 1000 },
    { path: "Attachments/data.bin", bytes: binBytes, mtime: 2000 },
  ]
  const vault = await createInstalledVaultFixture(fixtureFiles)
  let runtime1: ReturnType<typeof vault.makeRuntime> | undefined
  let runtime2: ReturnType<typeof vault.makeRuntime> | undefined
  try {
    const pinnedSourceCommitSha = await seedEncryptedSource(server, fixtureFiles)
    const source = await verifyGitHubReencryptionForkSourceWithTranscodeInventory({
      github: makeClientFactory()(SOURCE_BRANCH), expectedRepoId: `${OWNER}/${REPO}#${SOURCE_BRANCH}`,
      expectedBranch: SOURCE_BRANCH, passphrase: OLD_PASSPHRASE,
    })
    const sourceRoot = `${CONFIG_DIR}/plugins/${PLUGIN_ID}/${V4_RUNTIME_INDEX_ROOT}`
    const sourceIndex = createEmptyV4LocalIndex({ repoId: source.sourceConfig.repoId, deviceId: vault.settings.vault, mode: "encrypted" })
    sourceIndex.remoteCommitSha = pinnedSourceCommitSha
    sourceIndex.epoch = source.sourceHead.epoch
    sourceIndex.generation = source.sourceHead.generation
    sourceIndex.shardHashes = { ...source.sourceHead.shardHashes }
    for (const [bucket, shard] of Object.entries(source.sourceShards)) {
      sourceIndex.shards[bucket] = { bucket, hash: sourceIndex.shardHashes[bucket]!, records: structuredClone(shard.records) }
    }
    await saveV4LocalIndex(vault.adapter, sourceRoot, sourceIndex)
    const sourceBefore = await loadV4LocalIndex(vault.adapter, sourceRoot)
    runtime1 = vault.makeRuntime()
    const runId = "d412-rehearsal-run-01"
    const backupBranch = "backup/d412-rehearsal"
    const destinationBranch = "rekey/d412-rehearsal"

    const report = await runtime1.runtime.runFencedReencryptionPreCutoverRehearsal({
      runId,
      backupBranch,
      destinationBranch,
      newPassphrase: NEW_PASSPHRASE,
      requestedIterations: 700_000,
      prepareShadowIndex: true,
      stageDestinationSecret: true,
      acknowledgement: "accept-best-effort-power-loss-recovery-risk",
      assertExclusiveInitiatorLease: async () => {},
      createGitHubClient: makeClientFactory(),
    })

    assert.equal(report.integrityScope, "installed-owner-pre-cutover-source-backup-destination-rehearsal")
    assert.equal(report.status, "destination-published-fenced-no-cutover")
    assert.equal(report.finalPhase, "destination-published-no-cutover")
    assert.equal(report.pinnedSourceCommitSha, pinnedSourceCommitSha)
    assert.equal(report.verifiedFileCount, 2)
    assert.equal(report.verifiedPlaintextBytes, String(noteBytes.byteLength + binBytes.byteLength))
    assert.equal(report.scratchRestoredFileCount, 2)
    assert.equal(report.shadow?.verifiedFileCount, 2)
    assert.equal(report.shadow?.destinationCommitSha, report.destinationCommitSha)
    assert.equal(report.shadow?.resumeSyncAuthorized, false)
    assert.equal(report.stagedSecret?.status, "destination-secret-staged-uncommitted")
    const stagedId = report.stagedSecret!.destinationPassphraseSecretId
    assert.notEqual(stagedId, vault.settings.encryptionPassphraseSecretId)
    assert.notEqual(stagedId, vault.settings.githubTokenSecretId)
    assert.equal(vault.secrets.get(stagedId), NEW_PASSPHRASE)
    assert.equal(vault.secrets.get(vault.settings.encryptionPassphraseSecretId), OLD_PASSPHRASE)
    assert.equal(vault.secrets.get(vault.settings.githubTokenSecretId), vault.settings.githubToken)
    assert.equal(runtime1.plugin.settings.encryptionPassphraseSecretId, vault.settings.encryptionPassphraseSecretId)
    assert.deepEqual(await loadV4LocalIndex(vault.adapter, sourceRoot), sourceBefore)
    const shadowRoot = `${sourceRoot}-rekey-${runId}`
    const shadow = await loadV4LocalIndex(vault.adapter, shadowRoot)
    assert.equal(shadow.remoteCommitSha, report.destinationCommitSha)
    assert.equal(shadow.repoId, report.destinationRepoId)
    assert.equal(report.cutoverAuthorized, false)
    assert.equal(report.localCutoverExecuted, false)
    assert.equal(report.resumeSyncAuthorized, false)
    assert.equal(report.oldPassphraseCleanupAuthorized, false)
    assert.equal(report.powerLossDurabilityProven, false)

    // Watch disabled, settings untouched, no Cutover route written, scratch cleaned.
    assert.equal(runtime1.watchEnabled, false)
    assert.equal(runtime1.plugin.settings.githubBranch, SOURCE_BRANCH)
    assert.equal(runtime1.plugin.settings.encryptionPassphrase, OLD_PASSPHRASE)
    assert.equal(await vault.adapter.exists(V4_REENCRYPTION_RUNTIME_ROUTE_PATH), false)
    assert.equal(await vault.adapter.exists(`${CONFIG_DIR}/plugins/${PLUGIN_ID}/rekey-scratch-${runId}`), false)
    assert.equal(await vault.adapter.exists(`${CONFIG_DIR}/plugins/${PLUGIN_ID}/${V4_REENCRYPTION_SYNC_FENCE_ROOT}/active.json`), true)

    // Both remote branches exist and use separate keys; Destination has 0 parents.
    assert.equal(server.refs.get(backupBranch), pinnedSourceCommitSha)
    const destSha = server.refs.get(destinationBranch)
    assert.equal(destSha, report.destinationCommitSha)
    assert.deepEqual(server.commits.get(destSha!)?.parents, [])

    const destVerifiedNew = await verifyGitHubReencryptionForkSource({
      github: makeClientFactory()(destinationBranch),
      expectedRepoId: `${OWNER}/${REPO}#${destinationBranch}`,
      expectedBranch: destinationBranch,
      passphrase: NEW_PASSPHRASE,
    })
    assert.equal(destVerifiedNew.pinnedSourceCommitSha, destSha)
    assert.equal(destVerifiedNew.verifiedFileCount, 2)

    await assert.rejects(() => verifyGitHubReencryptionForkSource({
      github: makeClientFactory()(destinationBranch),
      expectedRepoId: `${OWNER}/${REPO}#${destinationBranch}`,
      expectedBranch: destinationBranch,
      passphrase: OLD_PASSPHRASE,
    }))

    // Independently authenticate the on-disk journal using the original
    // Source key derived from known fixture metadata, not a rehearsal secret.
    const layout = await planV4PluginPrivateWalLocation({ configDir: CONFIG_DIR, pluginId: PLUGIN_ID, runId })
    const journalAdapter = {
      read: (relative: string) => readFile(path.join(vault.pluginDir, relative), "utf8"),
      exists: async (relative: string) => stat(path.join(vault.pluginDir, relative)).then(() => true, () => false),
      write: async () => { throw Error("Read-only independent journal check") },
      mkdir: async () => { throw Error("Read-only independent journal check") },
    }
    const keyring = await deriveV4Keyring({
      passphrase: OLD_PASSPHRASE, repoId: `${OWNER}/${REPO}#${SOURCE_BRANCH}`,
      salt: utf8ToBytes("d412-source-salt"), iterations: 600_000,
    })
    const journalInput = {
      adapter: journalAdapter, root: layout.journalRoot, runId,
      sourceCommitSha: pinnedSourceCommitSha, destinationRepoId: `${OWNER}/${REPO}#${destinationBranch}`,
    }
    try {
      const independent = createV4ReencryptionRecoveryJournal({ ...journalInput, journalKey: keyring.journalKey })
      const snapshot = await independent.assertHealthySnapshot(report.finalWalGeneration)
      assert.equal(snapshot.verifiedRefObservations.length, 2)
      const foreign = createV4ReencryptionRecoveryJournal({ ...journalInput, journalKey: new Uint8Array(32).fill(0x5a) })
      await assert.rejects(() => foreign.assertHealthySnapshot(report.finalWalGeneration))
    } finally {
      for (const key of Object.values(keyring)) key.fill(0)
    }

    // Simulate real Obsidian restart with a brand-new Runtime on the same Vault.
    runtime1.runtime.dispose()
    runtime1 = undefined
    runtime2 = vault.makeRuntime()

    await assert.rejects(() => runtime2!.runtime.assertReencryptionSettingsSaveAllowed())
    await runtime2.runtime.manualSync()
    assert.equal(runtime2.runtime.progressSnapshot.lifecycle, "failed")
    assert.equal(runtime2.watchEnabled, false)
    const scheduledAfterRestart = await runtime2.runtime.scheduledSync() as { status?: string; changedFiles?: number }
    assert.equal(scheduledAfterRestart.status, "skipped")

    const recoveryInput = {
      runId,
      backupBranch,
      destinationBranch,
      pinnedSourceCommitSha,
      sourceTreeSha: report.sourceTreeSha,
      destinationCommitSha: report.destinationCommitSha,
      destinationTreeSha: report.destinationTreeSha,
      expectedFinalWalGeneration: report.finalWalGeneration,
      verifyShadowIndex: true,
      recoverStagedSecret: true,
      expectedFileCount: 2,
      expectedPlaintextBytes: String(noteBytes.byteLength + binBytes.byteLength),
      expectedPhysicalRepositoryId: PHYSICAL_REPO_ID,
      defaultBranch: DEFAULT_BRANCH,
      createGitHubClient: makeClientFactory(),
    }
    const recovered = await runtime2.runtime.inspectFencedReencryptionPreCutoverRecovery(recoveryInput)
    assert.equal(recovered.shadowReverified, true)
    assert.equal(recovered.stagedSecretReverified, true)
    // D515: real Obsidian may lose a just-staged secret across forced exit.
    // Inspection stays read-only; only explicit re-entry may repair absence.
    vault.secrets.delete(stagedId)
    const missing = await runtime2.runtime.inspectFencedReencryptionPreCutoverRecovery(recoveryInput)
    assert.equal(missing.observation, "manual-recovery-required")
    assert.equal(missing.stagedSecretMissing, true)
    assert.equal(vault.secrets.has(stagedId), false)
    const wrongRepair = await runtime2.runtime.restoreFencedReencryptionStagedSecret({ ...recoveryInput, newPassphrase: "wrong-key" })
    assert.equal(wrongRepair.observation, "manual-recovery-required")
    assert.equal(vault.secrets.has(stagedId), false)
    const restored = await runtime2.runtime.restoreFencedReencryptionStagedSecret({ ...recoveryInput, newPassphrase: NEW_PASSPHRASE })
    assert.equal(restored.observation, "authenticated-pre-cutover-destination-still-fenced")
    assert.equal(restored.integrityScope, "installed-pre-cutover-staged-secret-recovery")
    assert.equal(restored.stagedSecretRestored, true)
    assert.equal(restored.stagedSecretReverified, true)
    assert.equal(restored.resumeSyncAuthorized, false)
    assert.equal(vault.secrets.get(stagedId), NEW_PASSPHRASE)
    assert.equal((await runtime2.runtime.inspectFencedReencryptionPreCutoverRecovery(recoveryInput)).stagedSecretReverified, true)
    vault.secrets.set(stagedId, "wrong-staged-key")
    const occupied = await runtime2.runtime.restoreFencedReencryptionStagedSecret({ ...recoveryInput, newPassphrase: NEW_PASSPHRASE })
    assert.equal(occupied.observation, "manual-recovery-required")
    assert.equal(vault.secrets.get(stagedId), "wrong-staged-key")
    const wrongSecret = await runtime2.runtime.inspectFencedReencryptionPreCutoverRecovery(recoveryInput)
    assert.equal(wrongSecret.observation, "manual-recovery-required")
    assert.equal(wrongSecret.resumeSyncAuthorized, false)
    vault.secrets.set(stagedId, NEW_PASSPHRASE)
    const receiptPath = `${CONFIG_DIR}/plugins/${PLUGIN_ID}/${V4_RUNTIME_INDEX_ROOT}-rekey-secret-${runId}/receipt.enc`
    const receipt = await vault.adapter.read(receiptPath)
    assert.ok(!receipt.includes(NEW_PASSPHRASE) && !receipt.includes(OLD_PASSPHRASE))
    await vault.adapter.write(receiptPath, receipt.slice(0,-8) + "AAAAAAAA")
    const wrongReceipt = await runtime2.runtime.inspectFencedReencryptionPreCutoverRecovery(recoveryInput)
    assert.equal(wrongReceipt.observation, "manual-recovery-required")
    assert.equal(wrongReceipt.resumeSyncAuthorized, false)
    await vault.adapter.write(receiptPath, receipt)
    assert.equal(vault.secrets.get(vault.settings.encryptionPassphraseSecretId), OLD_PASSPHRASE)

    assert.equal(recovered.observation, "authenticated-pre-cutover-destination-still-fenced")
    assert.equal(recovered.walAuthenticated, true)
    assert.equal(recovered.backupReverified, true)
    assert.equal(recovered.destinationReverified, true)
    assert.equal(recovered.verifiedFileCount, 2)
    assert.equal(recovered.cutoverAuthorized, false)
    assert.equal(recovered.localCutoverAuthorized, false)
    assert.equal(recovered.resumeSyncAuthorized, false)
    assert.equal(recovered.oldPassphraseCleanupAuthorized, false)
    assert.equal(recovered.powerLossDurabilityProven, false)

    // Even a valid local cache digest cannot authorize a forged remote identity.
    const firstShard = Object.values(shadow.shards)[0]!
    const firstRecord = Object.values(firstShard.records)[0]!
    firstRecord.fileId = "forged-file-identity"
    await saveV4LocalIndex(vault.adapter, shadowRoot, shadow)
    const tampered = await runtime2.runtime.inspectFencedReencryptionPreCutoverRecovery(recoveryInput)
    assert.equal(tampered.observation, "manual-recovery-required")
    assert.equal(tampered.resumeSyncAuthorized, false)
    assert.deepEqual(await loadV4LocalIndex(vault.adapter, sourceRoot), sourceBefore)

    // Physical Vault notes remain identical to original fixture.
    assert.deepEqual(new Uint8Array(await vault.adapter.readBinary("Notes/สวัสดี.md")), noteBytes)
    assert.deepEqual(new Uint8Array(await vault.adapter.readBinary("Attachments/data.bin")), binBytes)
  } finally {
    runtime1?.runtime.dispose()
    runtime2?.runtime.dispose()
    setRequestUrlHandler(null)
    await vault.cleanup()
  }
})

test("D515 SecretStorage failed or uncertain write preserves old custody and never overwrites staged receipt", async () => {
  for (const fault of ["before-write", "after-write", "bad-readback"] as const) {
    const files = new Map<string, string>()
    const dirs = new Set<string>()
    const adapter = {
      read: async (p: string) => { const v = files.get(p); if (v === undefined) throw Error("missing"); return v },
      write: async (p: string, v: string) => { files.set(p, v) },
      exists: async (p: string) => files.has(p) || dirs.has(p),
      mkdir: async (p: string) => { dirs.add(p) },
    }
    const secrets = new Map([["old", "old-secret"], ["token", "token-value"]])
    let attemptedId = ""
    let writes = 0
    const storage = {
      getSecret: (id: string) => secrets.get(id) ?? null,
      setSecret: (id: string, value: string) => {
        writes++
        attemptedId = id
        assert.ok(files.has(installedSecretReceiptRoot("d515-fault-run") + "/receipt.enc"))
        if (fault === "before-write") throw Error("write refused")
        secrets.set(id, fault === "bad-readback" ? "" : value)
        if (fault === "after-write") throw Error("acknowledgement lost")
      },
    }
    const identity = { runId: "d515-fault-run", deviceId: "device",
      sourceRepoId: "owner/repo#source", backupRepoId: "owner/repo#backup", destinationRepoId: "owner/repo#destination",
      pinnedSourceCommitSha: "a".repeat(40), sourceTreeSha: "b".repeat(40),
      destinationCommitSha: "c".repeat(40), destinationTreeSha: "d".repeat(40),
      finalWalGeneration: 12, verifiedFileCount: 2, verifiedPlaintextBytes: "2116",
      physicalRepositoryId: 1, defaultBranch: "main" }
    const owner = { storage, sourcePassphraseSecretId: "old", githubTokenSecretId: "token",
      oldPassphrase: "old-secret", token: "token-value", assertOwner: () => {} }
    const key = new Uint8Array(32).fill(7)
    const input = { adapter, identity, owner, key, newPassphrase: "new-secret",
      assertLease: async () => {}, checkpoint: async () => {} }
    await assert.rejects(() => stageV4InstalledDestinationSecret(input))
    assert.equal(secrets.get("old"), "old-secret")
    assert.equal(secrets.get("token"), "token-value")
    assert.notEqual(attemptedId, "old")
    assert.notEqual(attemptedId, "token")
    const receipt = files.get(installedSecretReceiptRoot(identity.runId) + "/receipt.enc")
    assert.ok(receipt)
    await assert.rejects(() => stageV4InstalledDestinationSecret(input), /Manual Recovery/u)
    assert.equal(writes, 1)
    assert.equal(files.get(installedSecretReceiptRoot(identity.runId) + "/receipt.enc"), receipt)
    if (fault === "after-write") {
      const recovered = await readV4InstalledDestinationSecret(input)
      assert.equal(recovered.id, attemptedId)
      assert.equal(recovered.passphrase, "new-secret")
    } else await assert.rejects(() => readV4InstalledDestinationSecret(input))
    key.fill(0)
  }
})

test("D414 installed post-restart Recovery authenticates frozen Backup after independent old Source advancement", async () => {
  const server = createMemoryGitHubServer()
  setRequestUrlHandler(server.handler)
  const noteBytes = utf8ToBytes("# D414 old Source advances independently after snapshot\\n")
  const file = { path: "Notes/stale-source.md", bytes: noteBytes, mtime: 171 }
  const vault = await createInstalledVaultFixture([file])
  let before: ReturnType<typeof vault.makeRuntime> | undefined
  let after: ReturnType<typeof vault.makeRuntime> | undefined
  try {
    const pinned = await seedEncryptedSource(server, [file])
    const original = server.commits.get(pinned)
    assert.ok(original)
    before = vault.makeRuntime()
    const runId = "d414-source-advanced-01"
    const backupBranch = "backup/d414-frozen"
    const destinationBranch = "rekey/d414-orphan"
    const report = await before.runtime.runFencedReencryptionPreCutoverRehearsal({
      runId, backupBranch, destinationBranch, newPassphrase: NEW_PASSPHRASE,
      requestedIterations: 700_000,
      acknowledgement: "accept-best-effort-power-loss-recovery-risk",
      assertExclusiveInitiatorLease: async () => {},
      createGitHubClient: makeClientFactory(),
    })
    assert.equal(report.status, "destination-published-fenced-no-cutover")
    assert.equal(server.refs.get(backupBranch), pinned)
    assert.equal(server.refs.get(destinationBranch), report.destinationCommitSha)

    // An independent existing old-key device advances Source AFTER frozen
    // Backup and new-key Destination publication. Use a valid descendant with
    // the same immutable source tree to isolate ref divergence; the live D413
    // two-Obsidian test additionally exercises an actual changed note.
    const advanced = gitSha1("commit", utf8ToBytes("D414 source advance " + pinned))
    server.commits.set(advanced, {
      sha: advanced, treeSha: original.treeSha,
      parents: [pinned], message: "Old-key peer advanced Source independently",
    })
    server.refs.set(SOURCE_BRANCH, advanced)
    assert.notEqual(server.refs.get(SOURCE_BRANCH), pinned)
    assert.equal(server.refs.get(backupBranch), pinned)

    before.runtime.dispose()
    before = undefined
    after = vault.makeRuntime()
    const inspect = () => after!.runtime.inspectFencedReencryptionPreCutoverRecovery({
      runId, backupBranch, destinationBranch,
      pinnedSourceCommitSha: pinned,
      sourceTreeSha: report.sourceTreeSha,
      destinationCommitSha: report.destinationCommitSha,
      destinationTreeSha: report.destinationTreeSha,
      expectedFinalWalGeneration: report.finalWalGeneration,
      expectedFileCount: 1, expectedPlaintextBytes: String(noteBytes.byteLength),
      newPassphrase: NEW_PASSPHRASE,
      expectedPhysicalRepositoryId: PHYSICAL_REPO_ID,
      defaultBranch: DEFAULT_BRANCH,
      createGitHubClient: makeClientFactory(),
    })
    const recovered = await inspect()
    assert.equal(recovered.observation, "authenticated-pre-cutover-destination-still-fenced")
    assert.equal(recovered.walAuthenticated, true)
    assert.equal(recovered.backupReverified, true)
    assert.equal(recovered.destinationReverified, true)
    assert.equal(recovered.verifiedFileCount, 1)
    assert.equal(recovered.cutoverAuthorized, false)
    assert.equal(recovered.resumeSyncAuthorized, false)
    assert.equal(server.refs.get(SOURCE_BRANCH), advanced)
    assert.equal(server.refs.get(backupBranch), pinned)
    assert.equal(server.refs.get(destinationBranch), report.destinationCommitSha)
    // Fail closed even when the wrong Backup points at a valid old Source
    // descendant with byte-identical tree: its immutable pinned identity is
    // an essential part of the recovery proof.
    server.refs.set(backupBranch, advanced)
    const wrongBackup = await inspect()
    assert.equal(wrongBackup.observation, "manual-recovery-required")
    assert.equal(wrongBackup.cutoverAuthorized, false)
    assert.equal(wrongBackup.resumeSyncAuthorized, false)
    server.refs.set(backupBranch, pinned)
    await assert.rejects(() => after!.runtime.assertReencryptionSettingsSaveAllowed())
    assert.deepEqual(new Uint8Array(await vault.adapter.readBinary(file.path)), noteBytes)
  } finally {
    before?.runtime.dispose()
    after?.runtime.dispose()
    setRequestUrlHandler(null)
    await vault.cleanup()
  }
})

test("D412 refuses rehearsal before arming Sync fence when Backup or Destination branch already exists", async () => {
  const server = createMemoryGitHubServer()
  setRequestUrlHandler(server.handler)
  const noteBytes = utf8ToBytes("D412 existing ref guard\n")
  const vault = await createInstalledVaultFixture([{ path: "note.md", bytes: noteBytes }])
  let runtime1: ReturnType<typeof vault.makeRuntime> | undefined
  try {
    const pinnedSha = await seedEncryptedSource(server, [{ path: "note.md", bytes: noteBytes, mtime: 100 }])
    server.refs.set("backup/already-exists", pinnedSha)
    runtime1 = vault.makeRuntime()

    await assert.rejects(
      () => runtime1!.runtime.runFencedReencryptionPreCutoverRehearsal({
        runId: "d412-ref-occupied-01",
        backupBranch: "backup/already-exists",
        destinationBranch: "rekey/unused-dest",
        newPassphrase: NEW_PASSPHRASE,
        requestedIterations: 600_000,
        acknowledgement: "accept-best-effort-power-loss-recovery-risk",
        assertExclusiveInitiatorLease: async () => {},
        createGitHubClient: makeClientFactory(),
      }),
      /already exists/u,
    )
    // Fence must NOT be armed when pre-flight branch check fails.
    await runtime1.runtime.assertReencryptionSettingsSaveAllowed()
    assert.equal(server.refs.has("rekey/unused-dest"), false)
  } finally {
    runtime1?.runtime.dispose()
    setRequestUrlHandler(null)
    await vault.cleanup()
  }
})

test("D412 rejects physical Vault drift before publishing Destination ref and preserves WAL for Manual Recovery", async () => {
  const server = createMemoryGitHubServer()
  setRequestUrlHandler(server.handler)
  const originalNote = utf8ToBytes("D412 drift note A\n")
  const driftedNote = utf8ToBytes("D412 drift note B\n")
  assert.equal(originalNote.byteLength, driftedNote.byteLength)
  const vault = await createInstalledVaultFixture([{ path: "drift.md", bytes: originalNote }])
  let runtime1: ReturnType<typeof vault.makeRuntime> | undefined
  try {
    await seedEncryptedSource(server, [{ path: "drift.md", bytes: originalNote, mtime: 100 }])
    runtime1 = vault.makeRuntime()
    const runId = "d412-drift-guard-01"
    const destinationBranch = "rekey/d412-drift-dest"

    await assert.rejects(
      () => runtime1!.runtime.runFencedReencryptionPreCutoverRehearsal({
        runId,
        backupBranch: "backup/d412-drift-backup",
        destinationBranch,
        newPassphrase: NEW_PASSPHRASE,
        requestedIterations: 600_000,
        acknowledgement: "accept-best-effort-power-loss-recovery-risk",
        assertExclusiveInitiatorLease: async () => {},
        createGitHubClient: makeClientFactory(),
        onPhase: async phase => {
          if (phase === "candidate-prepared") {
            await writeFile(path.join(vault.root, "drift.md"), driftedNote)
          }
        },
      }),
      /local content does not match authenticated source SHA-256/u,
    )

    assert.equal(server.refs.has(destinationBranch), false, "Destination ref must NOT be created after local drift")
    await assert.rejects(() => runtime1!.runtime.assertReencryptionSettingsSaveAllowed())
    const walLayout = await planV4PluginPrivateWalLocation({ configDir: CONFIG_DIR, pluginId: PLUGIN_ID, runId })
    assert.equal(await vault.adapter.exists(`${CONFIG_DIR}/plugins/${PLUGIN_ID}/${walLayout.journalRoot}/slot-0.json`), true)
  } finally {
    runtime1?.runtime.dispose()
    setRequestUrlHandler(null)
    await vault.cleanup()
  }
})

test("D412 post-restart recovery fails closed on wrong new passphrase or tampered WAL slot", async () => {
  const server = createMemoryGitHubServer()
  setRequestUrlHandler(server.handler)
  const noteBytes = utf8ToBytes("D412 tamper recovery note\n")
  const vault = await createInstalledVaultFixture([{ path: "note.md", bytes: noteBytes }])
  let runtime1: ReturnType<typeof vault.makeRuntime> | undefined
  let runtime2: ReturnType<typeof vault.makeRuntime> | undefined
  try {
    const pinnedSourceCommitSha = await seedEncryptedSource(server, [{ path: "note.md", bytes: noteBytes, mtime: 100 }])
    runtime1 = vault.makeRuntime()
    const runId = "d412-tamper-recovery-01"
    const backupBranch = "backup/d412-tamper"
    const destinationBranch = "rekey/d412-tamper"

    const report = await runtime1.runtime.runFencedReencryptionPreCutoverRehearsal({
      runId,
      backupBranch,
      destinationBranch,
      newPassphrase: NEW_PASSPHRASE,
      requestedIterations: 600_000,
      acknowledgement: "accept-best-effort-power-loss-recovery-risk",
      assertExclusiveInitiatorLease: async () => {},
      createGitHubClient: makeClientFactory(),
    })
    runtime1.runtime.dispose()
    runtime1 = undefined

    runtime2 = vault.makeRuntime()
    const wrongPass = await runtime2.runtime.inspectFencedReencryptionPreCutoverRecovery({
      runId,
      backupBranch,
      destinationBranch,
      pinnedSourceCommitSha,
      sourceTreeSha: report.sourceTreeSha,
      destinationCommitSha: report.destinationCommitSha,
      destinationTreeSha: report.destinationTreeSha,
      expectedFinalWalGeneration: report.finalWalGeneration,
      expectedFileCount: 1,
      expectedPlaintextBytes: String(noteBytes.byteLength),
      newPassphrase: "wrong-new-passphrase",
      expectedPhysicalRepositoryId: PHYSICAL_REPO_ID,
      defaultBranch: DEFAULT_BRANCH,
      createGitHubClient: makeClientFactory(),
    })
    assert.equal(wrongPass.observation, "manual-recovery-required")
    assert.equal(wrongPass.cutoverAuthorized, false)
    assert.equal(wrongPass.destinationReverified, false)

    // Partial pre-route Cutover artifact on disk must fail closed with manual recovery.
    const partialCutoverDir = path.join(vault.pluginDir, `${V4_RUNTIME_INDEX_ROOT}-rekey-cutover-candidate-${runId}`)
    await mkdir(partialCutoverDir, { recursive: true })
    const partialCutover = await runtime2.runtime.inspectFencedReencryptionPreCutoverRecovery({
      runId,
      backupBranch,
      destinationBranch,
      pinnedSourceCommitSha,
      sourceTreeSha: report.sourceTreeSha,
      destinationCommitSha: report.destinationCommitSha,
      destinationTreeSha: report.destinationTreeSha,
      expectedFinalWalGeneration: report.finalWalGeneration,
      expectedFileCount: 1,
      expectedPlaintextBytes: String(noteBytes.byteLength),
      newPassphrase: NEW_PASSPHRASE,
      expectedPhysicalRepositoryId: PHYSICAL_REPO_ID,
      defaultBranch: DEFAULT_BRANCH,
      createGitHubClient: makeClientFactory(),
    })
    assert.equal(partialCutover.observation, "manual-recovery-required")
    assert.equal(partialCutover.cutoverAuthorized, false)
    await rm(partialCutoverDir, { recursive: true, force: true })

    const walLayout = await planV4PluginPrivateWalLocation({ configDir: CONFIG_DIR, pluginId: PLUGIN_ID, runId })
    const slot0 = path.join(vault.pluginDir, ...walLayout.journalRoot.split("/"), "slot-0.json")
    const slot1 = path.join(vault.pluginDir, ...walLayout.journalRoot.split("/"), "slot-1.json")
    await writeFile(slot0, "{corrupted")
    await writeFile(slot1, "{corrupted")

    const tamperedWal = await runtime2.runtime.inspectFencedReencryptionPreCutoverRecovery({
      runId,
      backupBranch,
      destinationBranch,
      pinnedSourceCommitSha,
      sourceTreeSha: report.sourceTreeSha,
      destinationCommitSha: report.destinationCommitSha,
      destinationTreeSha: report.destinationTreeSha,
      expectedFinalWalGeneration: report.finalWalGeneration,
      expectedFileCount: 1,
      expectedPlaintextBytes: String(noteBytes.byteLength),
      newPassphrase: NEW_PASSPHRASE,
      expectedPhysicalRepositoryId: PHYSICAL_REPO_ID,
      defaultBranch: DEFAULT_BRANCH,
      createGitHubClient: makeClientFactory(),
    })
    assert.equal(tamperedWal.observation, "manual-recovery-required")
    assert.equal(tamperedWal.walAuthenticated, false)
    assert.equal(tamperedWal.cutoverAuthorized, false)
  } finally {
    runtime1?.runtime.dispose()
    runtime2?.runtime.dispose()
    setRequestUrlHandler(null)
    await vault.cleanup()
  }
})
