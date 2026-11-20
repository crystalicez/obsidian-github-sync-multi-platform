#!/usr/bin/env node
// D445: Real installed Obsidian FIRST USE without GitHub credentials or remote operations.
// All plugin data and Electron state stay in an independently generated Vault/Profile
// under this worktree's .tmp. This does not qualify a real GitHub Sync.
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { buildNativePluginReadyExpression } from "./native-obsidian-plugin-ready.mjs"
import { sanitizeOfflineFastChildEnvironment } from "./fast-offline-qualification-plan.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const pluginId = "encrypted-github-sync-multi-platform"
const exe = "C:\\Program Files\\Obsidian\\Obsidian.exe"
const testRoot = path.join(root, ".tmp", "obsidian-offline-first-use")
const port = 30000 + (process.pid % 24000)
const args = process.argv.slice(2)
assert.ok(args.length === 1 && ["--preflight-only", "--run"].includes(args[0]),
  "Usage: node scripts/run-obsidian-offline-first-use.mjs --preflight-only|--run")

let runRoot
let child
let socket
let passed = false
let cleanupStatus = "not-started"
let stage = "preflight"
let requestId = 0
const pending = new Map()
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
function safeFailure(error) {
  // Never log raw renderer exceptions, Vault data or profile locations.
  if (!(error instanceof Error)) return "native-smoke-failed"
  if (error.message.includes("Installed Obsidian.exe not found")) return "obsidian-not-installed"
  if (error.message.includes("Production build artifacts are missing")) return "build-artifacts-missing"
  if (error.message.includes("CDP port occupied")) return "cdp-port-occupied"
  return error.name === "AssertionError" ? "assertion-failed" : "native-smoke-failed"
}
async function preflight() {
  for (const filename of ["main.js", "manifest.json", "styles.css"]) {
    const info = await lstat(path.join(root, filename)).catch(() => null)
    assert.ok(info?.isFile() && !info.isSymbolicLink(),
      "Production build artifacts are missing; run pnpm build before the smoke")
  }
  const executable = await stat(exe).catch(() => null)
  assert.ok(executable?.isFile(),
    "Installed Obsidian.exe not found. Native acceptance remains unqualified")
  assert.ok(Number.isSafeInteger(port) && port > 1024 && port < 65535)
  try {
    const response = await fetch("http://127.0.0.1:" + port + "/json/list", {
      signal: AbortSignal.timeout(1200),
    })
    if (response.ok) throw Error("CDP port occupied; refusing other Obsidian instance")
  } catch (error) {
    if (!/fetch failed|ECONNREFUSED|timed out|TimeoutError/u.test(String(error))) throw error
  }
}
async function requireOwnTempRoot() {
  for (const dir of [path.dirname(testRoot), testRoot]) {
    await mkdir(dir, { recursive: true })
    const info = await lstat(dir)
    assert.ok(info.isDirectory() && !info.isSymbolicLink(),
      "Refusing linked or non-directory test root")
  }
}
async function send(method, params = {}, timeoutMs = 18000) {
  assert.equal(socket?.readyState, WebSocket.OPEN, "Isolated renderer connection missing")
  return new Promise((resolve, reject) => {
    const id = ++requestId
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(Error("Isolated renderer request timed out"))
    }, timeoutMs)
    pending.set(id, {
      resolve: value => { clearTimeout(timer); resolve(value) },
      reject: error => { clearTimeout(timer); reject(error) },
    })
    socket.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluate(expression, timeoutMs = 22000) {
  const data = await send("Runtime.evaluate", {
    expression, awaitPromise: true, returnByValue: true,
  }, timeoutMs)
  if (data.exceptionDetails) throw Error("Isolated renderer rejected smoke expression")
  return data.result?.value
}
async function waitFor(expression, description, attempts = 80) {
  for (let n = 0; n < attempts; n++) {
    const value = await evaluate(expression)
    if (value) return value
    await sleep(220)
  }
  throw Error("Isolated renderer readiness failed: " + description)
}
async function connectVerifiedVault(vault) {
  let target
  for (let n = 0; n < 155; n++) {
    try {
      const response = await fetch("http://127.0.0.1:" + port + "/json/list", {
        signal: AbortSignal.timeout(1000),
      })
      const list = response.ok ? await response.json() : []
      target = list.find(entry => entry.type === "page"
        && entry.url === "app://obsidian.md/index.html" && entry.webSocketDebuggerUrl)
      if (target) break
    } catch { /* wait only for the port assigned to this run */ }
    await sleep(350)
  }
  assert.ok(target, "Isolated native Obsidian window did not start")
  socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true })
    socket.addEventListener("error", () => reject(Error("Isolated CDP handshake failed")), { once: true })
  })
  socket.addEventListener("message", event => {
    let packet
    try { packet = JSON.parse(String(event.data)) } catch { return }
    if (!packet.id) return
    const waiter = pending.get(packet.id)
    if (!waiter) return
    pending.delete(packet.id)
    if (packet.error) waiter.reject(Error("Isolated CDP command rejected"))
    else waiter.resolve(packet.result)
  })
  await send("Runtime.enable")
  // Verify native Obsidian's ACTUAL adapter path before evaluating plugin code.
  const identity = await waitFor(
    "(()=>typeof app==='undefined'?null:app.vault?.adapter?.getBasePath?.())()",
    "Vault identity",
  )
  assert.equal(identity.toLowerCase(), vault.toLowerCase(),
    "Refusing plugin actions in a non-disposable Vault")
  await waitFor(
    "(()=>{const p=app.plugins;return !!p&&typeof p.isEnabled==='function'"
      + "&&typeof p.setEnable==='function'&&typeof p.enablePluginAndSave==='function'"
      + "&&typeof p.loadPlugin==='function'&&typeof p.enabledPlugins?.has==='function'})()",
    "Obsidian plugin manager",
  )
  const loaded = await evaluate(buildNativePluginReadyExpression(pluginId), 35000)
  assert.equal(loaded, true, "Production plugin failed native startup")
  await waitFor("(()=>{const p=app.plugins.plugins[" + JSON.stringify(pluginId)
    + "];return !!p?.settings&&!!p?.v4Runtime&&!!p?.settingTab&&!!p?.ribbonIcon})()",
  "Plugin onload and Settings UI")
}
async function launch(profile, vault) {
  // Never open the user's default profile or any externally supplied Vault.
  child = spawn(exe, ["--user-data-dir=" + profile, "--remote-debugging-port=" + port], {
    detached: true, windowsHide: true, stdio: "ignore",
    env: sanitizeOfflineFastChildEnvironment(process.env),
  })
  child.on("error", () => {})
  child.unref()
  await connectVerifiedVault(vault)
}
function stopOwnedProcess() {
  try { socket?.close() } catch {}
  socket = undefined
  if (!child?.pid) return
  const pid = child.pid
  if (child.exitCode !== null || child.signalCode !== null) {
    child = undefined
    return
  }
  const stopped = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
    encoding: "utf8", timeout: 16000, shell: false,
  })
  assert.equal(stopped.status, 0, "Could not stop owned synthetic Obsidian process")
  child = undefined
}
async function performFirstUse() {
  stage = "native-first-use"
  const report = await evaluate(`(async()=>{
    let step="read-initial-settings";
    try {
      const plugin=app.plugins.plugins[${JSON.stringify(pluginId)}];
      const fresh=plugin.settings;
      if(fresh.githubOwner||fresh.githubRepo||fresh.githubToken||fresh.encryptionPassphrase)
        throw Error("Expected blank synthetic GitHub configuration");
      const originalId=fresh.vault;
      if(!/^device-[a-f0-9]{32}$/u.test(originalId))throw Error("First device ID invalid");
      step="wait-workspace-layout";
      await new Promise(resolve=>app.workspace.onLayoutReady(resolve));
      step="open-sync-center";
      await plugin.openSyncCenter();
      const start=Date.now();
      while(!document.querySelector(".github-sync-center")&&Date.now()-start<8000)
        await new Promise(resolve=>setTimeout(resolve,160));
      step="check-sync-center";
      const view=document.querySelector(".github-sync-center");
      if(!view||![...view.querySelectorAll("button")]
        .some(button=>button.textContent.trim()==="Sync now"))
        throw Error("Native Sync Center action unavailable");
      step="save-first-settings";
      await plugin.saveSettings({...fresh,syncOnStartup:false,
        syncOnLocalChange:false,scheduledSyncEnabled:false});
      if(plugin.settings.vault!==originalId)throw Error("Device identity changed on Save");
      return {newDeviceId:originalId,persisted:true,syncCenterOpen:true,
        noCredentials:!(plugin.settings.githubToken||plugin.settings.githubOwner
          ||plugin.settings.githubRepo||plugin.settings.encryptionPassphrase)};
    } catch {
      return {failedAt:step};
    }
  })()`, 45000)
  if (report?.failedAt) {
    stage = "native-first-use:" + report.failedAt
    throw Error("Native first-use step failed")
  }
  stage = "check-native-first-use-result"
  assert.match(report?.newDeviceId ?? "", /^device-[a-f0-9]{32}$/u)
  assert.equal(report.persisted, true)
  assert.equal(report.syncCenterOpen, true)
  assert.equal(report.noCredentials, true)
  return report.newDeviceId
}

