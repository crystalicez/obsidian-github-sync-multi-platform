#!/usr/bin/env node
// D377: real installed Obsidian Runtime Fence → create-only encrypted WAL →
// fresh process authenticated readback. Test-only synthetic Vault and settings.
// NEVER use an actual user Vault, token, migration branch or Cutover.
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { spawn, spawnSync } from "node:child_process"
import { lstat, mkdir, mkdtemp, rm, writeFile, copyFile, readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import esbuild from "esbuild"
import { buildNativePluginReadyExpression } from "./native-obsidian-plugin-ready.mjs"
import { assertD392InstalledEvidenceDigest } from "./installed-source-evidence-digest.mjs"

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const exe = "C:\\Program Files\\Obsidian\\Obsidian.exe"
const pluginId = "encrypted-github-sync-multi-platform"
const root = path.join(project, ".tmp", "obsidian-installed-wal-authoring")
const port = 28000 + process.pid % 27000
const expectedText = "D377 synthetic WAL source note: สวัสดี"
const options = process.argv.slice(2)
const d391Mode = options[0]?.startsWith("--authenticated-source-backup-prehandoff-drift=") === true
  ? "backup-prehandoff-drift" : options[0]?.startsWith("--authenticated-source-backup-tamper=") === true
  ? "backup-tamper" : options[0]?.startsWith("--authenticated-source-backup-revoke=") === true
    ? "backup-revoke" : options[0]?.startsWith("--authenticated-source-backup=") === true
      ? "backup" : options[0]?.startsWith("--authenticated-source=") === true
  ? "normal" : options[0]?.startsWith("--authenticated-source-tamper=") === true
    ? "tamper" : options[0]?.startsWith("--authenticated-source-revoke=") === true
      ? "revoke" : null
const allowedStandalone = ["--kill-writer", "--revoke-lease-after-intent",
  "--source-parity-and-revoke", "--source-parity-tamper"]
assert.ok(options.length === 0
  || (options.length === 1 && allowedStandalone.includes(options[0]))
  || (options.length === 2 && d391Mode !== null
    && /^--evidence-sha256=[a-f0-9]{64}$/u.test(options[1])),
  "Installed WAL proof requires one approved test option or pinned D392 evidence digest")
const verifiedBackupHandoff = d391Mode?.startsWith("backup") === true
const preHandoffDrift = d391Mode === "backup-prehandoff-drift"
const killWriter = options[0] === "--kill-writer"
const tamperSource = options[0] === "--source-parity-tamper"
  || d391Mode === "tamper" || d391Mode === "backup-tamper"
const sourceParity = options[0] === "--source-parity-and-revoke" || tamperSource
  || d391Mode !== null
const revokeLease = options[0] === "--revoke-lease-after-intent"
  || options[0] === "--source-parity-and-revoke"
  || d391Mode === "revoke" || d391Mode === "backup-revoke"

let verifiedEvidence = null
if (d391Mode !== null) {
  // Only consume one manifest created by the caller's approved disposable
  // GitHub E2E scenario. Never load credentials or a developer's vault.
  const evidencePath = path.resolve(options[0].slice(options[0].indexOf("=") + 1))
  const allowed = path.join(project, ".tmp", "github-e2e")
  const relative = path.relative(allowed, evidencePath).replaceAll("\\", "/")
  assert.match(relative, /^d391-inventory-[A-Za-z0-9_-]{6,60}\/source\.json$/u)
  for (const folder of [path.join(project, ".tmp"), allowed, path.dirname(evidencePath)]) {
    const stat = await lstat(folder)
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink(),
      "D391 input directory must be a verified test-only regular directory")
  }
  const stat = await lstat(evidencePath)
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1
    && stat.size > 150 && stat.size < 12_000,
    "D391 test-only source manifest is missing or unsafe")
  // Parent authenticated the immutable GitHub Source before writing this
  // token-free manifest. Bind its exact bytes to a digest passed through a
  // separate child argument. A valid-looking modified manifest cannot pass.
  // This is a test provenance fence, not a Production GitHub trust boundary.
  const evidenceBytes = await readFile(evidencePath)
  assertD392InstalledEvidenceDigest(evidenceBytes, options[1].slice("--evidence-sha256=".length))
  verifiedEvidence = JSON.parse(evidenceBytes.toString("utf8"))
  const proof = verifiedEvidence
  const record = proof?.inventory?.sourceRecords?.[0]
  const derivedTestBranch = purpose => typeof proof?.repo?.branch === "string"
    ? "obsidian-sync-e2e/local-" + purpose + "-"
      + createHash("sha256").update(proof.repo.branch + ":" + purpose, "utf8")
        .digest("hex").slice(0, 32)
    : null
  assert.ok(proof?.schemaVersion === 1
    && proof.provenance === "d391-github-e2e-trusted-immutable-readback"
    && proof.repo?.owner === "diamond-crystal"
    && proof.repo?.name === "test-vault-obsidian-encrypted-github-sync-multi-platform"
    && proof.repo?.physicalRepositoryId === 1284153873
    && /^obsidian-sync-e2e\/local-[A-Za-z0-9_-]{6,160}$/u.test(proof.repo.branch)
    && proof.inventory?.verifiedSource?.integrityScope === "all-live-objects"
    && proof.inventory?.verifiedSource?.verifiedFileCount === 1
    && proof.inventory?.sourceRecords?.length === 1
    && proof.inventory?.sourceRecords?.[0]?.path === "D377-synthetic-note.md"
    && record?.deleted === false
    && /^[a-f0-9]{64}$/u.test(record?.plaintextSha256)
    && record.size === Buffer.byteLength(expectedText, "utf8")
    && proof.inventory?.pinnedSourceCommitSha === proof.inventory?.verifiedSource?.pinnedSourceCommitSha
    && /^[a-f0-9]{40}$/u.test(proof.inventory.pinnedSourceCommitSha)
    && /^[a-f0-9]{40}$/u.test(proof.walBinding?.sourceTreeSha)
    && proof.walBinding?.sourceCommitSha === proof.inventory.pinnedSourceCommitSha
    && (verifiedBackupHandoff
      ? proof.verifiedFrozenBackup?.repoId === proof.walBinding?.backupRepoId
        && proof.verifiedFrozenBackup?.branch
          === proof.walBinding?.backupRepoId?.split("#")[1]
        && proof.verifiedFrozenBackup?.branch === derivedTestBranch("backup")
        && proof.verifiedFrozenBackup?.pinnedSourceCommitSha
          === proof.walBinding?.sourceCommitSha
        && proof.verifiedFrozenBackup?.pinnedSourceTreeSha
          === proof.walBinding?.sourceTreeSha
        && proof.verifiedFrozenBackup?.verifiedFileCount === 1
        && proof.verifiedFrozenBackup?.verifiedPlaintextBytes
          === proof.inventory?.verifiedSource?.totalVerifiedPlaintextBytes
        && proof.verifiedFrozenBackup?.backupContentsReadbackVerified === true
        && proof.verifiedFrozenBackup?.creationProven === false
        && proof.verifiedFrozenBackup?.cutoverAuthorized === false
      : proof.walBinding?.backupRepoId
        === proof.repo.owner + "/" + proof.repo.name + "#" + proof.repo.branch + "-d391-backup")
    && proof.walBinding?.destinationRepoId === (
      verifiedBackupHandoff
        ? proof.repo.owner + "/" + proof.repo.name + "#" + derivedTestBranch("destination")
        : proof.repo.owner + "/" + proof.repo.name + "#" + proof.repo.branch + "-d391-destination"
    )
    && proof.inventory.initiatorLocalParityVerified === false
    && proof.inventory.permissionToPublish === false
    && proof.inventory.cutoverAuthorized === false
    && proof.remoteMutationsAfterSourcePublish === 0,
    "D391 test-only authenticated source manifest failed its pinned shape checks")
  const noteSha = createHash("sha256").update(expectedText, "utf8").digest("hex")
  assert.equal(record.plaintextSha256, noteSha, "D391 note is not the exact expected test fixture")
}
const walLeaf = createHash("sha256").update("D377InstalledWalProof", "utf8").digest("hex")
let runRoot, child, ws, result, restartResult
let cleanup = "not-started", phase = "initial", success = false
let nextId = 0
const pending = new Map()
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// This script may DELETE its run directory. Guard both parents and reject
// symlinks/junctions before creating any synthetic Vault or profile.
for (const location of [path.dirname(root), root]) {
  await mkdir(location, { recursive: true })
  const stat = await lstat(location)
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink(),
    "D377 refuses linked or non-directory test root")
}
async function rpc(method, params = {}, timeoutMs = 25000) {
  assert.ok(ws?.readyState === WebSocket.OPEN)
  return new Promise((resolve, reject) => {
    const id = ++nextId
    const timeout = setTimeout(() => {
      pending.delete(id)
      reject(Error("D377 CDP request expired: " + method))
    }, timeoutMs)
    pending.set(id, {
      resolve: value => { clearTimeout(timeout); resolve(value) },
      reject: () => { clearTimeout(timeout); reject(Error("D377 CDP response denied")) },
    })
    ws.send(JSON.stringify({ id, method, params }))
  })
}
async function evalInVault(expression, timeoutMs = 50000) {
  const out = await rpc("Runtime.evaluate", {
    expression, awaitPromise: true, returnByValue: true,
  }, timeoutMs)
  // Never echo arbitrary CDP exception details; they could contain credentials.
  if (out.exceptionDetails) throw Error("D377 isolated renderer rejected at stage " + phase)
  return out.result?.value
}
async function connect(vault) {
  let endpoint
  for (let i = 0; i < 140; i++) {
    try {
      const r = await fetch("http://127.0.0.1:" + port + "/json/list", {
        signal: AbortSignal.timeout(1200),
      })
      if (r.ok) {
        const list = await r.json()
        endpoint = list.find(x => x.url === "app://obsidian.md/index.html" && x.webSocketDebuggerUrl)
        if (endpoint) break
      }
    } catch {}
    await sleep(300)
  }
  assert.ok(endpoint, "D377 isolated Obsidian renderer unavailable")
  ws = new WebSocket(endpoint.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true })
    ws.addEventListener("error", () => reject(Error("D377 CDP handshake failed")), { once: true })
  })
  ws.addEventListener("message", event => {
    const message = JSON.parse(String(event.data))
    const item = pending.get(message.id)
    if (!item) return
    pending.delete(message.id)
    if (message.error) item.reject()
    else item.resolve(message.result)
  })
  await rpc("Runtime.enable")
  for (let i = 0; i < 65; i++) {
    const actual = await evalInVault(
      "typeof app==='undefined'?null:app.vault?.adapter?.getBasePath?.()")
    if (actual) {
      assert.equal(actual.toLowerCase(), vault.toLowerCase(),
        "D377 refuses an Obsidian renderer from another Vault")
      break
    }
    if (i === 64) throw Error("D377 Vault identity unavailable")
    await sleep(220)
  }
  // Obsidian may expose the Vault before initializing its plugin manager.
  // Never invoke the startup loader against an uninitialized manager.
  let managerReady = false
  for (let i = 0; i < 65; i++) {
    managerReady = await evalInVault(
      "(()=>{if(typeof app==='undefined')return false;"
      + "const p=app.plugins;return !!p"
      + "&&typeof p.isEnabled==='function'"
      + "&&typeof p.setEnable==='function'"
      + "&&typeof p.enablePluginAndSave==='function'"
      + "&&typeof p.loadPlugin==='function'"
      + "&&typeof p.enabledPlugins?.has==='function'})()")
    if (managerReady) break
    await sleep(220)
  }
  assert.ok(managerReady, "D377 native plugin manager did not become ready")
  const loaded = await evalInVault(buildNativePluginReadyExpression(pluginId))
  assert.equal(loaded, true, "D377 installed test plugin did not load")
}
async function launch(profile, vault) {
  child = spawn(exe, [
    "--user-data-dir=" + profile, "--remote-debugging-port=" + port,
  ], { detached: true, windowsHide: false, stdio: "ignore" })
  child.on("error", () => {})
  child.unref()
  await connect(vault)
}
function terminate() {
  if (!child?.pid) return
  try { ws?.close() } catch {}
  ws = undefined
  const stop = spawnSync("taskkill", [
    "/PID", String(child.pid), "/T", "/F",
  ], { encoding: "utf8", timeout: 18000 })
  assert.equal(stop.status, 0, "D377 cannot prove synthetic Obsidian child exited")
  child = undefined
}
try {
  phase = "check CDP port"
  try {
    const existing = await fetch("http://127.0.0.1:" + port + "/json/list", {
      signal: AbortSignal.timeout(1200),
    })
    if (existing.ok) throw Error("D377 CDP port already used")
  } catch (err) {
    if (!/fetch failed|ECONNREFUSED|timed out|TimeoutError/u.test(String(err))) throw err
  }
  const bundled = await esbuild.build({
    entryPoints: [path.join(project, "scripts", "native-installed-wal-writer-probe.ts")],
    bundle: true, write: false, platform: "browser", format: "iife",
    globalName: "__d377Proof", target: "es2022", minify: true, logLevel: "silent",
  })
  const probe = bundled.outputFiles?.[0]?.text
  assert.ok(probe && probe.length < 400000, "D377 test-only bundle missing/oversized")
  phase = "create disposable profile"
  runRoot = await mkdtemp(path.join(root, "run-"))
  const vault = path.join(runRoot, "vault")
  const profile = path.join(runRoot, "profile")
  const pluginRoot = path.join(vault, ".obsidian", "plugins", pluginId)
  await mkdir(pluginRoot, { recursive: true })
  await mkdir(profile)
  for (const name of ["main.js", "manifest.json", "styles.css"]) {
    await copyFile(path.join(project, name), path.join(pluginRoot, name))
  }
  await writeFile(path.join(vault, ".obsidian", "community-plugins.json"),
    JSON.stringify([pluginId]) + "\n")
  await writeFile(path.join(profile, "obsidian.json"), JSON.stringify({
    vaults: { "d377synthetic": { path: vault, ts: Date.now(), open: true } },
  }) + "\n")
  await writeFile(path.join(vault, "D377-synthetic-note.md"), expectedText)
  phase = "first installed Obsidian process"
  await launch(profile, vault)
  assert.equal(await evalInVault(probe + ";true"), true)
  phase = "installed Runtime arms persisted fence and writes encrypted WAL"
  result = await evalInVault(`(async()=>{
    const plugin=app.plugins.plugins[${JSON.stringify(pluginId)}];
    if(!plugin||plugin.settings.githubToken||plugin.settings.githubOwner||plugin.settings.githubRepo)
      throw Error("D377 requires an unconfigured disposable plugin");
    const settings=plugin.settings;
    if(settings.syncEnabled)settings.syncEnabled=false;
    settings.githubOwner=${JSON.stringify(verifiedEvidence?.repo?.owner ?? "synthetic")};
    settings.githubRepo=${JSON.stringify(verifiedEvidence?.repo?.name ?? "repo")};
    settings.githubBranch=${JSON.stringify(verifiedEvidence?.repo?.branch ?? "source")};
    settings.encryptionMode="encrypted";
    settings.encryptionPassphraseSecretId="D377SyntheticOldSecret";
    settings.vault="D377SyntheticDevice";
    const source=${JSON.stringify(verifiedEvidence ? verifiedEvidence.repo.owner + "/" + verifiedEvidence.repo.name + "#" + verifiedEvidence.repo.branch : "synthetic/repo#source")};
    const dest=${JSON.stringify(verifiedEvidence?.walBinding?.destinationRepoId ?? "synthetic/repo#destination")};
    const transferred=${JSON.stringify(verifiedEvidence?.inventory ?? null)};
    const walBinding=${JSON.stringify(verifiedEvidence?.walBinding ?? null)};
    // D389 synthetic owner-controlled lease: unlike a no-op callback, the
    // same installed writer must reject all further writes after revocation.
    // This is NOT an OS-wide or production cross-device lease implementation.
    const leaseOwner={active:true,checks:0};
    const lease=async()=>{
      leaseOwner.checks++;
      if(!leaseOwner.active)throw Error("D389 synthetic initiating lease revoked");
    };
    const fenced=await plugin.v4Runtime.armReencryptionSyncFence({
      runId:"D377InstalledWalProof",destinationRepoId:dest,
      assertExclusiveInitiatorLease:lease
    });
    if(fenced.status!=="reencryption-sync-fence-armed-uncommitted")
      throw Error("D377 refused fence");
    const physicalReader=${JSON.stringify(sourceParity)}
      ? plugin.v4Runtime.createReencryptionInitiatorLocalReader(lease) : null;
    const sourceReport=physicalReader
      ? transferred
        ? await globalThis.__d377Proof.verifyTransferredAuthenticatedSourceParity(
          physicalReader,transferred)
        : await globalThis.__d377Proof.verifySyntheticInstalledSourceParity(
          physicalReader,${JSON.stringify(expectedText)})
      : null;
    if (${JSON.stringify(verifiedBackupHandoff)}) {
      // Recheck actual Source bytes under the SAME runtime lease immediately
      // before the authenticated Backup handoff, after the first parity scan.
      if (${JSON.stringify(preHandoffDrift)}) {
        const note="D377-synthetic-note.md";
        const original=await app.vault.adapter.read(note);
        const changed=original.replace(/^D377/u,"E377");
        if(original===changed || new TextEncoder().encode(original).byteLength
          !==new TextEncoder().encode(changed).byteLength)
          throw Error("D398 cannot induce same-size physical Source drift");
        await app.vault.adapter.write(note,changed);
      }
      let parityDenied=false;
      try {
        await globalThis.__d377Proof.verifyTransferredAuthenticatedSourceParity(
          physicalReader,transferred);
      } catch(error) {
        if (!${JSON.stringify(preHandoffDrift)}) throw error;
        parityDenied=error instanceof Error
          && /local content does not match authenticated source SHA-256/u.test(error.message);
      }
      if (${JSON.stringify(preHandoffDrift)}) {
        const walRoot=".obsidian/plugins/"+plugin.manifest.id
          +"/reencryption-wal/"+${JSON.stringify(walLeaf)};
        const noWalSlots=!(await app.vault.adapter.exists(walRoot+"/slot-0.json"))
          && !(await app.vault.adapter.exists(walRoot+"/slot-1.json"));
        return {...(sourceReport||{}),preHandoffParityDenied:parityDenied,
          noWalSlots,noConfiguredToken:!plugin.settings.githubToken,
          remoteGitHubUsed:false,cutoverAuthorized:false};
      }
    }
    const writer=await plugin.v4Runtime.openNewReencryptionDesktopWalForArmedRun();
    try {
      const written=${JSON.stringify(verifiedBackupHandoff)}
        ? await globalThis.__d377Proof.authorParentVerifiedBackupHandoff(
          writer.adapter,writer.journalRoot,walBinding,
          ${JSON.stringify(verifiedEvidence?.verifiedFrozenBackup ?? null)})
        : await globalThis.__d377Proof.authorUnpublishedPendingBackup(
          writer.adapter,writer.journalRoot,walBinding||undefined);
      if(!written.noCutover||!written.noGitHubUsed
        || (${JSON.stringify(verifiedBackupHandoff)}
          ? !written.verifiedBackupHandoff : !written.pendingBackupIntentOnly))
        throw Error("D397 WAL returned untrusted authority");
      let physicalSourceDriftDenied=false;
      let physicalSourceDriftSameSize=false;
      let physicalSourceDriftPreservedWal=false;
      let leaseRevocationDeniedSourceParity=false;
      let leaseRevocationDeniedNewWalWrite=false;
      let leaseRevocationDeniedCheckpoint=false;
      let physicalSlotsUnchangedAfterRevocation=false;
      let walDirectoryUnchangedAfterRevocation=false;
      let leaseAssertionsBeforeRevocation=leaseOwner.checks;
      if (${JSON.stringify(tamperSource)}) {
        // Only a proven disposable synthetic Vault is ever written.
        // Same-byte-size one-byte mutation tests actual content SHA-256,
        // not mere length mismatch or a revoked lease false positive.
        const note="D377-synthetic-note.md";
        const original=await app.vault.adapter.read(note);
        const modified=original.replace(/^D377/u,"E377");
        physicalSourceDriftSameSize=original!==modified
          && new TextEncoder().encode(original).length===
            new TextEncoder().encode(modified).length;
        if(!physicalSourceDriftSameSize)
          throw Error("D390 synthetic drift mutation was not same-byte-size");
        try {
          await app.vault.adapter.write(note,modified);
          try{
            if(transferred)
              await globalThis.__d377Proof.verifyTransferredAuthenticatedSourceParity(
                physicalReader,transferred);
            else
              await globalThis.__d377Proof.verifySyntheticInstalledSourceParity(
                physicalReader,${JSON.stringify(expectedText)});
          }catch(error){
            physicalSourceDriftDenied=error instanceof Error
              && /local content does not match authenticated source SHA-256/u.test(error.message);
          }
        }finally{
          await app.vault.adapter.write(note,original);
        }
        const walRoot=(app.vault.configDir||".obsidian")
          +"/plugins/"+plugin.manifest.id+"/"+writer.journalRoot;
        physicalSourceDriftPreservedWal=
          await globalThis.__d377Proof.assertPhysicalWalHashesUnchanged(
            app.vault.adapter,walRoot,written.ciphertextSlotSha256);
      }
      if (${JSON.stringify(revokeLease)}) {
        // The legitimate writer still holds the OS lock at this moment.
        // Revoke only this disposable injected lease and try a *new* write.
        leaseOwner.active=false;
        if (physicalReader) {
          try {
            if(transferred)
              await globalThis.__d377Proof.verifyTransferredAuthenticatedSourceParity(
                physicalReader,transferred);
            else
              await globalThis.__d377Proof.verifySyntheticInstalledSourceParity(
                physicalReader,${JSON.stringify(expectedText)});
          } catch (error) {
            leaseRevocationDeniedSourceParity=
              error instanceof Error && error.message==="D389 synthetic initiating lease revoked";
          }
        }
        const physicalRoot=(app.vault.configDir||".obsidian")
          +"/plugins/"+plugin.manifest.id+"/"+writer.journalRoot;
        const beforeFiles=(await app.vault.adapter.list(physicalRoot)).files.slice().sort();
        // This is a VALID WAL slot path. A bogus non-slot pathname would be
        // rejected independently of lease validation and give a false pass.
        const forbiddenSlot=writer.journalRoot+"/slot-0.json";
        try{await writer.adapter.write(forbiddenSlot,"D389 forbidden encrypted WAL overwrite")}
        catch(error){
          leaseRevocationDeniedNewWalWrite=
            error instanceof Error && error.message==="D389 synthetic initiating lease revoked";
        }
        try{await writer.assertBestEffortCheckpoint()}
        catch(error){
          leaseRevocationDeniedCheckpoint=
            error instanceof Error && error.message==="D389 synthetic initiating lease revoked";
        }
        const afterFiles=(await app.vault.adapter.list(physicalRoot)).files.slice().sort();
        walDirectoryUnchangedAfterRevocation=
          JSON.stringify(beforeFiles)===JSON.stringify(afterFiles);
        physicalSlotsUnchangedAfterRevocation=
          await globalThis.__d377Proof.assertPhysicalWalHashesUnchanged(
            app.vault.adapter,physicalRoot,written.ciphertextSlotSha256);
      }
      let settingsDenied=false;
      try{await plugin.v4Runtime.assertReencryptionSettingsSaveAllowed()}
      catch{settingsDenied=true}
      let reopenedDenied=false;
      try{await plugin.v4Runtime.openNewReencryptionDesktopWalForArmedRun()}
      catch{reopenedDenied=true}
      return {...written,settingsDenied,reopenedDenied,
        ...(sourceReport||{}),
        leaseRevocationDeniedSourceParity,
        physicalSourceDriftDenied,physicalSourceDriftSameSize,
        physicalSourceDriftPreservedWal,
        leaseAssertionsBeforeRevocation,
        leaseAssertionsAfterRevocation:leaseOwner.checks,
        leaseRevocationDeniedNewWalWrite,leaseRevocationDeniedCheckpoint,
        walDirectoryUnchangedAfterRevocation,physicalSlotsUnchangedAfterRevocation,
        sourceNoteUnchanged:(await app.vault.adapter.read("D377-synthetic-note.md"))
          ===${JSON.stringify(expectedText)},
        noConfiguredToken:!plugin.settings.githubToken,
        cutoverAuthorized:false,remoteGitHubUsed:false};
    }finally{
      if (${JSON.stringify(killWriter)}) {
        // Keep a strong reference to the same live FileHandle until taskkill.
        globalThis.__d377HeldWriter=writer;
      } else await writer.release();
    }
  })()`, 70000)
  if (preHandoffDrift) {
    assert.equal(result?.preHandoffParityDenied, true,
      "D398 second physical Source scan must reject intervening same-size content drift")
    assert.equal(result?.noWalSlots, true,
      "D398 failed Source recheck must leave both WAL slots absent")
    assert.equal(result?.noConfiguredToken, true)
    assert.equal(result?.cutoverAuthorized, false)
    assert.equal(result?.remoteGitHubUsed, false)
    success = true
  } else {
  for (const key of ["noCutover", "noGitHubUsed",
    "settingsDenied", "reopenedDenied", "sourceNoteUnchanged", "noConfiguredToken"]) {
    assert.equal(result[key], true, "D377 installed writer proof failed: " + key)
  }
  assert.equal(result.generation, verifiedBackupHandoff ? 4 : 2)
  assert.equal(result.pendingBackupIntentOnly, !verifiedBackupHandoff)
  if (verifiedBackupHandoff) assert.equal(result.verifiedBackupHandoff, true)
  assert.ok(result.ciphertextSlotSha256?.length === 2)
  if (verifiedEvidence) {
    assert.equal(result.transferredGitHubInventoryParityVerified, true,
      "D391 installed physical Source parity must match authenticated GitHub inventory")
    assert.equal(result.checkedFileCount, 1)
    assert.equal(result.checkedPlaintextBytes, String(Buffer.byteLength(expectedText, "utf8")))
    assert.equal(result.checkedSourceCommitSha, verifiedEvidence.inventory.pinnedSourceCommitSha)
    assert.equal(result.permissionToPublish, false)
    assert.equal(result.cutoverAuthorized, false)
    assert.equal(result.remoteGitHubUsed, false)
    if (revokeLease) {
      assert.equal(result.leaseRevocationDeniedSourceParity, true,
        "D391 revocation of the same initiating lease must block authenticated parity")
    }
  } else if (sourceParity) {
    assert.equal(result.syntheticSourceParityVerified, true,
      "D390 actual installed physical Source parity must succeed before WAL")
    assert.equal(result.physicalFilesVerified, 1)
    assert.equal(result.physicalBytesVerified, String(Buffer.byteLength(expectedText, "utf8")))
    assert.equal(result.sourceCommitSha, "a".repeat(40))
    assert.equal(result.remoteGitHubSourceAuthenticated, false)
    if (revokeLease) {
      assert.equal(result.leaseRevocationDeniedSourceParity, true,
        "D390 revoked SAME lease must block another physical parity scan")
    }
  }
  if (tamperSource) {
    for(const key of ["physicalSourceDriftDenied","physicalSourceDriftSameSize",
      "physicalSourceDriftPreservedWal"]){
      assert.equal(result[key],true,
        "D390 changed physical note must fail its SHA-256 parity without changing WAL: "+key)
    }
  }
  if (revokeLease) {
    for (const key of ["leaseRevocationDeniedNewWalWrite",
      "leaseRevocationDeniedCheckpoint", "walDirectoryUnchangedAfterRevocation",
      "physicalSlotsUnchangedAfterRevocation"]) {
      assert.equal(result[key], true, "D389 revoked installed lease failed: " + key)
    }
    assert.ok(result.leaseAssertionsBeforeRevocation >= 2,
      "D389 installed writer must check the real injected lease before authoring")
    assert.ok(result.leaseAssertionsAfterRevocation >
      result.leaseAssertionsBeforeRevocation,
      "D389 attempted forbidden operations must encounter the revoked lease")
  }
  assert.equal(await readFile(path.join(vault, "D377-synthetic-note.md"), "utf8"),
    expectedText)
  phase = "real process restart"
  if (killWriter) {
    const lock = path.join(pluginRoot, "reencryption-wal", walLeaf, ".exclusive.lock")
    const lockInfo = await lstat(lock)
    assert.ok(lockInfo.isFile() && !lockInfo.isSymbolicLink(),
      "D377 interrupted writer must own a physical lock before process kill")
  }
  terminate()
  await sleep(850)
  await launch(profile, vault)
  assert.equal(await evalInVault(probe + ";true"), true)
  phase = "restart reads encrypted WAL with manual-recovery fence"
  restartResult = await evalInVault(`(async()=>{
    const plugin=app.plugins.plugins[${JSON.stringify(pluginId)}];
    if(!plugin||plugin.settings.githubToken||plugin.settings.githubOwner||plugin.settings.githubRepo)
      throw Error("D377 restart unexpectedly configured network credentials");
    const report=await globalThis.__d377Proof.inspectAfterRealProcessRestart(
      app.vault.adapter,${JSON.stringify(pluginId)},
      ${JSON.stringify(result.ciphertextSlotSha256)},${result.generation},
      ${JSON.stringify(verifiedEvidence?.walBinding ?? null)}||undefined);
    const route=await plugin.v4Runtime.inspectFencedReencryptionIndexRoute();
    let settingsDenied=false;
    try{await plugin.v4Runtime.assertReencryptionSettingsSaveAllowed()}
    catch{settingsDenied=true}
    let writerDenied=false;
    try{await plugin.v4Runtime.openNewReencryptionDesktopWalForArmedRun()}
    catch{writerDenied=true}
    const adapter=app.vault.adapter;
    const fenceRoot=".obsidian/plugins/"+${JSON.stringify(pluginId)}
      +"/github-sync-v4-rekey-sync-fence";
    const lockPath=".obsidian/plugins/"+${JSON.stringify(pluginId)}
      +"/reencryption-wal/"+${JSON.stringify(walLeaf)}+"/.exclusive.lock";
    return {...report,
      orphanedWriterLockObserved:await adapter.exists(lockPath),
      persistedFenceSurvived:await adapter.exists(fenceRoot+"/active.json"),
      settingsDenied,writerDenied,
      noAutomaticResume:route.resumeSyncAuthorized===false,
      noAutomaticCutover:route.localCutoverAuthorized===false,
      sourceNoteUnchanged:(await adapter.read("D377-synthetic-note.md"))
        ===${JSON.stringify(expectedText)},
      remoteGitHubUsed:false};
  })()`, 60000)
  for (const key of ["authenticated", "WALUnchanged",
    "persistedFenceSurvived",
    "settingsDenied", "writerDenied", "noAutomaticResume",
    "noAutomaticCutover", "sourceNoteUnchanged"]) {
    assert.equal(restartResult[key], true, "D377 installed restart failed: " + key)
  }
  assert.equal(restartResult.pendingRefRequiresManualRevalidation,
    !verifiedBackupHandoff)
  assert.equal(restartResult.verifiedBackupHandoffSurvived,
    verifiedBackupHandoff)
  assert.equal(restartResult.orphanedWriterLockObserved, killWriter,
    "D377 killed writer must leave a stale OS lock for Manual Recovery")
  assert.equal(restartResult.remoteGitHubUsed, false)
  assert.equal(restartResult.localCutoverAuthorized, false)
  assert.equal(restartResult.resumeSyncAuthorized, false)
  success = true
  }
} catch (error) {
  // The native renderer must never leak raw CDP/secret error details.
  console.error("D377_INSTALLED_WAL_PROOF_FAILED at " + phase + ": "
    + String(error?.message ?? "unknown").slice(0,180))
  process.exitCode = 1
} finally {
  try { if (child?.pid) terminate() } catch {
    cleanup = "process-termination-unconfirmed"
    process.exitCode = 1
  }
  if (runRoot && cleanup !== "process-termination-unconfirmed") {
    for (let i = 0; i < 24; i++) {
      try {
        await rm(runRoot, { recursive: true, force: true,
          maxRetries: 2, retryDelay: 200 })
        cleanup = "temporary-vault-removed"
        break
      } catch {
        if (i === 23) {
          cleanup = "temporary-vault-removal-unconfirmed"
          process.exitCode = 1
        } else await sleep(350)
      }
    }
  }
  console.log(JSON.stringify({
    status: success && !process.exitCode ? "PASS" : "FAIL",
    processLossInjectedWhileWriterHeldLock: killWriter,
    revokedSyntheticInitiatorLeaseAfterPendingBackupIntent: revokeLease,
    installedAuthenticatedGitHubInventoryPhysicalParity: verifiedEvidence
      ? result?.transferredGitHubInventoryParityVerified === true
        && result?.checkedSourceCommitSha === verifiedEvidence.inventory.pinnedSourceCommitSha
        && result?.remoteGitHubUsed === false
        && result?.cutoverAuthorized === false
      : null,
    syntheticInstalledPhysicalSourceParity: sourceParity && !verifiedEvidence
      ? result?.syntheticSourceParityVerified === true
        && (tamperSource ? result?.physicalSourceDriftDenied === true
          : result?.leaseRevocationDeniedSourceParity === true)
        && result?.remoteGitHubSourceAuthenticated === false
      : null,
    physicalSourceSameSizeTamperRejectedAndWalRetained: tamperSource
      ? result?.physicalSourceDriftDenied === true
        && result?.physicalSourceDriftSameSize === true
        && result?.physicalSourceDriftPreservedWal === true
      : null,
    revokedLeaseRefusedWalWriteAndCheckpoint: revokeLease
      ? result?.leaseRevocationDeniedNewWalWrite === true
        && result?.leaseRevocationDeniedCheckpoint === true
        && result?.walDirectoryUnchangedAfterRevocation === true
        && result?.physicalSlotsUnchangedAfterRevocation === true
      : null,
    orphanedWriterLockRetained: killWriter
      ? restartResult?.orphanedWriterLockObserved === true : null,
    installedRuntimePersistedFence: result?.settingsDenied === true,
    createOnlyEncryptedWal: (verifiedBackupHandoff
      ? result?.verifiedBackupHandoff === true
      : result?.pendingBackupIntentOnly === true)
      && result?.reopenedDenied === true,
    preHandoffPhysicalDriftDeniedWithoutWal: preHandoffDrift
      ? result?.preHandoffParityDenied === true
        && result?.noWalSlots === true : null,
    installedVerifiedBackupHandoff: verifiedBackupHandoff
      ? result?.verifiedBackupHandoff === true && result?.generation === 4 : null,
    restartPreservedVerifiedBackupHandoff: verifiedBackupHandoff
      ? restartResult?.verifiedBackupHandoffSurvived === true
        && restartResult?.WALUnchanged === true : null,
    freshProcessAuthenticatedWal: restartResult?.authenticated === true
      && restartResult?.WALUnchanged === true,
    manualRecoveryAfterRestart: restartResult?.writerDenied === true
      && restartResult?.remoteWritesAuthorized === false
      && restartResult?.resumeSyncAuthorized === false,
    remoteGitHubUsed: false, cutoverAuthorized: false,
    actualPowerLossProven: false, installedFullMigrationProven: false,
    cleanup,
  }))
}
