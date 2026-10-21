import assert from "node:assert/strict"
import test from "node:test"
import { setRequestUrlHandler, Notice, Platform } from "obsidian"
import FastSync from "../../src/main"
import { DEFAULT_SETTINGS } from "../../src/setting"
import { GitHubClient } from "../../src/lib/github-api"
import { v4RecoveryPolicyContext } from "../../src/lib/v4/recovery-startup-policy"
import { activeGitHubCooldownUntil, githubRateLimitUntil } from "../../src/lib/v4/github-cooldown"

function browserTimerFixture(): () => void {
  const globals = globalThis as any
  const desktop = Platform.isDesktopApp
  const previousWindow = globals.window
  const previousDocument = globals.document
  Platform.isDesktopApp = false
  globals.window = { setTimeout, clearTimeout }
  globals.document = { hidden: false }
  return () => {
    Platform.isDesktopApp = desktop
    if (previousWindow === undefined) delete globals.window
    else globals.window = previousWindow
    if (previousDocument === undefined) delete globals.document
    else globals.document = previousDocument
  }
}

test("cooldown honors GitHub Retry-After, primary reset and 60-second fallback (uncapped)", () => {
  const now = 1_000_000
  assert.equal(githubRateLimitUntil({ "Retry-After": "6000" }, now), now + 6_000_000)
  assert.equal(githubRateLimitUntil({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": "2000" }, now), 2_000_000)
  assert.equal(githubRateLimitUntil({ "x-ratelimit-remaining": "10", "x-ratelimit-reset": "2000" }, now), now + 60_000)
  assert.equal(githubRateLimitUntil({}, now), now + 60_000)
  assert.equal(githubRateLimitUntil({ "retry-after": "invalid" }, now), now + 60_000)
  const utc = Date.parse("Wed, 21 Oct 2026 10:00:00 GMT")
  const dateDeadline = new Date(utc + 5 * 60_000).toUTCString()
  assert.equal(githubRateLimitUntil({ "retry-after": dateDeadline }, utc), utc + 5 * 60_000,
    "RFC 9110 Retry-After HTTP-date must not become a 60-second fallback")
  assert.equal(githubRateLimitUntil({
    "retry-after": dateDeadline,
    "x-ratelimit-remaining": "0",
    "x-ratelimit-reset": String((utc + 10 * 60_000) / 1_000),
  }, utc), utc + 10 * 60_000, "The later primary reset must still win")
  assert.equal(githubRateLimitUntil({ "retry-after": "0" }, now), now + 60_000)
  assert.equal(githubRateLimitUntil({ "retry-after": "0.000" }, now), now + 60_000)
  assert.equal(githubRateLimitUntil({ "retry-after": "9999999999999999999999999" }, now), now + 60_000)
  assert.equal(githubRateLimitUntil({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": "99999999999999999999" }, now), now + 60_000)
  assert.equal(githubRateLimitUntil({ "retry-after": "15", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "2000" }, now), 2_000_000)
  assert.equal(githubRateLimitUntil({ "retry-after": "3600", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "2000" }, now), now + 3_600_000)
  assert.equal(githubRateLimitUntil({ "retry-after": "0", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "2000" }, now), 2_000_000)
  assert.equal(activeGitHubCooldownUntil(now + 60_000, "ctx", "ctx", now), now + 60_000)
  assert.equal(activeGitHubCooldownUntil(now + 60_000, "ctx", "different", now), 0)
  assert.equal(activeGitHubCooldownUntil(now - 1, "ctx", "ctx", now), 0)
})

test("HTTP 200 GraphQL rate-limit persists deadline and blocks new requests before any remote call", async () => {
  const next = "b".repeat(40), before = "a".repeat(40)
  let until = 0
  let graphql = 0, rest = 0
  const client = new GitHubClient({ owner: "owner", repo: "repo", branch: "main", token: "secret" }, {
    getRateLimitUntil: () => until,
    onRateLimited: timestamp => { until = timestamp },
    transportPolicy: { mutationSpacingMs: 0 },
  })
  setRequestUrlHandler(async (request: unknown) => {
    const { method, url } = request as { method: string; url: string }
    if (method === "GET" && url.endsWith("/repos/owner/repo")) {
      rest++
      return { status: 200, text: "", headers: {}, json: { node_id: "R_repo_node", full_name: "owner/repo" } }
    }
    if (method === "POST" && url.endsWith("/graphql")) {
      graphql++
      return { status: 200, text: "", headers: { "retry-after": "121" }, json: { errors: [{ type: "RATE_LIMITED" }] } }
    }
    throw Error("unexpected transport")
  })
  try {
    await assert.rejects(() => client.updateGitRef(next, before), /rate limited/)
    assert.ok(until > Date.now() + 115_000)
    assert.equal(graphql, 1)
    await assert.rejects(() => client.updateGitRef(next, before), /Sync paused until/)
    assert.equal(graphql, 1)
    assert.equal(rest, 1)
  } finally { setRequestUrlHandler(null) }
})

test("GraphQL HTTP 200 with mixed-case primary limit headers pauses until reset", async () => {
  const next = "b".repeat(40), before = "a".repeat(40)
  const reset = Math.ceil(Date.now() / 1_000) + 800
  let deadline = 0, mutations = 0
  const client = new GitHubClient({ owner: "owner", repo: "repo", branch: "main", token: "secret" }, {
    getRateLimitUntil: () => deadline,
    onRateLimited: timestamp => { deadline = timestamp },
    transportPolicy: { mutationSpacingMs: 0 },
  })
  setRequestUrlHandler(async (input: unknown) => {
    const request = input as { method: string; url: string }
    if (request.method === "GET" && request.url.endsWith("/repos/owner/repo")) {
      return { status: 200, text: "", headers: {},
        json: { node_id: "R_repo_node", full_name: "owner/repo" } }
    }
    if (request.method === "POST" && request.url.endsWith("/graphql")) {
      mutations++
      return { status: 200, text: "", headers: {
        "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": String(reset), "Retry-After": "5",
      }, json: { errors: [{ type: "FORBIDDEN", message: "Request rejected" }] } }
    }
    throw Error("Unexpected request")
  })
  try {
    await assert.rejects(() => client.updateGitRef(next, before), /rate limited/)
    assert.equal(mutations, 1)
    assert.equal(deadline, reset * 1_000, "the longer primary-reset deadline must win")
    await assert.rejects(() => client.updateGitRef(next, before), /Sync paused until/)
    assert.equal(mutations, 1)
  } finally { setRequestUrlHandler(null) }
})

test("later rate-limit responses extend cooldown without shortening its durable deadline", async () => {
  const restoreTimers = browserTimerFixture()
  const plugin = new FastSync() as FastSync & Record<string, any>
  plugin.settings = {
    ...DEFAULT_SETTINGS, githubOwner: "owner", githubRepo: "repo",
    githubToken: "secret", githubTokenSecretId: "token-a",
    encryptionPassphraseSecretId: "pass-a", statusBarStatusEnabled: false,
  }
  plugin.app = { workspace: { getLeavesOfType: () => [] } }
  const saved: Array<{ settings: { githubCooldownUntil: number } }> = []
  let allowFirst!: () => void
  const firstBlocked = new Promise<void>(resolve => { allowFirst = resolve })
  plugin.saveData = async (payload: { settings: { githubCooldownUntil: number } }) => {
    saved.push(payload)
    if (saved.length === 1) await firstBlocked
  }
  const now = Date.now()
  try {
    plugin.recordGitHubCooldown(now + 90_000)
    plugin.recordGitHubCooldown(now + 150_000)
    plugin.recordGitHubCooldown(now + 30_000)
    assert.equal(plugin.getGitHubCooldownUntil(), now + 150_000)
    allowFirst()
    await plugin.settingsWriteQueue
    assert.equal(saved.length, 2)
    assert.equal(saved.at(-1)?.settings.githubCooldownUntil, now + 150_000)
    assert.equal(plugin.isWatchEnabled, false)
  } finally {
    allowFirst()
    plugin.cooldownTimeoutCancel?.()
    restoreTimers()
  }
})

test("REST HTTP 429 never blindly retries a write, but records the primary reset", async () => {
  let requests = 0, until = 0
  const client = new GitHubClient({ owner: "owner", repo: "repo", branch: "main", token: "secret" }, {
    getRateLimitUntil: () => until,
    onRateLimited: value => { until = value },
    transportPolicy: { mutationSpacingMs: 0, maxAttempts: 3 },
  })
  const reset = Math.ceil(Date.now() / 1000) + 700
  setRequestUrlHandler(async () => {
    requests++
    return { status: 429, text: "rate limited", headers: {
      "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset),
    }, json: {} }
  })
  try {
    await assert.rejects(() => client.createGitRef("a".repeat(40)))
    assert.equal(requests, 1)
    assert.equal(until, reset * 1000)
  } finally { setRequestUrlHandler(null) }
})

test("plugin persists rate-limit gate across reload; context changes reset it", async () => {
  const restoreTimers = browserTimerFixture()
  const plugin = new FastSync() as FastSync & Record<string, any>
  plugin.settings = {
    ...DEFAULT_SETTINGS, githubOwner: "owner", githubRepo: "repo",
    githubToken: "secret", githubTokenSecretId: "token-a",
    encryptionPassphraseSecretId: "pass-a", statusBarStatusEnabled: false,
  }
  plugin.app = { workspace: { getLeavesOfType: () => [] } }
  const saves: any[] = []
  plugin.saveData = async (value: unknown) => { saves.push(value) }
  Notice.messages.length = 0
  const deadline = Date.now() + 75_000
  try {
    plugin.recordGitHubCooldown(deadline)
    await plugin.settingsWriteQueue
    assert.equal(plugin.getGitHubCooldownUntil(), deadline)
    assert.equal(plugin.isWatchEnabled, false)
    assert.equal(saves.at(-1)?.settings.githubCooldownUntil, deadline)
    const restarted = new FastSync()
    restarted.settings = { ...DEFAULT_SETTINGS, ...saves.at(-1).settings,
      githubOwner: "owner", githubRepo: "repo",
      githubToken: "secret", githubTokenSecretId: "token-a",
      encryptionPassphraseSecretId: "pass-a" }
    assert.equal(restarted.getGitHubCooldownUntil(), deadline)
    restarted.settings.githubTokenSecretId = "other-token"
    assert.equal(restarted.getGitHubCooldownUntil(), 0)
    assert.ok(Notice.messages.some(message => message.includes("rate limit")))
  } finally { plugin.cooldownTimeoutCancel?.(); restoreTimers() }
})

test("cooldown expiration unblocks watch and starts exactly one fresh normal scheduled Sync", async () => {
  const restoreTimers = browserTimerFixture()
  const plugin = new FastSync() as FastSync & Record<string, any>
  plugin.settings = {
    ...DEFAULT_SETTINGS, githubOwner: "owner", githubRepo: "repo",
    githubToken: "secret", githubTokenSecretId: "token-a",
    encryptionPassphraseSecretId: "pass-a", statusBarStatusEnabled: false,
    syncOnLocalChange: true,
  }
  plugin.app = { workspace: { getLeavesOfType: () => [] } }
  plugin.saveData = async () => undefined
  let starts = 0
  plugin.recoveryStartupGate = false
  plugin.v4Runtime = { scheduledSync: async () => { starts++ } }
  try {
    plugin.recordGitHubCooldown(Date.now() + 45)
    assert.equal(plugin.isWatchEnabled, false)
    await new Promise(resolve => setTimeout(resolve, 110))
    assert.equal(plugin.getGitHubCooldownUntil(), 0)
    assert.equal(plugin.isWatchEnabled, true)
    assert.equal(starts, 1)
  } finally { plugin.cooldownTimeoutCancel?.(); restoreTimers() }
})
