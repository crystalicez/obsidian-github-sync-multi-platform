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
      // D478: the installed ribbon must not advertise a usable Sync before setup.
      const ribbonReadiness=()=>plugin.ribbonIcon?.getAttribute("aria-label")||"";
      if(!ribbonReadiness().includes("(Not Configured)")){
        step="native-unconfigured-ribbon-incorrect";
        throw Error("Ribbon claimed readiness without a GitHub configuration");
      }
      // D479: Do not construct a credentialed client for a stale, partial
      // saved configuration. These ephemeral values are never persisted or sent.
      step="reject-incomplete-native-github-client";
      const savedSettingsRef=plugin.settings;
      try {
        const fake={githubOwner:"synthetic-owner",githubRepo:"synthetic-repo",githubToken:"offline-only-fake"};
        for(const patch of [
          {...fake,githubBranch:""},
          {...fake,githubBranch:"main",vault:" "},
          {...fake,githubBranch:"main",encryptionMode:"encrypted",encryptionPassphrase:""},
        ]){
          plugin.settings={...savedSettingsRef,...patch};
          plugin.initGitHubClient();
          if(plugin.githubClient)throw Error("Incomplete Settings unexpectedly constructed a GitHub client");
        }
      } finally {
        plugin.settings=savedSettingsRef;
        plugin.initGitHubClient();
      }
      if(plugin.githubClient)throw Error("Incomplete test left an unexpected GitHub client");
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
      // D480: test the actual installed History view with synthetic *in-memory*
      // saved settings. Its message must name the missing field, not any secret.
      step="native-history-missing-field-guidance";
      const installedHistory=app.workspace.getLeavesOfType("github-sync-v4-center")[0]?.view;
      if(typeof installedHistory?.onSettingsSaved!=="function")
        throw Error("Installed Sync Center History refresh unavailable");
      const originalHistorySettings=plugin.settings;
      try {
        for(const scenario of [
          {patch:{githubBranch:""},field:"GitHub branch"},
          {patch:{vault:"  "},field:"Device ID"},
          {patch:{encryptionMode:"encrypted",encryptionPassphrase:""},field:"encryption passphrase"},
        ]){
          plugin.settings={...originalHistorySettings,
            githubOwner:"offline-test-owner",githubRepo:"offline-test-repo",
            githubToken:"offline-test-secret-never-render",githubBranch:"main",
            ...scenario.patch};
          installedHistory.onSettingsSaved();
          const guidance=installedHistory.contentEl.textContent||"";
          if(!guidance.includes("GitHub Sync is not configured")
            ||!guidance.includes(scenario.field)
            ||guidance.includes("offline-test-secret-never-render"))
            throw Error("Installed History missing-field guidance was inaccurate or unsafe");
        }
      } finally {
        plugin.settings=originalHistorySettings;
        installedHistory.onSettingsSaved();
      }
      if(plugin.githubClient)throw Error("History guidance unexpectedly created GitHub client");
      step="unconfigured-sync";
      if(plugin.githubClient)throw Error("Unexpected GitHub client on fresh installation");
      const syncButton=[...view.querySelectorAll("button")]
        .find(button=>button.textContent.trim()==="Sync now");
      const before=plugin.v4Runtime.progressSnapshot;
      const generation=plugin.v4Runtime.coordinator.syncExecutionGeneration;
      syncButton.click();
      // D472 first-use guard refuses the action before Runtime and shows
      // specific guidance; entering a failed Sync would spuriously pause auto.
      await new Promise(resolve=>setTimeout(resolve,180));
      const result=plugin.v4Runtime.progressSnapshot;
      if(result.lifecycle!==before.lifecycle
        ||plugin.v4Runtime.coordinator.syncExecutionGeneration!==generation
        ||plugin.githubClient){
        step="unconfigured-sync-started-runtime";
        throw Error("No-token Sync unexpectedly started Runtime");
      }
      const notices=[...document.querySelectorAll(".notice")]
        .map(node=>node.textContent||"");
      if(!notices.some(message=>message.includes("Configure GitHub owner")
        &&message.includes("GitHub repository")
        &&message.includes("GitHub token")
        &&message.includes("Save changes"))){
        step="unconfigured-sync-guidance-unavailable";
        throw Error("No-token Sync did not show missing-field guidance");
      }
      step="open-native-settings-tab";
      const host=app.setting;
      if(!host||typeof host.open!=="function"||typeof host.openTabById!=="function")
        throw Error("Obsidian native Settings host unavailable");
      host.open();
      host.openTabById(${JSON.stringify(pluginId)});
      const tab=plugin.settingTab;
      const rowForDevice=()=>[...tab.containerEl.querySelectorAll(".setting-item")]
        .find(row=>row.querySelector(".setting-item-name")?.textContent?.trim()
          ==="Device ID (this Obsidian vault)");
      const editStart=Date.now();
      while((!tab.containerEl.isConnected||!rowForDevice())
        &&Date.now()-editStart<9000)
        await new Promise(resolve=>setTimeout(resolve,120));
      const deviceInput=rowForDevice()?.querySelector("input");
      if(!tab.containerEl.isConnected||!deviceInput)
        throw Error("Native Settings Device ID input unavailable");
      const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")?.set;
      if(!setter)throw Error("Native input property missing");
      // D449: Prove that invalid Git ref input never reaches the settings
      // persistence API, then a corrected edit saves using the real UI.
      step="reject-invalid-native-github-branch";
      const branchRow=[...tab.containerEl.querySelectorAll(".setting-item")]
        .find(row=>row.querySelector(".setting-item-name")?.textContent?.trim()==="GitHub branch");
      const branchInput=branchRow?.querySelector("input");
      if(!branchInput){step="native-branch-input-unavailable";throw Error("Native GitHub branch input unavailable");}
      setter.call(branchInput,"invalid..branch");
      branchInput.dispatchEvent(new Event("input",{bubbles:true}));
      if(tab.tempSettings.githubBranch!=="invalid..branch"){
        step="native-invalid-branch-input-not-applied";
        throw Error("Native invalid branch input event did not update draft");
      }
      const invalidSave=[...tab.containerEl.querySelectorAll("button")]
        .find(button=>button.textContent.trim()==="Save changes");
      if(!invalidSave||invalidSave.disabled){step="native-invalid-save-action-missing";throw Error("Native invalid Save action missing");}
      const originalSaveSettings=plugin.saveSettings.bind(plugin);
      let saveAttempts=0;
      plugin.saveSettings=async (...args)=>{
        saveAttempts++;
        return originalSaveSettings(...args);
      };
      invalidSave.click();
      await new Promise(resolve=>setTimeout(resolve,150));
      if(saveAttempts!==0){
        step="native-invalid-branch-invoked-persistence";
        throw Error("Invalid GitHub branch invoked Settings persistence");
      }
      if(plugin.settings.githubBranch!=="main"){step="native-invalid-branch-was-persisted";throw Error("Invalid branch published");}
      if(!tab.isDirty()){step="native-invalid-branch-draft-discarded";throw Error("Invalid branch draft lost");}
      if(tab.tempSettings.githubBranch!=="invalid..branch"){step="native-invalid-branch-draft-mutated";throw Error("Invalid branch value mutated");}
      // D476: a completely empty branch must be rejected by the installed
      // Settings Save UI, not silently interpreted as main by Runtime.
      step="reject-empty-native-github-branch";
      setter.call(branchInput,"");
      branchInput.dispatchEvent(new Event("input",{bubbles:true}));
      if(tab.tempSettings.githubBranch!==""){step="native-blank-branch-input-not-applied";throw Error("Native blank branch input event failed");}
      const blankSave=[...tab.containerEl.querySelectorAll("button")]
        .find(button=>button.textContent.trim()==="Save changes");
      if(!blankSave||blankSave.disabled){step="native-blank-branch-save-missing";throw Error("Native blank branch Save unavailable");}
      blankSave.click();
      await new Promise(resolve=>setTimeout(resolve,150));
      if(saveAttempts!==0){step="native-blank-branch-invoked-persistence";throw Error("Blank GitHub branch invoked Settings persistence");}
      if(plugin.settings.githubBranch!=="main"||!tab.isDirty()
        ||tab.tempSettings.githubBranch!==""){
        step="native-blank-branch-draft-or-saved-value-changed";
        throw Error("Blank branch Save changed saved settings or removed editable draft");
      }
      setter.call(branchInput,"main");
      branchInput.dispatchEvent(new Event("input",{bubbles:true}));
      step="edit-native-device-id";
      const newId="native-ui-"+originalId.slice(-12);
      setter.call(deviceInput,newId);
      deviceInput.dispatchEvent(new Event("input",{bubbles:true}));
      const saveStart=Date.now();
      let saveButton;
      while(!saveButton&&Date.now()-saveStart<6000){
        saveButton=[...tab.containerEl.querySelectorAll("button")]
          .find(button=>button.textContent.trim()==="Save changes");
        if(!saveButton)await new Promise(resolve=>setTimeout(resolve,100));
      }
      if(!tab.isDirty()||!saveButton||saveButton.disabled)
        throw Error("Edited Device ID did not expose Save changes");
      step="click-native-save-changes";
      saveButton.click();
      const savedStart=Date.now();
      while((plugin.settings.vault!==newId||tab.isDirty())
        &&Date.now()-savedStart<9000)
        await new Promise(resolve=>setTimeout(resolve,120));
      if(plugin.settings.vault!==newId||tab.isDirty())
        throw Error("Native UI Save did not persist Device ID");
      if(saveAttempts!==1)throw Error("Corrected native UI Save did not use persistence exactly once");
      plugin.saveSettings=originalSaveSettings;
      if(plugin.githubClient)throw Error("Native UI Save unexpectedly configured GitHub");
      if(!ribbonReadiness().includes("(Not Configured)")){
        step="native-save-unconfigured-ribbon-incorrect";
        throw Error("Ribbon claimed readiness after a partial Settings Save");
      }
      host.close();
      return {generatedDeviceId:originalId,newDeviceId:newId,persisted:true,syncCenterOpen:true,
        nativeSaveClicked:true,invalidBranchRejectedBeforeSave:true,emptyBranchRejectedBeforeSave:true,
        nativeUnconfiguredRibbonAccurate:true,nativeIncompleteClientRefused:true,
        nativeHistoryMissingFieldGuidance:true,noCredentialSyncRejected:true,
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
  assert.match(report?.generatedDeviceId ?? "", /^device-[a-f0-9]{32}$/u)
  assert.match(report?.newDeviceId ?? "", /^native-ui-[a-f0-9]{12}$/u)
  assert.equal(report.persisted, true)
  assert.equal(report.syncCenterOpen, true)
  assert.equal(report.nativeSaveClicked, true)
  assert.equal(report.invalidBranchRejectedBeforeSave, true)
  assert.equal(report.emptyBranchRejectedBeforeSave, true)
  assert.equal(report.noCredentialSyncRejected, true)
  assert.equal(report.nativeUnconfiguredRibbonAccurate, true)
  assert.equal(report.nativeIncompleteClientRefused, true)
  assert.equal(report.nativeHistoryMissingFieldGuidance, true)
  assert.equal(report.noCredentials, true)
  return { generatedDeviceId: report.generatedDeviceId, savedDeviceId: report.newDeviceId }
}

