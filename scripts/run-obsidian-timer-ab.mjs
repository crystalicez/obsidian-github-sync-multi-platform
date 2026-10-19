#!/usr/bin/env node
// Local-only experiment: real Obsidian's production request scheduler, synthetic writes.
// Never supplies GitHub credentials, never invokes GitHub or performs a remote mutation.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginId = "encrypted-github-sync-multi-platform";
const runId = randomBytes(8).toString("hex");
const runRoot = path.join(sourceRoot, ".tmp", "obsidian-timer-ab", runId);
const vault = path.join(runRoot, "vault");
const profile = path.join(runRoot, "profile");
const exe = process.env.OBSIDIAN_TEST_EXE || "C:\\Program Files\\Obsidian\\Obsidian.exe";
const port = 20000 + (process.pid % 35000);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const args = new Set(process.argv.slice(2));
const longHidden = !args.has("--short-hidden");
let child, ws, serial = 0;
const pending = new Map();
const requireProof = (condition, message) => assert.ok(condition, message);

async function cdp(method, params = {}, timeoutMs = 15000) {
  const id = ++serial;
  return new Promise((resolve, reject) => {
    const watchdog = setTimeout(() => { pending.delete(id); reject(new Error("CDP timeout " + method)); }, timeoutMs);
    watchdog.unref();
    pending.set(id, { resolve, reject, watchdog });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const out = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (out.exceptionDetails) throw new Error("Synthetic Obsidian experiment exception: " + String(out.exceptionDetails.text));
  return out.result?.value;
}
async function waitPage() {
  const deadline = Date.now() + 65000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) });
      const t = (await r.json()).find(x => x.type === "page" && x.url === "app://obsidian.md/index.html" && x.webSocketDebuggerUrl);
      if (t) return t;
    } catch {}
    await pause(250);
  }
  throw new Error("New isolated Obsidian page did not open");
}
async function waitVisible(expected, timeoutMs = 18000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await evaluate("document.visibilityState");
    if (state === expected) return state;
    await pause(400);
  }
  throw new Error("Real isolated Obsidian window did not become " + expected);
}
function windowState(state) {
  const code = `
  $ErrorActionPreference='Stop'
  Add-Type -Namespace NativeAB -Name Window -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int command); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);'
  $processes=Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'Obsidian.exe' -and $_.CommandLine -like '*${runId}*' }
  $handles=@($processes | ForEach-Object { (Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue).MainWindowHandle } | Where-Object { $_ -ne [IntPtr]::Zero })
  if ($handles.Count -ne 1) { throw "Expected one isolated test window, got $($handles.Count)" }
  $handle=$handles[0]
  [NativeAB.Window]::ShowWindowAsync($handle, ${state === "visible" ? 9 : 6}) | Out-Null
  if ('${state}' -eq 'visible') { [NativeAB.Window]::SetForegroundWindow($handle) | Out-Null }
  Write-Output 'TEST_WINDOW_TOGGLED'
  `;
  const r = spawnSync("powershell", ["-NoProfile", "-Command", code], { encoding: "utf8", windowsHide: true, timeout: 20000 });
  requireProof(r.status === 0 && r.stdout.includes("TEST_WINDOW_TOGGLED"), "Could not change isolated Obsidian window visibility: " + (r.stderr || r.stdout).slice(0,250));
}

