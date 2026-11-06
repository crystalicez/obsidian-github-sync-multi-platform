#!/usr/bin/env node
// Isolated real Obsidian command smoke. No GitHub credentials, no remote writes.
// Never use a user's live vault or default Obsidian profile.
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { copyFile, lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import esbuild from "esbuild"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const args = process.argv.slice(2)
const option = (name, fallback) =>
  args.find(value => value.startsWith("--" + name + "="))?.slice(name.length + 3) ?? fallback
const exe = option("obsidian", "C:\\Program Files\\Obsidian\\Obsidian.exe")
const pluginId = "encrypted-github-sync-multi-platform"
const commandId = pluginId + ":verify-reencryption-complete-recovery-read-only"
const port = Number(option("port", String(25000 + process.pid % 30000)))
const tmpRoot = path.join(root, ".tmp", "obsidian-readonly-recovery-ui")
const staleRun = option("cleanup-run", "")

// The test deletes synthetic vaults. Refuse a linked/junction test root before
// creating, cleaning or following any child path, including --cleanup-run.
for (const location of [path.dirname(tmpRoot), tmpRoot]) {
  await mkdir(location, { recursive: true })
  const info = await lstat(location)
  assert.ok(info.isDirectory() && !info.isSymbolicLink(),
    "Refusing linked or non-directory native Obsidian test root")
}
if (staleRun) {
  assert.match(staleRun, /^run-[a-zA-Z0-9_-]{6,24}$/u,
    "Cleanup may name only one synthetic Recovery UI run")
  const staleRoot = path.join(tmpRoot, staleRun)
  const info = await lstat(staleRoot)
  assert.ok(info.isDirectory() && !info.isSymbolicLink()
    && Date.now() - info.mtimeMs > 60_000,
    "Refusing a live, linked, or recently written native test directory")
  await rm(staleRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 300 })
  console.log(JSON.stringify({ cleanup: "stale-synthetic-run-removed", staleRun }))
  process.exit(0)
}
let runRoot
let child
let ws
let nativeResult
let nativeOutcomes
let nativeDiskEvidence
let nativeReloadEvidence
let nativeRestartEvidence
let nativeOrphanEvidence
let nativeSettingsDigestBeforeRestart
let nativeAuthenticatedWalEvidence
let nativeAuthenticatedWalContract
let nativeAuthenticatedWalRestart
let nativeAuthenticatedWalOrphanRestart
let nativeOsLockProof
let walProofBundle
let passed = false
let cleanup = "not-started"
let nativePhase = "initial"
const pending = new Map()
let nextId = 0

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }
async function send(method, params = {}, timeoutMs = 15000) {
  assert.ok(ws?.readyState === WebSocket.OPEN, "CDP socket is unavailable")
  return new Promise((resolve, reject) => {
    const id = ++nextId
    const timeout = setTimeout(() => {
      pending.delete(id)
      reject(Error("CDP request timed out: " + method))
    }, timeoutMs)
    pending.set(id, {
      resolve: value => { clearTimeout(timeout); resolve(value) },
      reject: error => { clearTimeout(timeout); reject(error) },
    })
    ws.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluate(expression, timeoutMs = 20000) {
  const reply = await send("Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true }, timeoutMs)
  if (reply.exceptionDetails) throw Error(
    "Isolated Obsidian UI evaluation threw in " + nativePhase
    + " at expression line " + String(reply.exceptionDetails.lineNumber ?? "unknown"))
  return reply.result?.value
}
async function findIsolatedPage() {
  for (let i = 0; i < 130; i++) {
    try {
      const response = await fetch("http://127.0.0.1:" + port + "/json/list", {
        signal: AbortSignal.timeout(1200),
      })
      if (response.ok) {
        const list = await response.json()
        const target = list.find(item => item.url === "app://obsidian.md/index.html"
          && item.webSocketDebuggerUrl)
        if (target) return target
      }
    } catch {}
    await sleep(350)
  }
  throw Error("Isolated native Obsidian window did not open")
}
async function waitForValue(expression, label, attempts = 35) {
  for (let i = 0; i < attempts; i++) {
    const value = await evaluate(expression)
    if (value) return value
    await sleep(220)
  }
  throw Error("Native Obsidian did not report " + label)
}

async function attachIsolatedPage(vault) {
  const target = await findIsolatedPage()
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true })
    ws.addEventListener("error", () => reject(Error("Isolated CDP attach failed")), { once: true })
  })
  ws.addEventListener("message", event => {
    const message = JSON.parse(String(event.data))
    if (!message.id) return
    const waiting = pending.get(message.id)
    if (!waiting) return
    pending.delete(message.id)
    if (message.error) waiting.reject(Error("CDP command returned an error"))
    else waiting.resolve(message.result)
  })
  await send("Runtime.enable")
  await send("Page.enable")
  const identity = await waitForValue(
    "(()=>{if(typeof app==='undefined'||!app.vault?.adapter?.getBasePath)return null;"
      + "return {base:app.vault.adapter.getBasePath(),name:app.vault.getName()}})()",
    "the isolated vault",
  )
  assert.equal(identity.base.toLowerCase(), vault.toLowerCase(),
    "Refusing to inspect a non-isolated Obsidian vault")
}

async function installNativeWalProof() {
  assert.ok(walProofBundle, "Synthetic crypto proof bundle was not prepared")
  const loaded = await evaluate(walProofBundle
    + "\n;globalThis.__d287WalProof = __d287WalProof; true", 30000)
  assert.equal(loaded, true, "Isolated browser WAL probe failed to load")
}

async function verifyNativeWalProof(contract) {
  const report = await evaluate(`(async()=>{
    const id=${JSON.stringify(pluginId)};
    const plugin=app.plugins.plugins[id];
    if(!plugin || plugin.settings.githubToken || plugin.settings.githubOwner
      || plugin.settings.githubRepo)
      throw Error("Native WAL read-only probe requires a synthetic unconfigured plugin");
    return await globalThis.__d287WalProof.verifyExisting(
      app.vault.adapter,id,${JSON.stringify(contract)});
  })()`, 45000)
  for(const key of ["authenticated","readOnly","noCutover","realObsidianAdapter","noGitHubUsed"]){
    assert.equal(report[key],true,"Positive WAL read-only proof failed: "+key)
  }
  assert.equal(report.completeRecoveryProven,false)
  assert.equal(report.crashedPowerProven,false)
  return report
}