async function performNativeForceChangeRefusal() {
  stage = "native-force-change-refusal"
  // In-memory fake coordinates only. Replace BOTH destructive Runtime actions
  // with counters; no action under test can write to GitHub or user Vaults.
  const result = await evaluate(`(async()=>{
    let step="prepare-synthetic-force-modal";
    const plugin=app.plugins.plugins[${JSON.stringify(pluginId)}];
    if(plugin.githubClient || plugin.settings.githubToken)
      return {failedAt:"unexpected-native-credential"};
    const original=plugin.settings;
    const originalRuntime=plugin.v4Runtime;
    const originalPush=originalRuntime.forcePush;
    const originalPull=originalRuntime.forcePull;
    const note=app.vault.getAbstractFileByPath("D445-synthetic-first-use.md");
    let attempts=0;
    let activeModal;
    try {
      if(!note)throw Error("Synthetic note not found");
      plugin.disableWatch();
      plugin.v4Runtime.forcePush=async()=>{ attempts++; };
      plugin.v4Runtime.forcePull=async()=>{ attempts++; };
      plugin.settings={...original,githubOwner:"synthetic-test-owner",
        githubRepo:"synthetic-test-repo",githubBranch:"main",
        githubToken:"synthetic-not-a-real-token",
        syncEnabled:false,syncOnLocalChange:false,scheduledSyncEnabled:false};
      for(const operation of ["forcePush","forcePull"]) {
        for(const scenario of [
          {name:"note",path:note.path,syncBookmarks:false},
          {name:"bookmarks",path:".obsidian/bookmarks.json",syncBookmarks:true},
          {name:"runtime-replaced",path:note.path,syncBookmarks:false},
        ]) {
        plugin.settings={...plugin.settings,syncBookmarks:scenario.syncBookmarks};
        step="open-"+operation+"-"+scenario.name;
        const pending=plugin.showForceConfirm(operation);
        const start=Date.now();
        let slider,button;
        const label=operation==="forcePush"?"Force push":"Force pull";
        while(Date.now()-start<6000) {
          slider=document.querySelector(".github-sync-force-confirm-slider");
          button=slider?.closest(".modal")&&[...slider.closest(".modal").querySelectorAll("button")]
            .find(node=>node.textContent.trim()===label);
          if(slider&&button)break;
          await new Promise(resolve=>setTimeout(resolve,80));
        }
        if(!slider||!button)throw Error("Native Force dialog unavailable");
        activeModal=slider.closest(".modal");
        step="unlock-"+operation;
        const rect=slider.getBoundingClientRect();
        if(rect.width<=0)throw Error("Native slider has no width");
        // Drive the actual UI handler while avoiding synthetic pointer capture.
        slider.setPointerCapture=()=>{};
        slider.onpointerdown?.({pointerId:9,clientX:rect.right});
        if(button.style.display==="none")throw Error("Force action did not unlock");
        step="invalidate-"+operation;
        const size=note.stat.size,mtime=note.stat.mtime;
        if(scenario.name==="runtime-replaced") {
          // Deliberately replace the plugin Runtime with a harmless mock
          // while the already-unlocked real Obsidian modal is still open.
          plugin.v4Runtime={...originalRuntime,
            forcePush:async()=>{attempts++;},
            forcePull:async()=>{attempts++;}};
        } else {
          app.vault.trigger("modify",scenario.name==="note"?note:{path:scenario.path}); // Event only; no file mutation.
        }
        if(note.stat.size!==size||note.stat.mtime!==mtime)
          throw Error("Synthetic metadata changed");
        button.click();
        await Promise.race([pending,new Promise((_r,reject)=>
          setTimeout(()=>reject(Error("Force modal did not settle")),4500))]);
        activeModal=undefined;
        if(attempts!==0)throw Error("Stale Force actually executed");
        plugin.v4Runtime=originalRuntime;
        }
      }
      if(plugin.githubClient)throw Error("Synthetic Force created GitHub client");
      return {noForceExecuted:true};
    } catch { return {failedAt:step}; }
    finally {
      if(activeModal){
        const cancel=[...activeModal.querySelectorAll("button")]
          .find(node=>node.textContent.trim()==="Cancel");
        cancel?.click();
      }
      plugin.settings=original;
      plugin.v4Runtime=originalRuntime;
      originalRuntime.forcePush=originalPush;
      originalRuntime.forcePull=originalPull;
    }
  })()`, 36000)
  if (result?.failedAt) {
    stage = "native-force-change-refusal:" + result.failedAt
    throw Error("Installed Force change-refusal smoke failed")
  }
  assert.equal(result?.noForceExecuted, true)
}

