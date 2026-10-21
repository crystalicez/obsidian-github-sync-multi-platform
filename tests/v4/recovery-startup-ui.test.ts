import assert from "node:assert/strict"
import test from "node:test"
import FastSync from "../../src/main"
import { DEFAULT_SETTINGS } from "../../src/setting"
import { v4RecoveryPolicyContext } from "../../src/lib/v4/recovery-startup-policy"
import { createIdleV4Progress } from "../../src/lib/v4/progress"
import { modalButtons, modalEvents, modalInstances, resetModalTestState, Notice } from "../stubs/obsidian"

function fixture(status: "pending" | "corrupt" | "absent", policy: "ask" | "auto" | "notify") {
  resetModalTestState()
  Notice.messages.length = 0
  const plugin = new FastSync() as FastSync & Record<string, any>
  plugin.settings = {
    ...DEFAULT_SETTINGS, syncOnStartup: false,
    githubOwner: "owner", githubRepo: "repo", githubToken: "test",
    githubTokenSecretId: "token-id", encryptionPassphraseSecretId: "passphrase-id",
    interruptedRecoveryPolicy: policy,
  }
  plugin.settings.interruptedRecoveryContext = v4RecoveryPolicyContext(plugin.settings)
  let remoteCalls = 0
  let inspectCalls = 0
  let resumes = 0
  let snapshot = createIdleV4Progress()
  plugin.app = { workspace: { getLeavesOfType: () => [] } }
  plugin.v4Runtime = {
    get settingsGeneration() { return 1 },
    get progressSnapshot() { return snapshot },
    async inspectLocalRecovery() { inspectCalls++; return { status, phase: "publish-intent" } },
    async resumeSync() {
      remoteCalls++
      resumes++
      snapshot = { ...snapshot, lifecycle: "no-change", operation: "normal", trigger: "scheduled" }
      return { status: "completed", changedFiles: 0 }
    },
  }
  return { plugin, get inspectCalls() { return inspectCalls }, get resumes() { return resumes }, get remoteCalls() { return remoteCalls } }
}

test("startup Ask pauses automatic work and Later leaves the recovery pending with no remote request", async () => {
  const f = fixture("pending", "ask")
  await f.plugin.checkStartupRecovery()
  assert.equal(f.plugin.getInterruptedRecoveryState(), "pending")
  assert.equal(f.plugin.recoveryStartupGate, true)
  assert.equal(f.plugin.isWatchEnabled, false)
  assert.equal(f.inspectCalls, 1)
  assert.equal(f.remoteCalls, 0)
  assert.ok(modalEvents.includes("open"))
  const later = modalButtons.find(button => button.text === "Later")
  assert.ok(later)
  later.click()
  await Promise.resolve()
  assert.equal(f.plugin.getInterruptedRecoveryState(), "pending")
  assert.equal(f.plugin.recoveryStartupGate, true)
  assert.equal(f.remoteCalls, 0)
})

test("remembered automatic policy starts exactly one normal recovery then releases the gate", async () => {
  const f = fixture("pending", "auto")
  await f.plugin.checkStartupRecovery()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.resumes, 1)
  assert.equal(f.plugin.getInterruptedRecoveryState(), "none")
  assert.equal(f.plugin.recoveryStartupGate, false)
  assert.equal(modalEvents.length, 0)
})

test("corrupt recovery does not automatically resume even when Auto was remembered", async () => {
  const f = fixture("corrupt", "auto")
  await f.plugin.checkStartupRecovery()
  assert.equal(f.plugin.getInterruptedRecoveryState(), "corrupt")
  assert.equal(f.plugin.recoveryStartupGate, true)
  assert.equal(f.resumes, 0)
  assert.ok(Notice.messages.some(message => /cannot be verified/u.test(message)))
})

test("Notify only holds automatic work until an explicit normal Sync succeeds", async () => {
  const f = fixture("pending", "notify")
  await f.plugin.checkStartupRecovery()
  assert.equal(f.plugin.getInterruptedRecoveryState(), "pending")
  assert.equal(f.plugin.recoveryStartupGate, true)
  assert.equal(f.resumes, 0)
  assert.equal(modalEvents.length, 0)
  f.plugin.onRecoverySyncProgress({ ...createIdleV4Progress(), operation: "normal", trigger: "manual", lifecycle: "success" })
  assert.equal(f.plugin.getInterruptedRecoveryState(), "none")
  assert.equal(f.plugin.recoveryStartupGate, false)
})

test("skipped Resume preserves pending gate without automatic retries", async () => {
  const f = fixture("pending", "notify")
  f.plugin.v4Runtime.resumeSync = async () => ({ status: "skipped", changedFiles: 0 })
  await f.plugin.checkStartupRecovery()
  await f.plugin.resumeInterruptedRecovery()
  assert.equal(f.plugin.getInterruptedRecoveryState(), "pending")
  assert.equal(f.plugin.recoveryStartupGate, true)
})

test("checked Remember saves Later as Notify only for this vault", async () => {
  const f = fixture("pending", "ask")
  let savedPolicy = ""
  f.plugin.saveSettings = async (next: typeof f.plugin.settings) => { savedPolicy = next.interruptedRecoveryPolicy }
  await f.plugin.checkStartupRecovery()
  const checkbox = modalInstances[0].contentEl.findByAttribute("type", "checkbox") as any
  assert.ok(checkbox)
  checkbox.checked = true
  modalButtons.find(button => button.text === "Later")!.click()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(savedPolicy, "notify")
  assert.equal(f.plugin.recoveryStartupGate, true)
})

test("recovery prompt accepts at most one answer even when clicked repeatedly during Save", async () => {
  const f = fixture("pending", "ask")
  let saves = 0
  let release!: () => void
  const pendingSave = new Promise<void>(resolve => { release = resolve })
  f.plugin.saveSettings = async () => { saves++; await pendingSave }
  await f.plugin.checkStartupRecovery()
  const checkbox = modalInstances[0].contentEl.findByAttribute("type", "checkbox") as any
  assert.ok(checkbox)
  checkbox.checked = true
  const resume = modalButtons.find(button => button.text === "Verify and resume normal Sync")!
  const later = modalButtons.find(button => button.text === "Later")!
  resume.click()
  later.click()
  resume.click()
  assert.equal(saves, 1)
  assert.equal(f.resumes, 0, "no sync before saved policy is settled")
  release()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.resumes, 1)
  assert.equal(f.plugin.getInterruptedRecoveryState(), "none")
})

test("absent journal never prompts or contacts remote", async () => {
  const f = fixture("absent", "ask")
  await f.plugin.checkStartupRecovery()
  assert.equal(f.plugin.getInterruptedRecoveryState(), "none")
  assert.equal(f.plugin.recoveryStartupGate, false)
  assert.equal(f.remoteCalls, 0)
  assert.equal(modalEvents.length, 0)
})