async function restartIsolatedProcess(profile, vault) {
  assert.ok(child?.pid, "Synthetic Obsidian child PID must be known before restart")
  try { ws?.close() } catch {}
  ws = undefined
  const oldPid = child.pid
  const stopped = spawnSync("taskkill", ["/PID", String(oldPid), "/T", "/F"],
    { encoding: "utf8", timeout: 15000 })
  assert.equal(stopped.status, 0,
    "Refusing to relaunch while prior synthetic Obsidian process still runs")
  child = undefined
  await sleep(800)
  child = spawn(exe, [
    "--user-data-dir=" + profile, "--remote-debugging-port=" + port,
  ], { detached: true, windowsHide: false, stdio: "ignore" })
  child.on("error", () => {})
  child.unref()
  await attachIsolatedPage(vault)
  const loaded = await evaluate("(async()=>{const id=" + JSON.stringify(pluginId)
    + ";if(!app.plugins.isEnabled())await app.plugins.setEnable(true);"
    + "if(!app.plugins.enabledPlugins.has(id))await app.plugins.enablePluginAndSave(id);"
    + "await app.plugins.loadPlugin(id);"
    + "for(let i=0;i<40&&!app.plugins.plugins[id];i++){"
    + "await new Promise(resolve=>setTimeout(resolve,200));"
    + "if(app.plugins.isEnabled()&&app.plugins.manifests[id]&&!app.plugins.loadingPluginId)"
    + "await app.plugins.loadPlugin(id)};"
    + "return !!app.plugins.plugins[id]})()", 35000)
  assert.equal(loaded, true, "Fresh synthetic Obsidian process failed to load plugin")
  await waitForValue("(()=>{const p=app.plugins.plugins["
    + JSON.stringify(pluginId)
    + "];return !!p?.settings&&!!p?.v4Runtime"
    + "&&typeof p.v4Runtime.inspectFencedReencryptionIndexRoute==='function'})()",
    "initialized V4 runtime after process restart")
}