async function performNativeSettingsSaveDebounceFence() {
  stage = "native-settings-save-debounce-fence"
  // Only synthetic Vault/Profile plugin data may be saved. Replace the
  // coordinator execution with a local counter: no GitHub client or remote I/O.
  const result = await evaluate(`(async()=>{
    let step="prepare-coordinator";
    const plugin=app.plugins.plugins[${JSON.stringify(pluginId)}];
    if(plugin.githubClient || plugin.settings.githubToken)
      return {failedAt:"unexpected-native-credential"};
    const coordinator=plugin.v4Runtime?.coordinator;
    if(!coordinator || coordinator.pendingCount!==0)
      return {failedAt:"non-idle-coordinator"};
    const originalSettings={...plugin.settings};
    const originalExecute=coordinator.options.execute;
    const originalSchedule=coordinator.schedule;
    const originalCancel=coordinator.cancel;
    let staleCallback, executions=0, changedSettings=false;
    try {
      coordinator.schedule=(callback)=>{ staleCallback=callback; return "synthetic-d485-timer"; };
      coordinator.cancel=()=>{};
      coordinator.options.execute=async()=>{ executions++; return {changedFiles:0}; };
      coordinator.enqueue({type:"modify",path:"D445-synthetic-first-use.md",mtime:1000});
      if(!staleCallback||coordinator.pendingCount!==1)
        throw Error("No synthetic local-change debounce queued");
      step="save-settings-with-pending-debounce";
      await plugin.saveSettings({...originalSettings,
        statusBarStatusEnabled:!originalSettings.statusBarStatusEnabled});
      changedSettings=true;
      step="fire-old-host-debounce-after-save";
      staleCallback(); // Host timer callback delivered after cancellation.
      await Promise.resolve();
      await Promise.resolve();
      if(executions!==0||coordinator.pendingCount!==1||!coordinator.isAutomaticSyncPaused)
        throw Error("Stale local debounce started Sync or discarded queued edits");
      step="explicit-manual-reconciliation";
      const review=await coordinator.run({operation:"normal",trigger:"manual"});
      if(review.status!=="completed"||executions!==1||coordinator.pendingCount!==0)
        throw Error("Manual reconciliation did not drain queued edits exactly once");
      step="restore-synthetic-settings";
      await plugin.saveSettings(originalSettings);
      changedSettings=false;
      if(coordinator.isAutomaticSyncPaused)
        throw Error("Clean Settings Save should allow future Auto Sync");
      if(plugin.githubClient||plugin.settings.githubToken)
        throw Error("Synthetic test created a credentialed client");
      return {settingsDebounceFenced:true};
    } catch {return {failedAt:step};}
    finally {
      coordinator.options.execute=originalExecute;
      coordinator.schedule=originalSchedule;
      coordinator.cancel=originalCancel;
      if(changedSettings) {
        try {await plugin.saveSettings(originalSettings);} catch {}
      }
    }
  })()`, 45000)
  if (result?.failedAt) {
    stage = "native-settings-save-debounce-fence:" + result.failedAt
    throw Error("Installed Settings-save debounce fence failed")
  }
  assert.equal(result?.settingsDebounceFenced, true)
}

