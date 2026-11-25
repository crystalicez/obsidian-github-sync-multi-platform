#!/usr/bin/env node
// Native isolated SecretStorage persistence probe; no GitHub writes or credentials.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildNativePluginReadyExpression } from "./native-obsidian-plugin-ready.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginId = "encrypted-github-sync-multi-platform";
const exe = "C:\\Program Files\\Obsidian\\Obsidian.exe";
const port = 28000 + (process.pid % 27000);
const tmpParent = path.join(root, ".tmp", "obsidian-secret-storage-probe");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let child, ws, runRoot, nextId = 0;
const pending = new Map(), uiExceptions = [], ownedProcessIds = new Set();
const redact = () => "Renderer exception (redacted)";
function send(method, params = {}, timeoutMs = 25000) {
  assert.ok(ws?.readyState === WebSocket.OPEN, "CDP socket unavailable");
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP timeout: ${method}`));
    }, timeoutMs);
    pending.set(id, {
      resolve: value => { clearTimeout(timer); resolve(value); },
      reject: err => { clearTimeout(timer); reject(err); },
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evalInVault(expression, timeoutMs = 240000) {
  const out = await send("Runtime.evaluate", {
    expression, awaitPromise: true, returnByValue: true,
  }, timeoutMs);
  if (out.exceptionDetails) {
    throw new Error("Renderer exception: " + redact(out.exceptionDetails.exception?.description || out.exceptionDetails.text));
  }
  return out.result?.value;
}

async function connect(vaultPath) {
  let endpoint;
  for (let i = 0; i < 140; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1200) });
      if (res.ok) {
        const list = await res.json();
        endpoint = list.find(item => item.type === "page" && item.url === "app://obsidian.md/index.html" && item.webSocketDebuggerUrl);
        if (endpoint) break;
      }
    } catch {}
    await sleep(300);
  }
  assert.ok(endpoint, "Isolated Obsidian renderer unavailable");
  ws = new WebSocket(endpoint.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("CDP handshake failed")), { once: true });
  });
  ws.addEventListener("message", event => {
    const msg = JSON.parse(String(event.data));
    if (msg.method === "Runtime.exceptionThrown") uiExceptions.push("Uncaught UI exception");
    if (!msg.id) return;
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    if (msg.error) waiter.reject(new Error(String(msg.error.message || "CDP error").slice(0, 200)));
    else waiter.resolve(msg.result);
  });
  await send("Runtime.enable");
  for (let i = 0; i < 65; i++) {
    const base = await evalInVault("typeof app==='undefined'?null:app.vault?.adapter?.getBasePath?.()", 15000);
    if (base) {
      assert.equal(base.toLowerCase(), vaultPath.toLowerCase(), "Refusing renderer from wrong vault");
      break;
    }
    if (i === 64) throw new Error("Vault identity unavailable");
    await sleep(220);
  }
  let managerReady = false;
  for (let i = 0; i < 65; i++) {
    managerReady = await evalInVault(
      "(()=>{if(typeof app==='undefined')return false;const p=app.plugins;return !!p&&typeof p.isEnabled==='function'&&typeof p.setEnable==='function'&&typeof p.enablePluginAndSave==='function'&&typeof p.loadPlugin==='function'&&typeof p.enabledPlugins?.has==='function'})()",
      15000,
    );
    if (managerReady) break;
    await sleep(220);
  }
  assert.ok(managerReady, "Native plugin manager not ready");
  const loaded = await evalInVault(buildNativePluginReadyExpression(pluginId), 30000);
  assert.equal(loaded, true, "Production plugin failed to load");
  // Obsidian's manager may expose plugins[id] before its async onload()
  // finishes creating the ribbon. Saving Settings in that interval is not
  // equivalent to user interaction with a fully mounted plugin UI.
  let uiReady = false;
  for (let i = 0; i < 80; i++) {
    uiReady = await evalInVault(`(()=>{
      const p=app.plugins.plugins[${JSON.stringify(pluginId)}];
      return !!p?.ribbonIcon && !!p?.v4Runtime && !!p?.settingTab;
    })()`, 15000);
    if (uiReady) break;
    await sleep(180);
  }
  assert.equal(uiReady, true, "Installed plugin onload/ribbon not completed before simulated Settings interaction");
}

async function launch(profilePath, vaultPath) {
  child = spawn(exe, [`--user-data-dir=${profilePath}`, `--remote-debugging-port=${port}`], {
    detached: true, windowsHide: false, stdio: "ignore",
  });
  child.on("error", () => {});
  if (child.pid) ownedProcessIds.add(child.pid);
  child.unref();
  await connect(vaultPath);
}

function terminate() {
  if (!child?.pid) return;
  try { ws?.close(); } catch {}
  ws = undefined;
  const stop = spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
    encoding: "utf8", timeout: 18000, shell: false,
  });
  assert.equal(stop.status, 0, "Failed to terminate disposable Obsidian process");
  ownedProcessIds.delete(child.pid);
  child = undefined;
}

try {
  assert.equal(process.argv.length,2);
  try {
    const existing = await fetch(`http://127.0.0.1:${port}/json/list`, {signal:AbortSignal.timeout(1200)});
    if(existing.ok) throw Error("CDP port occupied");
  } catch(err) { if(!/fetch failed|ECONNREFUSED|timed out|TimeoutError/u.test(String(err))) throw err; }
  await mkdir(tmpParent,{recursive:true});
  for(const dir of [path.dirname(tmpParent),tmpParent]) {
    const info=await lstat(dir);
    assert.ok(info.isDirectory()&&!info.isSymbolicLink());
  }
  runRoot=await mkdtemp(path.join(tmpParent,"probe-"));
  const vault=path.join(runRoot,"vault"), profile=path.join(runRoot,"profile");
  const pluginDir=path.join(vault,".obsidian","plugins",pluginId);
  await mkdir(pluginDir,{recursive:true}); await mkdir(profile,{recursive:true});
  for(const name of ["main.js","manifest.json","styles.css"]) await copyFile(path.join(root,name),path.join(pluginDir,name));
  await writeFile(path.join(vault,".obsidian","community-plugins.json"),JSON.stringify([pluginId]));
  await writeFile(path.join(profile,"obsidian.json"),JSON.stringify({vaults:{probe:{path:vault,ts:Date.now(),open:true}}}));
  await launch(profile,vault);
  const results=[];
  for(const waitMs of [0,1000,5000]) {
    const id="rekey-passphrase-"+randomBytes(16).toString("hex"), value="synthetic-"+randomBytes(16).toString("hex");
    assert.equal(await evalInVault(`(()=>{if(app.secretStorage.getSecret(${JSON.stringify(id)})!==null)return false;app.secretStorage.setSecret(${JSON.stringify(id)},${JSON.stringify(value)});return app.secretStorage.getSecret(${JSON.stringify(id)})===${JSON.stringify(value)}})()`),true);
    if(waitMs) await sleep(waitMs);
    terminate(); await sleep(900); await launch(profile,vault);
    const persisted=await evalInVault(`app.secretStorage.getSecret(${JSON.stringify(id)})===${JSON.stringify(value)}`);
    results.push({waitMs,persisted});
    console.log(JSON.stringify({status:"OBSERVED",waitMs,persisted}));
  }
  assert.equal(uiExceptions.length,0);
  console.log(JSON.stringify({status:"PROBE_COMPLETE",results,uiExceptions:uiExceptions.length}));
} catch {console.error("Native probe failed (redacted)");process.exitCode=1}
finally {
  try {terminate(); for(const pid of ownedProcessIds) { const r=spawnSync("taskkill",["/PID",String(pid),"/T","/F"],{encoding:"utf8",timeout:18000,shell:false});assert.equal(r.status,0); }} catch{process.exitCode=1}
  if(runRoot&&!ownedProcessIds.size) {await rm(runRoot,{recursive:true,force:true,maxRetries:8,retryDelay:250});console.log(JSON.stringify({status:"TEMP_REMOVED"}))}
}