try {
  const compiled = await esbuild.build({
    entryPoints: [path.join(root, "scripts", "native-encrypted-wal-probe.ts")],
    bundle: true, write: false, platform: "browser", format: "iife",
    globalName: "__d287WalProof", target: "es2022", minify: true,
    logLevel: "silent",
  })
  walProofBundle = compiled.outputFiles?.[0]?.text
  assert.ok(walProofBundle && walProofBundle.length < 500_000,
    "Native test-only crypto bundle must be available and bounded")
  assert.ok(Number.isInteger(port) && port > 1024 && port < 65535,
    "Use an unoccupied local CDP port")
  try {
    const response = await fetch("http://127.0.0.1:" + port + "/json/list", {
      signal: AbortSignal.timeout(1200),
    })
    if (response.ok) throw Error("CDP port already in use; refusing other Obsidian process")
  } catch (error) {
    if (!/fetch failed|ECONNREFUSED|timed out|TimeoutError/u.test(String(error))) throw error
  }
  await mkdir(tmpRoot, { recursive: true })
  runRoot = await mkdtemp(path.join(tmpRoot, "run-"))
  const vault = path.join(runRoot, "vault")
  const profile = path.join(runRoot, "profile")
  const pluginRoot = path.join(vault, ".obsidian", "plugins", pluginId)
  await mkdir(pluginRoot, { recursive: true })
  await mkdir(profile)
  for (const filename of ["main.js", "manifest.json", "styles.css"]) {
    await copyFile(path.join(root, filename), path.join(pluginRoot, filename))
  }
  await writeFile(path.join(vault, ".obsidian", "community-plugins.json"),
    JSON.stringify([pluginId]) + "\n")
  await writeFile(path.join(profile, "obsidian.json"),
    JSON.stringify({ vaults: { "c307ab4210380d12": {
      path: vault, ts: Date.now(), open: true,
    } } }) + "\n")
  child = spawn(exe, [
    "--user-data-dir=" + profile, "--remote-debugging-port=" + port,
  ], { detached: true, windowsHide: false, stdio: "ignore" })
  child.on("error", () => {})
  child.unref()
  await attachIsolatedPage(vault)
  const loaded = await evaluate("(async()=>{const id=" + JSON.stringify(pluginId)
    + ";if(!app.plugins.isEnabled())await app.plugins.setEnable(true);"
    + "if(!app.plugins.enabledPlugins.has(id))await app.plugins.enablePluginAndSave(id);"
    + "await app.plugins.loadPlugin(id);"
    + "for(let i=0;i<40&&!app.plugins.plugins[id];i++){"
    + "await new Promise(resolve=>setTimeout(resolve,200));"
    + "if(app.plugins.isEnabled()&&app.plugins.manifests[id]&&!app.plugins.loadingPluginId)"
    + "await app.plugins.loadPlugin(id)};"
    + "return !!app.plugins.plugins[id]})()", 35000)
  assert.equal(loaded, true, "Plugin failed to load in real Obsidian")
  await waitForValue("(()=>{const p=app.plugins.plugins["
    + JSON.stringify(pluginId)
    + "];return !!p?.settings&&!!p?.v4Runtime"
    + "&&typeof p.v4Runtime.inspectFencedReencryptionIndexRoute==='function'})()",
    "initialized V4 runtime")
  // Test-only isolated renderer bundle uses the genuine V4 WAL journal and
  // read-only D237 cryptographic inspector with this actual Vault adapter.
  // It does not call installed Complete Recovery or prove any remote evidence.
  nativePhase = "authenticated encrypted WAL test bundle"
  await installNativeWalProof()
  nativeAuthenticatedWalEvidence = await evaluate(`(async()=>{
    const id=${JSON.stringify(pluginId)};
    const plugin=app.plugins.plugins[id];
    if(!plugin || plugin.settings.githubToken || plugin.settings.githubOwner
      || plugin.settings.githubRepo)
      throw Error("Native crypto proof requires synthetic no-token plugin");
    return globalThis.__d287WalProof.seedAndVerify(app.vault.adapter,id);
  })()`, 65000)
  for(const key of [
    "authenticatedTwoSlots", "exactContractBound", "wrongKeyRejected",
    "tamperedCiphertextWithRehashedHeaderRejected", "restoredAuthenticates",
    "noCutoverOrSync", "realObsidianAdapter", "noGitHubUsed",
  ]) {
    assert.equal(nativeAuthenticatedWalEvidence[key], true,
      "Native genuine encrypted WAL proof failed: "+key)
  }
  assert.equal(nativeAuthenticatedWalEvidence.completeRecoveryProven,false)
  assert.equal(nativeAuthenticatedWalEvidence.crashedPowerProven,false)
  nativeAuthenticatedWalContract = nativeAuthenticatedWalEvidence.contract
  assert.ok(nativeAuthenticatedWalContract?.identity?.runId,
    "Authentic WAL test contract must be pinned independently across restarts")
  // Verify the real Obsidian adapter resolves the same physical plugin root
  // before passing only this disposable Vault to the separate Node test.
  const nativePluginRoot = await evaluate(
    "app.vault.adapter.getFullPath("+JSON.stringify(".obsidian/plugins/"+pluginId)+")")
  assert.equal(nativePluginRoot.toLowerCase(),
    path.join(vault, ".obsidian", "plugins", pluginId).toLowerCase(),
    "Desktop WAL OS probe must be bound to Obsidian's verified physical plugin root")
  const slotSha256 = nativeAuthenticatedWalEvidence.slotSha256
  assert.ok(Array.isArray(slotSha256) && slotSha256.length === 2
    && slotSha256.every(item => /^[a-f0-9]{64}$/u.test(item)),
    "Desktop WAL probe requires two pinned ciphertext slot digests")
  const nodeProbe = await esbuild.build({
    entryPoints: [path.join(root, "scripts", "native-desktop-wal-os-lock-probe.ts")],
    bundle: true, write: false, platform: "node", format: "cjs",
    target: "node22", logLevel: "silent",
  })
  const osLockBundle = nodeProbe.outputFiles?.[0]?.text
  assert.ok(osLockBundle && osLockBundle.length < 350_000,
    "Desktop WAL probe must bundle to bounded test-only Node code")
  const probePath = path.join(runRoot, "desktop-wal-os-lock-probe.cjs")
  await writeFile(probePath, osLockBundle)
  nativePhase = "real Desktop OS lock two-process test"
  const osLockCheck = spawnSync(process.execPath,
    [probePath, "parent", vault, ...slotSha256],
    { encoding: "utf8", timeout: 65_000, windowsHide: true })
  assert.equal(osLockCheck.status, 0,
    "Existing Desktop WAL OS-lock probe failed: "
      + String(osLockCheck.stderr ?? "").trim().slice(0, 180))
  nativeOsLockProof = JSON.parse(osLockCheck.stdout.trim().split(/\r?\n/u).at(-1))
  for (const key of [
    "firstProcessHeldOSLock", "secondProcessBlocked", "releasedAndReopened",
    "encryptedSlotsPreserved", "nativeObsidianPhysicalWal",
  ]) {
    assert.equal(nativeOsLockProof[key], true,
      "Desktop encrypted WAL read-only OS lock regression: "+key)
  }
  assert.equal(nativeOsLockProof.remoteGitHubUsed, false)
  assert.equal(nativeOsLockProof.cutoverAuthorized, false)
  assert.equal(nativeOsLockProof.powerLossDurabilityProven, false)
  // Seed only this verified disposable Vault through Obsidian's real native
  // adapter. These intentionally malformed bytes cannot prove crypto or
  // authorize Cutover: the acceptance is strictly fail-closed and read-only.
  nativePhase = "physical disk fixture"
  nativeDiskEvidence = await evaluate(`(async()=>{
  const plugin=app.plugins.plugins[${JSON.stringify(pluginId)}];
  if(!plugin || plugin.settings.githubToken ||
    plugin.settings.githubOwner || plugin.settings.githubRepo)
    throw Error("Native WAL fixture requires an unconfigured synthetic plugin");
  const runtime=plugin.v4Runtime;
  const adapter=app.vault.adapter;
  const pluginRoot=".obsidian/plugins/"+plugin.manifest.id;
  const fenceRoot=pluginRoot+"/github-sync-v4-rekey-sync-fence";
  const routeRoot=pluginRoot+"/github-sync-v4-rekey-runtime-route";
  const mkdir=async location=>{
    if(!await adapter.exists(location))await adapter.mkdir(location);
  };
  const before=await runtime.inspectFencedReencryptionIndexRoute();
  const noRouteWasInactive=before.observation==="no-routing-artifact"
    && before.resumeSyncAuthorized===false
    && before.localCutoverAuthorized===false;
  let unfencedSettingsCheckAllowed=false;
  try {
    await runtime.assertReencryptionSettingsSaveAllowed();
    unfencedSettingsCheckAllowed=true;
  } catch {}
  const savedOwner=plugin.settings.githubOwner;
  const savedRepo=plugin.settings.githubRepo;
  try {
    plugin.settings.githubOwner="synthetic-offline-owner";
    plugin.settings.githubRepo="synthetic-offline-repo";
    await mkdir(fenceRoot);
    const runId="D284SyntheticRun2026";
    const fence=JSON.stringify({
      schemaVersion:1,phase:"migration-fenced-uncommitted",runId,
      sourceRepoId:"synthetic-offline-owner/synthetic-offline-repo#source",
      destinationRepoId:"synthetic-offline-owner/synthetic-offline-repo#destination"
    });
    await adapter.write(fenceRoot+"/active.json",fence);
    const fenced=await runtime.inspectFencedReencryptionIndexRoute();
    const preparedNotAuthorizing=fenced.observation==="fenced-before-routing-intent"
      && fenced.resumeSyncAuthorized===false
      && fenced.localCutoverAuthorized===false;
    let settingsSaveDenied=false;
    try {
      await runtime.assertReencryptionSettingsSaveAllowed();
    } catch {
      settingsSaveDenied=true;
    }
    await mkdir(routeRoot);
    const partial=await runtime.inspectFencedReencryptionIndexRoute();
    const partialRouteRejected=partial.observation==="manual-recovery-required"
      && partial.resumeSyncAuthorized===false;
    const badMarker='{"schemaVersion":1,"phase":"synthetic-not-trusted","mac":"bad"}';
    await adapter.write(routeRoot+"/intent.json",badMarker);
    const malformed=await runtime.inspectFencedReencryptionIndexRoute();
    const malformedRouteRejected=malformed.observation==="manual-recovery-required"
      && malformed.remoteWritesAuthorized===false;
    await mkdir(pluginRoot+"/reencryption-wal");
    const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(runId));
    const rootHash=Array.from(new Uint8Array(digest),b=>
      b.toString(16).padStart(2,"0")).join("");
    const walRoot=pluginRoot+"/reencryption-wal/"+rootHash;
    await mkdir(walRoot);
    const slots=[
      '{"schemaVersion":999,"synthetic":"not authenticated","slot":0}',
      '{"schemaVersion":999,"synthetic":"not authenticated","slot":1}'
    ];
    await adapter.write(walRoot+"/slot-0.json",slots[0]);
    await adapter.write(walRoot+"/slot-1.json",slots[1]);
    const walLocated=(await adapter.list(walRoot)).files.length===2;
    const structure=await runtime.inspectFencedReencryptionExistingWalStructure();
    const complete=await runtime.inspectFencedReencryptionCompleteRecovery();
    const unchanged=(await adapter.read(fenceRoot+"/active.json"))===fence
      && (await adapter.read(routeRoot+"/intent.json"))===badMarker
      && (await adapter.read(walRoot+"/slot-0.json"))===slots[0]
      && (await adapter.read(walRoot+"/slot-1.json"))===slots[1];
    const walList=await adapter.list(walRoot);
    const noUnexpectedWalFile=walList.files.length===2
      && walList.folders.length===0;
    return {
      noRouteWasInactive,unfencedSettingsCheckAllowed,
      preparedNotAuthorizing,settingsSaveDenied,
      partialRouteRejected,malformedRouteRejected,walLocated,
      structuralWalRejected:structure.observation==="manual-recovery-required"
        && structure.walAuthenticated===false
        && structure.completeRecoveryProven===false
        && structure.resumeSyncAuthorized===false
        && structure.localCutoverAuthorized===false,
      completeRecoveryRejected:complete===null,
      bytesUnchanged:unchanged,noUnexpectedWalFile,
      nativeHostAdapterUsed:true,
      walCryptographicallyAuthenticated:false,
      remoteGitHubUsed:false
    };
  } finally {
    plugin.settings.githubOwner=savedOwner;
    plugin.settings.githubRepo=savedRepo;
  }
})()`, 30000)
  for (const key of [
    "noRouteWasInactive", "unfencedSettingsCheckAllowed",
    "preparedNotAuthorizing", "settingsSaveDenied",
    "partialRouteRejected", "malformedRouteRejected", "walLocated",
    "structuralWalRejected", "completeRecoveryRejected",
    "bytesUnchanged", "noUnexpectedWalFile", "nativeHostAdapterUsed",
  ]) {
    assert.equal(nativeDiskEvidence[key], true,
      "Real Obsidian synthetic physical fence/WAL check failed: " + key)
  }
  assert.equal(nativeDiskEvidence.walCryptographicallyAuthenticated, false)
  assert.equal(nativeDiskEvidence.remoteGitHubUsed, false)
  // Reload the actual installed plugin against the same persisted malformed
  // route/WAL bytes. This is a plugin lifecycle restart, NOT an OS power cut
  // or a fresh Obsidian process boot, and never proves cryptographic success.
  nativePhase = "first plugin reload"
  nativeReloadEvidence = await evaluate(`(async()=>{
  const id=${JSON.stringify(pluginId)};
  const first=app.plugins.plugins[id];
  if(!first)throw Error("Initial isolated plugin Runtime missing");
  const adapter=app.vault.adapter;
  const root=".obsidian/plugins/"+id;
  const pathFence=root+"/github-sync-v4-rekey-sync-fence/active.json";
  const pathRoute=root+"/github-sync-v4-rekey-runtime-route/intent.json";
  const runId="D284SyntheticRun2026";
  const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(runId));
  const sha=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,"0")).join("");
  const walRoot=root+"/reencryption-wal/"+sha;
  const paths=[pathFence,pathRoute,walRoot+"/slot-0.json",walRoot+"/slot-1.json"];
  const before=await Promise.all(paths.map(x=>adapter.read(x)));
  const unchanged=async()=>{
    const after=await Promise.all(paths.map(x=>adapter.read(x)));
    return after.every((text,i)=>text===before[i]);
  };
  await app.plugins.unloadPlugin(id);
  const removed=!app.plugins.plugins[id];
  await app.plugins.loadPlugin(id);
  const next=app.plugins.plugins[id];
  if(!next)throw Error("Isolated plugin failed to reload");
  const fresh=next!==first&&next.v4Runtime!==first.v4Runtime;
  const credentialsStayedAbsent=!next.settings.githubToken
    && !next.settings.githubOwner&&!next.settings.githubRepo;
  const route=await next.v4Runtime.inspectFencedReencryptionIndexRoute();
  const routeRefused=route.observation==="manual-recovery-required"
    && route.routingHintAuthenticated===false
    && route.localCutoverAuthorized===false
    && route.resumeSyncAuthorized===false;
  let settingsSaveDenied=false;
  try{await next.v4Runtime.assertReencryptionSettingsSaveAllowed()}
  catch{settingsSaveDenied=true}
  const dataPath=root+"/data.json";
  const readData=async()=>await adapter.exists(dataPath)
    ? await adapter.read(dataPath) : null;
  const dataBefore=await readData();
  const activeSettings=next.settings;
  const formerConfig=next.settings.syncObsidianConfig;
  let realSettingsSaveDenied=false;
  try {
    await next.saveSettings({...next.settings,syncObsidianConfig:!formerConfig});
  } catch {
    realSettingsSaveDenied=true;
  }
  const actualSettingsUnchanged=next.settings===activeSettings
    && next.settings.syncObsidianConfig===formerConfig
    && !next.isSettingsSaveInProgress?.();
  const persistedDataUnchanged=(await readData())===dataBefore;
  const structure=await next.v4Runtime.inspectFencedReencryptionExistingWalStructure();
  const walRefused=structure.observation==="manual-recovery-required"
    && structure.walAuthenticated===false
    && structure.completeRecoveryProven===false;
  const complete=await next.v4Runtime.inspectFencedReencryptionCompleteRecovery();
  const noRecovery=complete===null;
  const diskPreserved=await unchanged();
  return {
    unloaded:removed,freshRuntime:fresh,credentialsStayedAbsent,
    routeRefused,settingsSaveDenied,realSettingsSaveDenied,
    actualSettingsUnchanged,persistedDataUnchanged,
    walRefused,noRecovery,diskPreserved,
    userVaultUsed:false,realProcessRestart:false,remoteGitHubUsed:false,
    cryptoSuccessProven:false
  };
})()`, 40000)
  for (const key of [
    "unloaded", "freshRuntime", "credentialsStayedAbsent", "routeRefused",
    "settingsSaveDenied", "realSettingsSaveDenied",
    "actualSettingsUnchanged", "persistedDataUnchanged",
    "walRefused", "noRecovery", "diskPreserved",
  ]) {
    assert.equal(nativeReloadEvidence[key], true,
      "Real Obsidian plugin reload must fail closed: " + key)
  }
  assert.equal(nativeReloadEvidence.realProcessRestart, false)
  assert.equal(nativeReloadEvidence.remoteGitHubUsed, false)
  assert.equal(nativeReloadEvidence.cryptoSuccessProven, false)
  // Compare the *persisted* plugin Settings digest across the actual process
  // restart; no secrets or raw settings are exported to this test runner.
  nativeSettingsDigestBeforeRestart = await evaluate(`(async()=>{
    const path=".obsidian/plugins/"+${JSON.stringify(pluginId)}+"/data.json";
    const adapter=app.vault.adapter;
    if(!await adapter.exists(path))return "absent";
    const raw=await adapter.read(path);
    const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(raw));
    return Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,"0")).join("");
  })()`)
  // A real process-level restart, NOT a physical power interruption.
  await restartIsolatedProcess(profile, vault)
  nativePhase = "first process restart validation"
  nativeRestartEvidence = await evaluate(`(async()=>{
  const id=${JSON.stringify(pluginId)};
  const plugin=app.plugins.plugins[id];
  if(!plugin)throw Error("Fresh Obsidian process did not load synthetic plugin");
  if(plugin.settings.githubToken||plugin.settings.githubOwner||plugin.settings.githubRepo)
    throw Error("Unexpected persistent credentials in synthetic vault");
  const root=".obsidian/plugins/"+id;
  const adapter=app.vault.adapter;
  const settingsPath=root+"/data.json";
  let pluginDataDigest="absent";
  if(await adapter.exists(settingsPath)){
    const settingsText=await adapter.read(settingsPath);
    const settingsHash=await crypto.subtle.digest("SHA-256",
      new TextEncoder().encode(settingsText));
    pluginDataDigest=Array.from(new Uint8Array(settingsHash),
      b=>b.toString(16).padStart(2,"0")).join("");
  }
  const fenceRoot=root+"/github-sync-v4-rekey-sync-fence";
  const routeRoot=root+"/github-sync-v4-rekey-runtime-route";
  const runId="D284SyntheticRun2026";
  const hashed=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(runId));
  const hash=Array.from(new Uint8Array(hashed),b=>b.toString(16).padStart(2,"0")).join("");
  const walRoot=root+"/reencryption-wal/"+hash;
  const expectedFence=JSON.stringify({
    schemaVersion:1,phase:"migration-fenced-uncommitted",runId,
    sourceRepoId:"synthetic-offline-owner/synthetic-offline-repo#source",
    destinationRepoId:"synthetic-offline-owner/synthetic-offline-repo#destination"
  });
  const expectedRoute='{"schemaVersion":1,"phase":"synthetic-not-trusted","mac":"bad"}';
  const expectedSlots=[
    '{"schemaVersion":999,"synthetic":"not authenticated","slot":0}',
    '{"schemaVersion":999,"synthetic":"not authenticated","slot":1}'
  ];
  const pathSlot0=walRoot+"/slot-0.json";
  const pathSlot1=walRoot+"/slot-1.json";
  const diskPreserved=(await adapter.read(fenceRoot+"/active.json"))===expectedFence
    && (await adapter.read(routeRoot+"/intent.json"))===expectedRoute
    && (await adapter.read(pathSlot0))===expectedSlots[0]
    && (await adapter.read(pathSlot1))===expectedSlots[1];
  const route=await plugin.v4Runtime.inspectFencedReencryptionIndexRoute();
  const routeRefused=route.observation==="manual-recovery-required"
    && route.resumeSyncAuthorized===false&&route.remoteWritesAuthorized===false;
  let settingsSaveDenied=false;
  try{await plugin.v4Runtime.assertReencryptionSettingsSaveAllowed()}
  catch{settingsSaveDenied=true}
  const structure=await plugin.v4Runtime.inspectFencedReencryptionExistingWalStructure();
  const structuralWalRefused=structure.observation==="manual-recovery-required"
    && structure.walAuthenticated===false;
  const complete=await plugin.v4Runtime.inspectFencedReencryptionCompleteRecovery();
  return {
    installedPluginLoaded:true,syntheticVaultCredentialsAbsent:true,diskPreserved,
    pluginDataDigest,routeRefused,settingsSaveDenied,structuralWalRefused,
    completeRefused:complete===null,
    cryptoSuccessProven:false,remoteGitHubUsed:false,powerLossProven:false
  };
})()`, 35000)
  for (const key of [
    "installedPluginLoaded", "syntheticVaultCredentialsAbsent", "diskPreserved",
    "routeRefused", "settingsSaveDenied", "structuralWalRefused", "completeRefused",
  ]) {
    assert.equal(nativeRestartEvidence[key], true,
      "Fresh Obsidian process must preserve a fenced Manual Recovery: " + key)
  }
  assert.equal(nativeRestartEvidence.pluginDataDigest, nativeSettingsDigestBeforeRestart,
    "Persisted plugin Settings must not change during fenced Obsidian process restart")
  assert.equal(nativeRestartEvidence.cryptoSuccessProven, false)
  assert.equal(nativeRestartEvidence.remoteGitHubUsed, false)
  assert.equal(nativeRestartEvidence.powerLossProven, false)
  nativePhase = "authenticated WAL after real process restart"
  await installNativeWalProof()
  nativeAuthenticatedWalRestart = await verifyNativeWalProof(nativeAuthenticatedWalContract)
  // Simulate ONLY a missing primary fence in the verified disposable Vault,
  // while preserving the orphan runtime-route marker and WAL slots. Persist
  // one fake legacy passphrase to prove startup does NOT migrate SecretStorage.
  nativePhase = "orphan-route fixture preparation"
  const orphanPrepared = await evaluate(`(async()=>{
  let step="check plugin";
  try {
  const id=${JSON.stringify(pluginId)};
  const plugin=app.plugins.plugins[id];
  if(!plugin || plugin.settings.githubToken || plugin.settings.githubOwner
    || plugin.settings.githubRepo)throw Error("Orphan route test requires isolated no-token plugin");
  const adapter=app.vault.adapter;
  const root=".obsidian/plugins/"+id;
  const fenceRoot=root+"/github-sync-v4-rekey-sync-fence";
  const routeRoot=root+"/github-sync-v4-rekey-runtime-route";
  step="check existing physical markers";
  if(!await adapter.exists(fenceRoot)
    || !await adapter.exists(routeRoot)
    || !await adapter.exists(routeRoot+"/intent.json"))
      throw Error("Orphan route fixture missing its original fence or route");
  step="check secret storage";
  const secretId="d286-disposable-orphan-route-passphrase";
  if(app.secretStorage.getSecret(secretId)!=null)
    throw Error("Orphan route test secret ID already exists");
  const legacy={
    settings:{
      encryptionMode:"encrypted",
      encryptionPassphraseSecretId:secretId,
      encryptionPassphrase:"D286-isolated-fixture-only-no-user-key",
      githubOwner:"",githubRepo:"",githubToken:""
    }
  };
  const legacyData=JSON.stringify(legacy);
  step="write disposable legacy data";
  await adapter.write(root+"/data.json",legacyData);
  step="remove disposable fence active marker";
  await adapter.remove(fenceRoot+"/active.json");
  step="remove disposable fence directory";
  if(await adapter.exists(fenceRoot))await adapter.rmdir(fenceRoot,true);
  step="verify orphan route readback";
  const routePreserved=await adapter.exists(routeRoot)
    && await adapter.exists(routeRoot+"/intent.json");
  const fenceAbsent=!(await adapter.exists(fenceRoot));
  return {routePreserved,fenceAbsent,legacyDataPreserved:
    await adapter.read(root+"/data.json")===legacyData};
  } catch (error) {
    return {prepErrorAt:step,prepErrorClass:error?.name??"unknown"};
  }
})()`, 35000)
  assert.equal(orphanPrepared.prepErrorAt, undefined,
    "Native orphan setup raised at " + String(orphanPrepared.prepErrorAt)
      + " (" + String(orphanPrepared.prepErrorClass) + ")")
  for (const key of ["routePreserved", "fenceAbsent", "legacyDataPreserved"]) {
    assert.equal(orphanPrepared[key], true, "Synthetic orphan-route setup failed: " + key)
  }
  nativePhase = "orphan-route process restart"
  await restartIsolatedProcess(profile, vault)
  nativePhase = "orphan-route process verification"
  nativeOrphanEvidence = await evaluate(`(async()=>{
  const id=${JSON.stringify(pluginId)};
  const plugin=app.plugins.plugins[id];
  if(!plugin)throw Error("Orphan route process restart did not reload plugin");
  const adapter=app.vault.adapter;
  const root=".obsidian/plugins/"+id;
  const routeRoot=root+"/github-sync-v4-rekey-runtime-route";
  const fenceRoot=root+"/github-sync-v4-rekey-sync-fence";
  const secretId="d286-disposable-orphan-route-passphrase";
  const legacyData=JSON.stringify({
    settings:{
      encryptionMode:"encrypted",
      encryptionPassphraseSecretId:secretId,
      encryptionPassphrase:"D286-isolated-fixture-only-no-user-key",
      githubOwner:"",githubRepo:"",githubToken:""
    }
  });
  const routeSurvived=await adapter.exists(routeRoot)
    && await adapter.exists(routeRoot+"/intent.json")
    && !await adapter.exists(fenceRoot);
  const legacyDataUnchanged=(await adapter.read(root+"/data.json"))===legacyData;
  const secretNeverMigrated=app.secretStorage.getSecret(secretId)==null;
  const idPreserved=plugin.settings.encryptionPassphraseSecretId===secretId;
  const idleAndNoGitHub=!plugin.settings.githubToken&&!plugin.settings.githubOwner
    && !plugin.settings.githubRepo;
  const report=await plugin.v4Runtime.inspectFencedReencryptionIndexRoute();
  const manualRecovery=report.observation==="manual-recovery-required"
    && report.resumeSyncAuthorized===false
    && report.localCutoverAuthorized===false
    && report.remoteWritesAuthorized===false;
  let settingsGuardDenied=false;
  try{await plugin.v4Runtime.assertReencryptionSettingsSaveAllowed()}
  catch{settingsGuardDenied=true}
  let nativeSaveDenied=false;
  const originalSettings=plugin.settings;
  try{await plugin.saveSettings({...plugin.settings,newVaultKdfIterations:700000})}
  catch{nativeSaveDenied=true}
  const memorySettingsUnchanged=plugin.settings===originalSettings;
  const dataAfterSaveUnchanged=(await adapter.read(root+"/data.json"))===legacyData;
  const secretStillAbsent=app.secretStorage.getSecret(secretId)==null;
  const complete=await plugin.v4Runtime.inspectFencedReencryptionCompleteRecovery();
  return {routeSurvived,legacyDataUnchanged,secretNeverMigrated,
    idPreserved,idleAndNoGitHub,manualRecovery,settingsGuardDenied,
    nativeSaveDenied,memorySettingsUnchanged,dataAfterSaveUnchanged,
    secretStillAbsent,completeRecoveryRefused:complete===null,
    cryptoSuccessProven:false,remoteGitHubUsed:false,powerLossProven:false};
})()`, 35000)
  for (const key of [
    "routeSurvived", "legacyDataUnchanged", "secretNeverMigrated",
    "idPreserved", "idleAndNoGitHub", "manualRecovery", "settingsGuardDenied",
    "nativeSaveDenied", "memorySettingsUnchanged", "dataAfterSaveUnchanged",
    "secretStillAbsent", "completeRecoveryRefused",
  ]) {
    assert.equal(nativeOrphanEvidence[key], true,
      "Orphan route must fail closed after native process restart: " + key)
  }
  assert.equal(nativeOrphanEvidence.cryptoSuccessProven, false)
  assert.equal(nativeOrphanEvidence.remoteGitHubUsed, false)
  assert.equal(nativeOrphanEvidence.powerLossProven, false)
  nativePhase = "authenticated WAL after orphan-route process restart"
  await installNativeWalProof()
  nativeAuthenticatedWalOrphanRestart = await verifyNativeWalProof(nativeAuthenticatedWalContract)
  nativeResult = await evaluate("(async()=>{"
    + "const id=" + JSON.stringify(pluginId) + ";"
    + "const commandId=" + JSON.stringify(commandId) + ";"
    + "const plugin=app.plugins.plugins[id];"
    + "const safe=!plugin.settings.githubToken&&!plugin.settings.githubOwner&&!plugin.settings.githubRepo;"
    + "if(!safe)throw Error('Synthetic vault unexpectedly has credentials');"
    + "const available=!!app.commands.commands[commandId];"
    + "if(!available)return {available:false,configured:false};"
    + "const runtime=plugin.v4Runtime;"
    + "let completeReads=0,syncStarts=0;"
    + "const complete=runtime.inspectFencedReencryptionCompleteRecovery;"
    + "runtime.inspectFencedReencryptionCompleteRecovery=async function(){"
    + "completeReads++;return complete.call(runtime)};"
    + "for(const method of ['manualSync','startupSync','scheduledSync','forcePush','forcePull']){"
    + "const original=runtime[method];"
    + "runtime[method]=function(...args){syncStarts++;return original.apply(this,args)}}"
    + "app.commands.executeCommandById(commandId);"
    + "await new Promise(resolve=>setTimeout(resolve,800));"
    + "const notices=[...document.querySelectorAll('.notice')].map(el=>el.textContent||'');"
    + "let overlappingReads=0,release;"
    + "runtime.inspectFencedReencryptionCompleteRecovery=()=>{"
    + "overlappingReads++;return new Promise(resolve=>{release=resolve})};"
    + "app.commands.executeCommandById(commandId);"
    + "app.commands.executeCommandById(commandId);"
    + "await new Promise(resolve=>setTimeout(resolve,50));"
    + "const duplicateCalls=overlappingReads;"
    + "if(release)release(null);"
    + "await new Promise(resolve=>setTimeout(resolve,150));"
    + "plugin.openReencryptionWizard();"
    + "await new Promise(resolve=>setTimeout(resolve,150));"
    + "const modal=[...document.querySelectorAll('.modal')].find(el=>"
    + "(el.textContent||'').includes('Development preview')&&"
    + "(el.textContent||'').includes('Preflight & snapshot'));"
    + "const modalText=modal?.textContent||'';"
    + "const wizardPreviewBlocked=!!modal&&"
    + "modalText.includes('production safety gates pass')&&"
    + "modalText.includes('Preview')&&"
    + "modalText.includes('No backup or destination branch will be created');"
    + "const wizardNoExecute=!!modal&&!['Execute','Cutover','Publish now'].some(label=>"
    + "[...modal.querySelectorAll('button')].some(button=>button.textContent?.trim()===label));"
    + "const close=[...(modal?.querySelectorAll('button')||[])].find(button=>button.textContent?.trim()==='Close');"
    + "close?.click();"
    + "return {available,configured:false,completeReads,syncStarts,duplicateCalls,"
    + "manualRecoveryNotice:notices.some(text=>text.includes('Manual Recovery')),"
    + "wizardPreviewBlocked,wizardNoExecute,noticeCount:notices.length}})()", 30000)
  // UI-only synthetic result injection; native Obsidian and Notices are real.
  // This does NOT prove installed encrypted WAL or cryptographic authenticity.
  nativeOutcomes = await evaluate(`(async()=>{
    const plugin=app.plugins.plugins[${JSON.stringify(pluginId)}];
    const commandId=${JSON.stringify(commandId)};
    const runtime=plugin.v4Runtime;
    const callback=app.commands.commands[commandId]?.callback;
    if(!callback)throw Error("Native Recovery command callback missing");
    const valid={
      observation:"authenticated-complete-recovery-evidence-still-fenced",
      integrityScope:"read-only-original-backup-encrypted-wal-complete-destination",
      powerLossDurabilityProven:false,
      mobileOsLockProven:false,
      installedObsidianAcceptanceProven:false,
      commitDecisionAuthorized:false,
      rollbackAuthorized:false,
      oldPassphraseCleanupAuthorized:false,
      originalKeyAuthenticated:true,
      completeOldBackupReverified:true,
      walReceiptsBoundToDestination:true,
      completeDestinationContentsReverified:true,
      localCutoverAuthorized:false,
      resumeSyncAuthorized:false,
      remoteWritesAuthorized:false,
    };
    const noticeTexts=()=>[...document.querySelectorAll(".notice")]
      .map(node=>node.textContent||"");
    const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    const run=async(result)=>{
      const before=new Set(document.querySelectorAll(".notice"));
      runtime.inspectFencedReencryptionCompleteRecovery=async()=>result;
      callback();
      await sleep(180);
      return [...document.querySelectorAll(".notice")]
        .filter(node=>!before.has(node)).map(node=>node.textContent||"");
    };
    const watched=["manualSync","startupSync","scheduledSync","forcePush","forcePull"];
    let syncStarts=0;
    for(const name of watched){
      const previous=runtime[name];
      runtime[name]=function(...args){
        syncStarts++;
        return previous.apply(this,args);
      };
    }
    const desktop=await run({...valid,isolation:"desktop-os-cooperative-wal-lock"});
    const mobile=await run({...valid,isolation:"mobile-cooperative-best-effort-only"});
    const invalidIsolation=await run({...valid,isolation:"unknown-lock"});
    const contradictoryAuthority=await run({...valid,remoteWritesAuthorized:true});
    const incomplete=await run({...valid,walReceiptsBoundToDestination:false});
    runtime.inspectFencedReencryptionCompleteRecovery=async()=>{
      throw Error("synthetic-sensitive-token-never-display");
    };
    const beforeUnavailable=new Set(document.querySelectorAll(".notice"));
    callback();
    await sleep(180);
    const unavailable=[...document.querySelectorAll(".notice")]
      .filter(node=>!beforeUnavailable.has(node)).map(node=>node.textContent||"");
    let finish;
    let invocations=0;
    runtime.inspectFencedReencryptionCompleteRecovery=()=>{
      invocations++;
      return new Promise(resolve=>{finish=resolve});
    };
    callback();
    await sleep(70);
    const successesBeforeUnload=noticeTexts().filter(
      message=>message.includes("read-only Desktop scan")).length;
    plugin.onunload();
    if(finish)finish({...valid,isolation:"desktop-os-cooperative-wal-lock"});
    await sleep(120);
    const successesAfterUnload=noticeTexts().filter(
      message=>message.includes("read-only Desktop scan")).length;
    const noticesBeforeStaleCall=noticeTexts().length;
    callback();
    await sleep(60);
    return {
      desktopVerifiedNotice:desktop.some(message=>
        message.includes("read-only Desktop scan") &&
        message.includes("not authorized")),
      mobileBestEffortNotice:mobile.some(message=>
        message.includes("read-only Mobile scan") &&
        message.includes("no OS lock or power-loss durability is proven")),
      incompleteManualRecoveryNotice:incomplete.some(message=>
        message.includes("could not be independently verified") &&
        message.includes("Manual Recovery")),
      invalidIsolationRefused:invalidIsolation.some(message=>
        message.includes("could not be independently verified")),
      contradictoryAuthorityRefused:contradictoryAuthority.some(message=>
        message.includes("could not be independently verified")),
      unavailableSanitizedNotice:unavailable.some(message=>
        message.includes("Read-only Complete Recovery check unavailable")),
      secretNotRendered:unavailable.every(message=>
        !message.includes("synthetic-sensitive-token-never-display")),
      staleSuccessSuppressed:successesAfterUnload===successesBeforeUnload,
      staleInvocationSuppressed:invocations===1,
      staleNoticeSuppressed:noticeTexts().length===noticesBeforeStaleCall,
      syncStarts,
    };
  })()`, 30000)
  assert.equal(nativeOutcomes.desktopVerifiedNotice, true,
    "Native verified Desktop UI must warn that Cutover and Sync are unauthorized")
  assert.equal(nativeOutcomes.mobileBestEffortNotice, true,
    "Native verified Mobile UI must disclose missing OS lock and durability proof")
  assert.equal(nativeOutcomes.incompleteManualRecoveryNotice, true,
    "Native incomplete Recovery cannot be displayed as verified")
  assert.equal(nativeOutcomes.invalidIsolationRefused, true,
    "Native Recovery must refuse an unknown WAL isolation claim")
  assert.equal(nativeOutcomes.contradictoryAuthorityRefused, true,
    "Native Recovery must refuse a report claiming unauthorized remote writes")
  assert.equal(nativeOutcomes.unavailableSanitizedNotice, true,
    "Native failed Recovery must display a safe unavailable message")
  assert.equal(nativeOutcomes.secretNotRendered, true,
    "Native Recovery must not surface raw exception details")
  assert.equal(nativeOutcomes.staleSuccessSuppressed, true,
    "A pending native Recovery result must be discarded after unload")
  assert.equal(nativeOutcomes.staleInvocationSuppressed, true,
    "Stored native Command callback must not invoke Runtime after unload")
  assert.equal(nativeOutcomes.staleNoticeSuppressed, true,
    "Stored native Command callback must not emit Notice after unload")
  assert.equal(nativeOutcomes.syncStarts, 0,
    "Native mocked Recovery outcomes must not trigger Sync")
  assert.equal(nativeResult.available, true, "Command Palette entry missing")
  assert.equal(nativeResult.completeReads, 1, "Real Command must invoke one Recovery diagnostic")
  assert.equal(nativeResult.duplicateCalls, 1, "Native Command must coalesce rapid duplicate invocations")
  assert.equal(nativeResult.syncStarts, 0, "Recovery Command must not start Sync or Force actions")
  assert.equal(nativeResult.manualRecoveryNotice, true,
    "Missing or unconfigured Recovery evidence must show Manual Recovery")
  assert.equal(nativeResult.wizardPreviewBlocked, true,
    "Native Re-encryption Wizard must show Preview-only and blocked publication")
  assert.equal(nativeResult.wizardNoExecute, true,
    "Native Re-encryption Preview cannot expose executable publication or cutover actions")
  passed = true
} catch (error) {
  console.error("OBSIDIAN_READONLY_RECOVERY_UI_SMOKE_FAILED: "
    + String(error?.message ?? error).slice(0,230))
  process.exitCode = 1
} finally {
  try { ws?.close() } catch {}
  if (child?.pid) {
    const stopped = spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"],
      { encoding: "utf8", timeout: 15000 })
    if (stopped.status !== 0) {
      cleanup = "process-termination-unconfirmed"
      process.exitCode = 1
    }
  }
  if (runRoot && cleanup !== "process-termination-unconfirmed") {
    for (let attempt = 0; attempt < 24; attempt++) {
      try {
        await rm(runRoot, { recursive: true, force: true, maxRetries: 2, retryDelay: 200 })
        cleanup = "temporary-vault-removed"
        break
      } catch (error) {
        if (attempt === 23) {
          cleanup = "temporary-vault-removal-failed-" + String(error?.code ?? "unknown")
          process.exitCode = 1
        } else {
          await sleep(400)
        }
      }
    }
  }
  console.log(JSON.stringify({
    status: passed && !process.exitCode ? "PASS" : "FAIL",
    nativeWindowsCommandAvailable: nativeResult?.available ?? false,
    diagnosticRuns: nativeResult?.completeReads ?? 0,
    duplicateNativeInvocations: nativeResult?.duplicateCalls ?? 0,
    syncStarts: nativeResult?.syncStarts ?? 0,
    manualRecoveryNotice: nativeResult?.manualRecoveryNotice ?? false,
    nativePhysicalFenceAndInvalidRouteFailClosed: nativeDiskEvidence?.structuralWalRejected === true
      && nativeDiskEvidence?.completeRecoveryRejected === true
      && nativeDiskEvidence?.settingsSaveDenied === true,
    nativePhysicalWalBytesPreserved: nativeDiskEvidence?.bytesUnchanged ?? false,
    nativeReloadFencedRecoveryRefused: nativeReloadEvidence?.routeRefused === true
      && nativeReloadEvidence?.settingsSaveDenied === true
      && nativeReloadEvidence?.walRefused === true
      && nativeReloadEvidence?.noRecovery === true,
    nativeReloadPhysicalBytesPreserved: nativeReloadEvidence?.diskPreserved ?? false,
    nativeProcessRestartFencedRecoveryRefused: nativeRestartEvidence?.routeRefused === true
      && nativeRestartEvidence?.settingsSaveDenied === true
      && nativeRestartEvidence?.structuralWalRefused === true
      && nativeRestartEvidence?.completeRefused === true,
    nativeProcessRestartWalBytesPreserved: nativeRestartEvidence?.diskPreserved ?? false,
    nativeProcessRestartSettingsPreserved: nativeRestartEvidence?.pluginDataDigest ===
      nativeSettingsDigestBeforeRestart,
    nativeOrphanRouteRestartFailClosed: nativeOrphanEvidence?.manualRecovery === true
      && nativeOrphanEvidence?.completeRecoveryRefused === true
      && nativeOrphanEvidence?.nativeSaveDenied === true,
    nativeDesktopOsLockCrossProcess: nativeOsLockProof?.firstProcessHeldOSLock === true
      && nativeOsLockProof?.secondProcessBlocked === true
      && nativeOsLockProof?.releasedAndReopened === true
      && nativeOsLockProof?.encryptedSlotsPreserved === true,
    nativeAuthenticatedWalCryptoReadback: nativeAuthenticatedWalEvidence?.authenticatedTwoSlots === true
      && nativeAuthenticatedWalEvidence?.wrongKeyRejected === true
      && nativeAuthenticatedWalEvidence?.tamperedCiphertextWithRehashedHeaderRejected === true,
    nativeAuthenticatedWalSurvivedProcessRestart: nativeAuthenticatedWalRestart?.authenticated === true
      && nativeAuthenticatedWalRestart?.readOnly === true,
    nativeAuthenticatedWalSurvivedOrphanRestart: nativeAuthenticatedWalOrphanRestart?.authenticated === true
      && nativeAuthenticatedWalOrphanRestart?.readOnly === true,
    nativeOrphanRouteSecretsUnchanged: nativeOrphanEvidence?.secretNeverMigrated === true
      && nativeOrphanEvidence?.secretStillAbsent === true
      && nativeOrphanEvidence?.legacyDataUnchanged === true,
    nativeFencedSaveSettingsRejected: nativeReloadEvidence?.realSettingsSaveDenied === true
      && nativeReloadEvidence?.actualSettingsUnchanged === true
      && nativeReloadEvidence?.persistedDataUnchanged === true,
    mockedDesktopVerifiedNotice: nativeOutcomes?.desktopVerifiedNotice ?? false,
    mockedMobileBestEffortNotice: nativeOutcomes?.mobileBestEffortNotice ?? false,
    mockedIncompleteManualRecoveryNotice: nativeOutcomes?.incompleteManualRecoveryNotice ?? false,
    mockedInvalidIsolationRefused: nativeOutcomes?.invalidIsolationRefused ?? false,
    mockedContradictoryAuthorityRefused: nativeOutcomes?.contradictoryAuthorityRefused ?? false,
    mockedErrorSanitized: nativeOutcomes?.secretNotRendered ?? false,
    mockedStaleResultSuppressed: nativeOutcomes?.staleSuccessSuppressed ?? false,
    mockedUnloadCallbackBlocked: nativeOutcomes?.staleInvocationSuppressed ?? false,
    mockedSyncStarts: nativeOutcomes?.syncStarts ?? -1,
    wizardPreviewBlocked: nativeResult?.wizardPreviewBlocked ?? false,
    wizardNoExecute: nativeResult?.wizardNoExecute ?? false,
    cleanup,
    remoteGitHubUsed: false,
    installedEncryptedWalProven: false,
  }))
}