const runExpression = `(()=> {
  const base = app?.vault?.adapter?.getBasePath?.() || "";
  if (!base.includes("${runId}") || !base.includes("obsidian-timer-ab")) throw Error("Wrong vault: A/B refused");
  const p = app.plugins.plugins["${pluginId}"];
  if (!p?.githubClient?.requestScheduler) throw Error("Production request scheduler missing");
  if (globalThis.__timerAb?.active) throw Error("Previous A/B round still running");
  const Constructor = p.githubClient.requestScheduler.constructor;
  const jobs = {};
  const state = { active: true, visibility: document.visibilityState, jobs, started: performance.now() };
  globalThis.__timerAb = state;
  for (const kind of ["browser", "node"]) {
    const controller = new AbortController();
    const starts = [], wallStarts = [], delays = [];
    const timer = kind === "browser" ? window.setTimeout.bind(window) : require("node:timers").setTimeout;
    const scheduler = new Constructor({
      mutationSpacingMs: 1000, writeConcurrency: 2, maxAttempts: 1,
      sleep: ms => new Promise(resolve => timer(resolve, ms)),
      onDelay: e => delays.push(e.milliseconds),
    });
    const job = { kind, started: 0, finished: false, errors: [], starts, wallStarts, delays, aborted: false, controller, scheduler };
    jobs[kind] = job;
    const tasks = Array.from({ length: 10 }, (_, i) => scheduler.run("write", async () => {
      starts.push(performance.now()); wallStarts.push(Date.now()); job.started++; return i;
    }, controller.signal));
    Promise.allSettled(tasks).then(results => {
      job.finished = true;
      job.errors = results.filter(r => r.status === "rejected").map(r => String(r.reason?.message ?? r.reason).slice(0,80));
    });
  }
  return { launched: true, visibility: state.visibility };
})()`;
async function observe() {
  return evaluate(`(()=> {
    const s = globalThis.__timerAb; if (!s) return null;
    const map = {};
    for (const [kind, job] of Object.entries(s.jobs)) {
      const intervals = job.starts.slice(1).map((t, i) => Math.round(t - job.starts[i]));
      const wallIntervals = job.wallStarts.slice(1).map((t, i) => t - job.wallStarts[i]);
      map[kind] = {
        kind, completed: job.started, finished: job.finished, errors: job.errors,
        minWallSpacingMs: wallIntervals.length ? Math.min(...wallIntervals) : null,
        minSpacingMs: intervals.length ? Math.min(...intervals) : null,
        maxSpacingMs: intervals.length ? Math.max(...intervals) : null,
        elapsedMs: job.starts.length ? Math.round(job.starts.at(-1) - job.starts[0]) : 0,
        maxSleepOvershootMs: Math.round(job.scheduler.snapshot.maxPolicySleepOvershootMs),
        oldestSleepOverdueMs: Math.round(job.scheduler.snapshot.oldestPolicySleepOverdueMs),
        activeSleeps: job.scheduler.snapshot.activePolicySleeps,
        queuedWrites: job.scheduler.snapshot.queuedWrites,
      };
    }
    return { visibility: document.visibilityState, jobs: map };
  })()`);
}
async function runPair(label, timeoutMs) {
  const launched = await evaluate(runExpression);
  requireProof(launched?.launched === true, "Production scheduler A/B did not start");
  const end = Date.now() + timeoutMs;
  let final;
  do {
    final = await observe();
    if (final?.jobs?.browser?.finished && final?.jobs?.node?.finished) break;
    await pause(1100);
  } while (Date.now() < end);
  if (!final?.jobs?.browser?.finished || !final?.jobs?.node?.finished) {
    await evaluate("(()=> {for (const j of Object.values(globalThis.__timerAb.jobs)) if (!j.finished) j.controller.abort('A/B observation deadline'); return true})()");
    await pause(200);
    final = await observe();
  }
  const info = { kind: "native-timer-ab", label, ...final };
  console.log(JSON.stringify(info));
  for (const v of Object.values(final.jobs)) {
    if (v.completed >= 2) requireProof(v.minWallSpacingMs >= 1000,
      "Scheduler policy clock allowed writes sooner than 1,000 ms for " + v.kind);
    requireProof(v.errors.length === (v.finished && v.completed === 10 ? 0 : 10 - v.completed), "A/B cancellation did not account for remaining tasks");
  }
  await evaluate("(()=>{globalThis.__timerAb.active=false; return true})()");
  return info;
}

