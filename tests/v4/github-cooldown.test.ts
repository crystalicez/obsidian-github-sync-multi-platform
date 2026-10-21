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
