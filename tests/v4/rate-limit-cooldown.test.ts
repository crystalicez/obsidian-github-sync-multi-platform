import assert from "node:assert/strict"
import test from "node:test"
import { setRequestUrlHandler } from "obsidian"
import { GitHubClient } from "../../src/lib/github-api"
import { V4RateLimitCooldownStore, type V4CooldownFileAdapter } from "../../src/lib/v4/rate-limit-cooldown"

const scopeA = "a".repeat(64)
const scopeB = "b".repeat(64)

function memoryAdapter() {
  const files = new Map<string, string>()
  const adapter: V4CooldownFileAdapter = {
    exists: async path => files.has(path),
    read: async path => {
      const value = files.get(path)
      if (value === undefined) throw new Error("missing")
      return value
    },
    write: async (path, value) => { files.set(path, value) },
  }
  return { files, adapter }
}

test("E2 cooldown survives construction and never stores GitHub tokens in the cache", async () => {
  const { files, adapter } = memoryAdapter()
  const original = new V4RateLimitCooldownStore(adapter, ".obsidian/plugins/my-plugin")
  assert.equal(await original.load(scopeA), 0)
  await original.save(scopeA, 10_000)
  await original.save(scopeB, 15_000)
  const restored = new V4RateLimitCooldownStore(adapter, ".obsidian/plugins/my-plugin")
  assert.equal(await restored.load(scopeA), 10_000)
  assert.equal(await restored.load(scopeB), 15_000)
  const disk = [...files.values()].join(" ")
  assert.equal(disk.includes("Bearer"), false)
  assert.equal(disk.includes("token-secret"), false)
  assert.equal(files.size, 2)
})

test("E2 interrupted newest checksum slot falls back to prior valid snapshot and all-corrupt fails closed", async () => {
  const { files, adapter } = memoryAdapter()
  const root = ".obsidian/plugins/plugin"
  const store = new V4RateLimitCooldownStore(adapter, root)
  await store.save(scopeA, 10_000)
  await store.save(scopeA, 15_000)
  files.set(root + "/v4-rate-limit-0.json", "{torn")
  const recovered = new V4RateLimitCooldownStore(adapter, root)
  assert.equal(await recovered.load(scopeA), 10_000)
  files.set(root + "/v4-rate-limit-1.json", "{torn")
  const corrupted = new V4RateLimitCooldownStore(adapter, root)
  await assert.rejects(() => corrupted.load(scopeA), /corrupt/i)
})

test("E2 fail-first: a failed cooldown persistence cannot be silently bypassed on the next request", async () => {
  const { adapter } = memoryAdapter()
  const faulted: V4CooldownFileAdapter = {
    ...adapter,
    write: async () => { throw new Error("disk-write-denied") },
  }
  const store = new V4RateLimitCooldownStore(faulted, "plugin")
  await assert.rejects(() => store.save(scopeA, 13_000), /disk-write-denied/)
  await assert.rejects(() => store.load(scopeA), /disk-write-denied/)
  await assert.rejects(() => store.save(scopeA, 13_000), /disk-write-denied/)
})

test("E2 GitHubClient observes a persisted HTTP 429 deadline after a client restart, without bleeding to a new token", async () => {
  let now = 5_000
  let calls = 0
  const sleeps: number[] = []
  const { files, adapter } = memoryAdapter()
  setRequestUrlHandler(async () => {
    calls++
    if (calls === 1) return { status: 429, text: "rate-limited", headers: { "retry-after": "4" }, json: {} }
    return { status: 200, text: "", headers: {}, json: [] }
  })
  try {
    const options = {
      transportPolicy: { maxAttempts: 1, mutationSpacingMs: 0 },
      now: () => now,
      sleep: async (ms: number) => { sleeps.push(ms); now += ms },
    }
    const first = new GitHubClient(
      { owner: "owner", repo: "repo", branch: "main", token: "token-secret" },
      { ...options, cooldownStore: new V4RateLimitCooldownStore(adapter, "plugin") },
    )
    await assert.rejects(() => first.listCommits(), /rate-limited/)
    assert.equal(files.size, 1)
    assert.equal([...files.values()].join("").includes("token-secret"), false)
    const restarted = new GitHubClient(
      { owner: "owner", repo: "different", branch: "main", token: "token-secret" },
      { ...options, cooldownStore: new V4RateLimitCooldownStore(adapter, "plugin") },
    )
    assert.deepEqual(await restarted.listCommits(), [])
    assert.deepEqual(sleeps, [4_000])
    assert.equal(now, 9_000)
    const unrelated = new GitHubClient(
      { owner: "owner", repo: "repo", branch: "main", token: "separate-token" },
      { ...options, cooldownStore: new V4RateLimitCooldownStore(adapter, "plugin") },
    )
    assert.deepEqual(await unrelated.listCommits(), [])
    assert.deepEqual(sleeps, [4_000])
    assert.equal(calls, 3)
  } finally {
    setRequestUrlHandler(null)
  }
})