const observations = [];
try {
  assert.equal(process.platform, "win32", "Native Obsidian A/B only runs on Windows");
  // Never connect to a port already used by a separate application.
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(900) });
    if (r.ok) throw Error("CDP port occupied");
  } catch (e) {
    if (String(e).includes("CDP port occupied")) throw e;
  }
  await mkdir(path.join(vault, ".obsidian", "plugins", pluginId), { recursive: true });
  await mkdir(profile, { recursive: true });
  for (const file of ["main.js", "manifest.json", "styles.css"]) await copyFile(path.join(sourceRoot, file), path.join(vault, ".obsidian", "plugins", pluginId, file));
  await writeFile(path.join(vault, ".obsidian", "community-plugins.json"), JSON.stringify([pluginId]));
  await writeFile(path.join(vault, "Synthetic.md"), "# Disposable local timer experiment\n");
  await writeFile(path.join(profile, "obsidian.json"), JSON.stringify({ vaults: { "b342e771": { path: vault, ts: Date.now(), open: true } } }));
  child = spawn(exe, [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`], { detached: true, windowsHide: false, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
  const page = await waitPage();
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error("CDP connection failed")); });
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(String(data)); if (!message.id) return;
    const waiter = pending.get(message.id); if (!waiter) return;
    pending.delete(message.id); clearTimeout(waiter.watchdog);
    message.error ? waiter.reject(Error(String(message.error.message))) : waiter.resolve(message.result);
  };
  await cdp("Runtime.enable");
  const identityDeadline = Date.now() + 45000;
  let identity;
  while (Date.now() < identityDeadline) {
    identity = await evaluate("(()=>typeof app !== 'undefined' && app.vault?.adapter?.getBasePath ? app.vault.adapter.getBasePath() : null)()");
    if (identity) break;
    await pause(300);
  }
  assert.equal(identity?.toLowerCase(), vault.toLowerCase(), "Refusing A/B outside freshly generated synthetic vault");
  const loaded = await evaluate(`(async()=>{
    const pid = "${pluginId}";
    if (!app.plugins.isEnabled()) await app.plugins.setEnable(true);
    if (!app.plugins.enabledPlugins.has(pid)) await app.plugins.enablePluginAndSave(pid);
    await app.plugins.loadPlugin(pid);
    const deadline = Date.now() + 15000;
    while (!app.plugins.plugins[pid] && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 250));
      if (app.plugins.manifests[pid] && !app.plugins.loadingPluginId) await app.plugins.loadPlugin(pid);
    }
    const p = app.plugins.plugins[pid];
    if (!p) return { ready: false, reason: 'not-loaded' };
    if (p.settings.githubOwner || p.settings.githubRepo || p.settings.githubToken) throw Error("Unexpected GitHub configuration");
    Object.assign(p.settings, {
      githubOwner: "unused-local-timer-a-b", githubRepo: "unused-local-timer-a-b",
      githubToken: "NO_NETWORK_LOCAL_ONLY", githubBranch: "unused",
      syncEnabled: false, syncOnStartup: false, syncOnLocalChange: false,
      scheduledSyncEnabled: false,
    });
    p.initGitHubClient();
    return { ready: !!p.githubClient?.requestScheduler && p.settings.syncEnabled === false,
      client: !!p.githubClient, scheduler: !!p.githubClient?.requestScheduler,
      clientCtor: p.githubClient?.constructor?.name ?? null, syncEnabled: p.settings.syncEnabled };
  })()`);
  requireProof(loaded?.ready === true, "Isolated production scheduler unavailable: " + JSON.stringify(loaded));
  // A headless Windows worker cannot make a native Obsidian window actually visible.
  // CDP focus emulation is a positive control, not proof of physical foreground behavior.
  windowState("visible");
  await cdp("Emulation.setFocusEmulationEnabled", { enabled: true });
  await waitVisible("visible");
  observations.push(await runPair("cdp-emulated-visible-1", 80000));
  observations.push(await runPair("cdp-emulated-visible-2", 80000));
  await cdp("Emulation.setFocusEmulationEnabled", { enabled: false });
  windowState("hidden");
  await waitVisible("hidden");
  console.log(JSON.stringify({ kind: "native-timer-ab-hidden-precondition", durationMs: longHidden ? 310000 : 5000, visibility: "hidden" }));
  await pause(longHidden ? 310000 : 5000);
  await waitVisible("hidden");
  observations.push(await runPair("hidden-1", 105000));
  observations.push(await runPair("hidden-2", 105000));
  windowState("visible");
  await cdp("Emulation.setFocusEmulationEnabled", { enabled: true });
  await waitVisible("visible");
  observations.push(await runPair("cdp-emulated-visible-recovery", 80000));
  console.log(JSON.stringify({ status: "AB_FINISHED", source: "actual-production-scheduler", localOnly: true, githubMutations: 0, observations: observations.length }));
} finally {
  try { ws?.close(); } catch {}
  if (child?.pid) {
    const result = spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { encoding: "utf8", timeout: 20000, windowsHide: true });
    console.log(JSON.stringify({ kind: "native-timer-ab-process-cleanup", exitCode: result.status, pid: child.pid }));
  }
  try { await rm(runRoot, { recursive: true, force: true, maxRetries: 6, retryDelay: 1000 }); console.log(JSON.stringify({ kind: "native-timer-ab-cleanup", removedSyntheticRunRoot: true })); }
  catch (error) { console.log(JSON.stringify({ kind: "native-timer-ab-cleanup", removedSyntheticRunRoot: false, error: String(error?.message ?? error).slice(0, 120) })); }
}
