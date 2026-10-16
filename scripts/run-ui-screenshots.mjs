#!/usr/bin/env node
/**
 * Isolated Obsidian Desktop visual smoke test; no GitHub credentials and no mutations
 * outside the repository's ignored .tmp directory.
 *
 * Run after "pnpm build":
 *   node scripts/run-ui-screenshots.mjs --launch
 * Attach to a previously launched isolated test instance:
 *   node scripts/run-ui-screenshots.mjs --attach --port=9239 --vault=.tmp/ui-acceptance-20261010-vault
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, lstat, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const id = "encrypted-github-sync-multi-platform";
const args = process.argv.slice(2);
const option = (key, fallback) => args.find(s => s.startsWith(`--${key}=`))?.slice(key.length + 3) ?? fallback;
const attach = args.includes("--attach");
const port = Number(option("port", "9249"));
const vault = path.resolve(root, option("vault", ".tmp/ui-visual-smoke/vault"));
const profile = path.resolve(root, option("profile", ".tmp/ui-visual-smoke/profile"));
const screenshots = path.resolve(root, option("out", ".tmp/ui-visual-smoke/screenshots"));
const exe = option("obsidian", "C:\\Program Files\\Obsidian\\Obsidian.exe");

function assertProjectTmp(target, label) {
  const rel = path.relative(path.resolve(root, ".tmp"), target);
  assert.ok(rel && rel !== "." && !rel.startsWith("..") && !path.isAbsolute(rel), `${label} must be a child of <repository>/.tmp`);
}
for (const [p, label] of [[vault,"vault"],[profile,"profile"],[screenshots,"screenshots"]]) assertProjectTmp(p,label);
async function refuseSymlinkTraversal(target) {
  let cursor = path.resolve(root, ".tmp");
  for (const part of ["", ...path.relative(cursor, target).split(path.sep)]) {
    if (part) cursor = path.join(cursor, part);
    try {
      assert.ok(!(await lstat(cursor)).isSymbolicLink(), `Symlink/junction not allowed within UI smoke path: ${cursor}`);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
  }
}
for (const p of [vault,profile,screenshots]) await refuseSymlinkTraversal(p);
assert.notEqual(vault.toLowerCase(), profile.toLowerCase(), "Profile and vault must be separate");
assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535, "Valid isolated CDP port required");

const evidence = { repo: root, vault, profile, port, pluginId: id, checks: [], screenshots: [], warnings: [], exceptions: [] };
const checked = (name, ok, detail = "") => {
  evidence.checks.push({name,ok:Boolean(ok),detail:String(detail).slice(0,600)});
  if (!ok) throw Error(`UI check failed: ${name}: ${detail}`);
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function listTargets() {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) });
  if (!response.ok) throw Error(`CDP target discovery HTTP ${response.status}`);
  return response.json();
}
async function waitForTarget(timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const t = (await listTargets()).find(p => p.type === "page" && /^app:\/\/obsidian\.md\/index\.html/u.test(p.url) && p.webSocketDebuggerUrl);
      if (t) return t;
    } catch {}
    await sleep(350);
  }
  throw Error("Isolated Obsidian vault did not open on the requested CDP port; screenshots were not fabricated.");
}
if (!attach) {
  try { await listTargets(); throw Error("Requested CDP port already in use; choose another --port to avoid an unrelated app"); }
  catch (error) { if (!/fetch failed|ECONNREFUSED|TimeoutError|timed out/u.test(String(error))) throw error; }
  // Never reuse an existing vault/profile in launch mode: doing so could
  // overwrite data in a previously created (or deliberately substituted) vault.
  await mkdir(path.dirname(vault), {recursive:true});
  await mkdir(vault);
  await mkdir(path.dirname(profile), {recursive:true});
  await mkdir(profile);
  await mkdir(path.join(vault, ".obsidian", "plugins", id), {recursive:true});
  await mkdir(path.join(vault, "Notes"), {recursive:true});
  for (const file of ["main.js", "manifest.json", "styles.css"]) {
    await copyFile(path.join(root,file),path.join(vault,".obsidian","plugins",id,file));
  }
  await writeFile(path.join(vault, ".obsidian", "community-plugins.json"), JSON.stringify([id])+"\n");
  await writeFile(path.join(vault,"UI-smoke.md"), "# Synthetic UI test note\n\nNo private data or remote credentials.\n");
  await writeFile(path.join(vault,"Notes","long-path-example.md"), "# A sample file\n\nOnly test data.\n");
  const config = {vaults:{"da9d8e727d6c1aba":{path:vault,ts:Date.now(),open:true}}};
  await writeFile(path.join(profile,"obsidian.json"),JSON.stringify(config,null,2)+"\n");
  const child = spawn(exe,[`--user-data-dir=${profile}`,`--remote-debugging-port=${port}`],{detached:true,stdio:"ignore",windowsHide:false});
  child.on("error",()=>{});
  child.unref();
  evidence.launchedPid = child.pid;
} else {
  // Attach mode MUST validate the live vault identity and saved credentials
  // before touching any file or opening any plugin UI.
}

let ws;
let serial=0;
const pending = new Map();
try {
  const target = await waitForTarget(attach ? 10000 : 55000);
  checked("isolated Obsidian CDP target",!!target.webSocketDebuggerUrl && target.url === "app://obsidian.md/index.html",target.url);
  ws=new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=()=>reject(Error("CDP WebSocket connection failed"));});
  ws.onmessage=({data})=>{
    const msg=JSON.parse(String(data));
    if(msg.method==="Runtime.exceptionThrown") evidence.exceptions.push(String(msg.params?.exceptionDetails?.exception?.description||msg.params?.exceptionDetails?.text).slice(0,500));
    if(!msg.id)return;
    const waiter=pending.get(msg.id);
    if(!waiter)return;
    pending.delete(msg.id);
    if(msg.error)waiter.reject(Error(msg.error.message));else waiter.resolve(msg.result);
  };
  const send=(method,params={})=>new Promise((resolve,reject)=>{
    const id=++serial;
    pending.set(id,{resolve,reject});
    ws.send(JSON.stringify({id,method,params}));
    setTimeout(()=>{if(pending.delete(id))reject(Error(`CDP timeout: ${method}`));},20000).unref();
  });
  const evaluate=async expression=>{
    const r=await send("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});
    if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);
    return r.result.value;
  };
  await send("Runtime.enable");
  await send("Page.enable");
  let activeSend = send;
  let activeEvaluate = evaluate;
  let settingsWs = null;
  // Exact real-vault identity guard. Do this before changing localStorage,
  // loading plugins, clicking UI, or capturing potentially private content.
  const identity=await evaluate(`(()=>({base:app.vault.adapter.getBasePath(),name:app.vault.getName(),location:location.href}))()`);
  checked("synthetic vault base path",String(identity.base).toLowerCase()===vault.toLowerCase(),identity.base);
  checked("synthetic vault basename",identity.name===path.basename(vault),identity.name);
  const pre=await evaluate(`(()=>({configured:!!(app.plugins.plugins[${JSON.stringify(id)}]?.settings?.githubToken),owner:app.plugins.plugins[${JSON.stringify(id)}]?.settings?.githubOwner||"",repo:app.plugins.plugins[${JSON.stringify(id)}]?.settings?.githubRepo||""}))()`);
  checked("no configured remote account",!pre.configured && !pre.owner && !pre.repo,"credentials must not be configured in synthetic vault");
  for (const file of ["main.js","manifest.json","styles.css"]) await copyFile(path.join(root,file),path.join(vault,".obsidian","plugins",id,file));
  const pluginState=await evaluate(`(async()=>{
    const pid=${JSON.stringify(id)};
    if(!app.plugins.isEnabled()) await app.plugins.setEnable(true);
    if(app.plugins.plugins[pid]) await app.plugins.unloadPlugin(pid);
    if(!app.plugins.enabledPlugins.has(pid)) await app.plugins.enablePluginAndSave(pid);
    await app.plugins.loadPlugin(pid);
    // On a first-run vault, Restricted Mode opt-in and community plugin
    // initialization can continue asynchronously after setEnable() returns.
    const deadline=Date.now()+15000;
    while(!app.plugins.plugins[pid] && Date.now()<deadline){
      await new Promise(r=>setTimeout(r,200));
      if(app.plugins.isEnabled() && app.plugins.manifests[pid] && !app.plugins.loadingPluginId) {
        await app.plugins.loadPlugin(pid);
      }
    }
    const p=app.plugins.plugins[pid];
    return {loaded:!!p,tab:!!p?.settingTab,noCredentials:!p?.settings?.githubToken&&!p?.settings?.githubOwner&&!p?.settings?.githubRepo,pluginVersion:p?.manifest?.version};
  })()`);
  checked("production plugin loads in Obsidian",pluginState.loaded,JSON.stringify(pluginState));
  checked("Settings tab registered",pluginState.tab);
  checked("plugin has no GitHub credentials",pluginState.noCredentials);
  const record=async (name)=>{
    const dom=await activeEvaluate(`(()=>({title:document.title,viewport:{width:innerWidth,height:innerHeight},text:(document.body.innerText||"").slice(0,800),settingsSections:document.querySelectorAll(".github-sync-settings-header").length,settingsContentWidth:(()=>{const e=document.querySelector(".vertical-tab-content");return e?Math.round(e.getBoundingClientRect().width):null})(),dirtyBanner:document.querySelectorAll(".github-sync-settings-dirty-banner").length,syncCenters:document.querySelectorAll(".github-sync-center").length,horizontalOverflow:Math.max(0,document.documentElement.scrollWidth-document.documentElement.clientWidth),centerLayout:(()=>{const layout=document.querySelector(".github-sync-center__layout")?.getBoundingClientRect();const detail=document.querySelector(".github-sync-center__detail")?.getBoundingClientRect();return layout&&detail?{availableWidth:Math.round(layout.width),detailRight:Math.round(detail.right),layoutRight:Math.round(layout.right),fits:detail.right<=layout.right+2}:null})(),notices:[...document.querySelectorAll(".notice")].map(e=>e.innerText.slice(0,120))}))()`);
    const shot=await activeSend("Page.captureScreenshot",{format:"png",captureBeyondViewport:false,fromSurface:true});
    checked(`screenshot buffer: ${name}`,Boolean(shot?.data&&shot.data.length>1000));
    const out=path.join(screenshots,name+".png");
    await mkdir(screenshots,{recursive:true});
    await writeFile(out,Buffer.from(shot.data,"base64"));
    evidence.screenshots.push({name,path:out,bytes:Math.floor(shot.data.length*.75),dom});
    return dom;
  };
  await record("00-vault");
  await evaluate(`(async()=>{
    app.setting.open();
    await new Promise(r=>setTimeout(r,300));
    app.setting.openTabById(${JSON.stringify(id)});
    await new Promise(r=>setTimeout(r,700));
  })()`);
  // Obsidian 1.14 opens Settings in a *separate Electron window*. Capture
  // its own CDP page rather than mistaking the unchanged main vault for a fail.
  const settingsTarget=(await listTargets()).find(t=>t.type==="page" && t.title?.startsWith(`Settings - ${path.basename(vault)} - Obsidian`) && t.webSocketDebuggerUrl);
  checked("Settings popout belongs to synthetic vault",!!settingsTarget,JSON.stringify((await listTargets()).map(x=>x.title).slice(0,6)));
  settingsWs=new WebSocket(settingsTarget.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{settingsWs.onopen=resolve;settingsWs.onerror=()=>reject(Error("Settings CDP connection failed"));});
  let settingsSerial=0;
  const settingsPending=new Map();
  settingsWs.onmessage=({data})=>{
    const msg=JSON.parse(String(data));
    if(msg.method==="Runtime.exceptionThrown")evidence.exceptions.push(String(msg.params?.exceptionDetails?.exception?.description||msg.params?.exceptionDetails?.text).slice(0,500));
    if(!msg.id)return;
    const pendingItem=settingsPending.get(msg.id);
    if(!pendingItem)return;
    settingsPending.delete(msg.id);
    if(msg.error)pendingItem.reject(Error(msg.error.message));else pendingItem.resolve(msg.result);
  };
  const settingsSend=(method,params={})=>new Promise((resolve,reject)=>{
    const sid=++settingsSerial;
    settingsPending.set(sid,{resolve,reject});
    settingsWs.send(JSON.stringify({id:sid,method,params}));
    setTimeout(()=>{if(settingsPending.delete(sid))reject(Error(`Settings CDP timeout: ${method}`));},20000).unref();
  });
  const settingsEvaluate=async expression=>{
    const r=await settingsSend("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});
    if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);
    return r.result.value;
  };
  await settingsSend("Runtime.enable");
  await settingsSend("Page.enable");
  activeSend=settingsSend;
  activeEvaluate=settingsEvaluate;
  const opened=await settingsEvaluate(`(()=>({headers:document.querySelectorAll(".github-sync-settings-header").length,visible:!!document.querySelector(".github-sync-settings-dirty-banner, .github-sync-settings-header"),title:document.title}))()`);
  checked("Settings UI rendered",opened.visible,JSON.stringify(opened));
  await record("01-settings-general");
  await evaluate(`(()=>{
    const t=app.plugins.plugins[${JSON.stringify(id)}].settingTab;
    if(!t.tempSettings)throw Error("Settings draft not active");
    t.tempSettings.githubOwner="synthetic-unsaved-owner";
    t.updateDirtyState();
  })()`);
  const dirty=await settingsEvaluate(`(()=>({dirty:!!document.querySelector(".github-sync-settings-dirty-banner"),notice:document.querySelector(".github-sync-settings-dirty-banner")?.innerText?.slice(0,200)}))()`);
  checked("unsaved settings banner",dirty.dirty,dirty.notice);
  await record("02-settings-dirty");
  await evaluate(`(()=>{const t=app.plugins.plugins[${JSON.stringify(id)}].settingTab;t.tempSettings.githubOwner=app.plugins.plugins[${JSON.stringify(id)}].settings.githubOwner;t.updateDirtyState();})()`);
  const scroll=await activeEvaluate(`(()=>{const els=[...document.querySelectorAll(".vertical-tab-content, .vertical-tab-content-container, .modal-content")].map(e=>({e,h:e.scrollHeight-e.clientHeight})).sort((a,b)=>b.h-a.h); const x=els[0]; if(x)x.e.scrollTop=x.e.scrollHeight;return {max:x?.h??0};})()`);
  if(scroll.max>100)await record("03-settings-bottom");else evidence.warnings.push("Settings scroll container could not be identified; bottom viewport not separately captured.");
  const prevTheme=await activeEvaluate(`(()=>({dark:document.body.classList.contains("theme-dark"),light:document.body.classList.contains("theme-light")}))()`);
  await activeEvaluate(`(()=>{document.body.classList.remove("theme-dark");document.body.classList.add("theme-light");})()`);
  await record("04-settings-light");
  await activeEvaluate(`(()=>{document.body.classList.remove("theme-light");document.body.classList.add("theme-dark");})()`);
  await record("05-settings-dark");
  await activeEvaluate(`(()=>{document.body.classList.toggle("theme-dark",${prevTheme.dark});document.body.classList.toggle("theme-light",${prevTheme.light});})()`);
  // Browser-emulated narrow viewport on desktop Electron: NOT mobile-device proof.
  await activeEvaluate(`(()=>{const x=[...document.querySelectorAll(".vertical-tab-content, .vertical-tab-content-container, .modal-content")].sort((a,b)=>(b.scrollHeight-b.clientHeight)-(a.scrollHeight-a.clientHeight))[0];if(x)x.scrollTop=0;})()`);
  await activeSend("Emulation.setDeviceMetricsOverride",{width:375,height:760,deviceScaleFactor:1,mobile:false});
  const narrow=await record("06-settings-narrow-375");
  if(narrow.horizontalOverflow>2)evidence.warnings.push(`375px viewport has ${narrow.horizontalOverflow}px document overflow; inspect screenshot manually`);
  if(narrow.settingsContentWidth!==null && narrow.settingsContentWidth<260)evidence.warnings.push(`Obsidian desktop Settings popout leaves only ${narrow.settingsContentWidth}px for plugin content at 375px viewport; not a mobile-device acceptance pass.`);
  await activeSend("Emulation.clearDeviceMetricsOverride");
  await evaluate(`(()=>app.setting.close())()`);
  activeSend=send;
  activeEvaluate=evaluate;
  try{settingsWs.close()}catch{}
  const syncState=await evaluate(`(async()=>{await app.plugins.plugins[${JSON.stringify(id)}].openSyncCenter();await new Promise(r=>setTimeout(r,700));return {count:document.querySelectorAll(".github-sync-center").length,body:document.body.innerText.slice(-500)}})()`);
  checked("Sync Center rendered",syncState.count>0,JSON.stringify(syncState));
  const dock=await record("07-sync-center-commits");
  checked("Sync Center details fit the actual Obsidian dock",dock.centerLayout?.fits,JSON.stringify(dock.centerLayout));
  const active=await evaluate(`(async()=>{
    const f=app.vault.getAbstractFileByPath("UI-smoke.md");
    if(f)await app.workspace.getLeaf("tab").openFile(f);
    await new Promise(r=>setTimeout(r,200));
    const b=[...document.querySelectorAll(".github-sync-center__actions button")].find(e=>e.textContent.trim()==="Current file");
    b?.click();
    await new Promise(r=>setTimeout(r,600));
    return {button:!!b,pressed:b?.getAttribute("aria-pressed"),center:document.querySelectorAll(".github-sync-center").length};
  })()`);
  checked("Current File navigation",active.button && active.center>0,JSON.stringify(active));
  await record("08-sync-center-current-file");
  await send("Emulation.setDeviceMetricsOverride",{width:375,height:760,deviceScaleFactor:1,mobile:false});
  await record("09-sync-center-narrow-375");
  await send("Emulation.clearDeviceMetricsOverride");
  // With no GitHub credentials, Force commands must refuse to open destructive dialogs.
  // This run never unlocks a Force control or invokes a remote operation.
  for(const mode of ["forcePush","forcePull"]){
    const before=await evaluate(`(()=>document.querySelectorAll(".modal-container").length)()`);
    await evaluate(`(()=>{void app.plugins.plugins[${JSON.stringify(id)}].showForceConfirm(${JSON.stringify(mode)});return true})()`);
    await sleep(100);
    const safety=await evaluate(`(()=>({
      dialogs:document.querySelectorAll(".modal-container").length,
      notices:[...document.querySelectorAll(".notice")].map(e=>e.innerText),
      forceSlider:!!document.querySelector(".github-sync-force-confirm-slider"),
    }))()`);
    checked(`${mode} refuses unconfigured repository`,safety.dialogs===before&&!safety.forceSlider&&safety.notices.some(t=>/Configure and save your GitHub owner/u.test(t)),JSON.stringify(safety));
    await record(mode==="forcePush"?"10-force-push-unconfigured":"11-force-pull-unconfigured");
  }
  if(evidence.exceptions.length)evidence.warnings.push(`Runtime exceptions seen: ${evidence.exceptions.length}; inspect exceptions array`);
} catch(err) {
  evidence.failure=String(err?.stack||err).slice(0,1800);
  process.exitCode=1;
} finally {
  try{await mkdir(screenshots,{recursive:true});await writeFile(path.join(screenshots,"report.json"),JSON.stringify(evidence,null,2)+"\n");}catch(e){console.error("Failed to write UI evidence:",String(e));process.exitCode=1;}
  if(ws)try{ws.close()}catch{}
  console.log(JSON.stringify({status:process.exitCode?"FAILED":"PASSED",checks:evidence.checks.length,screenshots:evidence.screenshots.map(s=>({name:s.name,path:s.path,bytes:s.bytes})),warnings:evidence.warnings,exceptions:evidence.exceptions,failure:evidence.failure,report:path.join(screenshots,"report.json")},null,2));
}
