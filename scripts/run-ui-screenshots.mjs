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
import { spawn, spawnSync } from "node:child_process";
import { copyFile, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { visibleIntersection, verifyPngBytes } from "./ui-visual-assertions.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const id = "encrypted-github-sync-multi-platform";
const args = process.argv.slice(2);
const option = (key, fallback) => args.find(s => s.startsWith(`--${key}=`))?.slice(key.length + 3) ?? fallback;
const attach = args.includes("--attach");
const runId = `${Date.now()}-${process.pid}`;
const runDir = path.join(".tmp", "ui-visual-smoke", "runs", runId);
const port = Number(option("port", String(20000 + (process.pid % 25000))));
const vault = path.resolve(root, option("vault", path.join(runDir, "vault")));
const profile = path.resolve(root, option("profile", path.join(runDir, "profile")));
const screenshots = path.resolve(root, option("out", path.join(runDir, "screenshots")));
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
const overlap = (a, b) => {
  const relative = path.relative(a, b);
  return !relative || (!relative.startsWith("..") && !path.isAbsolute(relative));
};
assert.ok(!overlap(vault, profile) && !overlap(profile, vault), "Profile and vault must not overlap");
assert.ok(!overlap(vault, screenshots) && !overlap(screenshots, vault), "Screenshots and vault must not overlap");
assert.ok(!overlap(profile, screenshots) && !overlap(screenshots, profile), "Screenshots and profile must not overlap");
assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535, "Valid isolated CDP port required");
const markerFile = path.join(vault, ".obsidian-ui-screenshot-fixture");
const markerValue = "obsidian-ui-screenshot-fixture-v1";

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
  await writeFile(markerFile, markerValue + "\n", {flag:"wx"});
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
  // Refuse to attach to arbitrary Obsidian vaults even if the caller points
  // somewhere below .tmp. This marker is created only for a fresh test vault.
  assert.equal((await readFile(markerFile,"utf8")).trim(), markerValue, "Attach requires a vault created by the UI screenshot runner");
  // The live vault path and credentials are checked below before any mutation.
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
  let identity=null;
  const startupDeadline=Date.now()+45000;
  while(!identity && Date.now()<startupDeadline){
    identity=await evaluate(`(()=>{
      if(typeof app==="undefined" || !app?.vault?.adapter?.getBasePath || !app?.workspace) return null;
      return {base:app.vault.adapter.getBasePath(),name:app.vault.getName(),location:location.href};
    })()`);
    if(!identity)await sleep(250);
  }
  checked("Obsidian vault API is ready",Boolean(identity),"index.html alone does not establish that the app has finished booting");
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
  let workspaceReady=null;
  const workspaceDeadline=Date.now()+30000;
  while(Date.now()<workspaceDeadline){
    workspaceReady=await evaluate(`(()=>{
      const text=document.body?.innerText??"";
      return {ok:!!app.workspace.layoutReady && text.includes("UI-smoke") && !/Loading plugins|Loading vault/u.test(text),
        sample:text.slice(0,160)};
    })()`);
    if(workspaceReady.ok)break;
    await sleep(250);
  }
  checked("synthetic Obsidian workspace fully rendered",workspaceReady?.ok,JSON.stringify(workspaceReady));
  const record=async (name,{visibleSelector,cropSelector}={})=>{
    const dom=await activeEvaluate(`(()=>({title:document.title,viewport:{width:innerWidth,height:innerHeight},text:(document.body.innerText||"").slice(0,800),settingsSections:document.querySelectorAll(".github-sync-settings-header").length,settingsContentWidth:(()=>{const e=document.querySelector(".vertical-tab-content");return e?Math.round(e.getBoundingClientRect().width):null})(),dirtyBanner:document.querySelectorAll(".github-sync-settings-dirty-banner").length,syncCenters:document.querySelectorAll(".github-sync-center").length,horizontalOverflow:Math.max(0,document.documentElement.scrollWidth-document.documentElement.clientWidth),centerLayout:(()=>{const layout=document.querySelector(".github-sync-center__layout")?.getBoundingClientRect();const detail=document.querySelector(".github-sync-center__detail")?.getBoundingClientRect();return layout&&detail?{availableWidth:Math.round(layout.width),detailRight:Math.round(detail.right),layoutRight:Math.round(layout.right),fits:detail.right<=layout.right+2}:null})(),notices:[...document.querySelectorAll(".notice")].map(e=>e.innerText.slice(0,120))}))()`);
    let clip;
    let cropDpr=1;
    if(visibleSelector||cropSelector){
      const selector=cropSelector??visibleSelector;
      const target=await activeEvaluate(`(()=>{
        const el=document.querySelector(${JSON.stringify(selector)});
        if(!el)return null;
        const b=el.getBoundingClientRect();
        return {rect:{x:b.x,y:b.y,width:b.width,height:b.height},viewport:{width:innerWidth,height:innerHeight},dpr:devicePixelRatio};
      })()`);
      checked(`screenshot target exists: ${name}`,Boolean(target),selector);
      const intersection=visibleIntersection(target.rect,target.viewport);
      checked(`screenshot target onscreen: ${name}`,true,JSON.stringify(intersection));
      if(cropSelector){clip=intersection;cropDpr=target.dpr;}
    }
    const shot=await activeSend("Page.captureScreenshot",{
      format:"png",captureBeyondViewport:false,fromSurface:true,...(clip?{clip}:{}),
    });
    const imageBytes=Buffer.from(shot?.data??"","base64");
    const size=verifyPngBytes(imageBytes,{minWidth:80,minHeight:80});
    if(clip){
      checked(`cropped target actually captured: ${name}`,
        Math.abs(size.width-clip.width*cropDpr)<=3&&Math.abs(size.height-clip.height*cropDpr)<=3,
        `png=${JSON.stringify(size)} clip=${JSON.stringify(clip)}`);
    }
    checked(`valid screenshot PNG: ${name}`,true,`${size.width}x${size.height}`);
    const out=path.join(screenshots,name+".png");
    await mkdir(screenshots,{recursive:true});
    await writeFile(out,imageBytes);
    evidence.screenshots.push({name,path:out,bytes:imageBytes.length,png:size,dom});
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
  await record("01-settings-general",{visibleSelector:".github-sync-settings-header"});
  // Native Settings form acceptance: exercise actual Obsidian text component
  // input events and the rendered Save button. No token is ever entered.
  const formValues = {
    "GitHub owner": "synthetic-owner",
    "GitHub repo": "synthetic-repo",
    "GitHub branch": "testing/settings-ui",
  };
  const typeSettingsField = async (name, value) => settingsEvaluate(`(()=>{
    const label=${JSON.stringify(name)};
    const labelEl=[...document.querySelectorAll(".setting-item-name")]
      .find(e=>e.textContent?.trim()===label);
    const input=labelEl?.closest(".setting-item")?.querySelector("input");
    if(input?.tagName!=="INPUT")throw Error("Settings field is missing: "+label);
    const ownerWindow=input.ownerDocument.defaultView;
    const setter=Object.getOwnPropertyDescriptor(ownerWindow.HTMLInputElement.prototype,"value")?.set;
    if(!setter)throw Error("Settings input has no native value setter: "+label);
    setter.call(input,${JSON.stringify(value)});
    input.dispatchEvent(new ownerWindow.Event("input",{bubbles:true}));
    input.dispatchEvent(new ownerWindow.Event("change",{bubbles:true}));
    return {renderedValue:input.value,type:input.type};
  })()`);
  const clickSettingsSave = async () => settingsEvaluate(`(()=>{
    const button=[...document.querySelectorAll(".github-sync-settings-dirty-banner button")]
      .find(e=>e.textContent.trim()==="Save changes");
    if(!button || button.disabled)throw Error("Active Save changes button is missing");
    button.click();
    return true;
  })()`);
  const invalidField = await typeSettingsField("GitHub branch", "bad branch");
  checked("native settings input changes branch text",invalidField.renderedValue==="bad branch",JSON.stringify(invalidField));
  await clickSettingsSave();
  await sleep(250);
  const rejectedForm = await evaluate(`(()=>({
    branch:app.plugins.plugins[${JSON.stringify(id)}].settings.githubBranch,
    configured:!!app.plugins.plugins[${JSON.stringify(id)}].githubClient,
  }))()`);
  const rejectedUI = await settingsEvaluate(`(()=>({
    dirty:!!document.querySelector(".github-sync-settings-dirty-banner"),
    errors:[...document.querySelectorAll(".notice")].map(e=>e.innerText.slice(0,120)),
  }))()`);
  checked("invalid native branch never saves",rejectedForm.branch==="main"&&!rejectedForm.configured&&rejectedUI.dirty,
    JSON.stringify({savedBranch:rejectedForm.branch,dirty:rejectedUI.dirty}));
  checked("invalid branch displays a validation notice",rejectedUI.errors.some(t=>/settings not saved.*invalid github branch/iu.test(t)),
    JSON.stringify(rejectedUI.errors));
  for(const [name,value] of Object.entries(formValues)){
    const typed=await typeSettingsField(name,value);
    checked(`native settings form accepts ${name}`,typed.renderedValue===value,JSON.stringify(typed));
  }
  const draft=await evaluate(`(()=>{const t=app.plugins.plugins[${JSON.stringify(id)}].settingTab;
    return {owner:t.tempSettings?.githubOwner,repo:t.tempSettings?.githubRepo,branch:t.tempSettings?.githubBranch,token:t.tempSettings?.githubToken};
  })()`);
  checked("real form input events update plugin draft",
    draft.owner===formValues["GitHub owner"]&&draft.repo===formValues["GitHub repo"]
    &&draft.branch===formValues["GitHub branch"]&&!draft.token,
    JSON.stringify({owner:draft.owner,repo:draft.repo,branch:draft.branch,hasToken:!!draft.token}));
  await record("01a-settings-real-form-edited",{visibleSelector:".github-sync-settings-header"});
  await clickSettingsSave();
  await sleep(600);
  const savedForm=await evaluate(`(async()=>{
    const p=app.plugins.plugins[${JSON.stringify(id)}];
    const stored=await p.loadData();
    return {owner:p.settings.githubOwner,repo:p.settings.githubRepo,branch:p.settings.githubBranch,
      storedOwner:stored?.settings?.githubOwner,storedRepo:stored?.settings?.githubRepo,
      storedBranch:stored?.settings?.githubBranch,hasClient:!!p.githubClient,
      hasToken:!!p.settings.githubToken||!!stored?.settings?.githubToken};
  })()`);
  const savedUi=await settingsEvaluate(`(()=>({dirty:!!document.querySelector(".github-sync-settings-dirty-banner")}))()`);
  checked("native Save persists owner repo and branch without GitHub client",
    savedForm.owner===formValues["GitHub owner"]&&savedForm.repo===formValues["GitHub repo"]
    &&savedForm.branch===formValues["GitHub branch"]
    &&savedForm.storedOwner===savedForm.owner&&savedForm.storedRepo===savedForm.repo
    &&savedForm.storedBranch===savedForm.branch&&!savedForm.hasClient&&!savedForm.hasToken&&!savedUi.dirty,
    JSON.stringify(savedForm));
  await record("01b-settings-real-form-saved",{visibleSelector:".github-sync-settings-header"});
  // Restore the empty synthetic remote so subsequent Force refusal checks stay non-destructive.
  for(const [name,value] of Object.entries({"GitHub owner":"","GitHub repo":"","GitHub branch":"main"})){
    await typeSettingsField(name,value);
  }
  await clickSettingsSave();
  await sleep(500);
  const restored=await evaluate(`(async()=>{const p=app.plugins.plugins[${JSON.stringify(id)}];const data=await p.loadData();
    return {owner:p.settings.githubOwner,repo:p.settings.githubRepo,branch:p.settings.githubBranch,
      dataOwner:data?.settings?.githubOwner,dataRepo:data?.settings?.githubRepo,hasClient:!!p.githubClient};
  })()`);
  checked("native Settings UI restores unconfigured synthetic vault",
    !restored.owner&&!restored.repo&&restored.branch==="main"&&!restored.dataOwner&&!restored.dataRepo&&!restored.hasClient,
    JSON.stringify(restored));
  // Exercise real password input and Obsidian Secret Storage with disposable
  // literal fixture values. Leave owner/repo EMPTY throughout so no GitHub
  // client can be constructed and no remote URL can be contacted.
  const fixtureTokenA="ui-test-NOT-A-TOKEN-a";
  const fixturePassA="ui-test-NOT-A-PASSPHRASE-a";
  const fixtureTokenB="ui-test-NOT-A-TOKEN-b";
  const fixturePassB="ui-test-NOT-A-PASSPHRASE-b";
  const tokenField=await typeSettingsField("GitHub token",fixtureTokenA);
  checked("actual GitHub token UI is masked password input",
    tokenField.type==="password"&&tokenField.renderedValue===fixtureTokenA,
    JSON.stringify({type:tokenField.type,fixtureMatched:tokenField.renderedValue===fixtureTokenA}));
  const encryptionToggle=async()=>settingsEvaluate(`(()=>{
    const item=[...document.querySelectorAll(".setting-item-name")]
      .find(e=>e.textContent.trim()==="Encrypted sync")?.closest(".setting-item");
    const toggle=item?.querySelector(".checkbox-container");
    if(!toggle)throw Error("Encrypted sync toggle is missing");
    toggle.click();
    return {passphraseVisible:[...document.querySelectorAll(".setting-item-name")]
      .some(e=>e.textContent.trim()==="Encryption passphrase")};
  })()`);
  const encryptedOn=await encryptionToggle();
  checked("native encrypted mode toggle reveals passphrase field",encryptedOn.passphraseVisible,JSON.stringify(encryptedOn));
  const passField=await typeSettingsField("Encryption passphrase",fixturePassA);
  checked("actual encryption passphrase UI is masked password input",
    passField.type==="password"&&passField.renderedValue===fixturePassA,
    JSON.stringify({type:passField.type,fixtureMatched:passField.renderedValue===fixturePassA}));
  await clickSettingsSave();
  await sleep(550);
  const secretA=await evaluate(`(async()=>{
    const p=app.plugins.plugins[${JSON.stringify(id)}], data=(await p.loadData())?.settings??{};
    const tokenId=p.settings.githubTokenSecretId,passId=p.settings.encryptionPassphraseSecretId;
    return {tokenMatch:p.settings.githubToken===${JSON.stringify("ui-test-NOT-A-TOKEN-a")},
      passMatch:p.settings.encryptionPassphrase===${JSON.stringify("ui-test-NOT-A-PASSPHRASE-a")},
      mode:p.settings.encryptionMode,tokenId,passId,
      secureTokenMatch:app.secretStorage.getSecret(tokenId)===${JSON.stringify("ui-test-NOT-A-TOKEN-a")},
      securePassMatch:app.secretStorage.getSecret(passId)===${JSON.stringify("ui-test-NOT-A-PASSPHRASE-a")},
      persistedTokenAbsent:!Object.hasOwn(data,"githubToken"),persistedPassAbsent:!Object.hasOwn(data,"encryptionPassphrase"),
      hasClient:!!p.githubClient};
  })()`);
  checked("native password form stores both secrets only in Obsidian Secret Storage",
    secretA.tokenMatch&&secretA.passMatch&&secretA.mode==="encrypted"&&secretA.tokenId&&secretA.passId
      &&secretA.tokenId!==secretA.passId&&secretA.secureTokenMatch&&secretA.securePassMatch
      &&secretA.persistedTokenAbsent&&secretA.persistedPassAbsent&&!secretA.hasClient,
    JSON.stringify(secretA));
  await typeSettingsField("GitHub token",fixtureTokenB);
  await typeSettingsField("Encryption passphrase",fixturePassB);
  await clickSettingsSave();
  await sleep(550);
  const secretB=await evaluate(`(async()=>{
    const p=app.plugins.plugins[${JSON.stringify(id)}],data=(await p.loadData())?.settings??{};
    const tokenId=p.settings.githubTokenSecretId,passId=p.settings.encryptionPassphraseSecretId;
    return {tokenId,passId,
      tokenMatch:p.settings.githubToken===${JSON.stringify("ui-test-NOT-A-TOKEN-b")},
      passMatch:p.settings.encryptionPassphrase===${JSON.stringify("ui-test-NOT-A-PASSPHRASE-b")},
      secureTokenMatch:app.secretStorage.getSecret(tokenId)===${JSON.stringify("ui-test-NOT-A-TOKEN-b")},
      securePassMatch:app.secretStorage.getSecret(passId)===${JSON.stringify("ui-test-NOT-A-PASSPHRASE-b")},
      oldTokenCleared:!app.secretStorage.getSecret(${JSON.stringify(secretA.tokenId)}),
      oldPassCleared:!app.secretStorage.getSecret(${JSON.stringify(secretA.passId)}),
      persistedTokenAbsent:!Object.hasOwn(data,"githubToken"),persistedPassAbsent:!Object.hasOwn(data,"encryptionPassphrase"),
      hasClient:!!p.githubClient};
  })()`);
  checked("real Settings rotates secrets and scrubs superseded Secret Storage slots",
    secretB.tokenId!==secretA.tokenId&&secretB.passId!==secretA.passId
      &&secretB.tokenMatch&&secretB.passMatch&&secretB.secureTokenMatch&&secretB.securePassMatch
      &&secretB.oldTokenCleared&&secretB.oldPassCleared
      &&secretB.persistedTokenAbsent&&secretB.persistedPassAbsent&&!secretB.hasClient,
    JSON.stringify(secretB));
  await typeSettingsField("GitHub token","");
  await typeSettingsField("Encryption passphrase","");
  const encryptedOff=await encryptionToggle();
  checked("native encrypted mode toggle hides passphrase field",!encryptedOff.passphraseVisible,JSON.stringify(encryptedOff));
  await clickSettingsSave();
  await sleep(550);
  const secretsCleared=await evaluate(`(async()=>{
    const p=app.plugins.plugins[${JSON.stringify(id)}],data=(await p.loadData())?.settings??{};
    return {tokenEmpty:!p.settings.githubToken,passEmpty:!p.settings.encryptionPassphrase,
      mode:p.settings.encryptionMode,oldTokenCleared:!app.secretStorage.getSecret(${JSON.stringify(secretB.tokenId)}),
      oldPassCleared:!app.secretStorage.getSecret(${JSON.stringify(secretB.passId)}),
      activeTokenEmpty:!app.secretStorage.getSecret(p.settings.githubTokenSecretId),
      activePassEmpty:!app.secretStorage.getSecret(p.settings.encryptionPassphraseSecretId),
      persistedTokenAbsent:!Object.hasOwn(data,"githubToken"),persistedPassAbsent:!Object.hasOwn(data,"encryptionPassphrase"),
      hasClient:!!p.githubClient};
  })()`);
  checked("native Settings clears both secrets and restores plaintext unconfigured vault",
    secretsCleared.tokenEmpty&&secretsCleared.passEmpty&&secretsCleared.mode==="plaintext"
      &&secretsCleared.oldTokenCleared&&secretsCleared.oldPassCleared
      &&secretsCleared.activeTokenEmpty&&secretsCleared.activePassEmpty
      &&secretsCleared.persistedTokenAbsent&&secretsCleared.persistedPassAbsent&&!secretsCleared.hasClient,
    JSON.stringify(secretsCleared));
  await evaluate(`(()=>{
    const t=app.plugins.plugins[${JSON.stringify(id)}].settingTab;
    if(!t.tempSettings)throw Error("Settings draft not active");
    t.tempSettings.githubOwner="synthetic-unsaved-owner";
    t.updateDirtyState();
  })()`);
  const dirty=await settingsEvaluate(`(()=>({dirty:!!document.querySelector(".github-sync-settings-dirty-banner"),notice:document.querySelector(".github-sync-settings-dirty-banner")?.innerText?.slice(0,200)}))()`);
  checked("unsaved settings banner",dirty.dirty,dirty.notice);
  await settingsEvaluate(`(()=>document.querySelector(".github-sync-settings-dirty-banner")?.scrollIntoView({block:"start"}))()`);
  await record("02-settings-dirty",{visibleSelector:".github-sync-settings-dirty-banner"});
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
  const narrow=await record("06-settings-narrow-375",{visibleSelector:".github-sync-settings-header"});
  if(narrow.horizontalOverflow>2)evidence.warnings.push(`375px viewport has ${narrow.horizontalOverflow}px document overflow; inspect screenshot manually`);
  if(narrow.settingsContentWidth!==null && narrow.settingsContentWidth<260)evidence.warnings.push(`Obsidian desktop Settings popout leaves only ${narrow.settingsContentWidth}px for plugin content at 375px viewport; not a mobile-device acceptance pass.`);
  await activeSend("Emulation.clearDeviceMetricsOverride");
  await evaluate(`(()=>app.setting.close())()`);
  activeSend=send;
  activeEvaluate=evaluate;
  try{settingsWs.close()}catch{}
  const syncState=await evaluate(`(async()=>{await app.plugins.plugins[${JSON.stringify(id)}].openSyncCenter();await new Promise(r=>setTimeout(r,700));return {count:document.querySelectorAll(".github-sync-center").length,body:document.body.innerText.slice(-500)}})()`);
  checked("Sync Center rendered",syncState.count>0,JSON.stringify(syncState));
  const dock=await record("07-sync-center-commits",{visibleSelector:".github-sync-center"});
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
  await record("08-sync-center-current-file",{visibleSelector:".github-sync-center"});
  // A 375px *app viewport* pushes Obsidian's right dock offscreen; the
  // previous test saved a nearly blank PNG and falsely counted it as passed.
  // Capture the actually visible narrow dock, cropped to the live sidebar.
  const dockNarrow=await record("09-sync-center-narrow-dock",{cropSelector:".github-sync-center"});
  checked("narrow Sync Center uses the actual sidebar width",dockNarrow.centerLayout?.availableWidth<=640,
    JSON.stringify(dockNarrow.centerLayout));
  // Real Obsidian dock evidence for independently authored file-status UI.
  // Synthetic inventory is supplied in memory; never open a network client.
  const filesMock=await evaluate(`(async()=>{
    const p=app.plugins.plugins[${JSON.stringify(id)}];
    const leaves=app.workspace.getLeavesOfType("github-sync-v4-center");
    const view=leaves[0]?.view;
    if(!view)throw Error("Sync Center view absent");
    window.__syncUiDemo={runtime:p.v4Runtime,realOverview:p.v4Runtime.fileOverview,
      owner:p.settings.githubOwner,repo:p.settings.githubRepo,branch:p.settings.githubBranch,view};
    p.settings.githubOwner="sample-owner";
    p.settings.githubRepo="sample-repository";
    p.settings.githubBranch="preview";
    p.v4Runtime.fileOverview=async()=>({remoteCommitSha:"a".repeat(40),entries:[
      {path:"02_Areas/blog/assets/logo.png",status:"local-only",local:true,remote:false},
      {path:"02_Areas/blog/guide.md",status:"changed",local:true,remote:true},
      {path:"02_Areas/blog/drafts/post.md",status:"changed",local:true,remote:true},
      {path:"Notes/remote-idea.md",status:"remote-only",local:false,remote:true},
      {path:"Notes/reference.md",status:"synced",local:true,remote:true},
      {path:"Notes/tracked-local-deleted.md",status:"changed",reason:"local-deleted",local:false,remote:true},
      {path:"Notes/tracked-remote-deleted.md",status:"changed",reason:"remote-deleted",local:true,remote:false},
      {path:"Notes/moved-original.md",status:"changed",reason:"remote-renamed-from",relatedPath:"Archive/moved.md",local:true,remote:false},
      {path:"Archive/moved.md",status:"changed",reason:"remote-renamed-to",relatedPath:"Notes/moved-original.md",local:false,remote:true},
    ]});
    await view.renderFilesMode();
    return {chips:[...document.querySelectorAll(".github-sync-center__file-filters button")].map(e=>e.textContent.trim()),
      tree:!!document.querySelector(".github-sync-center__folder-toggle"),records:document.querySelectorAll(".github-sync-center__file-row").length};
  })()`);
  checked("native file-status filters and tree render from synthetic verified-shaped snapshot",
    filesMock.chips.includes("All 9")&&filesMock.chips.includes("Changed 6")
    &&filesMock.chips.includes("Local only 1")&&filesMock.chips.includes("Remote 1")
    &&filesMock.chips.includes("Synced 1")&&filesMock.tree&&filesMock.records===9,
    JSON.stringify(filesMock));
  await record("17-files-tree",{cropSelector:".github-sync-center"});
  const changedMock=await evaluate(`(()=>{
    const button=[...document.querySelectorAll(".github-sync-center__file-filters button")]
      .find(e=>e.textContent.trim()==="Changed 6");
    if(!button)throw Error("Changed filter missing");
    button.click();
    return {count:document.querySelectorAll(".github-sync-center__file-row").length,
      active:button.getAttribute("aria-pressed")};
  })()`);
  checked("native Changed filter includes tracked deletions",changedMock.count===6&&changedMock.active==="true",JSON.stringify(changedMock));
  const deletionMock=await evaluate(`(()=>{
    const local=document.querySelector('[aria-label="Notes/tracked-local-deleted.md, Deleted locally"]');
    const remote=document.querySelector('[aria-label="Notes/tracked-remote-deleted.md, Deleted remotely"]');
    if(!local||!remote)return {missing:true};
    local.click();
    const localWarning=document.querySelector(".github-sync-center__file-warning")?.textContent??"";
    remote.click();
    const remoteWarning=document.querySelector(".github-sync-center__file-warning")?.textContent??"";
    remote.scrollIntoView({block:"nearest"});
    return {localWarning:localWarning.includes("may propagate this deletion"),
      remoteWarning:remoteWarning.includes("may remove the local file")};
  })()`);
  checked("native deleted-file warnings are explicit and distinguish deletion direction",
    deletionMock.localWarning&&deletionMock.remoteWarning,JSON.stringify(deletionMock));
  const renameMock=await evaluate(`(()=>{
    const source=document.querySelector('[aria-label="Notes/moved-original.md, Moved on GitHub"]');
    const target=document.querySelector('[aria-label="Archive/moved.md, Renamed on GitHub"]');
    if(!source||!target)return {missing:true};
    source.click();
    const sourceDescription=document.querySelector(".github-sync-center__file-warning")?.textContent??"";
    target.click();
    const targetDescription=document.querySelector(".github-sync-center__file-warning")?.textContent??"";
    target.scrollIntoView({block:"nearest"});
    return {source:sourceDescription.includes("Archive/moved.md"),
      target:targetDescription.includes("Notes/moved-original.md"),
      incorrectlyDeleted:targetDescription.includes("may remove the local file")};
  })()`);
  checked("native remote rename keeps file lineage distinct from deletion warnings",
    renameMock.source&&renameMock.target&&!renameMock.incorrectlyDeleted,JSON.stringify(renameMock));
  await record("18-files-changed-filter",{cropSelector:".github-sync-center"});
  await evaluate(`(async()=>{
    const d=window.__syncUiDemo,p=app.plugins.plugins[${JSON.stringify(id)}];
    d.runtime.fileOverview=d.realOverview;
    p.settings.githubOwner=d.owner;p.settings.githubRepo=d.repo;p.settings.githubBranch=d.branch;
    await d.view.renderCommitMode();
    delete window.__syncUiDemo;
  })()`);
  // Side-by-side hunk review in an actual native Obsidian modal. No run is
  // enqueued, and Cancel is asserted to produce a no-op resolution.
  const conflictOpened=await evaluate(`(()=>{
    const p=app.plugins.plugins[${JSON.stringify(id)}];
    const enc=new TextEncoder();
    const local="## Notes\\nRate: 100\\nOwner: Local\\nShared heading\\nLocal edits\\nFinal line";
    const remote="## Notes\\nRate: 120\\nOwner: Remote\\nShared heading\\nRemote edits\\nFinal line";
    window.__uiConflictPreview=p.v4Runtime.askConflict("Notes/sample-conflict.md",
      new AbortController().signal,enc.encode(local),enc.encode(remote));
    return true;
  })()`);
  await sleep(200);
  const modalState=await evaluate(`(()=>({
    visible:!!document.querySelector(".github-sync-conflict"),
    hunks:document.querySelectorAll(".github-sync-conflict__hunk").length,
    disabled:document.querySelector(".github-sync-conflict__apply")?.disabled,
  }))()`);
  checked("real desktop conflict modal shows two independent hunks and disabled Apply",
    conflictOpened&&modalState.visible&&modalState.hunks===2&&modalState.disabled,JSON.stringify(modalState));
  await record("19-conflict-desktop",{visibleSelector:".github-sync-conflict"});
  const decisions=await evaluate(`(()=>{
    const click=(label)=>{
      const button=[...document.querySelectorAll(".github-sync-conflict__line-actions button")]
        .find(el=>el.getAttribute("aria-label")===label);
      if(!button)throw Error("Missing per-line decision: "+label);
      button.click();
    };
    const steps=[
      "Change 1 local line 1: keep",
      "Change 1 local line 2: omit",
      "Change 1 remote line 1: omit",
      "Change 1 remote line 2: keep",
      "Change 2 local line 1: keep",
      "Change 2 remote line 1: omit",
    ];
    for(const label of steps.slice(0,-1))click(label);
    const guarded=document.querySelector(".github-sync-conflict__apply").disabled;
    click(steps[steps.length-1]);
    const output=document.querySelector(".github-sync-conflict__output");
    return {guarded,disabled:document.querySelector(".github-sync-conflict__apply").disabled,
      choices:document.querySelectorAll('.github-sync-conflict__line-actions button[aria-pressed="true"]').length,
      text:output.value.slice(0,250)};
  })()`);
  checked("native conflict can merge individual lines from both sides of one change",
    decisions.guarded&&!decisions.disabled&&decisions.choices===6
      &&decisions.text.includes("Rate: 100")&&decisions.text.includes("Owner: Remote")
      &&!decisions.text.includes("Owner: Local")&&!decisions.text.includes("Rate: 120")
      &&decisions.text.includes("Local edits"),JSON.stringify(decisions));
  const custom=await evaluate(`(()=>{
    const editor=document.querySelector(".github-sync-conflict__editor");
    const original=editor.value;
    editor.value=original+"\\nEdited in preview";
    editor.dispatchEvent(new Event("input",{bubbles:true}));
    const button=[...document.querySelectorAll(".github-sync-conflict__line-actions button")]
      .find(el=>el.getAttribute("aria-label")==="Change 1 remote line 1: keep");
    button.click();
    const preserved=editor.value.endsWith("Edited in preview");
    document.querySelector('[aria-label="Discard manual edits and restore selected lines"]').click();
    return {preserved,reset:editor.value.includes("Rate: 120")&&!editor.value.includes("Edited in preview"),
      enabled:!document.querySelector(".github-sync-conflict__apply").disabled};
  })()`);
  checked("native editable merge preserves manual edits until explicit reset",
    custom.preserved&&custom.reset&&custom.enabled,JSON.stringify(custom));
  await record("20-conflict-reviewed",{visibleSelector:".github-sync-conflict"});
  await activeSend("Emulation.setDeviceMetricsOverride",{width:390,height:780,deviceScaleFactor:1,mobile:false});
  await record("21-conflict-compact-390");
  await activeSend("Emulation.clearDeviceMetricsOverride");
  const cancelled=await evaluate(`(async()=>{
    const button=[...document.querySelectorAll(".github-sync-conflict__actions button")]
      .find(e=>e.textContent.trim()==="Cancel");
    if(!button)throw Error("Native conflict Cancel missing");
    button.click();
    const result=await window.__uiConflictPreview;
    delete window.__uiConflictPreview;
    return {action:result.action,remaining:document.querySelectorAll(".github-sync-conflict").length};
  })()`);
  checked("native review Cancel never applies or leaves the modal open",
    cancelled.action==="ask"&&cancelled.remaining===0,JSON.stringify(cancelled));
  const largeReview=await evaluate(`(async()=>{
    const p=app.plugins.plugins[${JSON.stringify(id)}];
    const enc=new TextEncoder();
    const a=Array.from({length:12000},(_,i)=>"local text line "+i).join("\\n");
    const b=Array.from({length:12000},(_,i)=>"remote text line "+i).join("\\n");
    const started=performance.now();
    window.__uiLargeConflict=p.v4Runtime.askConflict("Notes/large-review.md",
      new AbortController().signal,enc.encode(a),enc.encode(b));
    // Cooperative diff deliberately yields to the UI: wait for the actual
    // review state, not a fixed 240ms that flakes on a cold clean checkout.
    const deadline=performance.now()+12000;
    while(!document.querySelector(".github-sync-conflict") && performance.now()<deadline){
      await new Promise(resolve=>setTimeout(resolve,80));
    }
    const elapsed=Math.round(performance.now()-started);
    return {elapsed,visible:!!document.querySelector(".github-sync-conflict"),
      rows:document.querySelectorAll(".github-sync-conflict__line").length,
      hasPaging:!![...document.querySelectorAll(".github-sync-conflict__pager button")]
        .find(e=>e.textContent.trim()==="Next lines"),
      disabled:document.querySelector(".github-sync-conflict__apply")?.disabled};
  })()`);
  checked("native 12k-line conflict uses a bounded page instead of 24k mounted rows",
    largeReview.visible&&largeReview.rows<=96&&largeReview.hasPaging&&largeReview.disabled,
    JSON.stringify(largeReview));
  const nextPage=await evaluate(`(()=>{
    [...document.querySelectorAll(".github-sync-conflict__pager button")]
      .find(e=>e.textContent.trim()==="Next lines").click();
    const later=!!document.querySelector('[aria-label="Change 1 remote line 49: keep"]');
    const earlier=!!document.querySelector('[aria-label="Change 1 remote line 1: keep"]');
    const rows=document.querySelectorAll(".github-sync-conflict__line").length;
    return {later,earlier,rows};
  })()`);
  checked("paged conflict reuses DOM for later lines while preserving line identity",
    nextPage.later&&!nextPage.earlier&&nextPage.rows<=96,JSON.stringify(nextPage));
  const bulkReview=await evaluate(`(()=>{
    const started=performance.now();
    document.querySelector('[aria-label="Change 1: local"]').click();
    const afterShortcut=Math.round(performance.now()-started);
    const editor=document.querySelector(".github-sync-conflict__editor");
    const baseline=editor.value.includes("local text line 48")
      &&!editor.value.includes("remote text line 48");
    document.querySelector('[aria-label="Change 1 remote line 49: keep"]').click();
    const override=editor.value.includes("local text line 48")
      &&editor.value.includes("remote text line 48");
    return {afterShortcut,baseline,override,
      ready:!document.querySelector(".github-sync-conflict__apply").disabled,
      mounted:document.querySelectorAll(".github-sync-conflict__line").length,
      selected:document.querySelector('[aria-label="Change 1 remote line 49: keep"]').getAttribute("aria-pressed")};
  })()`);
  checked("native large hunk shortcut and one-line override preserve exact merged content without expanding DOM",
    bulkReview.baseline&&bulkReview.override&&bulkReview.ready&&bulkReview.mounted<=96
      &&bulkReview.selected==="true",JSON.stringify(bulkReview));
  await record("22-conflict-large-paged",{visibleSelector:".github-sync-conflict"});
  const canceledLarge=await evaluate(`(async()=>{
    [...document.querySelectorAll(".github-sync-conflict__actions button")]
      .find(e=>e.textContent.trim()==="Cancel").click();
    const r=await window.__uiLargeConflict;
    delete window.__uiLargeConflict;
    return {action:r.action,remaining:document.querySelectorAll(".github-sync-conflict").length};
  })()`);
  checked("large paged review Cancel is a no-op",canceledLarge.action==="ask"&&canceledLarge.remaining===0,JSON.stringify(canceledLarge));
  const denseReview=await evaluate(`(async()=>{
    const p=app.plugins.plugins[${JSON.stringify(id)}];
    const enc=new TextEncoder();
    const dense="\\n".repeat(1100000);
    window.__uiDenseConflict=p.v4Runtime.askConflict("Notes/dense-review.md",
      new AbortController().signal,enc.encode(dense),enc.encode(dense+"other"));
    await new Promise(resolve=>setTimeout(resolve,0));
    return {visible:!!document.querySelector(".github-sync-conflict"),
      editor:!!document.querySelector(".github-sync-conflict__editor"),
      rows:document.querySelectorAll(".github-sync-conflict__line").length,
      warning:[...document.querySelectorAll(".github-sync-conflict__intro")].some(e=>e.textContent.includes("line-dense")),
      wholeFile:!![...document.querySelectorAll(".github-sync-conflict__actions button")]
        .find(e=>e.textContent.trim()==="Use remote")};
  })()`);
  checked("native line-dense review refuses huge line arrays and keeps whole-file actions",
    denseReview.visible&&!denseReview.editor&&denseReview.rows===0
      &&denseReview.warning&&denseReview.wholeFile,JSON.stringify(denseReview));
  const canceledDense=await evaluate(`(async()=>{
    [...document.querySelectorAll(".github-sync-conflict__actions button")]
      .find(e=>e.textContent.trim()==="Cancel").click();
    const answer=await window.__uiDenseConflict;
    delete window.__uiDenseConflict;
    return {action:answer.action,remaining:document.querySelectorAll(".github-sync-conflict").length};
  })()`);
  checked("native dense review Cancel never writes or leaves a modal",
    canceledDense.action==="ask"&&canceledDense.remaining===0,JSON.stringify(canceledDense));
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
  // Exercise the real Electron keyboard path without creating a GitHub client,
  // storing credentials, or invoking either destructive action.
  for (const mode of ["forcePush", "forcePull"]) {
    const opened = await evaluate(`(()=>{
      const plugin=app.plugins.plugins[${JSON.stringify(id)}];
      if(plugin.githubClient)throw Error("UI fixture must not have a GitHub client");
      plugin.settings.githubOwner="synthetic-owner";
      plugin.settings.githubRepo="synthetic-repo";
      plugin.settings.githubBranch="synthetic-branch";
      plugin.settings.githubToken="invalid-fixture-token";
      void plugin.showForceConfirm(${JSON.stringify(mode)});
      const slider=document.querySelector(".github-sync-force-confirm-slider");
      slider?.focus();
      const dialog=slider?.closest(".modal-container");
      const forceButton=[...(dialog?.querySelectorAll("button")??[])].find(e=>/^Force (push|pull)$/u.test(e.textContent.trim()));
      return {slider:!!slider,focused:document.activeElement===slider,role:slider?.getAttribute("role"),
        label:slider?.getAttribute("aria-label"),value:slider?.getAttribute("aria-valuenow"),
        hidden:forceButton?.style.display==="none",hasClient:!!plugin.githubClient};
    })()`);
    checked(`${mode} real Obsidian keyboard slider initial state`,
      opened.slider&&opened.focused&&opened.role==="slider"&&opened.value==="0"&&opened.hidden
        &&!opened.hasClient&&opened.label.includes("synthetic-owner/synthetic-repo on synthetic-branch"),
      JSON.stringify(opened));
    for(let index=0;index<9;index++){
      await send("Input.dispatchKeyEvent",{type:"keyDown",key:"ArrowRight",code:"ArrowRight",windowsVirtualKeyCode:39});
      await send("Input.dispatchKeyEvent",{type:"keyUp",key:"ArrowRight",code:"ArrowRight",windowsVirtualKeyCode:39});
    }
    const partial=await evaluate(`(()=>{
      const slider=document.querySelector(".github-sync-force-confirm-slider");
      const dialog=slider?.closest(".modal-container");
      const forceButton=[...(dialog?.querySelectorAll("button")??[])].find(e=>/^Force (push|pull)$/u.test(e.textContent.trim()));
      return {value:slider?.getAttribute("aria-valuenow"),hidden:forceButton?.style.display==="none"};
    })()`);
    checked(`${mode} nine real ArrowRight presses cannot enable Force`,partial.value==="90"&&partial.hidden,JSON.stringify(partial));
    await send("Input.dispatchKeyEvent",{type:"keyDown",key:"ArrowRight",code:"ArrowRight",windowsVirtualKeyCode:39});
    await send("Input.dispatchKeyEvent",{type:"keyUp",key:"ArrowRight",code:"ArrowRight",windowsVirtualKeyCode:39});
    const unlocked=await evaluate(`(()=>{
      const slider=document.querySelector(".github-sync-force-confirm-slider");
      const dialog=slider?.closest(".modal-container");
      const forceButton=[...(dialog?.querySelectorAll("button")??[])].find(e=>/^Force (push|pull)$/u.test(e.textContent.trim()));
      return {value:slider?.getAttribute("aria-valuenow"),text:slider?.getAttribute("aria-valuetext"),
        actionVisible:!!forceButton&&forceButton.style.display!=="none"};
    })()`);
    checked(`${mode} ten real ArrowRight presses unlock but never execute`,
      unlocked.value==="100"&&/Unlocked/u.test(unlocked.text)&&unlocked.actionVisible,JSON.stringify(unlocked));
    await record(mode==="forcePush"?"12-force-push-keyboard-unlocked":"13-force-pull-keyboard-unlocked",
      {visibleSelector:".github-sync-force-confirm-slider"});
    const cancelled=await evaluate(`(()=>{
      const plugin=app.plugins.plugins[${JSON.stringify(id)}];
      const slider=document.querySelector(".github-sync-force-confirm-slider");
      const dialog=slider?.closest(".modal-container");
      const cancel=[...(dialog?.querySelectorAll("button")??[])].find(e=>e.textContent.trim()==="Cancel");
      cancel?.click();
      plugin.settings.githubOwner="";
      plugin.settings.githubRepo="";
      plugin.settings.githubBranch="main";
      plugin.settings.githubToken="";
      return {cancelFound:!!cancel,hasClient:!!plugin.githubClient,
        cleared:!plugin.settings.githubToken&&!plugin.settings.githubOwner&&!plugin.settings.githubRepo};
    })()`);
    checked(`${mode} keyboard confirmation cancelled without a remote client`,
      cancelled.cancelFound&&!cancelled.hasClient&&cancelled.cleared,JSON.stringify(cancelled));
  }
  if(evidence.exceptions.length)evidence.warnings.push(`Runtime exceptions seen: ${evidence.exceptions.length}; inspect exceptions array`);
} catch(err) {
  evidence.failure=String(err?.stack||err).slice(0,1800);
  process.exitCode=1;
} finally {
  if(ws)try{ws.close()}catch{}
  // Only the process launched by THIS invocation may be terminated. Attach
  // mode never shuts down an existing instance. --keep-open is opt-in.
  if(!attach && evidence.launchedPid && !args.includes("--keep-open")) {
    const stopped=spawnSync("taskkill", ["/PID", String(evidence.launchedPid), "/T", "/F"], {encoding:"utf8",timeout:15000});
    if(stopped.status!==0) evidence.warnings.push("Could not shut down isolated Obsidian process; close its synthetic test window manually.");
  }
  try{await mkdir(screenshots,{recursive:true});await writeFile(path.join(screenshots,"report.json"),JSON.stringify(evidence,null,2)+"\n");}catch(e){console.error("Failed to write UI evidence:",String(e));process.exitCode=1;}
  console.log(JSON.stringify({status:process.exitCode?"FAILED":"PASSED",checks:evidence.checks.length,screenshots:evidence.screenshots.map(s=>({name:s.name,path:s.path,bytes:s.bytes})),warnings:evidence.warnings,exceptions:evidence.exceptions,failure:evidence.failure,report:path.join(screenshots,"report.json")},null,2));
}