try {
  // Preflight MUST precede even the creation of synthetic .tmp directories.
  await preflight()
  if (args[0] === "--preflight-only") {
    console.log(JSON.stringify({ nativeOfflineFirstUse: "PREFLIGHT_PASS",
      installed: true, buildPresent: true, remoteGitHubUsed: false }))
    passed = true
  } else {
    stage = "prepare-disposable-vault"
    await requireOwnTempRoot()
    runRoot = await mkdtemp(path.join(testRoot, "run-"))
    const vault = path.join(runRoot, "vault")
    const profile = path.join(runRoot, "profile")
    const pluginDir = path.join(vault, ".obsidian", "plugins", pluginId)
    await mkdir(pluginDir, { recursive: true })
    await mkdir(profile)
    for (const filename of ["main.js", "manifest.json", "styles.css"]) {
      await copyFile(path.join(root, filename), path.join(pluginDir, filename))
    }
    await writeFile(path.join(vault, ".obsidian", "community-plugins.json"),
      JSON.stringify([pluginId]) + "\n")
    await writeFile(path.join(profile, "obsidian.json"),
      JSON.stringify({ vaults: { d445firstuse: {
        path: vault, ts: Date.now(), open: true,
      } } }) + "\n")
    await writeFile(path.join(vault, "D445-synthetic-first-use.md"),
      "# D445 offline installation test\nNo GitHub account configured.\n")
    stage = "first-native-launch"
    await launch(profile, vault)
    stage = "check-pre-save-disk"
    const beforePath = path.join(pluginDir, "data.json")
    const before = await stat(beforePath).catch(() => null)
    // A clean install may persist newly allocated empty SecretStorage IDs
    // during startup migration. If so, the saved Device ID must already match
    // the live instance, and neither kind of credential may reach data.json.
    if (before) {
      stage = "check-startup-migration-data"
      const early = JSON.parse(await readFile(beforePath, "utf8"))
      const earlySettings = early.settings ?? early
      const live = await evaluate(`(()=>{
        const s=app.plugins.plugins[${JSON.stringify(pluginId)}].settings;
        return {deviceId:s.vault,noCredentials:!(s.githubToken||s.githubOwner
          ||s.githubRepo||s.encryptionPassphrase)};
      })()`)
      assert.equal(earlySettings.vault, live.deviceId,
        "Startup migration saved a different Device ID")
      assert.equal(live.noCredentials, true)
      assert.equal("githubToken" in earlySettings, false)
      assert.equal("encryptionPassphrase" in earlySettings, false)
    }
    const originalDeviceId = await performFirstUse()
    stage = "check-saved-disk"
    const disk = JSON.parse(await readFile(beforePath, "utf8"))
    assert.equal(disk.settings?.vault ?? disk.vault, originalDeviceId,
      "Plugin Save did not persist native Device ID")
    stage = "terminate-for-restart"
    stopOwnedProcess()
    await sleep(850)
    stage = "second-native-launch"
    await launch(profile, vault)
    stage = "check-reloaded-device-id"
    const reloaded = await evaluate(`(()=>{
      const plugin=app.plugins.plugins[${JSON.stringify(pluginId)}];
      return { deviceId:plugin.settings.vault,
        noCredentials:!(plugin.settings.githubToken||plugin.settings.githubOwner
          ||plugin.settings.githubRepo||plugin.settings.encryptionPassphrase) };
    })()`)
    assert.equal(reloaded?.deviceId, originalDeviceId,
      "Installed plugin lost saved Device ID across process restart")
    assert.equal(reloaded.noCredentials, true)
    const note = await readFile(path.join(vault, "D445-synthetic-first-use.md"), "utf8")
    assert.equal(note, "# D445 offline installation test\nNo GitHub account configured.\n")
    passed = true
    console.log(JSON.stringify({ nativeOfflineFirstUse: "PASS", installed: true,
      settingsSaved: true, deviceIdPersistedAcrossRestart: true,
      syncCenterReady: true, noGitHubCredentials: true, remoteGitHubUsed: false,
      syntheticNotesPreserved: true }))
  }
} catch (error) {
  // Do not claim qualification on missing Windows Obsidian, CDP failure or startup fault.
  console.error(JSON.stringify({ nativeOfflineFirstUse: "BLOCKED_OR_FAIL",
    stage, reason: safeFailure(error), installedAcceptance: false, remoteGitHubUsed: false }))
  process.exitCode = 1
} finally {
  try {
    stopOwnedProcess()
    if (runRoot) {
      const info = await lstat(runRoot)
      assert.ok(info.isDirectory() && !info.isSymbolicLink(),
        "Refusing unsafe synthetic cleanup target")
      await rm(runRoot, { recursive: true, force: true, maxRetries: 16, retryDelay: 260 })
    }
    cleanupStatus = "synthetic-only"
  } catch {
    cleanupStatus = "manual-synthetic-cleanup-required"
    process.exitCode = 1
  }
  if (runRoot) console.log(JSON.stringify({ syntheticCleanup: cleanupStatus }))
  if (!passed) process.exitCode = 1
}