async function performNativeHistoricalRecovery() {
  stage = "native-history-recovery"
  // The history version is synthetic, but the installed plugin renders its
  // real action and Obsidian Vault.create persists the resulting note.
  const result = await evaluate(`(async()=>{
    let step="locate-installed-history-view";
    try {
      const plugin=app.plugins.plugins[${JSON.stringify(pluginId)}];
      if(plugin.githubClient || plugin.settings.githubOwner || plugin.settings.githubToken)
        throw Error("Unexpected real GitHub connection");
      const leaf=app.workspace.getLeavesOfType("github-sync-v4-center")[0];
      const view=leaf?.view;
      if(typeof view?.appendPreview!=="function" || typeof view?.beginRender!=="function")
        throw Error("Installed history preview unavailable");
      const source=app.vault.getAbstractFileByPath("D445-synthetic-first-use.md");
      if(!source)throw Error("Synthetic source note unavailable");
      const original=await app.vault.read(source);
      step="prepare-collision";
      const existingName="Recovered-D445-synthetic-first-use-abcdef12.md";
      const recoveredName="Recovered-D445-synthetic-first-use-abcdef12-2.md";
      const already=app.vault.getAbstractFileByPath(existingName);
      if(already||app.vault.getAbstractFileByPath(recoveredName))
        throw Error("Synthetic recovery path already exists");
      await app.vault.create(existingName,"# Earlier synthetic recovery\\n");
      step="render-installed-preview";
      const container=view.contentEl.querySelector(".github-sync-center__detail");
      if(!container)throw Error("Installed history detail unavailable");
      container.empty();
      view.appendPreview(container,
        {kind:"text",text:"# Native historical recovery\\n",bytes:new TextEncoder().encode("# Native historical recovery\\n")},
        view.beginRender(),
        {sha:"abcdef1234567890",message:"synthetic history",authoredAt:"",source:"plugin"},
        {kind:"modify",path:"D445-synthetic-first-use.md",fileId:"synthetic",source:"plugin"});
      const action=[...container.querySelectorAll("button")].find(button=>button.textContent.trim()==="Restore as new note");
      if(!action)throw Error("Installed history restore action unavailable");
      step="click-installed-restore";
      action.click();
      action.click();
      const start=Date.now();
      while(!app.vault.getAbstractFileByPath(recoveredName)&&Date.now()-start<8000)
        await new Promise(resolve=>setTimeout(resolve,120));
      const recovered=app.vault.getAbstractFileByPath(recoveredName);
      if(!recovered)throw Error("Installed Obsidian did not create recovery copy");
      step="verify-original-and-copies";
      if(await app.vault.read(source)!==original)throw Error("Recovery overwrote original note");
      const prior=app.vault.getAbstractFileByPath(existingName);
      if(!prior||await app.vault.read(prior)!=="# Earlier synthetic recovery\\n")
        throw Error("Recovery overwrote existing copy");
      if(await app.vault.read(recovered)!=="# Native historical recovery\\n")
        throw Error("Recovered bytes mismatch");
      if(app.vault.getAbstractFileByPath("Recovered-D445-synthetic-first-use-abcdef12-3.md"))
        throw Error("Repeated recovery action created a second copy");
      if(!action.disabled)throw Error("Repeated recovery action remains enabled");
      step="check-explicit-native-open";
      if(app.workspace.getActiveFile()?.path===recoveredName)
        throw Error("Restore changed the active note without consent");
      const open=[...container.querySelectorAll("button")].find(button=>button.textContent.trim()==="Open recovered note");
      if(!open)throw Error("Installed history recovery lacks Open recovered note");
      open.click();
      open.click();
      const openedStart=Date.now();
      while(app.workspace.getActiveFile()?.path!==recoveredName&&Date.now()-openedStart<8000)
        await new Promise(resolve=>setTimeout(resolve,120));
      if(app.workspace.getActiveFile()?.path!==recoveredName)
        throw Error("Installed Open recovered note did not navigate to the saved file");
      if(!open.disabled)throw Error("Repeated Open recovered note remains enabled");
      if(await app.vault.read(recovered)!=="# Native historical recovery\\n")
        throw Error("Opening recovered note changed its contents");
      step="restore-markdown-bom-with-installed-vault";
      const bomBytes=new Uint8Array([0xef,0xbb,0xbf,0x23,0x20,0xe2,0x9c,0x85,0x0d,0x0a]);
      const bomName="Recovered-D445-synthetic-first-use-b0b0b0b0.md";
      if(app.vault.getAbstractFileByPath(bomName))throw Error("BOM recovery path already present");
      container.empty();
      view.appendPreview(container,
        {kind:"text",text:new TextDecoder("utf-8",{fatal:true,ignoreBOM:true}).decode(bomBytes),bytes:bomBytes},
        view.beginRender(),
        {sha:"b0b0b0b012345678",message:"synthetic BOM history",authoredAt:"",source:"plugin"},
        {kind:"modify",path:"D445-synthetic-first-use.md",fileId:"synthetic",source:"plugin"});
      const bomRestore=[...container.querySelectorAll("button")].find(button=>button.textContent.trim()==="Restore as new note");
      if(!bomRestore)throw Error("BOM historical recovery action missing");
      bomRestore.click();
      const bomStart=Date.now();
      while(!app.vault.getAbstractFileByPath(bomName)&&Date.now()-bomStart<8000)
        await new Promise(resolve=>setTimeout(resolve,120));
      const bomFile=app.vault.getAbstractFileByPath(bomName);
      if(!bomFile)throw Error("Installed Vault did not save the BOM recovery");
      const actualBom=new Uint8Array(await app.vault.readBinary(bomFile));
      if(actualBom.length!==bomBytes.length||actualBom.some((byte,index)=>byte!==bomBytes[index]))
        throw Error("Installed Vault changed BOM, Unicode or CRLF bytes");
      step="reject-invalid-markdown-history";
      container.empty();
      view.appendPreview(container,
        {kind:"binary",bytes:new Uint8Array([0x23,0x20,0xff])},
        view.beginRender(),
        {sha:"badutf812345678",message:"malformed synthetic history",authoredAt:"",source:"plugin"},
        {kind:"modify",path:"D445-synthetic-first-use.md",fileId:"synthetic",source:"plugin"});
      if([...container.querySelectorAll("button")].some(button=>
        button.textContent.trim()==="Restore as new note"||button.textContent.trim()==="Copy version text"))
        throw Error("Invalid UTF-8 Markdown offered a lossy restore");
      if(!container.textContent.includes("not readable as UTF-8"))
        throw Error("Invalid UTF-8 Markdown did not explain why restore is unavailable");
      if(plugin.githubClient)throw Error("Recovery created a GitHub connection");
      return {restored:true,originalPreserved:true,collisionPreserved:true,
        doubleClickSafe:true,explicitOpen:true,bomPreserved:true,invalidUtf8Refused:true};
    }catch{return {failedAt:step}}
  })()`, 35000)
  if (result?.failedAt) {
    stage = "native-history-recovery:" + result.failedAt
    throw Error("Native history recovery failed")
  }
  assert.equal(result?.restored, true)
  assert.equal(result.originalPreserved, true)
  assert.equal(result.collisionPreserved, true)
  assert.equal(result.doubleClickSafe, true)
  assert.equal(result.explicitOpen, true)
  assert.equal(result.bomPreserved, true)
  assert.equal(result.invalidUtf8Refused, true)
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
    const firstInstall = await performFirstUse()
    await performNativeHistoricalRecovery()
    await performNativeForceChangeRefusal()
    await performNativeSettingsSaveDebounceFence()
    const originalDeviceId = firstInstall.savedDeviceId
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
    assert.equal(await readFile(path.join(vault, "Recovered-D445-synthetic-first-use-abcdef12.md"), "utf8"),
      "# Earlier synthetic recovery\n")
    assert.equal(await readFile(path.join(vault, "Recovered-D445-synthetic-first-use-abcdef12-2.md"), "utf8"),
      "# Native historical recovery\n")
    assert.equal(await stat(path.join(vault, "Recovered-D445-synthetic-first-use-abcdef12-3.md")).catch(() => null), null,
      "Native restore must never create a duplicate on double click")
    assert.deepEqual(await readFile(path.join(vault, "Recovered-D445-synthetic-first-use-b0b0b0b0.md")),
      Buffer.from([0xef, 0xbb, 0xbf, 0x23, 0x20, 0xe2, 0x9c, 0x85, 0x0d, 0x0a]),
      "Native BOM recovery must preserve the exact UTF-8, Unicode and CRLF bytes after restart")
    assert.equal(await stat(path.join(vault, "Recovered-D445-synthetic-first-use-badutf81.md")).catch(() => null), null,
      "Malformed historical Markdown must not create a recovered note")

    // D448: A second *fresh* profile/vault must not inherit the first one's
    // random identity. Each installation uses the real native UI and restart.
    stage = "prepare-independent-second-install"
    stopOwnedProcess()
    await sleep(850)
    const peerVault = path.join(runRoot, "peer-vault")
    const peerProfile = path.join(runRoot, "peer-profile")
    const peerPluginDir = path.join(peerVault, ".obsidian", "plugins", pluginId)
    await mkdir(peerPluginDir, { recursive: true })
    await mkdir(peerProfile)
    for (const filename of ["main.js", "manifest.json", "styles.css"]) {
      await copyFile(path.join(root, filename), path.join(peerPluginDir, filename))
    }
    await writeFile(path.join(peerVault, ".obsidian", "community-plugins.json"),
      JSON.stringify([pluginId]) + "\n")
    await writeFile(path.join(peerProfile, "obsidian.json"),
      JSON.stringify({ vaults: { d448second: {
        path: peerVault, ts: Date.now(), open: true,
      } } }) + "\n")
    await writeFile(path.join(peerVault, "D445-synthetic-first-use.md"),
      "# D445 offline installation test\nNo GitHub account configured.\n")

    stage = "independent-second-native-launch"
    await launch(peerProfile, peerVault)
    const secondInstall = await performFirstUse()
    assert.notEqual(secondInstall.generatedDeviceId, firstInstall.generatedDeviceId,
      "Separate native installations must have different initial Device IDs")
    assert.notEqual(secondInstall.savedDeviceId, originalDeviceId,
      "Separate native Settings Saves must retain independent device identities")
    stage = "verify-independent-second-settings"
    const peerDisk = JSON.parse(await readFile(path.join(peerPluginDir, "data.json"), "utf8"))
    assert.equal(peerDisk.settings?.vault ?? peerDisk.vault, secondInstall.savedDeviceId,
      "Second native installation did not save its own Device ID")
    stopOwnedProcess()
    await sleep(850)
    stage = "independent-second-native-restart"
    await launch(peerProfile, peerVault)
    const peerReloaded = await evaluate(`(()=>{
      const plugin=app.plugins.plugins[${JSON.stringify(pluginId)}];
      return { deviceId:plugin.settings.vault,
        noCredentials:!(plugin.settings.githubToken||plugin.settings.githubOwner
          ||plugin.settings.githubRepo||plugin.settings.encryptionPassphrase) };
    })()`)
    assert.equal(peerReloaded?.deviceId, secondInstall.savedDeviceId,
      "Second native installation lost its own Device ID on restart")
    assert.equal(peerReloaded.noCredentials, true)
    const peerNote = await readFile(path.join(peerVault, "D445-synthetic-first-use.md"), "utf8")
    assert.equal(peerNote, "# D445 offline installation test\nNo GitHub account configured.\n")

    // D481: A separate, owned synthetic installation begins with malformed
    // legacy GitHub routing persisted BEFORE Obsidian loads the plugin.
    // Verify its real Settings UI can repair the value without GitHub I/O.
    stage = "prepare-repairable-legacy-install"
    stopOwnedProcess()
    await sleep(850)
    const legacyVault = path.join(runRoot, "legacy-vault")
    const legacyProfile = path.join(runRoot, "legacy-profile")
    const legacyPluginDir = path.join(legacyVault, ".obsidian", "plugins", pluginId)
    await mkdir(legacyPluginDir, { recursive: true })
    await mkdir(legacyProfile)
    for (const filename of ["main.js", "manifest.json", "styles.css"]) {
      await copyFile(path.join(root, filename), path.join(legacyPluginDir, filename))
    }
    await writeFile(path.join(legacyVault, ".obsidian", "community-plugins.json"),
      JSON.stringify([pluginId]) + "\n")
    await writeFile(path.join(legacyProfile, "obsidian.json"),
      JSON.stringify({ vaults: { d481legacy: { path: legacyVault, ts: Date.now(), open: true } } }) + "\n")
    const legacySettings = {
      ...(peerDisk.settings ?? peerDisk), githubOwner: "../unsafe",
      githubRepo: "synthetic-repo", githubBranch: "main",
      githubToken: "", vault: "native-legacy-device",
    }
    const legacyData = peerDisk.settings
      ? { ...peerDisk, settings: legacySettings } : legacySettings
    const legacyDataPath = path.join(legacyPluginDir, "data.json")
    await writeFile(legacyDataPath, JSON.stringify(legacyData) + "\n")
    stage = "launch-repairable-legacy-install"
    await launch(legacyProfile, legacyVault)
    const beforeRepair = JSON.parse(await readFile(legacyDataPath, "utf8"))
    assert.deepEqual(beforeRepair, legacyData,
      "Invalid saved routing must never rewrite local plugin data on startup")
    stage = "repair-legacy-settings-through-native-ui"
    const repaired = await evaluate(`(async()=>{
      let step="verify-malformed-startup";
      try {
        const plugin=app.plugins.plugins[${JSON.stringify(pluginId)}];
        if(plugin.settings.githubOwner!=="../unsafe" || plugin.githubClient)
          throw Error("Unsafe legacy routing did not remain fenced for repair");
        if(!(plugin.ribbonIcon?.getAttribute("aria-label")||"").includes("(Not Configured)"))
          throw Error("Invalid GitHub owner incorrectly advertised ready Sync");
        step="open-legacy-native-settings";
        const host=app.setting;
        host.open();
        host.openTabById(${JSON.stringify(pluginId)});
        const tab=plugin.settingTab;
        const row=()=>[...tab.containerEl.querySelectorAll(".setting-item")]
          .find(node=>node.querySelector(".setting-item-name")?.textContent?.trim()==="GitHub owner");
        const start=Date.now();
        while((!tab.containerEl.isConnected||!row())&&Date.now()-start<9000)
          await new Promise(resolve=>setTimeout(resolve,120));
        const input=row()?.querySelector("input");
        if(!input||input.value!=="../unsafe")
          throw Error("Legacy GitHub owner not editable in native Settings");
        step="save-repaired-native-owner";
        const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")?.set;
        if(!setter)throw Error("Native input setter unavailable");
        setter.call(input,"native-repaired-owner");
        input.dispatchEvent(new Event("input",{bubbles:true}));
        const save=[...tab.containerEl.querySelectorAll("button")]
          .find(button=>button.textContent.trim()==="Save changes");
        if(!tab.isDirty()||!save||save.disabled)
          throw Error("Corrected GitHub owner did not offer Save changes");
        save.click();
        const saveStart=Date.now();
        while((plugin.settings.githubOwner!=="native-repaired-owner"||tab.isDirty())
          &&Date.now()-saveStart<9000)
          await new Promise(resolve=>setTimeout(resolve,120));
        if(plugin.settings.githubOwner!=="native-repaired-owner"||tab.isDirty())
          throw Error("Native Settings failed to persist repaired GitHub owner");
        if(plugin.githubClient||plugin.settings.githubToken)
          throw Error("Repair unexpectedly configured a GitHub credential");
        host.close();
        return {repaired:true};
      } catch { return {failedAt:step} }
    })()`, 36000)
    if (repaired?.failedAt) {
      stage = "native-legacy-routing:" + repaired.failedAt
      throw Error("Native legacy routing repair failed")
    }
    assert.equal(repaired?.repaired, true)
    const legacySaved = JSON.parse(await readFile(legacyDataPath, "utf8"))
    assert.equal((legacySaved.settings ?? legacySaved).githubOwner, "native-repaired-owner")
    stage = "restart-repaired-legacy-install"
    stopOwnedProcess()
    await sleep(850)
    await launch(legacyProfile, legacyVault)
    const repairedReloaded = await evaluate(`(()=>{
      const plugin=app.plugins.plugins[${JSON.stringify(pluginId)}];
      return { owner:plugin.settings.githubOwner, deviceId:plugin.settings.vault,
        noClient:!plugin.githubClient, noCredentials:!plugin.settings.githubToken };
    })()`)
    assert.equal(repairedReloaded?.owner, "native-repaired-owner")
    assert.equal(repairedReloaded.deviceId, "native-legacy-device")
    assert.equal(repairedReloaded.noClient, true)
    assert.equal(repairedReloaded.noCredentials, true)
    passed = true
    console.log(JSON.stringify({ nativeOfflineFirstUse: "PASS", installed: true,
      settingsSaved: true, deviceIdPersistedAcrossRestart: true,
      nativeIndependentInstallations: 2, nativeLegacyRepairInstallation: 1,
      nativeLegacyRoutingRepair: true, distinctGeneratedDeviceIds: true,
      syncCenterReady: true, nativeSettingsUiSave: true,
      nativeInvalidBranchRejectedBeforeSave: true,
      nativeEmptyBranchRejectedBeforeSave: true,
      nativeUnconfiguredRibbonAccurate: true, nativeIncompleteClientRefused: true,
      nativeHistoryMissingFieldGuidance: true, nativeForceChangeRefusal: true,
      nativeSettingsSaveDebounceFence: true,
      noCredentialSyncRejected: true, noGitHubCredentials: true, remoteGitHubUsed: false,
      syntheticNotesPreserved: true, nativeHistoryRestoreCopy: true,
      nativeHistoryRestorePersistedAfterRestart: true,
      nativeHistoryOpenAfterRestore: true,
      nativeHistoryBomPreservedAfterRestart: true,
      nativeHistoryInvalidUtf8Refused: true }))
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
