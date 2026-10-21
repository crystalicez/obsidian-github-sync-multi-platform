import assert from "node:assert/strict"
import test from "node:test"
import { createV4RecoveryStore } from "../../src/lib/v4/recovery-store"
import { effectiveV4RecoveryPolicy, v4RecoveryPolicyContext } from "../../src/lib/v4/recovery-startup-policy"
import { V4PluginRuntime } from "../../src/lib/v4/runtime"

function adapter() {
  const files = new Map<string, string>()
  const reads: string[] = []
  return {
    files, reads,
    async exists(path: string) { reads.push(path); return files.has(path) },
    async read(path: string) { reads.push(path); const text = files.get(path); if (text === undefined) throw Error("missing"); return text },
    async write(path: string, content: string) { files.set(path, content) },
    async mkdir(_path: string) {},
    async stat(path: string) { return files.has(path) ? { size: files.get(path)!.length } : null },
  }
}

test("startup inspection is local-only, absent before first journal and pending after publication intent", async () => {
  const io = adapter()
  const store = createV4RecoveryStore({ adapter: io, root: "recovery", repoId: "user/test#main" })
  assert.deepEqual(await store.inspect(), { status: "absent" })
  await store.save({ runId: "r1", phase: "publish-intent", expectedRemoteHead: "old" })
  const before = io.files.size
  assert.deepEqual(await store.inspect(), { status: "pending", phase: "publish-intent" })
  assert.equal(io.files.size, before, "inspection must not write")
  assert.equal(io.reads.every(path => path.startsWith("recovery/slot-")), true)
})

test("completed recovery is not prompted; malformed slot fails closed even with another valid slot", async () => {
  const io = adapter()
  const store = createV4RecoveryStore({ adapter: io, root: "recovery", repoId: "user/test#main" })
  await store.save({ runId: "r", phase: "publish-intent", expectedRemoteHead: null })
  await store.save({ runId: "r", phase: "index-committed", expectedRemoteHead: null })
  assert.deepEqual(await store.inspect(), { status: "completed", phase: "index-committed" })
  io.files.set("recovery/slot-1.json", "{ invalid JSON")
  assert.deepEqual(await store.inspect(), { status: "corrupt" })
})

test("local runtime recovery probe needs no GitHub client, key, passphrase or sync", async () => {
  const io = adapter()
  const runtime = Object.create(V4PluginRuntime.prototype) as V4PluginRuntime & Record<string, any>
  runtime.disposed = false
  runtime.settingsTransitionActive = false
  runtime.credentialGeneration = 1
  runtime.adapter = io
  runtime.plugin = {
    settings: { githubOwner: "user", githubRepo: "repo", githubBranch: "main" },
    get githubClient() { throw Error("network access is forbidden") },
  }
  assert.deepEqual(await runtime.inspectLocalRecovery(), { status: "absent" })
  assert.equal(io.reads.length, 2)
  assert.equal(io.reads.every(path => /^github-sync-v4-recovery\/[0-9a-f]{32}\/slot-[01]\.json$/u.test(path)), true)
})

test("remembered policy is vault-and-context-scoped; stale identity falls back to Ask", () => {
  const identity = {
    githubOwner: "a", githubRepo: "b", githubBranch: "main",
    encryptionMode: "encrypted", githubTokenSecretId: "token1", encryptionPassphraseSecretId: "pass1",
  }
  const saved = v4RecoveryPolicyContext(identity)
  assert.equal(effectiveV4RecoveryPolicy("auto", saved, saved), "auto")
  assert.equal(effectiveV4RecoveryPolicy("notify", saved, saved), "notify")
  assert.equal(effectiveV4RecoveryPolicy("auto", saved, v4RecoveryPolicyContext({ ...identity, githubBranch: "different" })), "ask")
  assert.equal(effectiveV4RecoveryPolicy("auto", saved, v4RecoveryPolicyContext({ ...identity, encryptionPassphraseSecretId: "pass2" })), "ask")
  assert.equal(effectiveV4RecoveryPolicy("auto", "", saved), "ask")
})
