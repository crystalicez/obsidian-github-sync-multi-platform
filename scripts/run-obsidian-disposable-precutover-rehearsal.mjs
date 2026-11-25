#!/usr/bin/env node
// D412: Real installed Windows Obsidian.exe + approved disposable GitHub repo
// (ID 1284153873) pre-cutover rehearsal: Source -> Backup -> Staging -> Scratch
// -> Destination without Cutover, followed by real Obsidian restart and read-only
// WAL/Backup/Destination recovery + Wizard UI fence verification.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildNativePluginReadyExpression } from "./native-obsidian-plugin-ready.mjs";
import {
  deriveGitHubE2EDestinationBranch,
  deriveGitHubE2EFrozenBackupBranch,
  loadGitHubE2EEnv,
  qualificationE2EBranch,
  resolvePinnedGitHubE2ERepoId,
  validateGitHubE2EConfig,
} from "./github-e2e-env.mjs";
import { cleanupE2EBranch, preflightE2ERemote, readE2EBranch } from "./github-e2e-remote.mjs";
import { CANONICAL_REPOSITORY_ID, readOriginFetchRepository } from "./github-repo.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginId = "encrypted-github-sync-multi-platform";
const exe = "C:\\Program Files\\Obsidian\\Obsidian.exe";
const initiatorPort = 28000 + (process.pid % 27000);
const stalePort = initiatorPort + 1;
let port = initiatorPort;
const tmpParent = path.join(root, ".tmp", "obsidian-installed-precutover-rehearsal");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const staleClientMode = process.argv.includes("--stale-client");
const secretMode = process.argv.includes("--stage-secret");
const shadowMode = secretMode || process.argv.includes("--shadow-index");
assert.ok(process.argv.slice(2).every(arg => arg === "--stale-client" || arg === "--shadow-index" || arg === "--stage-secret"),
  "Only --stale-client, --shadow-index and --stage-secret are supported; all writes must remain in approved disposable branches.");

const oldPassphrase = "d412-old-" + randomBytes(18).toString("base64url");
const newPassphrase = "d412-new-" + randomBytes(18).toString("base64url");
const runId = "d412live" + randomBytes(6).toString("hex");
const noteText = "# D412 Real Obsidian Rehearsal\n\nสวัสดีครับ 🌍\n";
const binaryBytes = Buffer.from(Array.from({ length: 2048 }, (_, i) => (i * 29 + 3) & 0xff));

let configuration;
let backupBranch;
let destinationBranch;
let refs = [];
let runRoot;
let child;
let ws;
let nextId = 0;
const pending = new Map();
const uiExceptions = [];
let passed = false;
let cleanupState = "not-started";
let remoteCleanupErrors = [];
let staleClientReport;
let staleSession;
const ownedProcessIds = new Set();

const redact = value => {
  let msg = String(value?.message ?? value ?? "");
  for (const secret of [configuration?.token, oldPassphrase, newPassphrase].filter(Boolean)) {
    msg = msg.replaceAll(secret, "[redacted]");
  }
  return msg
    .replace(/gh[pousr]_[A-Za-z0-9_]+/gu, "[redacted]")
    .replace(/github_pat_[A-Za-z0-9_]+/gu, "[redacted]")
    .slice(0, 400);
};

async function readWithRetry(refConfig) {
  for (let i = 0; i < 5; i++) {
    try {
      return await readE2EBranch(refConfig);
    } catch (err) {
      if (i === 4) throw err;
      await sleep((i + 1) * 1000);
    }
  }
  throw new Error("Unreachable retry state");
}

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
  // Check both fixed CDP ports before starting ANY disposable process.
  for (const checkPort of staleClientMode ? [initiatorPort, stalePort] : [initiatorPort]) {
    try {
      const existing = await fetch(`http://127.0.0.1:${checkPort}/json/list`, { signal: AbortSignal.timeout(1200) });
      if (existing.ok) throw new Error("CDP port already occupied");
    } catch (err) {
      if (!/fetch failed|ECONNREFUSED|timed out|TimeoutError/u.test(String(err))) throw err;
    }
  }

  for (const location of [path.dirname(tmpParent), tmpParent]) {
    await mkdir(location, { recursive: true });
    const info = await lstat(location);
    assert.ok(info.isDirectory() && !info.isSymbolicLink(), "Refusing linked/non-directory temp root");
  }

  const shaRes = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", shell: false });
  assert.equal(shaRes.status, 0);
  const sha = shaRes.stdout.trim();
  assert.match(sha, /^[a-f0-9]{40}$/u);

  const rootEnvPath = path.resolve(root, "..", "..", ".env.github-e2e");
  const localEnvPath = path.resolve(root, ".env.github-e2e");
  let envFile = rootEnvPath;
  try { await lstat(localEnvPath); envFile = localEnvPath; } catch {}
  const { env } = await loadGitHubE2EEnv({ cwd: root, env: process.env, envFile });
  const expectedRepoId = resolvePinnedGitHubE2ERepoId(env.GITHUB_E2E_EXPECTED_REPO_ID, "1284153873");
  assert.equal(expectedRepoId, "1284153873");

  const sourceBranch = qualificationE2EBranch(sha, randomBytes(8).toString("hex"));
  backupBranch = deriveGitHubE2EFrozenBackupBranch(sourceBranch);
  destinationBranch = deriveGitHubE2EDestinationBranch(sourceBranch);
  const sourceRepo = readOriginFetchRepository({
    runner: (cmd, args, opt) => spawnSync(cmd, args, { ...opt, shell: false }),
    cwd: root,
  });
  configuration = validateGitHubE2EConfig({
    owner: env.GITHUB_E2E_OWNER,
    repo: env.GITHUB_E2E_REPO,
    token: env.GITHUB_E2E_TOKEN,
    branch: sourceBranch,
    expectedRepoId,
    currentSourceRepo: sourceRepo,
  });
  assert.notEqual(configuration.expectedRepoId, CANONICAL_REPOSITORY_ID);

  const target = await preflightE2ERemote({
    config: { ...configuration, currentSourceRepoId: CANONICAL_REPOSITORY_ID },
  });
  assert.equal(target.id, "1284153873");

  for (const branch of [sourceBranch, backupBranch, destinationBranch]) {
    await preflightE2ERemote({
      config: { ...configuration, branch, currentSourceRepoId: CANONICAL_REPOSITORY_ID },
    });
  }
  refs = [sourceBranch, backupBranch, destinationBranch].map(branch => ({
    owner: configuration.owner,
    repo: configuration.repo,
    branch,
    token: configuration.token,
  }));
  for (const ref of refs) {
    const r1 = await readWithRetry(ref);
    await preflightE2ERemote({
      config: { ...configuration, branch: ref.branch, currentSourceRepoId: CANONICAL_REPOSITORY_ID },
    });
    const r2 = await readWithRetry(ref);
    assert.ok(r1.kind === "absent" && r2.kind === "absent", `Refusing pre-existing branch: ${ref.branch}`);
  }
  console.log(JSON.stringify({
    status: "ABSENT_FIRST",
    repoId: target.id,
    sourceBranch,
    backupBranch,
    destinationBranch,
  }));

  runRoot = await mkdtemp(path.join(tmpParent, "run-"));
  const vault = path.join(runRoot, "vault");
  const profile = path.join(runRoot, "profile");
  // D413: the separate old-key client is a second REAL Obsidian Vault and
  // profile, never the initiator's encrypted credentials or Index.
  const staleVault = path.join(runRoot, "stale-vault");
  const staleProfile = path.join(runRoot, "stale-profile");
  const pluginDir = path.join(vault, ".obsidian", "plugins", pluginId);
  await mkdir(pluginDir, { recursive: true });
  await mkdir(profile, { recursive: true });
  for (const name of ["main.js", "manifest.json", "styles.css"]) {
    await copyFile(path.join(root, name), path.join(pluginDir, name));
  }
  await writeFile(path.join(vault, ".obsidian", "community-plugins.json"), JSON.stringify([pluginId]) + "\n");
  await writeFile(path.join(profile, "obsidian.json"), JSON.stringify({
    vaults: { d412live: { path: vault, ts: Date.now(), open: true } },
  }) + "\n");
  await writeFile(path.join(vault, "D412-unicode-สวัสดี.md"), noteText, "utf8");
  await writeFile(path.join(vault, "D412-binary.bin"), binaryBytes);
  if (staleClientMode) {
    const stalePluginDir = path.join(staleVault, ".obsidian", "plugins", pluginId);
    await mkdir(stalePluginDir, { recursive: true });
    await mkdir(staleProfile, { recursive: true });
    for (const name of ["main.js", "manifest.json", "styles.css"]) {
      await copyFile(path.join(root, name), path.join(stalePluginDir, name));
    }
    await writeFile(path.join(staleVault, ".obsidian", "community-plugins.json"),
      JSON.stringify([pluginId]) + "\n");
    await writeFile(path.join(staleProfile, "obsidian.json"), JSON.stringify({
      vaults: { d413stale: { path: staleVault, ts: Date.now(), open: true } },
    }) + "\n");
  }

  await launch(profile, vault);

  // Configure disposable settings and seed Source commit via real Obsidian forcePush.
  await evalInVault(`(async()=>{
    const p=app.plugins.plugins[${JSON.stringify(pluginId)}];
    if(!p||p.settings.githubToken||p.settings.githubOwner||p.settings.githubRepo)
      throw Error("Expected unconfigured synthetic plugin");
    await p.saveSettings({
      ...p.settings,
      githubOwner:${JSON.stringify(configuration.owner)},
      githubRepo:${JSON.stringify(configuration.repo)},
      githubBranch:${JSON.stringify(sourceBranch)},
      githubToken:${JSON.stringify(configuration.token)},
      syncEnabled:true,syncOnStartup:false,syncOnLocalChange:false,scheduledSyncEnabled:false,
      encryptionMode:"encrypted",
      encryptionPassphrase:${JSON.stringify(oldPassphrase)},
      newVaultKdfIterations:600000,
      syncObsidianConfig:false,syncBookmarks:false,syncPlugins:false
    });
    const pushed=await p.v4Runtime.forcePush(false);
    const snap=p.v4Runtime.progressSnapshot;
    if(!["success","no-change"].includes(snap.lifecycle))
      throw Error("Seed forcePush failed: "+JSON.stringify({lifecycle:snap.lifecycle,phase:snap.failurePhase??snap.phase,apiFailures:snap.diagnostics?.apiFailures}));
    return {status:pushed?.status??null,lifecycle:snap.lifecycle};
  })()`, 240000);

  const seededRef = await readWithRetry(refs[0]);
  assert.equal(seededRef.kind, "present");

  if (staleClientMode) {
    // D413: establish a second, fully installed old-key client BEFORE
    // migration. Its local index must be pinned to the pre-rekey Source tip.
    // Keep BOTH processes alive: a stale client must retain its original
    // in-memory credentials and pre-rekey Index while the initiator migrates.
    // A SIGKILL immediately after first saving a brand-new profile may lose
    // SecretStorage writes (best-effort durability), which is a different test.
    const initiatorSession = { child, ws };
    child = undefined;
    ws = undefined;
    port = stalePort;
    await launch(staleProfile, staleVault);
    const staleBefore = await evalInVault(`(async()=>{
      const p=app.plugins.plugins[${JSON.stringify(pluginId)}];
      if(!p||p.settings.githubToken||p.settings.githubOwner||p.settings.githubRepo)
        throw Error("Stale Vault must begin with independent, empty settings");
      await p.saveSettings({
        ...p.settings,
        githubOwner:${JSON.stringify(configuration.owner)},
        githubRepo:${JSON.stringify(configuration.repo)},
        githubBranch:${JSON.stringify(sourceBranch)},
        githubToken:${JSON.stringify(configuration.token)},
        syncEnabled:true,syncOnStartup:false,syncOnLocalChange:false,scheduledSyncEnabled:false,
        encryptionMode:"encrypted",
        encryptionPassphrase:${JSON.stringify(oldPassphrase)},
        newVaultKdfIterations:600000,
        syncObsidianConfig:false,syncBookmarks:false,syncPlugins:false
      });
      await p.v4Runtime.forcePull(false);
      const note=await app.vault.adapter.read("D412-unicode-สวัสดี.md");
      const binary=await app.vault.adapter.readBinary("D412-binary.bin");
      return {
        sourceSelected:p.settings.githubBranch===${JSON.stringify(sourceBranch)},
        oldKeySelected:p.settings.encryptionPassphrase===${JSON.stringify(oldPassphrase)},
        pulledNote:note===${JSON.stringify(noteText)},
        pulledBinaryBytes:binary.byteLength,
        lifecycle:p.v4Runtime.progressSnapshot.lifecycle
      };
    })()`, 240000);
    assert.equal(staleBefore.sourceSelected, true);
    assert.equal(staleBefore.oldKeySelected, true);
    assert.equal(staleBefore.pulledNote, true);
    assert.equal(staleBefore.pulledBinaryBytes, binaryBytes.byteLength);
    assert.ok(["success", "no-change"].includes(staleBefore.lifecycle));
    assert.equal((await readWithRetry(refs[0])).sha, seededRef.sha,
      "Stale old-key initialization must not publish any remote change");
    staleSession = { child, ws };
    child = initiatorSession.child;
    ws = initiatorSession.ws;
    port = initiatorPort;
  }

  // Run D412 pre-cutover rehearsal inside live installed Obsidian.
  const rehearsal = await evalInVault(`(async()=>{
    const p=app.plugins.plugins[${JSON.stringify(pluginId)}];
    const report=await p.v4Runtime.runFencedReencryptionPreCutoverRehearsal({
      runId:${JSON.stringify(runId)},
      backupBranch:${JSON.stringify(backupBranch)},
      destinationBranch:${JSON.stringify(destinationBranch)},
      newPassphrase:${JSON.stringify(newPassphrase)},
      requestedIterations:600000,
      prepareShadowIndex:${JSON.stringify(shadowMode)},
      stageDestinationSecret:${JSON.stringify(secretMode)},
      acknowledgement:"accept-best-effort-power-loss-recovery-risk",
      assertExclusiveInitiatorLease:async()=>{}
    });
    return {
      report,
      ...(report.stagedSecret ? { stagedSecretVerified: app.secretStorage.getSecret(report.stagedSecret.destinationPassphraseSecretId)===${JSON.stringify(newPassphrase)}
        && report.stagedSecret.destinationPassphraseSecretId!==p.settings.encryptionPassphraseSecretId
        && report.stagedSecret.destinationPassphraseSecretId!==p.settings.githubTokenSecretId
        && app.secretStorage.getSecret(p.settings.encryptionPassphraseSecretId)===${JSON.stringify(oldPassphrase)} } : {}),
      branchStillSource:p.settings.githubBranch===${JSON.stringify(sourceBranch)},
      passphraseStillOld:p.settings.encryptionPassphrase===${JSON.stringify(oldPassphrase)},
      scratchExists:await app.vault.adapter.exists(".obsidian/plugins/${pluginId}/rekey-scratch-${runId}")
    };
  })()`, 300000);

  assert.equal(rehearsal.report.status, "destination-published-fenced-no-cutover");
  assert.equal(rehearsal.report.cutoverAuthorized, false);
  assert.equal(rehearsal.report.localCutoverExecuted, false);
  assert.equal(rehearsal.report.resumeSyncAuthorized, false);
  assert.equal(rehearsal.report.oldPassphraseCleanupAuthorized, false);
  assert.equal(rehearsal.report.powerLossDurabilityProven, false);
  assert.equal(rehearsal.report.verifiedFileCount, 2);
  assert.equal(rehearsal.report.scratchRestoredFileCount, 2);
  assert.equal(rehearsal.branchStillSource, true);
  assert.equal(rehearsal.passphraseStillOld, true);
  assert.equal(rehearsal.scratchExists, false);
  if (shadowMode) {
    assert.equal(rehearsal.report.shadow?.status, "shadow-index-staged-uncommitted");
    assert.equal(rehearsal.report.shadow?.verifiedFileCount, 2);
    assert.equal(rehearsal.report.shadow?.destinationCommitSha, rehearsal.report.destinationCommitSha);
    assert.equal(rehearsal.report.shadow?.resumeSyncAuthorized, false);
    assert.equal(rehearsal.report.shadow?.powerLossDurabilityProven, false);
  }

  if (secretMode) {
    assert.equal(rehearsal.report.stagedSecret?.status, "destination-secret-staged-uncommitted");
    assert.equal(rehearsal.stagedSecretVerified, true);
    assert.equal(rehearsal.report.stagedSecret?.oldPassphraseCleanupAuthorized, false);
    const data = await readFile(path.join(vault, ".obsidian/plugins", pluginId, "data.json"), "utf8");
    assert.ok(!data.includes(newPassphrase) && !data.includes(oldPassphrase));
    assert.ok(!data.includes(rehearsal.report.stagedSecret.destinationPassphraseSecretId));
  }
  // Confirm both Backup and Destination refs exist on real GitHub.
  const backupRemote = await readWithRetry(refs[1]);
  const destRemote = await readWithRetry(refs[2]);
  assert.equal(backupRemote.kind, "present");
  assert.equal(backupRemote.sha, rehearsal.report.pinnedSourceCommitSha);
  assert.equal(destRemote.kind, "present");
  assert.equal(destRemote.sha, rehearsal.report.destinationCommitSha);

  // Real Obsidian process restart.
  terminate();
  await sleep(900);
  await launch(profile, vault);

  const postRestart = await evalInVault(`(async()=>{
    const p=app.plugins.plugins[${JSON.stringify(pluginId)}];
    let settingsFenceDenied=false;
    try{await p.v4Runtime.assertReencryptionSettingsSaveAllowed()}
    catch{settingsFenceDenied=true}
    const recoveryInput={
      runId:${JSON.stringify(runId)},
      backupBranch:${JSON.stringify(backupBranch)},
      destinationBranch:${JSON.stringify(destinationBranch)},
      pinnedSourceCommitSha:${JSON.stringify(rehearsal.report.pinnedSourceCommitSha)},
      sourceTreeSha:${JSON.stringify(rehearsal.report.sourceTreeSha)},
      destinationCommitSha:${JSON.stringify(rehearsal.report.destinationCommitSha)},
      destinationTreeSha:${JSON.stringify(rehearsal.report.destinationTreeSha)},
      expectedFinalWalGeneration:${rehearsal.report.finalWalGeneration},
      verifyShadowIndex:${JSON.stringify(shadowMode)},
      recoverStagedSecret:${JSON.stringify(secretMode)},
      expectedFileCount:${rehearsal.report.verifiedFileCount},
      expectedPlaintextBytes:${JSON.stringify(rehearsal.report.verifiedPlaintextBytes)},
      ${secretMode ? "" : "newPassphrase:" + JSON.stringify(newPassphrase) + ","}
      expectedPhysicalRepositoryId:1284153873,
      defaultBranch:${JSON.stringify(target.defaultBranch)},
    };
    const readOnly=await p.v4Runtime.inspectFencedReencryptionPreCutoverRecovery(recoveryInput);
    let recovered=readOnly;
    const secretId=${JSON.stringify(rehearsal.report.stagedSecret?.destinationPassphraseSecretId ?? "")};
    const missingAfterRestart=${JSON.stringify(secretMode)} && !app.secretStorage.getSecret(secretId);
    if(${JSON.stringify(secretMode)} && readOnly.stagedSecretMissing===true && missingAfterRestart){
      recovered=await p.v4Runtime.restoreFencedReencryptionStagedSecret({...recoveryInput,newPassphrase:${JSON.stringify(newPassphrase)}});
    }
    // Open Wizard UI, verifySource fails closed for pending recovery, and click Inspect Recovery button.
    p.openReencryptionWizard();
    await new Promise(r=>setTimeout(r,200));
    const buttons=[...document.querySelectorAll(".github-sync-rekey button")];
    const verifyBtn=buttons.find(b=>b.textContent?.includes("Verify source"));
    verifyBtn?.click();
    for(let i=0;i<30;i++){
      await new Promise(r=>setTimeout(r,150));
      if(document.querySelector(".github-sync-rekey__error"))break;
    }
    const errorText=document.querySelector(".github-sync-rekey__error")?.textContent??"";
    const inspectBtn=[...document.querySelectorAll(".github-sync-rekey button")].find(b=>b.textContent?.includes("Inspect installed Recovery"));
    inspectBtn?.click();
    for(let i=0;i<30;i++){
      await new Promise(r=>setTimeout(r,150));
      const text=document.querySelector(".github-sync-rekey")?.textContent??"";
      if(text.includes("unavailable or inconclusive")||text.includes("Authenticated Re-encryption Recovery"))break;
    }
    const modalText=document.querySelector(".github-sync-rekey")?.textContent??"";
    const leakedSecret=modalText.includes(p.settings.githubToken)
      ||modalText.includes(p.settings.encryptionPassphrase)
      ||modalText.includes(${JSON.stringify(newPassphrase)});
    return {
      settingsFenceDenied,
      recovered,
      readOnlyObservation:readOnly.observation,
      readOnlyFailureStage:readOnly.failureStage??null,
      readOnlyMissing:readOnly.stagedSecretMissing===true,
      missingAfterRestart,
      stagedSecretPresent: ${JSON.stringify(secretMode)} ? !!app.secretStorage.getSecret(${JSON.stringify(rehearsal.report.stagedSecret?.destinationPassphraseSecretId ?? "")}) : null,
      stagedSecretMatches: ${JSON.stringify(secretMode)} ? app.secretStorage.getSecret(${JSON.stringify(rehearsal.report.stagedSecret?.destinationPassphraseSecretId ?? "")}) === ${JSON.stringify(newPassphrase)} : null,
      sourceSecretMatches: app.secretStorage.getSecret(p.settings.encryptionPassphraseSecretId) === ${JSON.stringify(oldPassphrase)},
      tokenSecretMatches: app.secretStorage.getSecret(p.settings.githubTokenSecretId) === p.settings.githubToken,
      errorText,
      wizardBlockedNext:!![...document.querySelectorAll(".github-sync-rekey__navigation button")].find(b=>b.textContent==="Next"&&b.disabled),
      wizardInspectedInconclusiveBeforeCutover:modalText.includes("Installed Recovery inspection unavailable or inconclusive"),
      leakedSecret,
      branchStillSource:p.settings.githubBranch===${JSON.stringify(sourceBranch)}
    };
  })()`, 240000);

  assert.equal(postRestart.settingsFenceDenied, true);
  if (secretMode) {
    console.log(JSON.stringify({status:"SECRET_RESTART_OBSERVATION",missingAfterRestart:postRestart.missingAfterRestart,
      readOnlyObservation:postRestart.readOnlyObservation,readOnlyMissing:postRestart.readOnlyMissing,
      readOnlyFailureStage:postRestart.readOnlyFailureStage,restored:postRestart.recovered.stagedSecretRestored===true,
      recoveryFailureStage:postRestart.recovered.failureStage??null,stagedSecretMatches:postRestart.stagedSecretMatches,
      sourceSecretMatches:postRestart.sourceSecretMatches,tokenSecretMatches:postRestart.tokenSecretMatches}));
    if(postRestart.missingAfterRestart) {
      assert.equal(postRestart.readOnlyObservation,"manual-recovery-required");
      assert.equal(postRestart.readOnlyMissing,true);
      assert.equal(postRestart.recovered.stagedSecretRestored,true);
    } else {
      assert.equal(postRestart.readOnlyObservation,"authenticated-pre-cutover-destination-still-fenced");
      assert.equal(postRestart.recovered.stagedSecretRestored,undefined);
    }
    assert.equal(postRestart.stagedSecretMatches,true);
    assert.equal(postRestart.sourceSecretMatches,true);
    assert.equal(postRestart.tokenSecretMatches,true);
  }
  assert.equal(postRestart.recovered.observation, "authenticated-pre-cutover-destination-still-fenced", "Native Recovery failed at "+(postRestart.recovered.failureStage??"unknown"));
  assert.equal(postRestart.recovered.walAuthenticated, true);
  assert.equal(postRestart.recovered.backupReverified, true);
  assert.equal(postRestart.recovered.destinationReverified, true);
  assert.equal(postRestart.recovered.shadowReverified, shadowMode ? true : undefined);
  assert.equal(postRestart.recovered.stagedSecretReverified, secretMode ? true : undefined);
  assert.equal(postRestart.recovered.verifiedFileCount, 2);
  assert.equal(postRestart.recovered.cutoverAuthorized, false);
  assert.equal(postRestart.recovered.localCutoverAuthorized, false);
  assert.equal(postRestart.recovered.resumeSyncAuthorized, false);
  assert.equal(postRestart.recovered.oldPassphraseCleanupAuthorized, false);
  assert.match(postRestart.errorText, /Local Re-encryption Recovery may be pending/u);
  assert.equal(postRestart.wizardBlockedNext, true);
  assert.equal(postRestart.wizardInspectedInconclusiveBeforeCutover, true);
  assert.equal(postRestart.leakedSecret, false);
  assert.equal(postRestart.branchStillSource, true);
  assert.equal(uiExceptions.length, 0);

  if (staleClientMode) {
    // D413: a second installed Obsidian, whose old-key Index predates the
    // migration, independently publishes a new edit to its original Source.
    // Nothing in this flow configures it with the new Destination passphrase.
    const sourceBeforeStale = await readWithRetry(refs[0]);
    assert.equal(sourceBeforeStale.kind, "present");
    assert.equal(sourceBeforeStale.sha, rehearsal.report.pinnedSourceCommitSha);
    assert.ok(staleSession?.child?.pid && staleSession.ws,
      "The old-key client must have stayed alive independently of the migrating Obsidian");
    const initiatorSession = { child, ws };
    child = staleSession.child;
    ws = staleSession.ws;
    port = stalePort;
    const staleAfter = await evalInVault(`(async()=>{
      const p=app.plugins.plugins[${JSON.stringify(pluginId)}];
      const branchMatches=p.settings.githubBranch===${JSON.stringify(sourceBranch)};
      const oldKeyMatches=p.settings.encryptionPassphrase===${JSON.stringify(oldPassphrase)};
      const tokenPresent=!!p.settings.githubToken;
      if(!branchMatches||!oldKeyMatches||!tokenPresent)
        return { credentialCheckFailed:true, branchMatches, oldKeyMatches,
          tokenPresent, hasKeyId:!!p.settings.encryptionPassphraseSecretId,
          hasTokenId:!!p.settings.githubTokenSecretId };
      const note=app.vault.getAbstractFileByPath("D412-unicode-สวัสดี.md");
      if(!note)throw Error("Stale client's original note is missing");
      await app.vault.modify(note, ${JSON.stringify(noteText + "\nD413 late stale Source edit only\n")});
      const outcome=await p.v4Runtime.manualSync();
      const snap=p.v4Runtime.progressSnapshot;
      return {
        lifecycle:snap.lifecycle, status:outcome?.status??null,
        remainsOnOldSource:p.settings.githubBranch===${JSON.stringify(sourceBranch)},
        retainsOldPassphrase:p.settings.encryptionPassphrase===${JSON.stringify(oldPassphrase)},
        noteChanged:(await app.vault.read(note)).includes("D413 late stale Source edit only")
      };
    })()`, 240000);
    if (staleAfter.credentialCheckFailed) {
      console.log(JSON.stringify({ status:"D413_STALE_SETTINGS_READBACK_CHECK",
        branchMatches:staleAfter.branchMatches,
        oldKeyMatches:staleAfter.oldKeyMatches,
        tokenPresent:staleAfter.tokenPresent,
        hasKeyId:staleAfter.hasKeyId,
        hasTokenId:staleAfter.hasTokenId }));
      throw new Error("Stale installed device's persisted branch or secrets did not survive process restart.");
    }
    assert.ok(["success", "no-change"].includes(staleAfter.lifecycle),
      "Stale device's own Source Sync did not finish cleanly");
    assert.equal(staleAfter.remainsOnOldSource, true);
    assert.equal(staleAfter.retainsOldPassphrase, true);
    assert.equal(staleAfter.noteChanged, true);
    const advancedSource = await readWithRetry(refs[0]);
    const unchangedBackup = await readWithRetry(refs[1]);
    const unchangedDestination = await readWithRetry(refs[2]);
    assert.equal(advancedSource.kind, "present");
    assert.notEqual(advancedSource.sha, sourceBeforeStale.sha,
      "The actual stale client must publish its late edit to old Source");
    assert.equal(unchangedBackup.sha, rehearsal.report.pinnedSourceCommitSha,
      "Stale old-key client must never modify immutable Backup");
    assert.equal(unchangedDestination.sha, rehearsal.report.destinationCommitSha,
      "Stale old-key client must never publish to new-key Destination");
    // Reboot the initiating app again AFTER the still-running old-key client
    // advances Source. Its durable Fence must keep Sync and Cutover blocked.
    child = initiatorSession.child;
    ws = initiatorSession.ws;
    port = initiatorPort;
    terminate();
    await sleep(900);
    await launch(profile, vault);
    const initiatorAfterStale = await evalInVault(`(async()=>{
      const p=app.plugins.plugins[${JSON.stringify(pluginId)}];
      let fenced=false;
      try{await p.v4Runtime.assertReencryptionSettingsSaveAllowed()}
      catch{fenced=true}
      const recoveryInput={
        runId:${JSON.stringify(runId)},
        backupBranch:${JSON.stringify(backupBranch)},
        destinationBranch:${JSON.stringify(destinationBranch)},
        pinnedSourceCommitSha:${JSON.stringify(rehearsal.report.pinnedSourceCommitSha)},
        sourceTreeSha:${JSON.stringify(rehearsal.report.sourceTreeSha)},
        destinationCommitSha:${JSON.stringify(rehearsal.report.destinationCommitSha)},
        destinationTreeSha:${JSON.stringify(rehearsal.report.destinationTreeSha)},
        expectedFinalWalGeneration:${rehearsal.report.finalWalGeneration},
      verifyShadowIndex:${JSON.stringify(shadowMode)},
      recoverStagedSecret:${JSON.stringify(secretMode)},
        expectedFileCount:${rehearsal.report.verifiedFileCount},
        expectedPlaintextBytes:${JSON.stringify(rehearsal.report.verifiedPlaintextBytes)},
        ${secretMode ? "" : "newPassphrase:" + JSON.stringify(newPassphrase) + ","}
        expectedPhysicalRepositoryId:1284153873,
        defaultBranch:${JSON.stringify(target.defaultBranch)},
      };
      const readOnly=await p.v4Runtime.inspectFencedReencryptionPreCutoverRecovery(recoveryInput);
      let recovered=readOnly;
      const secretId=${JSON.stringify(rehearsal.report.stagedSecret?.destinationPassphraseSecretId ?? "")};
      const missingAfterRestart=${JSON.stringify(secretMode)} && !app.secretStorage.getSecret(secretId);
      if(${JSON.stringify(secretMode)} && readOnly.stagedSecretMissing===true && missingAfterRestart){
        recovered=await p.v4Runtime.restoreFencedReencryptionStagedSecret({...recoveryInput,newPassphrase:${JSON.stringify(newPassphrase)}});
      }
      return {
        fenced,
        ...( ${JSON.stringify(secretMode)} ? {secretRestart:{missingAfterRestart,readOnlyMissing:readOnly.stagedSecretMissing===true,restored:recovered.stagedSecretRestored===true,stagedSecretMatches:app.secretStorage.getSecret(secretId)===${JSON.stringify(newPassphrase)},failureStage:recovered.failureStage??null}} : {}),
        stillSource:p.settings.githubBranch===${JSON.stringify(sourceBranch)},
        stillOldPassphrase:p.settings.encryptionPassphrase===${JSON.stringify(oldPassphrase)},
        noSyncActive:!p.v4Runtime.isSyncing,
        originalNoteUnchanged:(await app.vault.adapter.read("D412-unicode-สวัสดี.md"))===${JSON.stringify(noteText)},
        afterStaleRecovery: {
          observation:recovered.observation,
          walAuthenticated:recovered.walAuthenticated,
          backupReverified:recovered.backupReverified,
          destinationReverified:recovered.destinationReverified,
          ...(recovered.shadowReverified ? {shadowReverified:true} : {}),
          ...(recovered.stagedSecretReverified ? {stagedSecretReverified:true} : {}),
          verifiedFileCount:recovered.verifiedFileCount,
          resumeSyncAuthorized:recovered.resumeSyncAuthorized,
          cutoverAuthorized:recovered.cutoverAuthorized
        }
      };
    })()`, 240000);
    assert.deepEqual({
      ...initiatorAfterStale,
      ...(secretMode ? {secretRestart:undefined} : {}),
      afterStaleRecovery:undefined
    }, {
      fenced:true,stillSource:true,stillOldPassphrase:true,
      noSyncActive:true,originalNoteUnchanged:true,afterStaleRecovery:undefined,
      ...(secretMode ? {secretRestart:undefined} : {})
    }, "An advancing stale Source must not silently cut over or resume the fenced initiating device");
    assert.deepEqual(initiatorAfterStale.afterStaleRecovery, {
      observation:"authenticated-pre-cutover-destination-still-fenced",
      walAuthenticated:true,backupReverified:true,
      destinationReverified:true,verifiedFileCount:2,
      ...(shadowMode ? {shadowReverified:true} : {}),
      ...(secretMode ? {stagedSecretReverified:true} : {}),
      resumeSyncAuthorized:false,cutoverAuthorized:false
    }, "After stale old Source advances, the initiating device must re-authenticate the ORIGINAL frozen Backup, WAL and destination");
    if (secretMode) {
      console.log(JSON.stringify({status:"SECRET_AFTER_STALE_RESTART",...initiatorAfterStale.secretRestart}));
      assert.equal(initiatorAfterStale.secretRestart.stagedSecretMatches,true);
      assert.equal(initiatorAfterStale.secretRestart.restored,initiatorAfterStale.secretRestart.missingAfterRestart);
      assert.equal(initiatorAfterStale.secretRestart.readOnlyMissing,initiatorAfterStale.secretRestart.missingAfterRestart);
    }
    staleClientReport = {
      secondInstalledObsidianVault: true,
      staleClientUsedOldSourceAndKey: staleAfter.remainsOnOldSource && staleAfter.retainsOldPassphrase,
      staleSourceCommitAdvanced: true,
      frozenBackupUnchanged: true,
      destinationUnchanged: true,
      initiatingDeviceStillFencedAfterRestart: true,
      autoCrossBranchMerge: false,
    };
  }

  assert.equal(await readFile(path.join(vault, "D412-unicode-สวัสดี.md"), "utf8"), noteText);
  assert.deepEqual(await readFile(path.join(vault, "D412-binary.bin")), binaryBytes);
  passed = true;

  console.log(JSON.stringify({
    status: staleClientMode
      ? "D413_LIVE_OBSIDIAN_STALE_SOURCE_ISOLATION_PASS"
      : "D412_LIVE_OBSIDIAN_PRE_CUTOVER_PASS",
    ...(staleClientMode ? { staleClientReport } : {}),
    repoId: target.id,
    pinnedSourceCommitSha: rehearsal.report.pinnedSourceCommitSha,
    destinationCommitSha: rehearsal.report.destinationCommitSha,
    finalWalGeneration: rehearsal.report.finalWalGeneration,
    ...(shadowMode ? {shadow:rehearsal.report.shadow,shadowReverified:postRestart.recovered.shadowReverified} : {}),
    ...(secretMode ? {stagedSecretReverified:postRestart.recovered.stagedSecretReverified,distinctSecretId:rehearsal.stagedSecretVerified} : {}),
    verifiedFileCount: rehearsal.report.verifiedFileCount,
    verifiedPlaintextBytes: rehearsal.report.verifiedPlaintextBytes,
    postRestartObservation: postRestart.recovered.observation,
    cutoverAuthorized: false,
    uiExceptions: uiExceptions.length,
  }));
} catch (error) {
  console.error("D412_LIVE_OBSIDIAN_REHEARSAL_FAILED:", redact(error));
  process.exitCode = 1;
} finally {
  try {
    if (child?.pid) terminate();
    try { staleSession?.ws?.close(); } catch {}
    // Also terminate independently held synthetic Vault processes on ANY
    // exception path, not only the currently selected CDP session.
    for (const ownedPid of [...ownedProcessIds]) {
      const stopped = spawnSync("taskkill", ["/PID", String(ownedPid), "/T", "/F"], {
        encoding: "utf8", timeout: 18000, shell: false,
      });
      assert.equal(stopped.status, 0, "Failed to stop a held disposable Obsidian process");
      ownedProcessIds.delete(ownedPid);
    }
  } catch {
    cleanupState = "process-termination-unconfirmed";
    process.exitCode = 1;
  }
  for (const ref of refs) {
    try {
      const before = await readWithRetry(ref);
      if (before.kind === "present") {
        try { await cleanupE2EBranch({ ...configuration, branch: ref.branch, currentSourceRepoId: CANONICAL_REPOSITORY_ID, maxAttempts: 5 }); } catch {}
      }
      const after1 = await readWithRetry(ref);
      const after2 = await readWithRetry(ref);
      if (after1.kind !== "absent" || after2.kind !== "absent") {
        throw new Error(`Disposable branch remains: ${ref.branch}`);
      }
      console.log(JSON.stringify({ status: "CLEANUP_VERIFIED_TWICE", branch: ref.branch, repoId: configuration?.expectedRepoId }));
    } catch (err) {
      remoteCleanupErrors.push(redact(err));
      console.error("CRITICAL E2E cleanup error:", redact(err));
      process.exitCode = 1;
    }
  }
  if (runRoot && cleanupState !== "process-termination-unconfirmed") {
    for (let i = 0; i < 24; i++) {
      try {
        await rm(runRoot, { recursive: true, force: true, maxRetries: 2, retryDelay: 200 });
        cleanupState = "temporary-vault-removed";
        break;
      } catch {
        if (i === 23) {
          cleanupState = "temporary-vault-removal-unconfirmed";
          process.exitCode = 1;
        } else {
          await sleep(350);
        }
      }
    }
  }
  console.log(JSON.stringify({
    status: passed && remoteCleanupErrors.length === 0 && !process.exitCode ? "PASS" : "FAIL",
    cleanupState,
    remoteCleanupErrors: remoteCleanupErrors.length,
  }));
}
