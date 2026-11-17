import assert from "node:assert/strict";
import { appendFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test, { after } from "node:test";
import { setRequestUrlHandler } from "obsidian";
import { deriveGitHubE2EDestinationBranch, deriveGitHubE2EFrozenBackupBranch } from "../../scripts/github-e2e-env.mjs";
import { digestD392InstalledEvidence } from "../../scripts/installed-source-evidence-digest.mjs";

import { GitHubClient, type GitHubConfig } from "../../src/lib/github-api";
import { fromBase64Url, randomBytes, sha256Hex, toBase64, toBase64Url } from "../../src/lib/bytes";
import { deriveV4Keyring, type V4Keyring } from "../../src/lib/v4/crypto";
import { V4HistoryService } from "../../src/lib/v4/history-service";
import { verifyGitHubReencryptionForkSourceWithParityInventory, verifyGitHubReencryptionForkSourceWithTranscodeInventory, verifyGitHubReencryptionSource, verifyGitHubFrozenReencryptionBackup } from "../../src/lib/v4/reencryption-trusted-loader";
import { verifyStagedV4ReencryptionGitBlobs } from "../../src/lib/v4/reencryption-blob-reconciliation";
import { verifyV4ReencryptionDestinationExactCommit } from "../../src/lib/v4/reencryption-destination-exact-commit";
import { inspectV4ReencryptionOrphanAfterAmbiguousPublication } from "../../src/lib/v4/reencryption-orphan-recovery";
import { createV4ReencryptionRecoveryJournal } from "../../src/lib/v4/reencryption-recovery-journal";
import { acquireV4DesktopRekeyWalStorage } from "../../src/lib/v4/reencryption-desktop-wal";
import { createV4BestEffortJournaledFrozenBackup, prepareV4BestEffortJournaledOrphanCandidate, publishV4BestEffortJournaledThreeBranchDestination, reconcileV4PendingFrozenBackupWithJournalBestEffort, reconcileV4PendingOrphanWithJournalBestEffort, stageV4BestEffortJournaledThreeBranchVault } from "../../src/lib/v4/reencryption-ref-journal-coordinator";
import { computeV4GitBlobSha1 } from "../../src/lib/v4/git-blob-identity";
import { proposeV4SameRepositoryReencryptionBackupBranch } from "../../src/lib/v4/reencryption-owner-decisions";
import { createV4FrozenSameRepositoryBackupRef } from "../../src/lib/v4/reencryption-frozen-backup-ref";
import { stageV4ReencryptionVaultObjects, type V4ReencryptionObjectReceipt } from "../../src/lib/v4/reencryption-staging-receipts";
import { prepareV4ReencryptionOrphanCommit, type V4PreparedOrphanCommit } from "../../src/lib/v4/reencryption-orphan-publication";
import { readImmutableGitFile } from "../../src/lib/v4/immutable-git-read";
import type { V4LocalIndexAdapter } from "../../src/lib/v4/local-index";
import {
  planV4OrphanReencryptionDestination,
  assertV4OrphanDestinationRefObservations,
  assertV4OrphanReencryptionRoot,
} from "../../src/lib/v4/reencryption-orphan-branch";
import { buildV4RemoteMetadata } from "../../src/lib/v4/remote-index";
import { createEmptyV4LocalIndex, type V4LocalIndex, type V4IndexFileRecord } from "../../src/lib/v4/local-index";
import { isV4PublicationRaceError } from "../../src/lib/v4/publication-race";
import { expectedV4PathLayout, V4_FORMAT_VERSION, type V4RemoteConfig, type V4RemoteHead, type V4StorageMode } from "../../src/lib/v4/protocol-types";
import { V4StorageCodec } from "../../src/lib/v4/storage-codec";
import { createV4WholeBufferContentSource } from "../../src/lib/v4/content-source";
import { verifyV4ReencryptionBackupRestoreRehearsal } from "../../src/lib/v4/reencryption-restore-rehearsal";
import { verifyV4ReencryptionInitiatorLocalParity, type V4InitiatorLocalReader } from "../../src/lib/v4/reencryption-initiator-parity";
import { V4RemoteObjectMissingError, V4SyncSession, type V4SessionVault, type V4SyncRunState } from "../../src/lib/v4/sync-session";
import type { V4RecoveryStore } from "../../src/lib/v4/recovery-store";
import { createV4StagingStore, type V4StagingBackend, type V4StagingStore } from "../../src/lib/v4/staging-store";
import {
  encodeGitHubE2ERefPath,
  readGitHubE2ETargetEnvironment,
  resetGitHubE2EDisposableBranch,
  resolveGitHubE2ETarget,
} from "./support/target-safety";
import { observeV4PrePublishHeadNull } from "./support/pre-publish-head-null-evidence";
import { inspectImmutableMissingObject } from "./support/immutable-missing-evidence";

const encoder = new TextEncoder();

type E2ESession = Pick<V4SyncSession, "sync">;

interface ModeContext {
  mode: V4StorageMode;
  remoteConfig: V4RemoteConfig;
  keyring?: V4Keyring;
}

interface DeviceContext {
  name: string;
  vault: MemoryVault;
  index: V4LocalIndex;
  client: GitHubClient;
  session: E2ESession;
  rawSession: V4SyncSession;
}

interface InterferenceState {
  armed: boolean;
  fired: boolean;
  marker?: string;
  externalCommitSha?: string;
}

const interference: InterferenceState = { armed: false, fired: false };

// Test-only one-shot injection. No production request, response or Sync policy is changed.
interface ControlledMissingObjectFault {
  expectedCommit: string;
  fired: boolean;
  evidenceOutcome?: string;
}
const missingObjectFaults = new WeakMap<GitHubClient, ControlledMissingObjectFault>();
const diagnosticRecoveryStores = new WeakMap<GitHubClient, V4RecoveryStore>();

function branchPath(config: GitHubConfig): string {
  return encodeGitHubE2ERefPath(config.branch);
}

function bytes(text: string): Uint8Array {
  return encoder.encode(text);
}

function deterministicBinary(length: number, seed: number): Uint8Array {
  const output = new Uint8Array(length);
  let value = seed >>> 0;
  for (let index = 0; index < output.length; index++) {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    output[index] = value >>> 24;
  }
  return output;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

async function fetchWithRetry(url: string, init: RequestInit, attempts = 3): Promise<Response> {
  let response: Response | undefined;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    response = await fetch(url, init);
    if (![401, 403, 429].includes(response.status) && response.status < 500) return response;
    if (attempt < attempts) {
      await response.arrayBuffer().catch(() => undefined);
      await new Promise(resolve => setTimeout(resolve, attempt * 500));
    }
  }
  return response!;
}

async function githubRequest(config: GitHubConfig, apiPath: string, init: RequestInit = {}, attempts = 3): Promise<Response> {
  return fetchWithRetry(`https://api.github.com/repos/${config.owner}/${config.repo}${apiPath}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2026-03-10",
      ...(init.headers ?? {}),
    },
  }, attempts);
}

async function expectJson<T>(response: Response, successStatuses: readonly number[], action: string): Promise<T> {
  const text = await response.text();
  if (!successStatuses.includes(response.status)) throw new Error(`${action}: HTTP ${response.status} ${text}`);
  return (text ? JSON.parse(text) : {}) as T;
}

async function publishExternalCommit(config: GitHubConfig, marker: string): Promise<string> {
  const encodedBranch = branchPath(config);
  const ref = await expectJson<{ object?: { sha?: string } }>(
    await githubRequest(config, `/git/ref/heads/${encodedBranch}?_=${Date.now()}`),
    [200],
    "Cannot read branch before external E2E commit",
  );
  const headSha = ref.object?.sha;
  if (!headSha) throw new Error("External E2E branch ref is missing a commit SHA.");

  const commit = await expectJson<{ tree?: { sha?: string } }>(
    await githubRequest(config, `/git/commits/${headSha}`),
    [200],
    "Cannot read commit before external E2E commit",
  );
  const baseTree = commit.tree?.sha;
  if (!baseTree) throw new Error("External E2E base commit is missing its tree SHA.");

  const blob = await expectJson<{ sha?: string }>(
    await githubRequest(config, "/git/blobs", {
      method: "POST",
      body: JSON.stringify({ content: toBase64(bytes(`external-e2e:${marker}\n`)), encoding: "base64" }),
    }),
    [201],
    "Cannot create external E2E blob",
  );
  if (!blob.sha) throw new Error("External E2E blob response is missing SHA.");

  const tree = await expectJson<{ sha?: string }>(
    await githubRequest(config, "/git/trees", {
      method: "POST",
      body: JSON.stringify({
        base_tree: baseTree,
        tree: [{ path: `.e2e-external/${marker}.txt`, mode: "100644", type: "blob", sha: blob.sha }],
      }),
    }),
    [201],
    "Cannot create external E2E tree",
  );
  if (!tree.sha) throw new Error("External E2E tree response is missing SHA.");

  const externalCommit = await expectJson<{ sha?: string }>(
    await githubRequest(config, "/git/commits", {
      method: "POST",
      body: JSON.stringify({ message: `external-e2e:${marker}`, tree: tree.sha, parents: [headSha] }),
    }),
    [201],
    "Cannot create external E2E commit",
  );
  if (!externalCommit.sha) throw new Error("External E2E commit response is missing SHA.");

  await expectJson<unknown>(
    await githubRequest(config, `/git/refs/heads/${encodedBranch}`, {
      method: "PATCH",
      body: JSON.stringify({ sha: externalCommit.sha, force: false }),
    }),
    [200],
    "Cannot publish external E2E commit",
  );
  return externalCommit.sha;
}

function installRequestUrlBridge(config: GitHubConfig): void {
  const refSuffix = `/git/refs/heads/${branchPath(config)}`;
  setRequestUrlHandler(async raw => {
    const request = raw as { url: string; method?: string; headers?: Record<string, string>; body?: string };
    const method = (request.method ?? "GET").toUpperCase();
    // Simulate an external writer immediately before the plugin's real
    // GraphQL CAS. The old REST PATCH interception alone cannot exercise
    // beforeOid rejection after Stage E1.
    const graphqlInput = method === "POST" && request.url === "https://api.github.com/graphql"
      ? (() => { try { return JSON.parse(request.body ?? "") as { query?: string; variables?: { input?: { refUpdates?: Array<{ name?: string }> } } }; } catch { return null; } })()
      : null;
    const isTargetCas = !!graphqlInput?.query?.includes("updateRefs(")
      && graphqlInput.variables?.input?.refUpdates?.some(ref => ref.name === `refs/heads/${config.branch}`);
    if (interference.armed && !interference.fired && (isTargetCas || (method === "PATCH" && request.url.includes(refSuffix)))) {
      interference.fired = true;
      interference.externalCommitSha = await publishExternalCommit(config, interference.marker ?? "controlled-race");
    }

    const response = await fetchWithRetry(request.url, {
      method,
      ...(request.headers ? { headers: request.headers } : {}),
      ...(request.body === undefined ? {} : { body: request.body }),
    });
    const arrayBuffer = await response.arrayBuffer();
    const text = new TextDecoder().decode(arrayBuffer);
    let json: unknown;
    try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      text,
      json,
      arrayBuffer,
    };
  });
}

function resetInterference(): void {
  interference.armed = false;
  interference.fired = false;
  delete interference.marker;
  delete interference.externalCommitSha;
}

function armInterference(marker: string): void {
  resetInterference();
  interference.armed = true;
  interference.marker = marker;
}

async function waitForBranchHead(config: GitHubConfig, expectedSha: string, timeoutMs = 15_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    const response = await githubRequest(config, `/git/ref/heads/${branchPath(config)}?_=${Date.now()}`);
    if (response.status === 200) {
      const ref = await response.json() as { object?: { sha?: string } };
      if (ref.object?.sha === expectedSha) return;
    } else {
      await response.arrayBuffer().catch(() => undefined);
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for GitHub E2E branch head ${expectedSha} after ${timeoutMs}ms.`);
}

class MemoryVault implements V4SessionVault {
  readonly files = new Map<string, { bytes: Uint8Array; mtime: number }>();
  staging?: V4StagingStore;

  set(path: string, content: Uint8Array, mtime = Date.now()): void {
    this.files.set(path, { bytes: new Uint8Array(content), mtime });
  }

  async listFiles() {
    return [...this.files].map(([path, file]) => ({ path, size: file.bytes.byteLength, mtime: file.mtime }));
  }

  async stat(path: string) {
    const file = this.files.get(path);
    return file ? { path, size: file.bytes.byteLength, mtime: file.mtime } : null;
  }

  async read(path: string) {
    const file = this.files.get(path);
    if (!file) throw new Error(`Missing local E2E file: ${path}`);
    return new Uint8Array(file.bytes);
  }

  async write(path: string, content: Uint8Array, mtime?: number) {
    this.set(path, content, mtime);
  }

  async trash(path: string) {
    this.files.delete(path);
  }
}

function repoId(config: GitHubConfig): string {
  return `${config.owner}/${config.repo}#${config.branch}`;
}

async function createModeContext(mode: V4StorageMode, config: GitHubConfig): Promise<ModeContext> {
  const salt = randomBytes(16);
  const remoteConfig: V4RemoteConfig = mode === "encrypted"
    ? {
      formatVersion: V4_FORMAT_VERSION,
      mode,
      repoId: repoId(config),
      pathLayout: expectedV4PathLayout(mode),
      algorithm: "AES-GCM",
      kdf: "PBKDF2-SHA-256",
      kdfParams: { iterations: 10_000, salt: toBase64Url(salt) },
    }
    : { formatVersion: V4_FORMAT_VERSION, mode, repoId: repoId(config), pathLayout: expectedV4PathLayout(mode) };
  const keyring = mode === "encrypted"
    ? await deriveV4Keyring({ passphrase: "v4-real-github-e2e", repoId: remoteConfig.repoId, salt, iterations: 10_000 })
    : undefined;
  return { mode, remoteConfig, ...(keyring ? { keyring } : {}) };
}

function createDevice(name: string, config: GitHubConfig, context: ModeContext, now?: () => number): DeviceContext {
  const vault = new MemoryVault();
  const index = createEmptyV4LocalIndex({
    repoId: context.remoteConfig.repoId,
    deviceId: name,
    mode: context.mode,
    pathLayout: expectedV4PathLayout(context.mode),
  });
  const client = new GitHubClient(config);
  // Diagnostic only: preserve the exact immutable ref that returned no object.
  // This is essential for distinguishing stale metadata from a missing blob.
  const getFileBytes = client.getFileBytes.bind(client);
  client.getFileBytes = (path, ref) => {
    const requested = getFileBytes(path, ref);
    // Do not add Promise scheduling to unrelated request paths in the race test.
    if (path !== "Notes/reborn.md") return requested;
    return requested.then(file => {
      const fault = missingObjectFaults.get(client);
      if (file && fault && !fault.fired && ref === fault.expectedCommit) {
        // Simulate an intermittent Contents+immutable read miss AFTER the real
        // client has successfully read the exact published bytes.
        fault.fired = true;
        file = null;
      }
      if (file) return file;
      // On the same rare null result, inspect each immutable Git level
      // independently. Never turn the original miss into success or retry.
      return (async () => {
        try {
          const readOnly = async (kind: "commit" | "tree", sha: string) => {
            const response = await githubRequest(config, `/git/${kind === "commit" ? "commits" : "trees"}/${sha}`, {}, 1);
            return response.status === 200
              ? { status: response.status, json: await response.json() as unknown }
              : { status: response.status };
          };
          const evidence = await inspectImmutableMissingObject(path, ref, {
            getCommit: sha => readOnly("commit", sha),
            getTree: sha => readOnly("tree", sha),
          });
          if (fault?.fired && ref === fault.expectedCommit) fault.evidenceOutcome = evidence.outcome;
          console.error(JSON.stringify({
            ...evidence,
            device: name,
            localIndexCommitSha: /^[0-9a-f]{40}$/u.test(index.remoteCommitSha ?? "")
              ? index.remoteCommitSha : null,
            localRecordFileIds: Object.values(index.shards).flatMap(shard => Object.values(shard.records))
              .filter(record => record.path === path && !record.deleted).map(record => record.fileId),
          }));
        } catch { /* Diagnostics must not replace the original missing result. */ }
        return file;
      })();
    });
  };
  const sessionInput = {
    github: client,
    vault,
    index,
    config: context.remoteConfig,
    ...(context.keyring ? { keyring: context.keyring } : {}),
    conflictPolicy: "copy" as const,
    abortChangePercent: 0,
    ...(now ? { now } : {}),
  };
  const rawSession = new V4SyncSession(sessionInput);
  const session: E2ESession = {
    async sync(options) {
      const runState: V4SyncRunState = { conflictCopies: new Map(), conflictCopyStages: new Map() };
      let lastError: unknown;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const recoveryStore = diagnosticRecoveryStores.get(client);
          return await new V4SyncSession({
            ...sessionInput, runState,
            ...(recoveryStore ? { recoveryStore } : {}),
          }).sync(options);
        } catch (error) {
          lastError = error;
          const message = error instanceof Error ? error.message : String(error);
          const retryable = options.operation === "normal" && isV4PublicationRaceError(error);
          if (!retryable || attempt === 3) {
            // Failure-only, read-only observations. Preserve the original error
            // and fail-closed publication result; never retry on this evidence.
            await observeV4PrePublishHeadNull(error, {
              device: name,
              localIndexCommitSha: index.remoteCommitSha,
              readBranch: async () => {
                const response = await githubRequest(config, `/git/ref/heads/${branchPath(config)}?_=${Date.now()}`);
                if (response.status !== 200) return { status: response.status };
                const body = await response.json() as { object?: { sha?: string } };
                return {
                  status: response.status,
                  ...(body.object?.sha ? { sha: body.object.sha } : {}),
                };
              },
              readExpectedCommit: async sha => {
                const response = await githubRequest(config, `/git/commits/${sha}`);
                if (response.status !== 200) return { status: response.status };
                const body = await response.json() as { sha?: string; tree?: { sha?: string } };
                return {
                  status: response.status,
                  ...(body.sha ? { sha: body.sha } : {}),
                  ...(body.tree?.sha ? { treeSha: body.tree.sha } : {}),
                };
              },
              report: evidence => console.error(JSON.stringify(evidence)),
            });
            throw error;
          }
          runState.conflictCopyStages?.clear();
          console.warn(`GitHub E2E retrying normal sync after recoverable CAS race (attempt ${attempt + 1}/3): ${message}`);
        }
      }
      throw lastError;
    },
  };
  return { name, vault, index, client, session, rawSession };
}

function liveRecords(device: DeviceContext) {
  return Object.values(device.index.shards).flatMap(shard => Object.values(shard.records)).filter(record => !record.deleted);
}

function recordFor(device: DeviceContext, path: string) {
  const record = liveRecords(device).find(candidate => candidate.path === path);
  if (!record) throw new Error(`${device.name} is missing V4 record for ${path}`);
  return record;
}

function assertVaultEquals(actual: MemoryVault, expected: MemoryVault, label: string): void {
  const actualPaths = [...actual.files.keys()].sort();
  const expectedPaths = [...expected.files.keys()].sort();
  assert.deepEqual(actualPaths, expectedPaths, `${label}: path set differs`);
  for (const path of expectedPaths) {
    const actualFile = actual.files.get(path);
    const expectedFile = expected.files.get(path)!;
    assert.ok(actualFile, `${label}: missing ${path}`);
    assert.deepEqual(actualFile.bytes, expectedFile.bytes, `${label}: bytes differ at ${path}`);
  }
}

function assertVaultContainsBytes(vault: MemoryVault, expected: Uint8Array, label: string): void {
  assert.equal([...vault.files.values()].some(file => sameBytes(file.bytes, expected)), true, label);
}

function assertNoConflictCopies(vault: MemoryVault, label: string): void {
  assert.equal([...vault.files.keys()].some(path => path.includes(".conflict-remote-")), false, label);
}

async function verifyEncryptedObjectTransport(device: DeviceContext, context: ModeContext, path?: string): Promise<void> {
  if (context.mode !== "encrypted") return;
  const commitSha = device.index.remoteCommitSha;
  assert.ok(commitSha, `${device.name}: missing remote commit SHA`);
  const commit = await device.client.getGitCommit(commitSha);
  const tree = await device.client.getTreeAt(commit.treeSha, true);
  const records = path ? [recordFor(device, path)] : liveRecords(device);
  const codec = new V4StorageCodec({ mode: context.mode, pathLayout: expectedV4PathLayout(context.mode), keyring: context.keyring });

  for (const record of records) {
    const node = tree.tree.find(item => item.path === record.remotePath);
    assert.ok(node, `${device.name}: missing remote object ${record.remotePath}`);
    const [byPath, byBlob]: [
      Awaited<ReturnType<GitHubClient["getFileBytes"]>>,
      Awaited<ReturnType<GitHubClient["getBlob"]>>,
    ] = await Promise.all([
      device.client.getFileBytes(record.remotePath, commitSha),
      device.client.getBlob(node.sha),
    ]);
    assert.ok(byPath, `${device.name}: Contents read missing ${record.remotePath}`);
    assert.deepEqual(byPath.bytes, byBlob, `${device.name}: Contents/Git Blob mismatch for ${record.remotePath}`);

    const decoded = await codec.read(record, async remotePath => {
      const remoteNode = tree.tree.find(item => item.path === remotePath);
      if (!remoteNode) throw new Error(`${device.name}: missing encrypted storage object ${remotePath}`);
      return device.client.getBlob(remoteNode.sha);
    });
    const local = device.vault.files.get(record.path);
    assert.ok(local, `${device.name}: missing local bytes for ${record.path}`);
    assert.deepEqual(decoded, local.bytes, `${device.name}: encrypted authentication mismatch for ${record.path}`);
  }
}

function scenarioMetrics(scenario: string, mode: V4StorageMode, started: number, devices: DeviceContext[]): void {
  console.log(JSON.stringify({
    scenario,
    mode,
    elapsedMs: Number((performance.now() - started).toFixed(1)),
    devices: Object.fromEntries(devices.map(device => [device.name, device.client.transportMetricsSnapshot])),
  }));
}

async function runScenario(
  config: GitHubConfig,
  mode: V4StorageMode,
  scenario: string,
  body: (input: {
    context: ModeContext;
    device: (name: string, now?: () => number) => DeviceContext;
  }) => Promise<void>,
): Promise<void> {
  await resetGitHubE2EDisposableBranch(targetEnvironment);
  const context = await createModeContext(mode, config);
  const devices: DeviceContext[] = [];
  const started = performance.now();

  try {
    await body({
      context,
      device: (name, now) => {
        const created = createDevice(name, config, context, now);
        devices.push(created);
        return created;
      },
    });
  } catch (error) {
    throw new Error(`GitHub E2E scenario failed: ${scenario} (${mode})`, { cause: error });
  } finally {
    scenarioMetrics(scenario, mode, started, devices);
    resetInterference();
  }
}

function seedBaseline(vault: MemoryVault, mode: V4StorageMode): void {
  vault.set("Notes/hello.md", bytes(`hello from ${mode}`), 1);
  vault.set("Assets/pixel.bin", new Uint8Array([0, 1, 2, 255]), 2);
  vault.set("Notes/สวัสดี 🌏/mañana.md", bytes("สวัสดี\nmañana\n🌏\n"), 3);
  vault.set("Projects/2026 Q3/[draft] #1.md", bytes("# draft\nspaces + punctuation\n"), 4);
  vault.set(".workspace/user-state.json", bytes('{"open":true,"pane":"left"}\n'), 5);
  vault.set("Empty/zero-byte.bin", new Uint8Array(), 6);
  vault.set("Assets/medium-1m.bin", deterministicBinary(1024 * 1024, 0x51a7), 7);
}

/**
 * D73 read-only live acceptance for D70-D72 pre-rekey source verification.
 * Reuses only the owner-approved, ID-proven, disposable E2E branch.
 */
async function runReencryptionReadOnlyScenario(config: GitHubConfig): Promise<void> {
  await runScenario(config, "encrypted", "readonly-rekey-encrypted", async ({ device }) => {
    const source = device("d73-source");
    seedBaseline(source.vault, "encrypted");
    const pushed = await source.session.sync({ operation: "forcePush", allowThresholdOverride: false });
    assert.equal(pushed.mode, "force-push");
    const publishedSha = source.index.remoteCommitSha;
    assert.match(publishedSha ?? "", /^[0-9a-f]{40}$/u);
    await waitForBranchHead(config, publishedSha!);

    // Create an independent GitHub client, not an already-cached sync reader.
    // The new D72 identity, D71 Git blob, D70 immutable tree, D69 plaintext
    // and D68 metadata checks all have to succeed against real REST responses.
    const reader = new GitHubClient(config);
    const before = reader.transportMetricsSnapshot;
    const inspected = await verifyGitHubReencryptionSource({
      github: reader,
      expectedRepoId: repoId(config),
      expectedBranch: config.branch,
      passphrase: "v4-real-github-e2e",
    });
    const after = reader.transportMetricsSnapshot;
    assert.equal(inspected.integrityScope, "all-live-objects");
    assert.equal(inspected.pinnedSourceCommitSha, publishedSha);
    assert.equal(inspected.verifiedFileCount, source.vault.files.size);
    assert.ok(inspected.verifiedRemoteObjectCount > 0);
    assert.equal(inspected.totalVerifiedPlaintextBytes,
      [...source.vault.files.values()].reduce((sum, file) => sum + BigInt(file.bytes.byteLength), BigInt(0)).toString());
    assert.equal(after.mutations, before.mutations,
      "Re-encryption source verification must NEVER mutate the remote Git repository");
    assert.equal((await reader.getGitRef()).sha, publishedSha,
      "Read-only verification changed the published Git branch");
    console.log(JSON.stringify({
      stage: "D73_READ_ONLY_REENCRYPTION_SOURCE_VERIFIED",
      branch: config.branch,
      sourceSha: publishedSha,
      files: inspected.verifiedFileCount,
      remoteObjects: inspected.verifiedRemoteObjectCount,
      plaintextBytes: inspected.totalVerifiedPlaintextBytes,
      gitReadRequests: after.requests,
      gitMutations: after.mutations - before.mutations,
    }));
  });
}

/**
 * D391: actual encrypted Source commit -> independently authenticated GitHub
 * inventory -> installed Windows Obsidian physical Vault parity -> same
 * initiating lease and WAL, with NO token passed to the installed process.
 *
 * The remote write below is only the existing approved E2E force-push into
 * the outer wrapper's preflight-proven ABSENT, disposable Source branch.
 * Backup and Destination exist ONLY as pending WAL intent names, never refs.
 */
async function runInstalledAuthenticatedSourceParityScenario(config: GitHubConfig): Promise<void> {
  const withBackup = process.env["GITHUB_E2E_ONLY_SCENARIO"] === "installed-source-backup-handoff-encrypted";
  await runScenario(config, "encrypted", withBackup ? "d397-installed-backup-handoff" : "d391-installed-authenticated-parity", async ({ device }) => {
    const source = device("d391-source");
    const note = "D377 synthetic WAL source note: สวัสดี";
    source.vault.set("D377-synthetic-note.md", bytes(note), 1);
    const pushed = await source.session.sync({ operation: "forcePush", allowThresholdOverride: false });
    assert.equal(pushed.mode, "force-push");
    const publishedSha = source.index.remoteCommitSha;
    assert.match(publishedSha ?? "", /^[a-f0-9]{40}$/u);
    await waitForBranchHead(config, publishedSha!);

    // A fresh client is required: cached Sync index records do NOT constitute
    // independently authenticated GitHub immutable-commit provenance.
    const reader = new GitHubClient(config);
    const before = reader.transportMetricsSnapshot;
    const inspected = await verifyGitHubReencryptionForkSourceWithParityInventory({
      github: reader,
      expectedRepoId: repoId(config),
      expectedBranch: config.branch,
      passphrase: "v4-real-github-e2e",
    });
    const after = reader.transportMetricsSnapshot;
    assert.equal(after.mutations, before.mutations);
    assert.equal(inspected.pinnedSourceCommitSha, publishedSha);
    assert.equal(inspected.verifiedSource.integrityScope, "all-live-objects");
    assert.equal(inspected.verifiedSource.verifiedFileCount, 1);
    assert.equal(inspected.verifiedSource.totalVerifiedPlaintextBytes, String(bytes(note).length));
    assert.equal(inspected.sourceRecords.length, 1);
    assert.equal(inspected.sourceRecords[0]?.path, "D377-synthetic-note.md");
    assert.equal(inspected.sourceRecords[0]?.plaintextSha256, await sha256Hex(bytes(note)));
    assert.equal(inspected.sourceRecords[0]?.deleted, false);
    assert.equal(inspected.initiatorLocalParityVerified, false);
    assert.equal(inspected.permissionToPublish, false);
    assert.equal(inspected.cutoverAuthorized, false);

    // A wrong old passphrase must fail the AES-GCM authentication itself,
    // not a broad assert.rejects that could pass on a GitHub network error.
    await assert.rejects(
      () => verifyGitHubReencryptionForkSourceWithParityInventory({
        github: new GitHubClient(config),
        expectedRepoId: repoId(config),
        expectedBranch: config.branch,
        passphrase: "d391-incorrect-old-passphrase",
      }),
      (error: unknown) => error instanceof Error
        && /Unable to decrypt V4 .* metadata/u.test(error.message)
        && error.cause instanceof Error && error.cause.name === "OperationError",
      "D391 wrong old key must be rejected by AES-GCM metadata authentication",
    );
    // Logical repo/ref mismatch must fail before any installed file access.
    await assert.rejects(
      () => verifyGitHubReencryptionForkSourceWithParityInventory({
        github: new GitHubClient(config),
        expectedRepoId: repoId(config),
        expectedBranch: config.branch + "-different",
        passphrase: "v4-real-github-e2e",
      }),
      /repository identity and branch do not match/u,
    );
    const physical = await reader.getRepositoryIdentity();
    assert.equal(physical.id, 1284153873);
    assert.equal(physical.fullName.toLowerCase(),
      (config.owner + "/" + config.repo).toLowerCase());
    const commit = await reader.getGitCommit(publishedSha!);
    assert.equal(commit.sha, publishedSha);
    assert.match(commit.treeSha, /^[a-f0-9]{40}$/u);
    assert.equal((await reader.getGitRef()).sha, publishedSha,
      "D391 read-only checks must leave disposable Source HEAD unmodified");

    // D397 runs a second, genuinely authenticated GitHub Backup readback
    // before the token-free inventory enters the installed Obsidian process.
    // The installed process never receives the GitHub credential.
    const backupBranch = deriveGitHubE2EFrozenBackupBranch(config.branch);
    const backupTarget = { ...targetEnvironment, branch: backupBranch, requiredBranch: backupBranch };
    const backupClient = new GitHubClient({ ...config, branch: backupBranch });
    let backupCleanupArmed = false;
    try {
      let verifiedFrozenBackup: {
        readonly branch: string;
        readonly repoId: string;
        readonly pinnedSourceCommitSha: string;
        readonly pinnedSourceTreeSha: string;
        readonly verifiedFileCount: number;
        readonly verifiedPlaintextBytes: string;
        readonly backupContentsReadbackVerified: true;
        readonly creationProven: false;
        readonly cutoverAuthorized: false;
      } | undefined;
      if (withBackup) {
        const target = await resolveGitHubE2ETarget(backupTarget);
        assert.equal(target.repositoryId, initialTarget.repositoryId);
        assert.equal(await backupClient.getGitRefOrNull(), null);
        assert.equal(await backupClient.getGitRefOrNull(), null);
        backupCleanupArmed = true;
        const plan = proposeV4SameRepositoryReencryptionBackupBranch({
          sourceRepoId: repoId(config),
          backupRepoId: `${config.owner}/${config.repo}#${backupBranch}`,
          destinationRepoId: `${config.owner}/${config.repo}#${deriveGitHubE2EDestinationBranch(config.branch)}`,
          pinnedSourceCommitSha: publishedSha!,
          sourcePhysicalRepositoryId: physical.id,
          backupPhysicalRepositoryId: physical.id,
          destinationPhysicalRepositoryId: physical.id,
          expectedPhysicalRepositoryId: physical.id,
          defaultBranch: initialTarget.defaultBranch,
        });
        // GitHub may return a transiently stale ref read after the one and
        // only create-only POST. Never send another POST. A specific uncertain
        // readback is resolved by independent full cryptographic Backup read.
        try {
          const created = await createV4FrozenSameRepositoryBackupRef({
            plan, verifiedSource: inspected.verifiedSource,
            source: reader, backup: backupClient, expectedSourceTreeSha: commit.treeSha,
          });
          assert.equal(created.backupRefCreatedAndReadBack, true);
          assert.equal(created.cutoverAuthorized, false);
        } catch (error) {
          if (!(error instanceof Error
            && error.message === "Frozen backup Git ref publication cannot be confirmed.")) {
            throw error;
          }
          // No second create attempt, even if the independent read is absent.
          console.log(JSON.stringify({
            stage: "D397_BACKUP_CREATE_READBACK_UNCERTAIN_NO_RETRY",
            backupBranch, remoteWritesAuthorized: false,
          }));
        }
        const freshBackupReader = new GitHubClient({ ...config, branch: backupBranch });
        const beforeBackup = freshBackupReader.transportMetricsSnapshot;
        const backup = await verifyGitHubFrozenReencryptionBackup({
          github: freshBackupReader, plan,
          expectedSourceTreeSha: commit.treeSha,
          passphrase: "v4-real-github-e2e",
        });
        assert.equal(freshBackupReader.transportMetricsSnapshot.mutations, beforeBackup.mutations);
        assert.equal(backup.backupContentsReadbackVerified, true);
        assert.equal(backup.verifiedFileCount, inspected.verifiedSource.verifiedFileCount);
        assert.equal(backup.verifiedPlaintextBytes, inspected.verifiedSource.totalVerifiedPlaintextBytes);
        assert.equal(backup.destinationPublicationAuthorized, false);
        assert.equal(backup.cutoverAuthorized, false);
        assert.equal((await backupClient.getGitRef()).sha, publishedSha);
        verifiedFrozenBackup = {
          branch: backupBranch, repoId: plan.backupRepoId,
          pinnedSourceCommitSha: publishedSha!,
          pinnedSourceTreeSha: commit.treeSha,
          verifiedFileCount: backup.verifiedFileCount,
          verifiedPlaintextBytes: backup.verifiedPlaintextBytes,
          backupContentsReadbackVerified: true, creationProven: false,
          cutoverAuthorized: false,
        };
      }

    // A one-use, token-FREE evidence handoff. The parent E2E process is the
    // provenance authority; the JSON file by itself is never sufficient for
    // production publication or cutover.
    const tempRoot = path.join(process.cwd(), ".tmp");
    const dir = path.join(tempRoot, "github-e2e");
    await mkdir(dir, { recursive: true });
    for (const target of [tempRoot, dir]) {
      const stat = await lstat(target);
      assert.ok(stat.isDirectory() && !stat.isSymbolicLink(),
        "D391 refuses redirected or non-directory test evidence roots");
    }
    const owned = await mkdtemp(path.join(dir, "d391-inventory-"));
    const ownedStat = await lstat(owned);
    assert.ok(ownedStat.isDirectory() && !ownedStat.isSymbolicLink(),
      "D391 refuses redirected temporary inventory directory");
    const evidencePath = path.join(owned, "source.json");
    const repoPrefix = `${config.owner}/${config.repo}#${config.branch}`;
    const data = {
      schemaVersion: 1,
      provenance: "d391-github-e2e-trusted-immutable-readback",
      repo: {
        owner: config.owner, name: config.repo, branch: config.branch,
        physicalRepositoryId: physical.id,
      },
      inventory: inspected,
      walBinding: {
        sourceCommitSha: publishedSha,
        sourceTreeSha: commit.treeSha,
        backupRepoId: withBackup ? `${config.owner}/${config.repo}#${backupBranch}`
          : repoPrefix + "-d391-backup",
        destinationRepoId: withBackup
          ? `${config.owner}/${config.repo}#${deriveGitHubE2EDestinationBranch(config.branch)}`
          : repoPrefix + "-d391-destination",
      },
      remoteMutationsAfterSourcePublish: 0,
      ...(verifiedFrozenBackup ? { verifiedFrozenBackup } : {}),
    };
    // Never transfer passphrases, ciphertext, credentials, tokens or local user data.
    // This digest originates in the parent immediately after its real GitHub
    // readback and binds the exact token-free bytes consumed by installed UI.
    const evidenceBytes = Buffer.from(JSON.stringify(data), "utf8");
    const evidenceDigest = digestD392InstalledEvidence(evidenceBytes);
    await writeFile(evidencePath, evidenceBytes, { flag: "wx" });
    const safeNativeEnv: NodeJS.ProcessEnv = {};
    for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "USERPROFILE", "APPDATA",
      "LOCALAPPDATA", "TEMP", "TMP", "HOMEDRIVE", "HOMEPATH", "COMSPEC",
      "PATHEXT", "ProgramFiles", "ProgramFiles(x86)", "USERNAME"]) {
      if (process.env[key] !== undefined) safeNativeEnv[key] = process.env[key];
    }
    try {
      // Negative end-to-end provenance test: change the Git tree SHA while
      // retaining valid JSON, valid SHA syntax and identical byte length.
      // The child must reject BEFORE loading any installed Obsidian profile.
      const tamperedEvidence = Buffer.from(evidenceBytes);
      const treeOffset = tamperedEvidence.indexOf(Buffer.from(commit.treeSha, "ascii"));
      assert.ok(treeOffset >= 0, "D392 could not locate the authenticated tree identity");
      tamperedEvidence[treeOffset] = commit.treeSha[0] === "0" ? 49 : 48;
      assert.equal(tamperedEvidence.byteLength, evidenceBytes.byteLength);
      assert.notEqual(tamperedEvidence.toString("utf8"), evidenceBytes.toString("utf8"));
      await writeFile(evidencePath, tamperedEvidence);
      try {
        const denied = spawnSync(process.execPath,
          ["scripts/run-obsidian-disposable-wal-authoring.mjs",
            "--authenticated-source=" + evidencePath, "--evidence-sha256=" + evidenceDigest],
          { cwd: process.cwd(), env: safeNativeEnv, shell: false,
            encoding: "utf8", timeout: 15_000, windowsHide: true });
        assert.equal(denied.error, undefined, "D392 tamper child must launch normally");
        assert.notEqual(denied.status, 0,
          "D392 edited test-only Source inventory must never pass installed acceptance");
        assert.match(denied.stderr, /D392 installed Source evidence SHA-256 mismatch/u,
          "D392 mismatch must be rejected at the manifest boundary, not during later Obsidian startup");
        assert.equal(denied.stdout.includes("D377_INSTALLED_WAL_PROOF"), false,
          "D392 rejected evidence cannot produce a successful installed WAL result");
      } finally {
        await writeFile(evidencePath, evidenceBytes);
      }
      if (withBackup) {
        // The parent-readback Backup identity is also pinned byte-for-byte.
        // A same-length valid-looking backup ref cannot be silently swapped
        // while the child is starting. Deny before creating the test Vault.
        const swapped = Buffer.from(evidenceBytes);
        const marker = Buffer.from(`"branch":"${backupBranch}"`, "utf8");
        const markerOffset = swapped.indexOf(marker);
        assert.ok(markerOffset >= 0, "D397 verified Backup evidence must be present");
        const hexIndex = markerOffset + marker.byteLength - 2;
        swapped[hexIndex] = swapped[hexIndex] === 48 ? 49 : 48;
        assert.equal(swapped.byteLength, evidenceBytes.byteLength);
        await writeFile(evidencePath, swapped);
        try {
          const denied = spawnSync(process.execPath,
            ["scripts/run-obsidian-disposable-wal-authoring.mjs",
              "--authenticated-source-backup=" + evidencePath,
              "--evidence-sha256=" + evidenceDigest],
            { cwd: process.cwd(), env: safeNativeEnv, shell: false,
              encoding: "utf8", timeout: 15_000, windowsHide: true });
          assert.equal(denied.error, undefined);
          assert.notEqual(denied.status, 0);
          assert.match(denied.stderr, /D392 installed Source evidence SHA-256 mismatch/u);
          assert.equal(denied.stdout.includes("D377_INSTALLED_WAL_PROOF"), false);
        } finally {
          await writeFile(evidencePath, evidenceBytes);
        }
      }
      for (const mode of withBackup ? ["backup", "backup-tamper", "backup-revoke", "backup-prehandoff-drift"] as const
        : ["normal", "tamper", "revoke"] as const) {
        const flag = mode === "backup-prehandoff-drift" ? "--authenticated-source-backup-prehandoff-drift="
          : mode === "backup-tamper" ? "--authenticated-source-backup-tamper="
          : mode === "backup-revoke" ? "--authenticated-source-backup-revoke="
            : mode === "backup" ? "--authenticated-source-backup="
          : mode === "normal" ? "--authenticated-source="
          : mode === "tamper" ? "--authenticated-source-tamper="
            : "--authenticated-source-revoke=";
        const child = spawnSync(process.execPath,
          ["scripts/run-obsidian-disposable-wal-authoring.mjs",
            flag + evidencePath, "--evidence-sha256=" + evidenceDigest],
          { cwd: process.cwd(), env: safeNativeEnv, shell: false,
            encoding: "utf8", timeout: 220_000, windowsHide: true });
        assert.equal(child.error, undefined, "D391 installed child could not be launched: " + mode);
        if (child.status !== 0) {
          // The installed runner already sanitizes renderer/CDP failures.
          // Never echo arbitrary child stdout or environment/token values.
          const safeFailure = child.stderr.split(/\r?\n/u)
            .filter(line => /^(?:D377_INSTALLED_WAL_PROOF_FAILED|AssertionError|Error:)/u.test(line))
            .slice(0, 2).map(line => line.slice(0, 180)).join(" | ");
          throw new Error("D391 installed child failed in " + mode
            + " (exit " + String(child.status) + "): "
            + (safeFailure || "no sanitized failure details"));
        }
        const lines = child.stdout.split(/\r?\n/u).filter(Boolean);
        const status = JSON.parse(lines.at(-1) ?? "null") as Record<string, unknown> | null;
        assert.equal(status?.["status"], "PASS");
        assert.equal(status?.["installedAuthenticatedGitHubInventoryPhysicalParity"], true);
        if (mode === "backup-prehandoff-drift") {
          assert.equal(status?.["preHandoffPhysicalDriftDeniedWithoutWal"], true,
            "D398 changed physical Source must fail before a Backup WAL is written");
          assert.equal(status?.["freshProcessAuthenticatedWal"], false);
          assert.equal(status?.["manualRecoveryAfterRestart"], false);
          assert.equal(status?.["installedVerifiedBackupHandoff"], false);
        } else {
          assert.equal(status?.["freshProcessAuthenticatedWal"], true);
          assert.equal(status?.["manualRecoveryAfterRestart"], true);
        }
        assert.equal(status?.["remoteGitHubUsed"], false);
        assert.equal(status?.["cutoverAuthorized"], false);
        assert.equal(status?.["cleanup"], "temporary-vault-removed");
        if (mode.startsWith("backup") && mode !== "backup-prehandoff-drift") {
          assert.equal(status?.["installedVerifiedBackupHandoff"], true);
          assert.equal(status?.["restartPreservedVerifiedBackupHandoff"], true);
          assert.equal(status?.["cutoverAuthorized"], false);
        }
        if (mode === "tamper" || mode === "backup-tamper") {
          assert.equal(status?.["physicalSourceSameSizeTamperRejectedAndWalRetained"], true);
        }
        if (mode === "revoke" || mode === "backup-revoke") {
          assert.equal(status?.["revokedLeaseRefusedWalWriteAndCheckpoint"], true);
        }
        console.log(JSON.stringify({
          stage: mode === "backup-prehandoff-drift" ? "D398_INSTALLED_PREHANDOFF_DRIFT_REJECTED"
            : mode.startsWith("backup") ? "D397_INSTALLED_VERIFIED_BACKUP_WAL_HANDOFF"
            : "D391_INSTALLED_GITHUB_AUTHENTICATED_SOURCE_PARITY",
          mode, physicalFileCount: inspected.verifiedSource.verifiedFileCount,
          pinnedSourceCommitSha: publishedSha,
          installedProcessRestartVerified: mode !== "backup-prehandoff-drift",
          remoteGitHubWritesInsideObsidian: false,
          ownerControlledLocalCutoverAuthorized: false,
          cleanup: status?.["cleanup"],
        }));
      }
    } finally {
      await rm(owned, { recursive: true, force: true });
    }
    assert.equal((await reader.getGitRef()).sha, publishedSha);
    assert.equal(reader.transportMetricsSnapshot.mutations, before.mutations);
    } finally {
      if (backupCleanupArmed) {
        await resetGitHubE2EDisposableBranch(backupTarget);
        assert.equal(await backupClient.getGitRefOrNull(), null);
        assert.equal(await backupClient.getGitRefOrNull(), null);
        console.log(JSON.stringify({
          stage: "D397_SECONDARY_BRANCH_CLEANUP_VERIFIED_TWICE",
          branch: backupBranch,
        }));
      }
    }
  });
}

/**
 * D382: Real backed-up ciphertext -> old-key plaintext -> physical scratch
 * write -> fresh physical scratch readback. Scratch is wholly disposable,
 * outside every actual Obsidian Vault. This is intentionally not an installed
 * Vault recovery/independent disk proof.
 */
async function d382VerifyLiveBackupScratch(input: {
  rootAbsolute: string;
  inventory: Awaited<ReturnType<typeof verifyGitHubReencryptionForkSourceWithTranscodeInventory>>;
  backupClient: GitHubClient;
  pinnedSourceCommitSha: string;
  oldKeyring: V4Keyring;
}) {
  const scratchDir = path.join(input.rootAbsolute, "scratch-d382");
  await mkdir(scratchDir);
  const scratchStat = await lstat(scratchDir);
  assert.ok(scratchStat.isDirectory() && !scratchStat.isSymbolicLink());
  const scratchPath = (opaque: string) => {
    const match = /^d382-scratch\/([A-Za-z0-9_-]{1,128}\.bin)$/u.exec(opaque);
    assert.ok(match, "D382 scratch cannot escape its isolated test namespace");
    return path.join(scratchDir, match[1]!);
  };
  const backend: V4StagingBackend = {
    boundedAppend: true,
    async write(opaque, value) { await writeFile(scratchPath(opaque), value); },
    async append(opaque, value) { await appendFile(scratchPath(opaque), value); },
    async remove(opaque) { await unlink(scratchPath(opaque)); },
    async openSource(opaque, expectedSize) {
      const content = new Uint8Array(await readFile(scratchPath(opaque)));
      assert.equal(content.byteLength, expectedSize);
      return createV4WholeBufferContentSource(content);
    },
    async freeBytes() { return undefined; },
  };
  const scratch = createV4StagingStore({
    root: "d382-scratch", backend, wholeBufferCeilingBytes: 2 * 1024 * 1024,
  });
  const sourceRecords = Object.values(input.inventory.sourceShards)
    .flatMap(shard => Object.values(shard.records).filter(record => !record.deleted));
  const sourceByPath = new Map(sourceRecords.map(record => [record.path, record] as const));
  assert.equal(sourceByPath.size, sourceRecords.length);
  const oldCodec = new V4StorageCodec({
    mode: "encrypted", pathLayout: expectedV4PathLayout("encrypted"),
    keyring: input.oldKeyring,
  });
  const snapshotId = await sha256Hex(bytes(
    "d382-isolated-real-github-backup:" + input.pinnedSourceCommitSha,
  ));
  const backup = {
    snapshotId, sourceCommitSha: input.pinnedSourceCommitSha,
    async readCurrentSnapshotId() {
      const ref = await input.backupClient.getGitRefOrNull();
      return ref?.sha === input.pinnedSourceCommitSha ? snapshotId : null;
    },
    async listFiles() {
      return sourceRecords.map(record => ({
        path: record.path, size: record.size,
        plaintextSha256: record.plaintextSha256, mtime: record.mtime,
      }));
    },
    async openFile(logicalPath: string, size: number) {
      assert.equal((await input.backupClient.getGitRef()).sha,
        input.pinnedSourceCommitSha);
      const record = sourceByPath.get(logicalPath);
      assert.ok(record && record.size === size);
      const content = await oldCodec.read(record, async opaque => {
        const result = await readImmutableGitFile(opaque, input.pinnedSourceCommitSha, {
          getCommit: sha => input.backupClient.getGitCommit(sha),
          getTree: sha => input.backupClient.getTreeAt(sha, false),
          getBlob: sha => input.backupClient.getBlob(sha),
        });
        assert.ok(result, "D382 original encrypted Backup object is absent");
        return result.bytes;
      });
      return createV4WholeBufferContentSource(content);
    },
  };
  try {
    const report = await verifyV4ReencryptionBackupRestoreRehearsal({
      config: input.inventory.sourceConfig,
      head: input.inventory.sourceHead,
      shards: input.inventory.sourceShards,
      keyring: input.oldKeyring,
      pinnedSourceCommitSha: input.pinnedSourceCommitSha,
      backup, sourceRefPolicy: "pinned-immutable-commit",
      async readCurrentSourceHeadSha() { return input.pinnedSourceCommitSha; },
      scratch,
      async assertScratchIsIsolated() {
        const current = await lstat(scratchDir);
        assert.ok(current.isDirectory() && !current.isSymbolicLink());
        assert.equal(path.relative(input.rootAbsolute, scratchDir), "scratch-d382");
      },
    });
    assert.equal(report.scratchReadbackMatched, true);
    assert.equal(report.roundTripFileCount, sourceRecords.length);
    assert.equal(report.roundTripPlaintextBytes,
      input.inventory.verifiedSource.totalVerifiedPlaintextBytes);
    return report;
  } finally {
    try {
      assert.deepEqual(await readdir(scratchDir), [],
        "D382 scratch restore must remove every temporary file");
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  }
}

/**
 * D383: A synthetic initiating Vault stored as independently opened physical
 * files under this run's disposable test root. This is not an installed
 * Obsidian editor/queue fence or a power-loss durability claim.
 */
async function d383CreatePhysicalInitiator(input: {
  rootAbsolute: string;
  originalSnapshot: ReadonlyMap<string, Uint8Array>;
  assertWalLease: () => Promise<void>;
  assertSourceConfigUnchanged: () => Promise<void>;
}) {
  const root = path.join(input.rootAbsolute, "d383-initiating-vault");
  await mkdir(root);
  const rootStat = await lstat(root);
  assert.ok(rootStat.isDirectory() && !rootStat.isSymbolicLink());
  const filenames = new Map<string, string>();
  for (const [logical, value] of input.originalSnapshot) {
    assert.ok(logical && !logical.startsWith("/") && !logical.includes("\\")
      && logical.split("/").every(segment => Boolean(segment) && segment !== "." && segment !== ".."));
    const physical = (await sha256Hex(bytes(logical))) + ".bin";
    assert.equal([...filenames.values()].includes(physical), false);
    filenames.set(logical, physical);
    await writeFile(path.join(root, physical), value, { flag: "wx" });
  }
  const physicalFile = async (logical: string) => {
    const name = filenames.get(logical);
    assert.ok(name, "D383 read attempted a file outside the authenticated original snapshot");
    const filename = path.join(root, name);
    const stat = await lstat(filename);
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), "D383 refuses a linked or non-file Vault entry");
    return { filename, stat };
  };
  const assertManifest = async () => {
    const actual = (await readdir(root)).sort();
    assert.deepEqual(actual, [...filenames.values()].sort(),
      "D383 physical initiating Vault has unexpected, missing or renamed files");
    const stat = await lstat(root);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
  };
  const reader: V4InitiatorLocalReader = {
    async listFiles() {
      await assertManifest();
      return Promise.all([...filenames.keys()].map(async logical => {
        const { stat } = await physicalFile(logical);
        return { path: logical, size: stat.size, mtime: stat.mtimeMs };
      }));
    },
    async openFile(logical) {
      const { filename, stat } = await physicalFile(logical);
      const data = new Uint8Array(await readFile(filename));
      assert.equal(data.byteLength, stat.size, "D383 file changed while opening physical bytes");
      return createV4WholeBufferContentSource(data);
    },
    async listOpenEditorPaths() {
      // Synthetic E2E Vault has no Obsidian editor/UI process.
      return [];
    },
    async assertIdleAndNoPendingEdits() {
      await assertManifest();
    },
    async assertSourceConfigurationUnchanged() {
      await input.assertSourceConfigUnchanged();
    },
    async assertExclusiveInitiatorLease() {
      await input.assertWalLease();
    },
  };
  return {
    reader,
    async tamperAndRestoreFirstFile(runNegativeProof: () => Promise<void>) {
      const first = [...input.originalSnapshot][0];
      assert.ok(first && first[1].byteLength > 0);
      const { filename } = await physicalFile(first[0]);
      const tampered = Uint8Array.from(first[1]);
      tampered[0] = tampered[0]! ^ 0xff;
      await writeFile(filename, tampered);
      try { await runNegativeProof(); }
      finally { await writeFile(filename, first[1]); }
    },
    async remove() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

/**
 * D385 test-only crash-recovery envelope. The parent runner creates this
 * disposable directory and passes synthetic secrets ONLY via child env,
 * never through plaintext files, process output, or GitHub branches.
 */
interface D385RecoveryEvidence {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly journalRoot: "reencryption/wal";
  readonly sourceCommitSha: string;
  readonly sourceTreeSha: string;
  readonly backupPlan: ReturnType<typeof proposeV4SameRepositoryReencryptionBackupBranch>;
  readonly orphanPlan: ReturnType<typeof planV4OrphanReencryptionDestination>;
  readonly prepared: V4PreparedOrphanCommit;
  readonly sourceConfig: V4RemoteConfig;
  readonly destinationConfig: V4RemoteConfig;
  readonly expectedRecords: readonly V4IndexFileRecord[];
  readonly expectedReceipts: readonly V4ReencryptionObjectReceipt[];
  readonly pendingGeneration: number;
}
async function d385Root(): Promise<string> {
  const supplied = process.env["GITHUB_E2E_D385_ROOT"];
  assert.ok(supplied, "D385 requires a wrapper-owned isolated test root");
  const root = path.resolve(supplied);
  const relative = path.relative(path.resolve(process.cwd(), ".tmp"), root);
  assert.match(relative, /^d385-owned-[A-Za-z0-9]{6}$/u,
    "D385 refuses any root outside the isolated test namespace");
  assert.equal(path.isAbsolute(supplied), true);
  const stat = await lstat(root);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink(),
    "D385 refuses a linked or non-directory test root");
  return root;
}
function d385JournalKey(): Uint8Array {
  const encoded = process.env["GITHUB_E2E_D385_JOURNAL_KEY_B64"];
  assert.match(encoded ?? "", /^[A-Za-z0-9_-]{43}$/u);
  const key = fromBase64Url(encoded!);
  assert.equal(key.byteLength, 32);
  return key;
}
function d385NewPassphrase(): string {
  const passphrase = process.env["GITHUB_E2E_D385_NEW_PASSPHRASE"];
  assert.match(passphrase ?? "", /^d385-disposable-[A-Za-z0-9_-]{24}$/u);
  return passphrase!;
}
async function d385WriteRecoveryEvidence(
  root: string, context: D385RecoveryEvidence,
): Promise<void> {
  assert.equal((await readdir(root)).includes("recovery-evidence.json"), false);
  const content = JSON.stringify(context);
  assert.ok(content.length > 100 && content.length < 512 * 1024,
    "D385 metadata must remain a small synthetic-only envelope");
  await writeFile(path.join(root, "recovery-evidence.json"), content, {
    flag: "wx", mode: 0o600,
  });
  const stat = await lstat(path.join(root, "recovery-evidence.json"));
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1);
}

/**
 * D385 recovery runs in a FRESH Node OS process after the first process
 * terminated without releasing its lock or observing the Destination ref.
 * The parent simulates an explicit, verified TEST-ONLY stale-lock quarantine
 * before this function runs. No production automatic lock reclamation.
 */
async function d385RecoverPublishedDestinationInNewProcess(
  config: GitHubConfig, testNegativeObservations = false,
): Promise<void> {
  const root = await d385Root();
  const contextPath = path.join(root, "recovery-evidence.json");
  const contextFile = await lstat(contextPath);
  assert.ok(contextFile.isFile() && !contextFile.isSymbolicLink()
    && contextFile.nlink === 1 && contextFile.size > 100
    && contextFile.size < 512 * 1024,
  "D385 recovery requires the exact prior-run synthetic metadata file");
  const evidence = JSON.parse(await readFile(contextPath, "utf8")) as D385RecoveryEvidence;
  assert.equal(evidence.schemaVersion, 1);
  assert.match(evidence.runId ?? "", /^d378-live-backup-[A-Za-z0-9_-]{14}$/u);
  assert.equal(evidence.journalRoot, "reencryption/wal");
  assert.equal(evidence.backupPlan.sourceRepoId, repoId(config));
  assert.equal(evidence.orphanPlan.sourceRepoId, repoId(config));
  assert.equal(evidence.backupPlan.backupBranch,
    deriveGitHubE2EFrozenBackupBranch(config.branch));
  assert.equal(evidence.orphanPlan.destinationBranch,
    deriveGitHubE2EDestinationBranch(config.branch));
  assert.equal(evidence.orphanPlan.destinationRepoId,
    repoId({ ...config, branch: evidence.orphanPlan.destinationBranch }));
  assert.equal(evidence.backupPlan.destinationRepoId,
    evidence.orphanPlan.destinationRepoId);
  assert.equal(evidence.sourceCommitSha, evidence.backupPlan.pinnedSourceCommitSha);
  assert.equal(evidence.sourceCommitSha, evidence.orphanPlan.pinnedSourceCommitSha);
  assert.equal(evidence.sourceCommitSha, evidence.prepared.pinnedSourceCommitSha);
  assert.equal(evidence.sourceTreeSha, evidence.prepared.sourceTreeSha);
  assert.equal(evidence.destinationConfig.repoId, evidence.orphanPlan.destinationRepoId);
  assert.equal(evidence.sourceConfig.repoId, repoId(config));
  assert.equal(evidence.pendingGeneration, 21,
    "D385 crash boundary must follow exactly one persisted Destination ref intent");

  const postedPath = path.join(root, "post-confirmed.json");
  const postedStat = await lstat(postedPath);
  assert.ok(postedStat.isFile() && !postedStat.isSymbolicLink()
    && postedStat.nlink === 1 && postedStat.size < 512);
  const posted = JSON.parse(await readFile(postedPath, "utf8")) as {
    schemaVersion: number; destinationCommitSha: string;
    sourceCommitSha: string; createAttempts: number;
  };
  assert.equal(posted.schemaVersion, 1);
  assert.equal(posted.destinationCommitSha, evidence.prepared.commitSha);
  assert.equal(posted.sourceCommitSha, evidence.sourceCommitSha);
  assert.equal(posted.createAttempts, 1);

  const originalSource = new GitHubClient(config);
  // Recovery proof must be reconstructed by a fresh GitHub authenticated
  // whole-Source scan, NOT loaded from the prior process's evidence file.
  const reverified = await verifyGitHubReencryptionSource({
    github: originalSource, expectedRepoId: repoId(config),
    expectedBranch: config.branch, passphrase: "v4-real-github-e2e",
  });
  assert.equal(reverified.pinnedSourceCommitSha, evidence.sourceCommitSha);
  assert.equal(reverified.verifiedFileCount, evidence.expectedRecords.length);
  const destination = new GitHubClient({
    ...config, branch: evidence.orphanPlan.destinationBranch,
  });
  const frozenBackup = new GitHubClient({
    ...config, branch: evidence.backupPlan.backupBranch,
  });
  assert.equal((await frozenBackup.getGitRef()).sha, evidence.sourceCommitSha);
  const journalKey = d385JournalKey();
  let wal: Awaited<ReturnType<typeof acquireV4DesktopRekeyWalStorage>> | undefined;
  try {
    wal = await acquireV4DesktopRekeyWalStorage({
      rootAbsolute: path.join(root, "wal-root"),
      journalRoot: evidence.journalRoot,
      recoveryExistingOnly: true,
    });
    const journal = createV4ReencryptionRecoveryJournal({
      adapter: wal.adapter, root: evidence.journalRoot, runId: evidence.runId,
      sourceCommitSha: evidence.sourceCommitSha,
      destinationRepoId: evidence.orphanPlan.destinationRepoId,
      journalKey,
    });
    const pending = await journal.assertHealthySnapshot(evidence.pendingGeneration);
    assert.equal(pending.cutoverAuthorized, false);
    assert.equal(pending.stageHandoffStarted, true);
    assert.equal(pending.pendingRefIntents.length, 1);
    assert.equal(pending.pendingRefIntents[0]?.role, "destination");
    assert.equal(pending.pendingRefIntents[0]?.commitSha, evidence.prepared.commitSha);
    assert.deepEqual(pending.verifiedRefObservations.map(x => x.role), ["backup"]);
    assert.equal(pending.pendingIntents.length, 0);
    assert.equal(pending.receipts.length, evidence.expectedReceipts.length);
    assert.equal(pending.preparedCandidateReceipt?.commitSha, evidence.prepared.commitSha);
    const expectedReceipts = new Map(evidence.expectedReceipts.map(r => [r.path, r] as const));
    assert.equal(expectedReceipts.size, evidence.expectedReceipts.length);
    for (const receipt of pending.receipts) {
      assert.deepEqual(receipt, expectedReceipts.get(receipt.path));
    }
    const beforeDestinationMutations = destination.transportMetricsSnapshot.mutations;
    const beforeBackupMutations = frozenBackup.transportMetricsSnapshot.mutations;
    const recoveryArgs = {
      plan: evidence.orphanPlan,
      prepared: evidence.prepared,
      backupPlan: evidence.backupPlan,
      backupRefReader: frozenBackup,
      verifiedOriginalSource: reverified,
      journal, wal,
      acknowledgement: "accept-best-effort-power-loss-recovery-risk" as const,
      github: destination,
      sourceTreeSha: evidence.sourceTreeSha,
      sourceConfig: evidence.sourceConfig,
      expectedDestinationConfig: evidence.destinationConfig,
      expectedRecords: evidence.expectedRecords,
      expectedReceipts: evidence.expectedReceipts,
      destinationPassphrase: d385NewPassphrase(),
    };
    if (testNegativeObservations) {
      // D386 must NEVER delete/overwrite an actually published test ref:
      // the newly restarted process injects *read-only observations* that
      // look absent or occupied, while independent real GitHub reads prove
      // the exact remote ref is intact before/after each rejection.
      const actualRead = destination.getGitRefOrNull.bind(destination);
      const actualRef = await actualRead();
      assert.ok(actualRef && actualRef.sha === evidence.prepared.commitSha
        && actualRef.ref === `refs/heads/${evidence.orphanPlan.destinationBranch}`
        && actualRef.type === "commit");
      const slotPaths = [0, 1].map(i => path.join(root, "wal-root",
        "reencryption", "wal", `slot-${i}.json`));
      const slotHashes = async () => Promise.all(slotPaths.map(async filename =>
        sha256Hex(new Uint8Array(await readFile(filename)))));
      const initialSlotHashes = await slotHashes();
      for (const kind of ["absent", "conflicted"] as const) {
        let injectedReadCount = 0;
        destination.getGitRefOrNull = async () => {
          injectedReadCount++;
          return kind === "absent" ? null : {
            ...actualRef, sha: "f".repeat(40),
          };
        };
        try {
          await assert.rejects(
            () => reconcileV4PendingOrphanWithJournalBestEffort(recoveryArgs),
            /missing, conflicting or incomplete/u,
            `D386 ${kind} Destination observation must require Manual Recovery`,
          );
        } finally {
          destination.getGitRefOrNull = actualRead;
        }
        assert.ok(injectedReadCount >= 2,
          `D386 ${kind} recovery must observe the ref repeatedly`);
        const afterFailedRecovery = await journal.assertHealthySnapshot(evidence.pendingGeneration);
        assert.deepEqual(afterFailedRecovery, pending,
          `D386 ${kind} must preserve ALL encrypted pending WAL evidence`);
        assert.deepEqual(await slotHashes(), initialSlotHashes,
          `D386 ${kind} must not rewrite either physical WAL slot`);
        assert.equal(destination.transportMetricsSnapshot.mutations, beforeDestinationMutations,
          `D386 ${kind} must not retry/create/overwrite Destination`);
        assert.equal(frozenBackup.transportMetricsSnapshot.mutations, beforeBackupMutations,
          `D386 ${kind} must not mutate frozen Backup`);
        assert.equal((await actualRead())?.sha, evidence.prepared.commitSha,
          `D386 ${kind} observation injection must not change the REAL remote ref`);
        console.log(JSON.stringify({
          stage: "D386_NEGATIVE_DESTINATION_OBSERVATION_FAIL_CLOSED",
          observation: kind, injectedReadCount,
          pendingWalGeneration: afterFailedRecovery.generation,
          pendingDestinationIntentPreserved: true,
          walSlotsUnchanged: true,
          recoveryGitMutations: 0, cutoverAuthorized: false,
        }));
      }
    }
    // The same WAL and real remote ref can still be authenticated after a
    // transient negative observation. No second create-only POST is sent.
    const report = await reconcileV4PendingOrphanWithJournalBestEffort(recoveryArgs);
    assert.equal(report.destinationContentsVerified, true);
    assert.equal(report.destinationCommitSha, evidence.prepared.commitSha);
    assert.equal(report.verifiedFileCount, reverified.verifiedFileCount);
    assert.equal(report.verifiedPlaintextBytes, reverified.totalVerifiedPlaintextBytes);
    assert.equal(report.automaticallyRetryCreateAuthorized, false);
    assert.equal(report.initiatingDeviceCutoverAuthorized, false);
    assert.equal(destination.transportMetricsSnapshot.mutations, beforeDestinationMutations,
      "D385 restarted recovery must never create/retry/update any GitHub ref");
    assert.equal(frozenBackup.transportMetricsSnapshot.mutations, beforeBackupMutations,
      "D385 restarted recovery must never mutate frozen Backup");
    const completed = await journal.assertHealthySnapshot(evidence.pendingGeneration + 1);
    assert.equal(completed.pendingRefIntents.length, 0);
    assert.equal(completed.pendingIntents.length, 0);
    assert.deepEqual(completed.verifiedRefObservations.map(x => x.role),
      ["backup", "destination"]);
    assert.equal(completed.verifiedRefObservations[1]?.commitSha,
      evidence.prepared.commitSha);
    assert.equal(completed.cutoverAuthorized, false);
    assert.equal(completed.permissionToPublish, false);
    assert.deepEqual(completed.receipts, pending.receipts);
    console.log(JSON.stringify({
      stage: "D385_RESTARTED_WAL_DESTINATION_RECONCILIATION",
      recoveryInNewProcess: true, childCreateAttempts: posted.createAttempts,
      recoveryGitMutations: destination.transportMetricsSnapshot.mutations
        - beforeDestinationMutations,
      commitSha: report.destinationCommitSha,
      verifiedFiles: report.verifiedFileCount,
      plaintextBytes: report.verifiedPlaintextBytes,
      beforeWalGeneration: pending.generation,
      recoveredWalGeneration: completed.generation,
      noRetry: true, cutoverAuthorized: false, crashDurabilityClaimed: false,
    }));
  } finally {
    await wal?.release();
    journalKey.fill(0);
  }
}

/**
 * D378: Join the real GitHub Backup ref POST to a physical, best-effort
 * two-slot WAL on a newly created TEST-ONLY Windows directory.
 * This is intentionally NOT an installed initiating-device Cutover or a
 * physical power-loss guarantee. A fresh reader must authenticate every
 * WAL transition after the writer closes.
 */
async function createJournaledFrozenBackupLive(input: {
  config: GitHubConfig;
  plan: ReturnType<typeof proposeV4SameRepositoryReencryptionBackupBranch>;
  sourceProof: Awaited<ReturnType<typeof verifyGitHubReencryptionSource>>;
  sourceClient: GitHubClient;
  backupClient: GitHubClient;
  pinnedTreeSha: string;
  injectUnknownCreateOutcome?: boolean;
  stageAfterVerifiedBackup?: {
    readonly inventory: Awaited<ReturnType<typeof verifyGitHubReencryptionForkSourceWithTranscodeInventory>>;
    readonly destination: GitHubClient;
    readonly physicalRepositoryId: number;
    readonly defaultBranch: string;
    readonly originalSnapshot: ReadonlyMap<string, Uint8Array>;
    readonly prepareCandidate?: boolean;
    readonly verifyScratchRestore?: boolean;
    readonly publishDestination?: boolean;
    readonly simulateLostDestinationCreateResponse?: boolean;
    readonly simulateCrashAfterDestinationCreate?: boolean;
  };
}): Promise<void> {
  if (input.injectUnknownCreateOutcome && input.stageAfterVerifiedBackup) {
    throw new Error("D379 refuses staging while the frozen Backup ref outcome is unresolved.");
  }
  const walParent = path.resolve(process.cwd(), ".tmp");
  await mkdir(walParent, { recursive: true });
  const parentStat = await lstat(walParent);
  assert.ok(parentStat.isDirectory() && !parentStat.isSymbolicLink(),
    "D378 refuses a linked WAL test directory");
  const crashRoot = input.stageAfterVerifiedBackup?.simulateCrashAfterDestinationCreate
    ? await d385Root() : undefined;
  const rootAbsolute = crashRoot
    ? path.join(crashRoot, "wal-root")
    : await mkdtemp(path.join(walParent, "d378-live-wal-"));
  if (crashRoot) await mkdir(rootAbsolute, { mode: 0o700 });
  const journalRoot = "reencryption/wal";
  const runId = "d378-live-backup-" + toBase64Url(randomBytes(10));
  const journalKey = crashRoot ? d385JournalKey() : randomBytes(32);
  let owned: Awaited<ReturnType<typeof acquireV4DesktopRekeyWalStorage>> | undefined;
  try {
    owned = await acquireV4DesktopRekeyWalStorage({
      rootAbsolute, journalRoot, requireNewJournalRoot: true,
    });
    const journal = createV4ReencryptionRecoveryJournal({
      adapter: owned.adapter, root: journalRoot, runId,
      destinationRepoId: input.plan.destinationRepoId,
      sourceCommitSha: input.plan.pinnedSourceCommitSha, journalKey,
    });
    const first = await journal.begin();
    assert.equal(first.generation, 1);
    const frozenInput = {
      plan: input.plan, journal, wal: owned,
      verifiedSource: input.sourceProof, source: input.sourceClient,
      expectedSourceTreeSha: input.pinnedTreeSha,
      originalPassphrase: "v4-real-github-e2e",
      acknowledgement: "accept-best-effort-power-loss-recovery-risk" as const,
    };
    let createdAndVerifiedBackup: Awaited<ReturnType<typeof createV4BestEffortJournaledFrozenBackup>> | undefined;
    if (input.injectUnknownCreateOutcome) {
      const interrupted = new AbortController();
      let createAttempts = 0;
      // Send exactly ONE real create-only GitHub ref POST, then lose the
      // synthetic child response. The controller abort stops same-run
      // reconciliation so that the WAL remains pending across storage reopen.
      const simulatedLostResponse = new Proxy(input.backupClient, {
        get(target, key) {
          if (key === "createGitRef") return async (sha: string) => {
            createAttempts++;
            await target.createGitRef(sha);
            interrupted.abort();
            throw new Error("D378 controlled lost GitHub create response");
          };
          const value: unknown = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      await assert.rejects(() => createV4BestEffortJournaledFrozenBackup({
        ...frozenInput, backup: simulatedLostResponse,
        signal: interrupted.signal,
      }));
      assert.equal(createAttempts, 1, "lost-response injection must never retry a POST");
      assert.equal((await input.backupClient.getGitRef()).sha,
        input.plan.pinnedSourceCommitSha);
    } else {
      const report = await createV4BestEffortJournaledFrozenBackup({
        ...frozenInput, backup: input.backupClient,
      });
      createdAndVerifiedBackup = report;
      assert.equal(report.backupContentsReadbackVerified, true);
      assert.equal(report.publicationOutcome, "response-confirmed");
      assert.equal(report.verifiedFileCount, input.sourceProof.verifiedFileCount);
      assert.equal(report.verifiedPlaintextBytes, input.sourceProof.totalVerifiedPlaintextBytes);
      assert.equal(report.initiatingDeviceCutoverAuthorized, false);
    }
    // D379: In one held physical WAL lease, join the verified real-GitHub
    // Backup to production immutable new-key staging. No Git ref, candidate,
    // installed Settings or local Index is published or switched.
    let stagedProof: {
      readonly generation: number;
      readonly receiptCount: number;
      readonly fileCount: number;
      readonly plaintextBytes: string;
      readonly independentNewKeyDecryptVerified: true;
      readonly oldKeyRejected: true;
      readonly candidateCommitSha?: string;
      readonly candidateTreeSha?: string;
      readonly candidateMetadataObjects?: number;
      readonly scratchRestoreVerified?: boolean;
      readonly scratchRestoredFiles?: number;
      readonly destinationPublished?: boolean;
      readonly destinationVerifiedFiles?: number;
      readonly lostDestinationResponseReconciled?: boolean;
    } | undefined;
    if (input.stageAfterVerifiedBackup) {
      const stageInput = input.stageAfterVerifiedBackup;
      const inventory = stageInput.inventory;
      const verifiedBackup = await verifyGitHubFrozenReencryptionBackup({
        github: new GitHubClient({ ...input.config, branch: input.plan.backupBranch }),
        plan: input.plan, expectedSourceTreeSha: input.pinnedTreeSha,
        passphrase: "v4-real-github-e2e",
      });
      assert.equal(verifiedBackup.backupContentsReadbackVerified, true);
      assert.equal(verifiedBackup.verifiedFileCount, input.sourceProof.verifiedFileCount);
      const oldSalt = fromBase64Url(inventory.sourceConfig.kdfParams!.salt);
      const newSalt = randomBytes(16);
      let oldKey: V4Keyring | undefined;
      let newKey: V4Keyring | undefined;
      try {
        oldKey = await deriveV4Keyring({
          passphrase: "v4-real-github-e2e", repoId: input.plan.sourceRepoId,
          salt: oldSalt, iterations: inventory.sourceConfig.kdfParams!.iterations,
        });
        const destinationConfig: V4RemoteConfig = {
          ...inventory.sourceConfig, repoId: input.plan.destinationRepoId,
          kdfParams: { iterations: 600_000, salt: toBase64Url(newSalt) },
        };
        const newPassphrase = crashRoot
          ? d385NewPassphrase()
          : "d379-disposable-" + toBase64Url(randomBytes(18));
        newKey = await deriveV4Keyring({
          passphrase: newPassphrase,
          repoId: input.plan.destinationRepoId, salt: newSalt,
          iterations: destinationConfig.kdfParams!.iterations,
        });
        const orphanPlan = planV4OrphanReencryptionDestination({
          sourceRepoId: input.plan.sourceRepoId,
          destinationRepoId: input.plan.destinationRepoId,
          sourceCommitSha: input.plan.pinnedSourceCommitSha,
          sourcePhysicalRepositoryId: stageInput.physicalRepositoryId,
          destinationPhysicalRepositoryId: stageInput.physicalRepositoryId,
          expectedPhysicalRepositoryId: stageInput.physicalRepositoryId,
          defaultBranch: stageInput.defaultBranch,
        });
        const checkFrozenBackup = async () => {
          assert.equal((await input.backupClient.getGitRef()).sha,
            input.plan.pinnedSourceCommitSha, "Backup changed during WAL-bound staging");
        };
        const beforeStage = await journal.assertHealthySnapshot(3);
        const staged = await stageV4BestEffortJournaledThreeBranchVault({
          plan: orphanPlan, journal, wal: owned!,
          acknowledgement: "accept-best-effort-power-loss-recovery-risk",
          beginAfterVerifiedBackup: {
            backupRef: {
              role: "backup", repoId: input.plan.backupRepoId,
              commitSha: input.plan.pinnedSourceCommitSha, treeSha: input.pinnedTreeSha,
            },
            expectedJournalGeneration: beforeStage.generation,
          },
          sourceConfig: inventory.sourceConfig,
          sourceHead: inventory.sourceHead,
          sourceShards: inventory.sourceShards,
          sourceKeyring: oldKey,
          destinationConfig, destinationKeyring: newKey,
          verifySourceStillPinned: checkFrozenBackup,
          async readSourceObject(objectPath, sha) {
            assert.equal(sha, input.plan.pinnedSourceCommitSha);
            const found = await readImmutableGitFile(objectPath, sha, {
              getCommit: commit => input.sourceClient.getGitCommit(commit),
              getTree: tree => input.sourceClient.getTreeAt(tree, false),
              getBlob: blob => input.sourceClient.getBlob(blob),
            });
            return found?.bytes ?? null;
          },
          async stageImmutableObject(_objectPath, ciphertext) {
            // The destination ref remains ABSENT: only immutable blobs are uploaded.
            return stageInput.destination.createGitBlob(ciphertext);
          },
        });
        assert.equal(staged.preview.finalizedFileCount, input.sourceProof.verifiedFileCount);
        assert.equal(staged.preview.totalPlaintextBytes,
          input.sourceProof.totalVerifiedPlaintextBytes);
        assert.ok(staged.receipts.length > 0);
        assert.equal(staged.journalSnapshot.stageHandoffStarted, true);
        assert.equal(staged.journalSnapshot.pendingIntents.length, 0);
        assert.equal(staged.journalSnapshot.pendingRefIntents.length, 0);
        assert.equal(staged.journalSnapshot.cutoverAuthorized, false);
        assert.equal(staged.preview.permissionToPublish, false);
        assert.equal(staged.preview.cutoverAuthorized, false);
        assert.equal(await stageInput.destination.getGitRefOrNull(), null);
        assert.equal(await stageInput.destination.getGitRefOrNull(), null);
        const independentlyReadingBlobs = new GitHubClient({
          ...input.config, branch: orphanPlan.destinationBranch,
        });
        const mutationsBefore = independentlyReadingBlobs.transportMetricsSnapshot.mutations;
        const blobProof = await verifyStagedV4ReencryptionGitBlobs({
          plan: orphanPlan, journal, github: independentlyReadingBlobs,
        });
        assert.equal(blobProof.status, "verified");
        assert.equal(blobProof.confirmedReceiptCount, staged.receipts.length);
        assert.equal(blobProof.verifiedObjectCount, staged.receipts.length);
        assert.equal(blobProof.pendingIntentCount, 0);
        assert.equal(blobProof.permissionToPublish, false);
        assert.equal(blobProof.cutoverAuthorized, false);
        assert.equal(independentlyReadingBlobs.transportMetricsSnapshot.mutations,
          mutationsBefore, "staged blob verification must be read-only");
        // D380: Cryptographic readback is stronger than Git SHA receipts.
        // Re-derive a separate new-key ring and decrypt real Git Blob GETs.
        const independentlyDerivedKey = await deriveV4Keyring({
          passphrase: newPassphrase, repoId: input.plan.destinationRepoId,
          salt: newSalt, iterations: destinationConfig.kdfParams!.iterations,
        });
        try {
          const codec = new V4StorageCodec({
            mode: "encrypted", pathLayout: expectedV4PathLayout("encrypted"),
            keyring: independentlyDerivedKey,
          });
          const receiptByPath = new Map(staged.receipts.map(receipt =>
            [receipt.path, receipt] as const));
          assert.equal(receiptByPath.size, staged.receipts.length);
          assert.equal(stageInput.originalSnapshot.size, staged.records.length);
          const stagedLogicalPaths = new Set(staged.records.map(record => record.path));
          assert.equal(stagedLogicalPaths.size, staged.records.length,
            "D380 duplicate staged paths would hide a missing original file");
          assert.deepEqual(stagedLogicalPaths, new Set(stageInput.originalSnapshot.keys()),
            "D380 staged logical paths must match the complete frozen snapshot");
          const readStagedBlob = async (opaquePath: string) => {
            const receipt = receiptByPath.get(opaquePath);
            assert.ok(receipt, "D380 new-key readback has no persisted WAL receipt");
            const data = await independentlyReadingBlobs.getBlob(receipt.sha);
            assert.equal(computeV4GitBlobSha1(data), receipt.sha,
              "D380 remote blob bytes disagree with WAL Git SHA");
            assert.equal(data.byteLength, receipt.byteLength);
            return data;
          };
          for (const record of staged.records) {
            const original = stageInput.originalSnapshot.get(record.path);
            assert.ok(original, "D380 staged path is absent from pinned Source snapshot");
            const restored = await codec.read(record, readStagedBlob);
            assert.deepEqual(restored, original,
              `D380 independently decrypted new-key bytes differ: ${record.path}`);
          }
          // The original source key must not authenticate the new-key blobs.
          const oldCodec = new V4StorageCodec({
            mode: "encrypted", pathLayout: expectedV4PathLayout("encrypted"),
            keyring: oldKey,
          });
          // A transport failure must never count as proof of wrong-key
          // rejection: first fetch a SHA-verified Blob, then require AES-GCM
          // to reject the ciphertext with an authentication OperationError.
          let oldKeyBlobReads = 0;
          await assert.rejects(() => oldCodec.read(staged.records[0]!, async opaquePath => {
            const ciphertext = await readStagedBlob(opaquePath);
            oldKeyBlobReads++;
            return ciphertext;
          }), (error: unknown) =>
            error instanceof Error && error.name === "OperationError",
          "old-key rejection must be an AES-GCM authentication failure");
          assert.ok(oldKeyBlobReads > 0,
            "old-key rejection must read a SHA-verified remote Git Blob");
          assert.equal(independentlyReadingBlobs.transportMetricsSnapshot.mutations,
            mutationsBefore, "D380 independent new-key decrypt must never mutate GitHub");
        } finally {
          for (const part of [
            independentlyDerivedKey.masterKey, independentlyDerivedKey.pathKey,
            independentlyDerivedKey.contentKey, independentlyDerivedKey.indexKey,
            independentlyDerivedKey.journalKey,
          ]) part.fill(0);
        }
        // D381: Prepare a zero-parent orphan candidate from this SAME physical
        // WAL and previously verified real Git Blob receipts. Do not publish
        // a Destination ref or grant installed Settings/Index authority.
        let preparedCandidate: Awaited<ReturnType<typeof prepareV4BestEffortJournaledOrphanCandidate>> | undefined;
        let candidateEvidence: {
          readonly generation: number;
          readonly commitSha: string;
          readonly treeSha: string;
          readonly metadataObjects: number;
        } | undefined;
        if (stageInput.prepareCandidate) {
          const beforeCandidate = await journal.assertHealthySnapshot(staged.journalSnapshot.generation);
          assert.equal(beforeCandidate.candidatePreparationSha256, null);
          assert.equal(beforeCandidate.preparedCandidateReceipt, null);
          const candidate = await prepareV4BestEffortJournaledOrphanCandidate({
            plan: orphanPlan, journal, wal: owned!,
            acknowledgement: "accept-best-effort-power-loss-recovery-risk",
            github: stageInput.destination,
            verifiedBackup,
            sourceConfig: inventory.sourceConfig, destinationConfig,
            destinationKeyring: newKey, sourceTreeSha: input.pinnedTreeSha,
            staged,
            deviceId: "d381-disposable-device",
            journalId: "d381-disposable-journal",
            createdAt: Date.now(),
          });
          preparedCandidate = candidate;
          assert.equal(candidate.rootHasZeroParents, true);
          assert.equal(candidate.refPublished, false);
          assert.equal(candidate.cutoverAuthorized, false);
          assert.equal(candidate.verifiedFileCount, staged.records.length);
          assert.equal(candidate.stagedCiphertextObjectCount, staged.receipts.length);
          assert.ok(candidate.encryptedMetadataObjectCount > 0);
          const candidateReader = new GitHubClient({
            ...input.config, branch: orphanPlan.destinationBranch,
          });
          const candidateReaderMutations = candidateReader.transportMetricsSnapshot.mutations;
          const remoteCandidate = await candidateReader.getGitCommit(candidate.commitSha);
          assert.equal(remoteCandidate.sha, candidate.commitSha);
          assert.equal(remoteCandidate.treeSha, candidate.treeSha);
          assert.deepEqual(remoteCandidate.parentShas, [],
            "D381 orphan candidate must have no Source or other parent");
          assert.equal(await candidateReader.getGitRefOrNull(), null,
            "D381 orphan candidate must remain unreachable by Destination ref");
          assert.equal(await candidateReader.getGitRefOrNull(), null);
          assert.equal(candidateReader.transportMetricsSnapshot.mutations, candidateReaderMutations,
            "D381 candidate verifier must not mutate GitHub");
          const candidateWal = await journal.assertHealthySnapshot(
            staged.journalSnapshot.generation + 2,
          );
          assert.match(candidateWal.candidatePreparationSha256 ?? "", /^[0-9a-f]{64}$/u);
          assert.equal(candidateWal.preparedCandidateReceipt?.commitSha, candidate.commitSha);
          assert.equal(candidateWal.preparedCandidateReceipt?.treeSha, candidate.treeSha);
          assert.match(candidateWal.preparedCandidateReceipt?.manifestSha256 ?? "", /^[0-9a-f]{64}$/u);
          assert.equal(candidateWal.pendingIntents.length, 0);
          assert.equal(candidateWal.pendingRefIntents.length, 0);
          assert.equal(candidateWal.cutoverAuthorized, false);
          candidateEvidence = {
            generation: candidateWal.generation, commitSha: candidate.commitSha,
            treeSha: candidate.treeSha, metadataObjects: candidate.encryptedMetadataObjectCount,
          };
        }
        // D382: Real GitHub frozen Backup -> authenticated old-key decrypt ->
        // disposable physical scratch write/readback -> remove every scratch file.
        // This proves independent test storage readback, not installed Obsidian.
        const scratchProof = stageInput.verifyScratchRestore
          ? await d382VerifyLiveBackupScratch({
            rootAbsolute, inventory, backupClient: input.backupClient,
            pinnedSourceCommitSha: input.plan.pinnedSourceCommitSha,
            oldKeyring: oldKey,
          }) : undefined;
        if (scratchProof) {
          assert.equal(scratchProof.scratchReadbackMatched, true);
          assert.equal(scratchProof.permissionToPublish, false);
          assert.equal(scratchProof.cutoverAuthorized, false);
          assert.equal(scratchProof.roundTripFileCount, staged.records.length);
          assert.equal(scratchProof.roundTripPlaintextBytes, staged.preview.totalPlaintextBytes);
          assert.equal(await stageInput.destination.getGitRefOrNull(), null,
            "D382 scratch roundtrip alone may never publish a Destination ref");
        }
        // D383: A real create-only GitHub Destination ref may be sent only
        // after independently authenticated Backup scratch restore, a
        // physical TEST Vault's two-pass exact Source parity and SAME-WAL
        // candidate/intent receipts. This does not operate on Obsidian files
        // or authorize installed Settings/Index cutover.
        let publicationEvidence: {
          readonly generation: number;
          readonly verifiedFiles: number;
          readonly lostResponseReconciled: boolean;
        } | undefined;
        if (stageInput.publishDestination) {
          assert.ok(preparedCandidate && candidateEvidence && scratchProof
            && createdAndVerifiedBackup, "D383 must not publish with missing live evidence");
          const initiator = await d383CreatePhysicalInitiator({
            rootAbsolute, originalSnapshot: stageInput.originalSnapshot,
            assertWalLease: async () => { await owned!.assertExclusiveStageLease(); },
            assertSourceConfigUnchanged: async () => {
              assert.equal(inventory.sourceConfig.repoId, input.plan.sourceRepoId);
              assert.equal(inventory.verifiedSource.pinnedSourceCommitSha,
                input.plan.pinnedSourceCommitSha);
            },
          });
          try {
            const localParity = {
              pinnedSourceCommitSha: input.plan.pinnedSourceCommitSha,
              verifiedSource: inventory.verifiedSource,
              sourceRecords: inventory.sourceRecords.filter(record => !record.deleted),
              reader: initiator.reader,
            };
            const preflight = await verifyV4ReencryptionInitiatorLocalParity(localParity);
            assert.equal(preflight.checkedFileCount, staged.records.length);
            assert.equal(preflight.checkedPlaintextBytes, staged.preview.totalPlaintextBytes);
            assert.equal(preflight.initiatorLocalCutoverAuthorized, false);
            // A same-size byte modification on disk MUST fail two-pass local
            // SHA parity before any new GitHub mutation. Restore only this
            // disposable test Vault before the positive publication.
            const mutationsBeforeNegative = stageInput.destination.transportMetricsSnapshot.mutations;
            await initiator.tamperAndRestoreFirstFile(async () => {
              await assert.rejects(
                () => verifyV4ReencryptionInitiatorLocalParity(localParity),
                /content does not match authenticated source SHA-256/u,
              );
            });
            assert.equal(stageInput.destination.transportMetricsSnapshot.mutations,
              mutationsBeforeNegative, "D383 invalid local bytes must not create a ref");
            await verifyV4ReencryptionInitiatorLocalParity(localParity);
            assert.equal(await stageInput.destination.getGitRefOrNull(), null);
            if (stageInput.simulateCrashAfterDestinationCreate) {
              assert.ok(crashRoot, "D385 test-only OS process-loss root missing");
              await d385WriteRecoveryEvidence(crashRoot, {
                schemaVersion: 1, runId, journalRoot,
                sourceCommitSha: input.plan.pinnedSourceCommitSha,
                sourceTreeSha: input.pinnedTreeSha,
                backupPlan: input.plan, orphanPlan, prepared: preparedCandidate,
                sourceConfig: inventory.sourceConfig, destinationConfig,
                expectedRecords: staged.records, expectedReceipts: staged.receipts,
                pendingGeneration: candidateEvidence.generation + 1,
              });
              const noPending = await journal.assertHealthySnapshot(candidateEvidence.generation);
              assert.equal(noPending.pendingRefIntents.length, 0);
              assert.equal(noPending.preparedCandidateReceipt?.commitSha,
                preparedCandidate.commitSha);
            }
            const mutationsBeforeCreate = stageInput.destination.transportMetricsSnapshot.mutations;
            // D384: Only the disposable Destination client is modified. The
            // REAL create-only GitHub POST must finish successfully first;
            // discard its response afterward so the production coordinator
            // must authenticate the full remote Destination from its WAL
            // intent, without issuing a second create-ref request.
            let destinationCreateAttempts = 0;
            let lostResponseAfterRemoteCreate = false;
            if (stageInput.simulateCrashAfterDestinationCreate) {
              assert.ok(crashRoot, "D385 cannot inject outside its isolated test root");
              const actualCreateRef = stageInput.destination.createGitRef.bind(stageInput.destination);
              let createAttempts = 0;
              stageInput.destination.createGitRef = async sha => {
                createAttempts++;
                assert.equal(createAttempts, 1,
                  "D385 must never send a second reachable-ref POST");
                assert.equal(sha, preparedCandidate.commitSha);
                // This is the ONLY live mutation: GitHub has returned a
                // confirmed successful create before the child terminates.
                await actualCreateRef(sha);
                await writeFile(path.join(crashRoot, "post-confirmed.json"),
                  JSON.stringify({
                    schemaVersion: 1, destinationCommitSha: sha,
                    sourceCommitSha: input.plan.pinnedSourceCommitSha,
                    createAttempts,
                  }), { flag: "wx", mode: 0o600 });
                console.log(JSON.stringify({
                  stage: "D385_SIMULATED_CHILD_EXIT_AFTER_REAL_DESTINATION_CREATE",
                  destinationCommitSha: sha, createAttempts,
                  noLocalCutover: true,
                }));
                // Intentionally SKIP all finally/release and test after hooks,
                // including WAL ref observation and in-process reconciliation.
                // Only the parent-owned disposable test can clean/recover it.
                process.exit(86);
              };
            }
            if (stageInput.simulateLostDestinationCreateResponse) {
              const realCreateRef = stageInput.destination.createGitRef.bind(stageInput.destination);
              stageInput.destination.createGitRef = async sha => {
                destinationCreateAttempts++;
                assert.equal(destinationCreateAttempts, 1,
                  "D384 must never retry a reachable-ref mutation");
                assert.equal(sha, preparedCandidate.commitSha);
                await realCreateRef(sha);
                lostResponseAfterRemoteCreate = true;
                throw new Error("D384_INJECTED_LOST_RESPONSE_AFTER_REMOTE_DESTINATION_CREATED");
              };
            }
            const published = await publishV4BestEffortJournaledThreeBranchDestination({
              plan: orphanPlan, backupPlan: input.plan, journal, wal: owned!,
              acknowledgement: "accept-best-effort-power-loss-recovery-risk",
              github: stageInput.destination, backupRefReader: input.backupClient,
              createdAndVerifiedBackup, scratchRestore: scratchProof,
              initiatorLocalParity: localParity, prepared: preparedCandidate,
              sourceTreeSha: input.pinnedTreeSha, sourceConfig: inventory.sourceConfig,
              expectedDestinationConfig: destinationConfig,
              expectedRecords: staged.records, expectedReceipts: staged.receipts,
              destinationPassphrase: newPassphrase,
              async assertInitiatingVaultUnchanged() {
                const parity = await verifyV4ReencryptionInitiatorLocalParity(localParity);
                assert.equal(parity.checkedFileCount, staged.records.length);
              },
            });
            assert.equal(published.destinationContentsReadbackVerified, true);
            assert.equal(published.destinationCommitSha, preparedCandidate.commitSha);
            assert.equal(published.verifiedFileCount, staged.records.length);
            assert.equal(published.verifiedPlaintextBytes, staged.preview.totalPlaintextBytes);
            assert.equal(published.backupScratchRoundTripVerified, true);
            assert.equal(published.initiatingDeviceCutoverAuthorized, false);
            if (stageInput.simulateLostDestinationCreateResponse) {
              assert.equal(destinationCreateAttempts, 1,
                "D384 lost-response handling must not retry create-ref");
              assert.equal(lostResponseAfterRemoteCreate, true,
                "D384 must inject the unknown outcome AFTER a real successful GitHub POST");
              assert.equal((await stageInput.destination.getGitRefOrNull())?.sha,
                preparedCandidate.commitSha,
                "D384 lost POST response must leave a real reachable exact Destination");
            }
            assert.equal(stageInput.destination.transportMetricsSnapshot.mutations,
              mutationsBeforeCreate + 1, "D383 must create Destination ref exactly once");
            const independentDestinationReader = new GitHubClient({
              ...input.config, branch: orphanPlan.destinationBranch,
            });
            const beforeIndependentReadback = independentDestinationReader.transportMetricsSnapshot.mutations;
            const independentDestination = await inspectV4ReencryptionOrphanAfterAmbiguousPublication({
              github: independentDestinationReader, plan: orphanPlan,
              prepared: preparedCandidate, sourceTreeSha: input.pinnedTreeSha,
              sourceConfig: inventory.sourceConfig,
              expectedDestinationConfig: destinationConfig,
              expectedRecords: staged.records, expectedReceipts: staged.receipts,
              destinationPassphrase: newPassphrase,
            });
            assert.equal(independentDestination.outcome, "destination-pinned-and-fully-verified");
            assert.equal(independentDestination.destinationContentsVerified, true);
            assert.equal(independentDestination.verifiedFileCount, staged.records.length);
            assert.equal(independentDestination.verifiedPlaintextBytes, staged.preview.totalPlaintextBytes);
            assert.equal(independentDestination.automaticallyRetryCreateAuthorized, false);
            assert.equal(independentDestination.localCutoverAuthorized, false);
            assert.equal(independentDestinationReader.transportMetricsSnapshot.mutations,
              beforeIndependentReadback, "D383 independent readback must never mutate GitHub");
            const publishedWal = await journal.assertHealthySnapshot(candidateEvidence.generation + 2);
            assert.equal(publishedWal.pendingRefIntents.length, 0);
            assert.equal(publishedWal.pendingIntents.length, 0);
            assert.deepEqual(publishedWal.verifiedRefObservations.map(ref => ref.role),
              ["backup", "destination"]);
            assert.equal(publishedWal.cutoverAuthorized, false);
            publicationEvidence = {
              generation: publishedWal.generation, verifiedFiles: published.verifiedFileCount,
              lostResponseReconciled: stageInput.simulateLostDestinationCreateResponse === true
                && lostResponseAfterRemoteCreate && destinationCreateAttempts === 1,
            };
          } finally {
            await initiator.remove();
          }
        }
        stagedProof = {
          generation: publicationEvidence?.generation
            ?? candidateEvidence?.generation ?? staged.journalSnapshot.generation,
          ...(publicationEvidence ? {
            destinationPublished: true,
            destinationVerifiedFiles: publicationEvidence.verifiedFiles,
            lostDestinationResponseReconciled: publicationEvidence.lostResponseReconciled,
          } : {}),
          ...(scratchProof ? {
            scratchRestoreVerified: true,
            scratchRestoredFiles: scratchProof.roundTripFileCount,
          } : {}),
          ...(candidateEvidence ? {
            candidateCommitSha: candidateEvidence.commitSha,
            candidateTreeSha: candidateEvidence.treeSha,
            candidateMetadataObjects: candidateEvidence.metadataObjects,
          } : {}),
          receiptCount: staged.receipts.length,
          fileCount: staged.preview.finalizedFileCount,
          plaintextBytes: staged.preview.totalPlaintextBytes,
          independentNewKeyDecryptVerified: true,
          oldKeyRejected: true,
        };
      } finally {
        for (const key of [oldKey, newKey]) {
          if (key) for (const part of [
            key.masterKey, key.pathKey, key.contentKey, key.indexKey, key.journalKey,
          ]) part.fill(0);
        }
        oldSalt.fill(0);
        newSalt.fill(0);
      }
    }
    const live = await journal.load();
    assert.ok(live);
    assert.equal(live.generation, input.injectUnknownCreateOutcome
      ? 2 : (stagedProof?.generation ?? 3));
    assert.equal(live.pendingRefIntents.length, input.injectUnknownCreateOutcome ? 1 : 0);
    assert.deepEqual(live.verifiedRefObservations.map(ref => ref.role),
      input.injectUnknownCreateOutcome ? []
        : stagedProof?.destinationPublished ? ["backup", "destination"] : ["backup"]);
    const slots = [journalRoot + "/slot-0.json", journalRoot + "/slot-1.json"];
    const originalHashes = await Promise.all(slots.map(async slot =>
      sha256Hex(bytes(await owned!.adapter.read(slot)))));
    await owned.release();
    owned = undefined;

    // Fresh storage + journal reader; never use the writer's in-memory
    // snapshot as a substitute for actual on-disk WAL verification.
    const reopened = await acquireV4DesktopRekeyWalStorage({
      rootAbsolute, journalRoot, recoveryExistingOnly: true,
    });
    try {
      const recovered = createV4ReencryptionRecoveryJournal({
        adapter: reopened.adapter, root: journalRoot, runId,
        destinationRepoId: input.plan.destinationRepoId,
        sourceCommitSha: input.plan.pinnedSourceCommitSha,
        journalKey: Uint8Array.from(journalKey),
      });
      const initialRead = await recovered.assertHealthySnapshot(live.generation);
      assert.deepEqual(initialRead.pendingRefIntents, live.pendingRefIntents);
      assert.deepEqual(initialRead.verifiedRefObservations, live.verifiedRefObservations);
      assert.deepEqual(initialRead.receipts, live.receipts,
        "reopened WAL lost or changed new-key ciphertext receipts");
      assert.equal(initialRead.stageHandoffStarted, Boolean(stagedProof));
      const afterHashes = await Promise.all(slots.map(async slot =>
        sha256Hex(bytes(await reopened.adapter.read(slot)))));
      assert.deepEqual(afterHashes, originalHashes,
        "WAL slots changed while the writer was closed and reopened");
      let reread = initialRead;
      if (input.injectUnknownCreateOutcome) {
        assert.equal(initialRead.pendingRefIntents.length, 1);
        assert.equal(initialRead.verifiedRefObservations.length, 0);
        const beforeMutations = input.backupClient.transportMetricsSnapshot.mutations;
        const recovery = await reconcileV4PendingFrozenBackupWithJournalBestEffort({
          plan: input.plan, journal: recovered, wal: reopened,
          verifiedOriginalSource: input.sourceProof,
          backup: input.backupClient, expectedSourceTreeSha: input.pinnedTreeSha,
          originalPassphrase: "v4-real-github-e2e",
          acknowledgement: "accept-best-effort-power-loss-recovery-risk",
        });
        assert.equal(recovery.backedUpContentsVerified, true);
        assert.equal(recovery.automaticallyRetryCreateAuthorized, false);
        assert.equal(recovery.initiatingDeviceCutoverAuthorized, false);
        assert.equal(recovery.verifiedFileCount, input.sourceProof.verifiedFileCount);
        assert.equal(recovery.verifiedPlaintextBytes,
          input.sourceProof.totalVerifiedPlaintextBytes);
        assert.equal(input.backupClient.transportMetricsSnapshot.mutations, beforeMutations,
          "manual WAL Backup reconciliation unexpectedly sent a GitHub mutation");
        reread = await recovered.assertHealthySnapshot(live.generation + 1);
      }
      assert.equal(reread.generation, input.injectUnknownCreateOutcome ? 3 : live.generation);
      assert.equal(reread.pendingRefIntents.length, 0);
      assert.equal(reread.pendingIntents.length, 0);
      assert.deepEqual(reread.verifiedRefObservations.map(ref => ref.role),
        stagedProof?.destinationPublished ? ["backup", "destination"] : ["backup"]);
      assert.deepEqual(reread.receipts, live.receipts,
        "recovery WAL staged receipts changed across physical close/reopen");
      if (stagedProof) {
        assert.equal(reread.receipts.length, stagedProof.receiptCount);
        assert.equal(reread.stageHandoffStarted, true);
        const reopenedDestinationRef =
          await input.stageAfterVerifiedBackup!.destination.getGitRefOrNull();
        if (stagedProof.destinationPublished) {
          assert.equal(reopenedDestinationRef?.sha, stagedProof.candidateCommitSha,
            "D383 reopened WAL destination must still point to exact candidate");
          assert.equal(reread.verifiedRefObservations.at(-1)?.role, "destination");
          assert.equal(reread.verifiedRefObservations.at(-1)?.commitSha,
            stagedProof.candidateCommitSha);
        } else {
          assert.equal(reopenedDestinationRef, null,
            "D378-D382 must never create a Destination Git ref");
        }
        if (stagedProof.candidateCommitSha) {
          assert.match(reread.candidatePreparationSha256 ?? "", /^[0-9a-f]{64}$/u);
          assert.equal(reread.preparedCandidateReceipt?.commitSha, stagedProof.candidateCommitSha);
          assert.equal(reread.preparedCandidateReceipt?.treeSha, stagedProof.candidateTreeSha);
          assert.match(reread.preparedCandidateReceipt?.manifestSha256 ?? "", /^[0-9a-f]{64}$/u);
        } else {
          assert.equal(reread.candidatePreparationSha256, null);
          assert.equal(reread.preparedCandidateReceipt, null);
        }
      }
      assert.equal(reread.permissionToPublish, false);
      assert.equal(reread.cutoverAuthorized, false);
      assert.equal((await input.backupClient.getGitRef()).sha, input.plan.pinnedSourceCommitSha);
      console.log(JSON.stringify({
        stage: input.injectUnknownCreateOutcome
          ? "D378_LOST_GITHUB_CREATE_RESPONSE_MANUAL_WAL_RECOVERY"
          : stagedProof?.lostDestinationResponseReconciled
            ? "D384_LIVE_DESTINATION_POST_RESPONSE_LOST_AND_RECONCILED"
            : stagedProof?.destinationPublished ? "D383_LIVE_WAL_DESTINATION_CREATE_ONLY_PUBLICATION"
              : stagedProof?.scratchRestoreVerified ? "D382_LIVE_WAL_BACKUP_SCRATCH_RESTORE"
              : stagedProof?.candidateCommitSha ? "D381_LIVE_WAL_ZERO_PARENT_ORPHAN_CANDIDATE"
              : stagedProof ? "D380_LIVE_WAL_NEW_KEY_BLOB_DECRYPT"
              : "D378_LIVE_BEST_EFFORT_WAL_BACKUP",
        candidatePrepared: Boolean(stagedProof?.candidateCommitSha),
        candidateCommitSha: stagedProof?.candidateCommitSha ?? null,
        candidateMetadataObjects: stagedProof?.candidateMetadataObjects ?? 0,
        candidateRefPublished: stagedProof?.destinationPublished ?? false,
        destinationVerifiedFiles: stagedProof?.destinationVerifiedFiles ?? 0,
        lostDestinationResponseReconciled: stagedProof?.lostDestinationResponseReconciled ?? false,
        scratchRestoreVerified: stagedProof?.scratchRestoreVerified ?? false,
        scratchRestoredFiles: stagedProof?.scratchRestoredFiles ?? 0,
        independentNewKeyDecryptVerified: stagedProof?.independentNewKeyDecryptVerified ?? false,
        oldKeyRejected: stagedProof?.oldKeyRejected ?? false,
        stagedNewKeyObjects: stagedProof?.receiptCount ?? 0,
        stagedFiles: stagedProof?.fileCount ?? 0,
        verifiedFiles: input.sourceProof.verifiedFileCount,
        plaintextBytes: input.sourceProof.totalVerifiedPlaintextBytes,
        WALGeneration: reread.generation,
        WALReopened: true,
        backupRefReadbackAuthenticated: true,
        WALReadbackUnchangedAcrossReopen: true,
        createRefRetriedAfterUnknownResponse: false,
        crashDurabilityClaimed: false,
        cutoverAuthorized: false,
      }));
    } finally {
      await reopened.release();
    }
  } finally {
    await owned?.release();
    journalKey.fill(0);
    await rm(rootAbsolute, { recursive: true, force: true });
  }
}

/**
 * D373: test-only, independently authenticated frozen Backup from the exact
 * encrypted source commit. This does NOT exercise crash-durable WAL, installed
 * Obsidian restore, re-encryption to new keys, or any cutover authorization.
 */
async function runFrozenBackupReadbackScenario(config: GitHubConfig, includeDestination = false): Promise<void> {
  const injectUnknownCreateOutcome = process.env["GITHUB_E2E_ONLY_SCENARIO"] === "wal-backup-ambiguous";
  const walCrashAfterDestination = process.env["GITHUB_E2E_ONLY_SCENARIO"] === "wal-publish-process-loss"
    || process.env["GITHUB_E2E_ONLY_SCENARIO"] === "wal-publish-process-loss-negative";
  const walLostDestinationResponse = process.env["GITHUB_E2E_ONLY_SCENARIO"] === "wal-publish-lost-response";
  const walPublish = process.env["GITHUB_E2E_ONLY_SCENARIO"] === "wal-publish-encrypted"
    || walLostDestinationResponse || walCrashAfterDestination;
  const walScratch = process.env["GITHUB_E2E_ONLY_SCENARIO"] === "wal-scratch-encrypted" || walPublish;
  const walCandidate = process.env["GITHUB_E2E_ONLY_SCENARIO"] === "wal-candidate-encrypted" || walScratch;
  const walStage = process.env["GITHUB_E2E_ONLY_SCENARIO"] === "wal-stage-encrypted" || walCandidate;
  const walBackedBackup = process.env["GITHUB_E2E_ONLY_SCENARIO"] === "wal-backup-encrypted" || injectUnknownCreateOutcome || walStage;
  await runScenario(config, "encrypted", injectUnknownCreateOutcome ? "wal-backup-ambiguous"
    : walCrashAfterDestination ? (process.env["GITHUB_E2E_ONLY_SCENARIO"] === "wal-publish-process-loss-negative"
      ? "wal-publish-process-loss-negative" : "wal-publish-process-loss")
      : walLostDestinationResponse ? "wal-publish-lost-response"
        : walPublish ? "wal-publish-encrypted" : walScratch ? "wal-scratch-encrypted" : walCandidate ? "wal-candidate-encrypted" : walStage ? "wal-stage-encrypted" : walBackedBackup ? "wal-backup-encrypted" : includeDestination ? "newkey-destination-encrypted" : "frozen-backup-encrypted", async ({ device }) => {
    const source = device("d373-source");
    seedBaseline(source.vault, "encrypted");
    const originalSnapshot = (includeDestination || walStage)
      ? new Map([...source.vault.files].map(([path, file]) => [path, Uint8Array.from(file.bytes)] as const))
      : undefined;
    const pushed = await source.session.sync({ operation: "forcePush", allowThresholdOverride: false });
    assert.equal(pushed.mode, "force-push");
    const pinnedSha = source.index.remoteCommitSha;
    assert.match(pinnedSha ?? "", /^[0-9a-f]{40}$/u);
    await waitForBranchHead(config, pinnedSha!);

    const sourceReader = new GitHubClient(config);
    const sourceProof = await verifyGitHubReencryptionSource({
      github: sourceReader, expectedRepoId: repoId(config),
      expectedBranch: config.branch, passphrase: "v4-real-github-e2e",
    });
    assert.equal(sourceProof.pinnedSourceCommitSha, pinnedSha);
    assert.equal(sourceProof.verifiedFileCount, source.vault.files.size);
    const transcodeInventory = (includeDestination || walStage)
      ? await verifyGitHubReencryptionForkSourceWithTranscodeInventory({
        github: sourceReader, expectedRepoId: repoId(config),
        expectedBranch: config.branch, passphrase: "v4-real-github-e2e",
      }) : undefined;
    if (transcodeInventory) assert.equal(transcodeInventory.pinnedSourceCommitSha, pinnedSha);
    const pinnedCommit = await sourceReader.getGitCommit(pinnedSha!);
    const physical = await sourceReader.getRepositoryIdentity();
    assert.equal(physical.id, Number(initialTarget.repositoryId));

    const backupBranch = deriveGitHubE2EFrozenBackupBranch(config.branch);
    const destinationBranch = deriveGitHubE2EDestinationBranch(config.branch);
    const backupTarget = { ...targetEnvironment, branch: backupBranch, requiredBranch: backupBranch };
    const backupClient = new GitHubClient({ ...config, branch: backupBranch });
    const backupTargetProof = await resolveGitHubE2ETarget(backupTarget);
    assert.equal(backupTargetProof.repositoryId, initialTarget.repositoryId);
    // This backup ref is entirely test-owned only after TWO absent observations.
    assert.equal(await backupClient.getGitRefOrNull(), null);
    assert.equal(await backupClient.getGitRefOrNull(), null);
    const destinationTarget = { ...targetEnvironment, branch: destinationBranch, requiredBranch: destinationBranch };
    const destinationClient = (includeDestination || walStage)
      ? new GitHubClient({ ...config, branch: destinationBranch }) : undefined;
    if (destinationClient) {
      const observed = await resolveGitHubE2ETarget(destinationTarget);
      assert.equal(observed.repositoryId, initialTarget.repositoryId);
      assert.equal(await destinationClient.getGitRefOrNull(), null);
      assert.equal(await destinationClient.getGitRefOrNull(), null);
    }
    let staleOldDevice: DeviceContext | undefined;
    let staleOldKey: V4Keyring | undefined;
    try {
      const plan = proposeV4SameRepositoryReencryptionBackupBranch({
        sourceRepoId: repoId(config),
        backupRepoId: `${config.owner}/${config.repo}#${backupBranch}`,
        destinationRepoId: `${config.owner}/${config.repo}#${destinationBranch}`,
        pinnedSourceCommitSha: pinnedSha!,
        sourcePhysicalRepositoryId: physical.id,
        backupPhysicalRepositoryId: physical.id,
        destinationPhysicalRepositoryId: physical.id,
        expectedPhysicalRepositoryId: physical.id,
        defaultBranch: initialTarget.defaultBranch,
      });
      if (walBackedBackup) {
        await createJournaledFrozenBackupLive({
          config, plan, sourceProof, sourceClient: sourceReader,
          backupClient, pinnedTreeSha: pinnedCommit.treeSha,
          injectUnknownCreateOutcome,
          ...(walStage ? { stageAfterVerifiedBackup: {
            inventory: transcodeInventory!, destination: destinationClient!,
            physicalRepositoryId: physical.id, defaultBranch: initialTarget.defaultBranch,
            originalSnapshot: originalSnapshot!,
            ...(walCandidate ? { prepareCandidate: true } : {}),
            ...(walScratch ? { verifyScratchRestore: true } : {}),
            ...(walPublish ? { publishDestination: true } : {}),
            ...(walLostDestinationResponse
              ? { simulateLostDestinationCreateResponse: true } : {}),
            ...(walCrashAfterDestination
              ? { simulateCrashAfterDestinationCreate: true } : {}),
          } } : {}),
        });
      } else {
        const created = await createV4FrozenSameRepositoryBackupRef({
          plan, verifiedSource: sourceProof, source: sourceReader,
          backup: backupClient, expectedSourceTreeSha: pinnedCommit.treeSha,
        });
        assert.equal(created.backupRefCreatedAndReadBack, true);
        assert.equal(created.backupContentsReadbackVerified, false);
        assert.equal(created.cutoverAuthorized, false);
        assert.equal(created.destinationPublicationAuthorized, false);
      }
      assert.equal((await backupClient.getGitRef()).sha, pinnedSha);
      if (includeDestination) {
        assert.ok(transcodeInventory);
        // Keep one old-key device at the ORIGINAL Source commit while the
        // initiator and new-key peers advance on independent branches.
        const staleSalt = fromBase64Url(transcodeInventory.sourceConfig.kdfParams!.salt);
        try {
          staleOldKey = await deriveV4Keyring({
            passphrase: "v4-real-github-e2e", repoId: repoId(config), salt: staleSalt,
            iterations: transcodeInventory.sourceConfig.kdfParams!.iterations,
          });
        } finally {
          staleSalt.fill(0);
        }
        staleOldDevice = createDevice("d376-stale-old-source",
          config, { mode: "encrypted",
            remoteConfig: transcodeInventory.sourceConfig, keyring: staleOldKey });
        await staleOldDevice.session.sync({
          operation: "forcePull", allowThresholdOverride: false,
        });
        assert.equal(staleOldDevice.index.remoteCommitSha, pinnedSha);
        assert.ok(originalSnapshot);
        assert.equal(staleOldDevice.vault.files.size, originalSnapshot.size);
        for (const [path, expected] of originalSnapshot) {
          assert.deepEqual(staleOldDevice.vault.files.get(path)?.bytes, expected,
            `stale old-key initial snapshot differs: ${path}`);
        }
      }
      // Test-only process-loss injection: the child exits without executing
      // E2E after/finally hooks, leaving BOTH refs for the outer wrapper.
      if (process.env["GITHUB_E2E_ONLY_SCENARIO"] === "frozen-backup-encrypted"
        && process.env["GITHUB_E2E_SIMULATE_EXIT_AFTER_BACKUP"] === "1") {
        console.log(JSON.stringify({ stage: "D373_SIMULATED_CHILD_EXIT_AFTER_BACKUP_REF", backupBranch }));
        process.exit(86);
      }

      // An ordinary device may keep syncing to the old branch after the fork.
      source.vault.set("Notes/hello.md", bytes("source advanced after frozen backup\n"), 200);
      const advanced = await source.session.sync({
        operation: "normal", allowThresholdOverride: false,
        changes: [{ type: "modify", path: "Notes/hello.md", mtime: 200 }],
      });
      assert.ok(["push", "pull-push"].includes(advanced.mode));
      const currentSourceSha = source.index.remoteCommitSha;
      assert.match(currentSourceSha ?? "", /^[0-9a-f]{40}$/u);
      assert.notEqual(currentSourceSha, pinnedSha);
      await waitForBranchHead(config, currentSourceSha!);

      const independentBackupReader = new GitHubClient({ ...config, branch: backupBranch });
      const before = independentBackupReader.transportMetricsSnapshot;
      const verified = await verifyGitHubFrozenReencryptionBackup({
        github: independentBackupReader, plan,
        expectedSourceTreeSha: pinnedCommit.treeSha,
        passphrase: "v4-real-github-e2e",
      });
      const after = independentBackupReader.transportMetricsSnapshot;
      assert.equal(verified.backupContentsReadbackVerified, true);
      assert.equal(verified.verifiedFileCount, sourceProof.verifiedFileCount);
      assert.equal(verified.verifiedPlaintextBytes, sourceProof.totalVerifiedPlaintextBytes);
      assert.equal(after.mutations, before.mutations);
      assert.equal((await backupClient.getGitRef()).sha, pinnedSha);
      assert.equal((await sourceReader.getGitRef()).sha, currentSourceSha);
      assert.equal(verified.destinationPublicationAuthorized, false);
      assert.equal(verified.cutoverAuthorized, false);
      console.log(JSON.stringify({
        stage: "D373_LIVE_FROZEN_BACKUP_READBACK",
        sourceBranch: config.branch, backupBranch,
        sourceAdvanced: currentSourceSha !== pinnedSha,
        backupPinnedToOriginalCommit: true,
        verifiedFileCount: verified.verifiedFileCount,
        verifiedPlaintextBytes: verified.verifiedPlaintextBytes,
        backupReaderMutations: after.mutations - before.mutations,
        cutoverAuthorized: verified.cutoverAuthorized,
      }));
      if (includeDestination) {
        assert.ok(destinationClient && transcodeInventory);
        const destinationRepoId = `${config.owner}/${config.repo}#${destinationBranch}`;
        const newSalt = randomBytes(16);
        const oldSalt = fromBase64Url(transcodeInventory.sourceConfig.kdfParams!.salt);
        const oldKey = await deriveV4Keyring({
          passphrase: "v4-real-github-e2e", repoId: repoId(config),
          salt: oldSalt, iterations: transcodeInventory.sourceConfig.kdfParams!.iterations,
        });
        const newPassphrase = `d374-new-key-${toBase64Url(randomBytes(18))}`;
        const newConfig: V4RemoteConfig = {
          ...transcodeInventory.sourceConfig, repoId: destinationRepoId,
          kdfParams: { iterations: 600_000, salt: toBase64Url(newSalt) },
        };
        const newKey = await deriveV4Keyring({
          passphrase: newPassphrase, repoId: destinationRepoId, salt: newSalt,
          iterations: 600_000,
        });
        try {
          const orphanPlan = planV4OrphanReencryptionDestination({
            sourceRepoId: repoId(config), destinationRepoId,
            sourceCommitSha: pinnedSha!,
            sourcePhysicalRepositoryId: physical.id,
            destinationPhysicalRepositoryId: physical.id,
            expectedPhysicalRepositoryId: physical.id,
            defaultBranch: initialTarget.defaultBranch,
          });
          const checkPinnedBackup = async () => {
            assert.equal((await backupClient.getGitRef()).sha, pinnedSha,
              "backup changed while transcoding immutable old source");
          };
          const staged = await stageV4ReencryptionVaultObjects({
            plan: orphanPlan,
            sourceConfig: transcodeInventory.sourceConfig,
            sourceHead: transcodeInventory.sourceHead,
            sourceShards: transcodeInventory.sourceShards,
            sourceKeyring: oldKey,
            destinationConfig: newConfig, destinationKeyring: newKey,
            async verifySourceStillPinned() { await checkPinnedBackup(); },
            async readSourceObject(path, sha) {
              assert.equal(sha, pinnedSha);
              const read = await readImmutableGitFile(path, sha, {
                getCommit: commit => sourceReader.getGitCommit(commit),
                getTree: tree => sourceReader.getTreeAt(tree, false),
                getBlob: blob => sourceReader.getBlob(blob),
              });
              return read?.bytes ?? null;
            },
            async stageImmutableObject(_path, ciphertext) {
              // No refs/index/Settings are modified by this Git blob upload.
              return destinationClient.createGitBlob(ciphertext);
            },
          });
          assert.equal(staged.preview.finalizedFileCount, verified.verifiedFileCount);
          assert.equal(staged.preview.totalPlaintextBytes, verified.verifiedPlaintextBytes);
          assert.equal(staged.preview.permissionToPublish, false);
          assert.equal(staged.preview.cutoverAuthorized, false);
          for (const record of staged.records) {
            const old: (typeof transcodeInventory.sourceRecords)[number] | undefined =
              transcodeInventory.sourceRecords.find(item => item.path === record.path);
            assert.ok(old);
            assert.notEqual(record.fileId, old.fileId);
            assert.notEqual(record.pathId, old.pathId);
            assert.equal(record.plaintextSha256, old.plaintextSha256);
          }
          const prepared = await prepareV4ReencryptionOrphanCommit({
            plan: orphanPlan, github: destinationClient, verifiedBackup: verified,
            sourceConfig: transcodeInventory.sourceConfig,
            destinationConfig: newConfig, destinationKeyring: newKey,
            sourceTreeSha: pinnedCommit.treeSha, staged,
            deviceId: "d374-new-device", journalId: "d374-new-journal",
            createdAt: 1_700_000_000_000,
            // Synthetic-only process-local guard; NEVER a WAL lease.
            assertExclusiveMigrationLease: checkPinnedBackup,
          });
          assert.equal(prepared.refPublished, false);
          assert.equal(prepared.rootHasZeroParents, true);
          // Source advanced after the fork; the immutable inventory is the authority.
          const originalFileCount = transcodeInventory.sourceRecords.length;
          assert.equal(originalFileCount, sourceProof.verifiedFileCount);
          assert.equal(await destinationClient.getGitRefOrNull(), null);
          assert.equal(await destinationClient.getGitRefOrNull(), null);
          // Test-only create-only ref on an approved random branch. No real WAL
          // or permission for a production Cutover is implied by this action.
          await destinationClient.createGitRef(prepared.commitSha);
          await waitForBranchHead({ ...config, branch: destinationBranch }, prepared.commitSha);
          const independentDestination = new GitHubClient({ ...config, branch: destinationBranch });
          const beforeDestination = independentDestination.transportMetricsSnapshot.mutations;
          const destinationProof = await verifyV4ReencryptionDestinationExactCommit({
            github: independentDestination, plan: orphanPlan,
            destinationCommitSha: prepared.commitSha,
            sourceTreeSha: pinnedCommit.treeSha,
            sourceConfig: transcodeInventory.sourceConfig,
            expectedDestinationConfig: newConfig,
            expectedRecords: staged.records, expectedReceipts: staged.receipts,
            destinationPassphrase: newPassphrase,
          });
          assert.equal(destinationProof.verifiedFileCount, originalFileCount);
          assert.equal(destinationProof.totalVerifiedPlaintextBytes, verified.verifiedPlaintextBytes);
          assert.equal(destinationProof.cutoverAuthorized, false);
          assert.equal(independentDestination.transportMetricsSnapshot.mutations, beforeDestination);
          const independentlyRestored = await verifyGitHubReencryptionSource({
            github: new GitHubClient({ ...config, branch: destinationBranch }),
            expectedRepoId: destinationRepoId, expectedBranch: destinationBranch,
            passphrase: newPassphrase,
          });
          assert.equal(independentlyRestored.verifiedFileCount, originalFileCount);
          assert.equal(independentlyRestored.totalVerifiedPlaintextBytes, verified.verifiedPlaintextBytes);
          // Separate empty device restores actual bytes via normal V4 Sync,
          // not just a verifier re-reading Git metadata and hashes.
          assert.ok(originalSnapshot);
          // A genuinely independent device must derive its OWN keyring rather
          // than borrow the in-memory key object used by the migrator.
          const peerKey = await deriveV4Keyring({
            passphrase: newPassphrase, repoId: destinationRepoId, salt: newSalt,
            iterations: newConfig.kdfParams!.iterations,
          });
          try {
            const peer = createDevice("d375-independent-peer",
              { ...config, branch: destinationBranch },
              { mode: "encrypted", remoteConfig: newConfig, keyring: peerKey });
            await peer.session.sync({ operation: "forcePull", allowThresholdOverride: false });
            assert.equal(peer.vault.files.size, originalSnapshot.size);
            for (const [path, expectedBytes] of originalSnapshot) {
              assert.deepEqual(peer.vault.files.get(path)?.bytes, expectedBytes,
                `new-key peer restore bytes differ: ${path}`);
            }
            assert.equal(peer.index.remoteCommitSha, prepared.commitSha);

            // Prove that ordinary Sync continues from this re-encrypted orphan
            // root, without editing or merging the independent old-key refs.
            const changedPath = "Notes/hello.md";
            assert.ok(originalSnapshot.has(changedPath));
            const changedContent = bytes("D375 destination-only edit after new-key restore\n");
            peer.vault.set(changedPath, changedContent, 300);
            const pushedNewKey = await peer.session.sync({
              operation: "normal", allowThresholdOverride: false,
              changes: [{ type: "modify", path: changedPath, mtime: 300 }],
            });
            assert.ok(["push", "pull-push"].includes(pushedNewKey.mode));
            const newDestinationHead = peer.index.remoteCommitSha;
            assert.match(newDestinationHead ?? "", /^[0-9a-f]{40}$/u);
            assert.notEqual(newDestinationHead, prepared.commitSha);
            await waitForBranchHead({ ...config, branch: destinationBranch }, newDestinationHead!);
            const nextCommit = await destinationClient.getGitCommit(newDestinationHead!);
            assert.deepEqual(nextCommit.parentShas, [prepared.commitSha],
              "post-migration first Sync must extend the zero-parent orphan, not Source");

            const followerKey = await deriveV4Keyring({
              passphrase: newPassphrase, repoId: destinationRepoId, salt: newSalt,
              iterations: newConfig.kdfParams!.iterations,
            });
            try {
              const follower = createDevice("d375-fresh-follower",
                { ...config, branch: destinationBranch },
                { mode: "encrypted", remoteConfig: newConfig, keyring: followerKey });
              await follower.session.sync({ operation: "forcePull", allowThresholdOverride: false });
              assert.equal(follower.vault.files.size, originalSnapshot.size);
              for (const [path, expectedBytes] of originalSnapshot) {
                assert.deepEqual(follower.vault.files.get(path)?.bytes,
                  path === changedPath ? changedContent : expectedBytes,
                  `third-device post-rekey content mismatch: ${path}`);
              }
              assert.equal(follower.index.remoteCommitSha, newDestinationHead);
            } finally {
              for (const part of [followerKey.masterKey, followerKey.pathKey,
                followerKey.contentKey, followerKey.indexKey, followerKey.journalKey]) part.fill(0);
            }
            assert.equal((await backupClient.getGitRef()).sha, pinnedSha,
              "new-key Sync must not move the old-key Backup");
            assert.equal((await sourceReader.getGitRef()).sha, currentSourceSha,
              "new-key Sync must not move the independently active old-key Source");
            console.log(JSON.stringify({
              stage: "D375_NEW_KEY_POST_MIGRATION_MULTIDEVICE_SYNC",
              freshPeerKeyDerived: true, thirdDeviceKeyDerived: true,
              restoredFileCount: originalSnapshot.size,
              sourceUnchanged: true, backupUnchanged: true,
              descendantOfOrphanRoot: true, destinationCommitAdvanced: true,
              cutoverAuthorized: false,
            }));

            // D376: an un-reconfigured client is still pinned to the old
            // encrypted Source. Its next normal Sync must not route a stale
            // local edit to the new-key Destination or mutate frozen Backup.
            assert.ok(staleOldDevice);
            assert.equal(staleOldDevice.index.remoteCommitSha, pinnedSha,
              "old-key client must remain stale until it explicitly syncs");
            const staleEditPath = "Projects/2026 Q3/[draft] #1.md";
            const staleEdit = bytes("D376 old-key source-only edit from a stale device\n");
            staleOldDevice.vault.set(staleEditPath, staleEdit, 400);
            const oldSync = await staleOldDevice.session.sync({
              operation: "normal", allowThresholdOverride: false,
              changes: [{ type: "modify", path: staleEditPath, mtime: 400 }],
            });
            assert.ok(["push", "pull-push"].includes(oldSync.mode),
              "stale old client must publish only to its original Source ref");
            const oldSourceTip = staleOldDevice.index.remoteCommitSha;
            assert.match(oldSourceTip ?? "", /^[a-f0-9]{40}$/u);
            assert.notEqual(oldSourceTip, currentSourceSha);
            await waitForBranchHead(config, oldSourceTip!);
            const oldCommit = await sourceReader.getGitCommit(oldSourceTip!);
            assert.deepEqual(oldCommit.parentShas, [currentSourceSha],
              "stale Source writer must extend old Source history, not Destination");
            assert.deepEqual(staleOldDevice.vault.files.get(staleEditPath)?.bytes, staleEdit);
            assert.deepEqual(staleOldDevice.vault.files.get("Notes/hello.md")?.bytes,
              bytes("source advanced after frozen backup\n"),
              "stale client must still catch up the old Source's independent edit");
            assert.equal((await destinationClient.getGitRef()).sha, newDestinationHead,
              "an un-reconfigured old-key client changed new-key Destination");
            assert.equal((await backupClient.getGitRef()).sha, pinnedSha,
              "an un-reconfigured old-key client changed frozen Backup");
            assert.equal((await sourceReader.getGitRef()).sha, oldSourceTip);
            console.log(JSON.stringify({
              stage: "D376_STALE_OLD_SOURCE_WRITER_ISOLATED",
              staleStartedFromOriginalCommit: true,
              oldSourceAdvancedOnOwnBranch: true,
              oldSourceParentIsPriorTip: true,
              destinationUnchanged: true,
              backupUnchanged: true,
              autoReconfiguration: false,
              cutoverAuthorized: false,
            }));
          } finally {
            for (const part of [peerKey.masterKey, peerKey.pathKey,
              peerKey.contentKey, peerKey.indexKey, peerKey.journalKey]) part.fill(0);
          }
          await assert.rejects(() => verifyGitHubReencryptionSource({
            github: new GitHubClient({ ...config, branch: destinationBranch }),
            expectedRepoId: destinationRepoId, expectedBranch: destinationBranch,
            passphrase: "v4-real-github-e2e",
          }), /decrypt|passphrase|auth|integrity/i);
          assert.equal((await backupClient.getGitRef()).sha, pinnedSha);
          assert.equal((await sourceReader.getGitRef()).sha, staleOldDevice?.index.remoteCommitSha);
          console.log(JSON.stringify({
            stage: "D374_LIVE_NEW_KEY_DESTINATION_EXACT_COMMIT",
            sourceAdvanced: true, backupFrozen: true,
            destinationHasZeroParents: prepared.rootHasZeroParents,
            verifiedFiles: destinationProof.verifiedFileCount,
            plaintextBytes: destinationProof.totalVerifiedPlaintextBytes,
            secondReaderAuthenticated: true, oldPassphraseRejected: true,
            destinationReaderMutations: independentDestination.transportMetricsSnapshot.mutations - beforeDestination,
            cutoverAuthorized: false,
          }));
        } finally {
          for (const key of [oldKey, newKey]) for (const part of
            [key.masterKey, key.pathKey, key.contentKey, key.indexKey, key.journalKey]) part.fill(0);
          oldSalt.fill(0);
          newSalt.fill(0);
        }
      }
    } finally {
      if (staleOldKey) {
        for (const part of [staleOldKey.masterKey, staleOldKey.pathKey,
          staleOldKey.contentKey, staleOldKey.indexKey, staleOldKey.journalKey]) part.fill(0);
      }
      // Every secondary ref was proven absent twice before child writes.
      // Attempt each cleanup even if another ref becomes uninspectable.
      const cleanupFailures: string[] = [];
      const owned = [
        { name: backupBranch, target: backupTarget, client: backupClient },
        ...(destinationClient
          ? [{ name: destinationBranch, target: destinationTarget, client: destinationClient }]
          : []),
      ];
      for (const entry of owned) {
        try {
          await resetGitHubE2EDisposableBranch(entry.target);
          assert.equal(await entry.client.getGitRefOrNull(), null);
          assert.equal(await entry.client.getGitRefOrNull(), null);
          console.log(JSON.stringify({
            stage: "D374_SECONDARY_BRANCH_CLEANUP_VERIFIED_TWICE", branch: entry.name,
          }));
        } catch (error) {
          cleanupFailures.push(`${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (cleanupFailures.length) {
        throw new Error(`E2E owned branch cleanup not proven: ${cleanupFailures.join("; ")}`);
      }
    }
  });
}
/**
 * D75: publish ONLY a synthetic encrypted orphan root on the guarded disposable
 * E2E branch. The real repository's default/source branch is READ ONLY.
 * This proves GitHub orphan-ref mechanics, not a full data migration or cutover.
 */
async function runOrphanRootBootstrapScenario(config: GitHubConfig): Promise<void> {
  const target = initialTarget;
  const destinationRepoId = repoId(config);
  const sourceRepoId = `${config.owner}/${config.repo}#${target.defaultBranch}`;
  const sourceClient = new GitHubClient({ ...config, branch: target.defaultBranch });
  const writer = new GitHubClient(config);
  const physical = await writer.getRepositoryIdentity();
  assert.equal(physical.id, Number(target.repositoryId));
  const oldHead = await sourceClient.getGitRef();
  assert.equal(oldHead.sha, target.defaultBranchSha);
  assert.equal(await writer.getGitRefOrNull(), null);
  assert.equal(await writer.getGitRefOrNull(), null);

  const plan = planV4OrphanReencryptionDestination({
    sourceRepoId, destinationRepoId,
    sourceCommitSha: oldHead.sha,
    sourcePhysicalRepositoryId: physical.id,
    destinationPhysicalRepositoryId: physical.id,
    expectedPhysicalRepositoryId: physical.id,
    defaultBranch: target.defaultBranch,
  });
  const oldSalt = randomBytes(16);
  const newSalt = randomBytes(16);
  assert.notDeepEqual(oldSalt, newSalt);
  const oldConfig: V4RemoteConfig = {
    formatVersion: V4_FORMAT_VERSION, mode: "encrypted", repoId: sourceRepoId,
    pathLayout: "opaque-stable-v1", algorithm: "AES-GCM", kdf: "PBKDF2-SHA-256",
    kdfParams: { iterations: 600_000, salt: toBase64Url(oldSalt) },
  };
  const newConfig: V4RemoteConfig = {
    ...oldConfig, repoId: destinationRepoId,
    kdfParams: { iterations: 600_000, salt: toBase64Url(newSalt) },
  };
  const keyring = await deriveV4Keyring({
    passphrase: "synthetic-d75-orphan-only",
    repoId: destinationRepoId, salt: newSalt, iterations: 600_000,
  });
  const codec = new V4StorageCodec({ mode: "encrypted", pathLayout: "opaque-stable-v1", keyring });
  const logicalPath = "Orphan/สวัสดี 🌏/note.md";
  const plaintext = bytes("D75 synthetic encrypted orphan root — no old vault migrated");
  const prepared = await codec.prepare(logicalPath, plaintext, "v1", 100, "d75-synthetic-file");
  const record = { ...prepared.record, path: logicalPath };
  const bucket = record.pathId.slice(0, 2);
  const signature = await sha256Hex(bytes(JSON.stringify([record])));
  const head: V4RemoteHead = {
    formatVersion: V4_FORMAT_VERSION, mode: "encrypted", epoch: 1, generation: 1,
    journalId: "d75-synthetic", deviceId: "d75-source", updatedAt: 100,
    shardHashes: { [bucket]: signature },
  };
  const metadata = await buildV4RemoteMetadata({ config: newConfig, head, records: [record], keyring });
  const uploaded = [...prepared.files, ...metadata];
  assert.ok(uploaded.every(file => !file.path.includes("สวัสดี")));
  const entries: Array<{ path: string; mode: "100644"; type: "blob"; sha: string }> = [];
  for (const file of uploaded) {
    entries.push({ path: file.path, mode: "100644", type: "blob",
      sha: await writer.createGitBlob(file.bytes) });
  }
  // No base_tree! Never inherit the source repository tree or old ciphertext.
  const rootTree = await writer.createGitTree(entries);
  const rootCommit = await writer.createGitCommit(
    "d75: synthetic orphan root (not a user re-encryption)",
    rootTree, [], { originalCannotBeReachable: true },
  );
  const remoteRoot = await writer.getGitCommit(rootCommit);
  const oldCommit = await sourceClient.getGitCommit(oldHead.sha);
  assertV4OrphanReencryptionRoot({
    plan, candidateCommit: remoteRoot, sourceTreeSha: oldCommit.treeSha,
    sourceConfigBytes: bytes(JSON.stringify(oldConfig)),
    destinationConfigBytes: bytes(JSON.stringify(newConfig)),
  });
  const finalRepo = await writer.getRepositoryIdentity();
  const finalSource = await sourceClient.getGitRef();
  assertV4OrphanDestinationRefObservations({
    plan, observedSourceCommitShaBefore: oldHead.sha,
    observedSourceCommitShaAfter: finalSource.sha,
    destinationFirstObservation: await writer.getGitRefOrNull(),
    destinationSecondObservation: await writer.getGitRefOrNull(),
    observedPhysicalRepositoryIdBefore: physical.id,
    observedPhysicalRepositoryIdAfter: finalRepo.id,
  });
  // Test-only publication to a random, twice-proven-absent, cleanup-scoped ref.
  await writer.createGitRef(rootCommit);
  await waitForBranchHead(config, rootCommit);

  const secondDevice = new GitHubClient(config);
  const before = secondDevice.transportMetricsSnapshot;
  const verified = await verifyGitHubReencryptionSource({
    github: secondDevice,
    expectedRepoId: destinationRepoId,
    expectedBranch: config.branch,
    passphrase: "synthetic-d75-orphan-only",
  });
  const after = secondDevice.transportMetricsSnapshot;
  assert.equal(verified.pinnedSourceCommitSha, rootCommit);
  assert.equal(verified.verifiedFileCount, 1);
  assert.equal(verified.verifiedRemoteObjectCount, 1);
  assert.equal(verified.totalVerifiedPlaintextBytes, String(plaintext.byteLength));
  assert.equal(after.mutations - before.mutations, 0);

  // D82: the *same disposable encrypted orphan* can be independently
  // reconciled by immutable Git Blob SHA. This audit is read-only, and a
  // matching pending intent is NOT promoted into a confirmed WAL receipt.
  const walFiles = new Map<string, string>();
  const walAdapter: V4LocalIndexAdapter = {
    async read(path) {
      const stored = walFiles.get(path);
      if (stored === undefined) throw new Error("Synthetic D82 WAL entry missing");
      return stored;
    },
    async write(path, value) { walFiles.set(path, value); },
    async exists(path) { return walFiles.has(path); },
    async mkdir(_path) {},
  };
  const wal = createV4ReencryptionRecoveryJournal({
    adapter: walAdapter,
    root: ".obsidian/plugins/e2e-d82/rekey",
    destinationRepoId, sourceCommitSha: oldHead.sha,
    runId: "d82-live-proof", journalKey: randomBytes(32),
  });
  const noteCiphertext = prepared.files.find(file => file.path === record.remotePath);
  assert.ok(noteCiphertext, "Expected a synthetic encrypted V4 note blob");
  const initialWal = await wal.begin();
  await wal.recordUploadIntent({
    path: noteCiphertext.path,
    sha: computeV4GitBlobSha1(noteCiphertext.bytes),
    byteLength: noteCiphertext.bytes.byteLength,
  }, initialWal.generation);
  const beforeBlobAudit = secondDevice.transportMetricsSnapshot.mutations;
  const audited = await verifyStagedV4ReencryptionGitBlobs({
    plan, journal: wal, github: secondDevice,
  });
  assert.equal(audited.status, "verified");
  assert.equal(audited.verifiedObjectCount, 1);
  assert.equal(audited.pendingIntentCount, 1);
  assert.equal(audited.permissionToPublish, false);
  assert.equal(audited.destinationContentVerified, false);
  assert.equal((await wal.load())!.pendingIntents.length, 1);
  assert.equal(secondDevice.transportMetricsSnapshot.mutations - beforeBlobAudit, 0);

  // D83: independently validate the *entire committed destination tree*,
  // authenticated V4 head/index and all encrypted plaintext at EXACT root SHA.
  // This does not authorize publication or a device cutover.
  const beforeExactAudit = secondDevice.transportMetricsSnapshot.mutations;
  const complete = await verifyV4ReencryptionDestinationExactCommit({
    github: secondDevice, plan, destinationCommitSha: rootCommit,
    sourceTreeSha: oldCommit.treeSha,
    sourceConfig: oldConfig, expectedDestinationConfig: newConfig,
    expectedRecords: [record],
    expectedReceipts: prepared.files.map(file => ({
      path: file.path, sha: computeV4GitBlobSha1(file.bytes),
      byteLength: file.bytes.byteLength,
    })),
    destinationPassphrase: "synthetic-d75-orphan-only",
  });
  assert.equal(complete.verifiedFileCount, 1);
  assert.equal(complete.verifiedRemoteObjectCount, prepared.files.length);
  assert.equal(complete.totalVerifiedPlaintextBytes, String(plaintext.byteLength));
  assert.equal(complete.permissionToPublish, false);
  assert.equal(complete.cutoverAuthorized, false);
  assert.equal(complete.backupVerified, false);
  assert.equal(complete.secondDeviceRestored, false);
  assert.equal(secondDevice.transportMetricsSnapshot.mutations - beforeExactAudit, 0);

  // D97 real GitHub evidence: simulate a lost create-ref HTTP response by
  // discarding that response, then independently re-observing and decrypting
  // the exact synthetic orphan from the disposable branch. READ ONLY.
  // This test-only candidate descriptor refers to a root created above;
  // it is not evidence of a production backup or durable migration intent.
  const beforeRecoveryMutations = secondDevice.transportMetricsSnapshot.mutations;
  const recovered = await inspectV4ReencryptionOrphanAfterAmbiguousPublication({
    github: secondDevice, plan,
    prepared: {
      integrityScope: "unreferenced-encrypted-orphan-commit",
      destinationRepoId, pinnedSourceCommitSha: oldHead.sha,
      physicalRepositoryId: physical.id,
      sourceTreeSha: oldCommit.treeSha, treeSha: rootTree, commitSha: rootCommit,
      verifiedFileCount: 1, stagedCiphertextObjectCount: prepared.files.length,
      encryptedMetadataObjectCount: metadata.length,
      deviceId: "d97-disposable-device",
      journalId: "d97-disposable-journal",
      createdAt: Date.now(),
      sourceAndBackupPreserved: true, rootHasZeroParents: true,
      backupProvenanceVerified: false, installedRestoreVerified: false,
      refPublished: false, cutoverAuthorized: false,
    },
    sourceTreeSha: oldCommit.treeSha,
    sourceConfig: oldConfig,
    expectedDestinationConfig: newConfig,
    expectedRecords: [record],
    expectedReceipts: prepared.files.map(file => ({
      path: file.path, sha: computeV4GitBlobSha1(file.bytes),
      byteLength: file.bytes.byteLength,
    })),
    destinationPassphrase: "synthetic-d75-orphan-only",
  });
  assert.equal(recovered.outcome, "destination-pinned-and-fully-verified");
  assert.equal(recovered.destinationContentsVerified, true);
  assert.equal(recovered.verifiedFileCount, 1);
  assert.equal(recovered.verifiedPlaintextBytes, String(plaintext.byteLength));
  assert.equal(recovered.automaticallyRetryCreateAuthorized, false);
  assert.equal(recovered.localCutoverAuthorized, false);
  assert.equal(secondDevice.transportMetricsSnapshot.mutations - beforeRecoveryMutations, 0);

  assert.deepEqual((await secondDevice.getGitCommit(rootCommit)).parentShas, []);
  assert.equal((await sourceClient.getGitRef()).sha, oldHead.sha,
    "orphan fixture must never modify default/source branch");
  console.log(JSON.stringify({
    stage: "D75_ORPHAN_ROOT_LIVE_VERIFIED",
    destinationBranch: config.branch,
    orphanCommit: rootCommit, parentCount: remoteRoot.parentShas.length,
    exactCommitVerifiedFiles: verified.verifiedFileCount,
    secondReaderMutations: after.mutations - before.mutations,
    sourceUnchanged: true,
  }));
}

async function runBaselineScenario(config: GitHubConfig, mode: V4StorageMode): Promise<void> {
  await runScenario(config, mode, "baseline-edge-path-roundtrip", async ({ context, device }) => {
    const source = device("device-a");
    seedBaseline(source.vault, mode);
    const pushed = await source.session.sync({ operation: "forcePush", allowThresholdOverride: false });
    assert.equal(pushed.mode, "force-push");
    await waitForBranchHead(config, source.index.remoteCommitSha!);

    if (mode === "encrypted") {
      const beforeRename = recordFor(source, "Notes/hello.md");
      const renamed = source.vault.files.get("Notes/hello.md")!;
      source.vault.files.delete("Notes/hello.md");
      source.vault.set("Notes/hello-renamed.md", renamed.bytes, 8);
      await source.session.sync({
        operation: "normal",
        allowThresholdOverride: false,
        changes: [{ type: "rename", oldPath: "Notes/hello.md", path: "Notes/hello-renamed.md", mtime: 8 }],
      });
      const afterRename = recordFor(source, "Notes/hello-renamed.md");
      assert.equal(afterRename.fileId, beforeRename.fileId);
      assert.equal(afterRename.remotePath, beforeRename.remotePath);
    }

    assert.equal((await source.session.sync({ operation: "normal", allowThresholdOverride: false })).mode, "noop");
    const publishedCommitSha = source.index.remoteCommitSha!;
    const history = new V4HistoryService({ github: source.client, config: context.remoteConfig, keyring: context.keyring });
    const historyPage = await history.listCommits();
    const publishedHistoryCommit = historyPage.items.find(item => item.sha === publishedCommitSha && item.source === "plugin");
    assert.ok(publishedHistoryCommit?.journalId);
    const historyChanges = await history.getCommitChanges(publishedHistoryCommit);
    assert.equal(historyChanges.some(change => change.path === (mode === "encrypted" ? "Notes/hello-renamed.md" : "Notes/hello.md")), true);

    const commit = await source.client.getGitCommit(publishedCommitSha);
    const tree = await source.client.getTreeAt(commit.treeSha, true);
    if (mode === "plaintext") {
      for (const path of source.vault.files.keys()) {
        assert.equal(tree.tree.some(node => node.path === path), true, `plaintext tree missing ${path}`);
      }
    } else {
      const logicalPaths = new Set(source.vault.files.keys());
      assert.equal(tree.tree.some(node => logicalPaths.has(node.path)), false, "encrypted tree leaked a logical path");
      assert.equal(tree.tree.some(node => /^\.obsidian-github-sync-v4\/data\/[0-9a-f]{2}\/[0-9a-f]{64}\.enc$/u.test(node.path)), true);
      for (const segment of ["Notes", "Assets", "hello", "pixel", "mañana", "draft", "workspace", "md", "bin"]) {
        assert.equal(tree.tree.some(node => node.path.includes(segment)), false, `encrypted tree leaked logical segment: ${segment}`);
      }

      const headPath = ".obsidian-github-sync-v4/head";
      const headNode = tree.tree.find(node => node.path === headPath);
      assert.ok(headNode, "Encrypted V4 head is missing from the published commit tree.");
      const [headByPath, headByBlob] = await Promise.all([
        source.client.getFileBytes(headPath, publishedCommitSha),
        source.client.getBlob(headNode.sha),
      ]);
      assert.ok(headByPath, "Encrypted V4 head is missing from the Contents API.");
      assert.deepEqual(headByPath.bytes, headByBlob, "Encrypted V4 head Contents/Git Blob mismatch.");
      assert.deepEqual([...headByBlob.subarray(0, 4)], [0x4f, 0x47, 0x53, 0x34]);
      await verifyEncryptedObjectTransport(source, context);
    }

    const target = device("device-c");
    target.vault.set("remove-me.md", bytes("old"), 1);
    const pulled = await target.session.sync({ operation: "forcePull", allowThresholdOverride: false });
    assert.equal(pulled.mode, "force-pull");
    assertVaultEquals(target.vault, source.vault, `${mode} baseline force pull`);

    if (mode === "encrypted") {
      for (const sourceRecord of liveRecords(source)) {
        const targetRecord = recordFor(target, sourceRecord.path);
        assert.equal(targetRecord.fileId, sourceRecord.fileId);
        assert.equal(targetRecord.remotePath, sourceRecord.remotePath);
      }
    }
  });
}

async function runStaleCatchupScenario(config: GitHubConfig, mode: V4StorageMode): Promise<void> {
  await runScenario(config, mode, "two-device-stale-catchup-and-disjoint-push", async ({ device }) => {
    const a = device("device-a");
    a.vault.set("shared.md", bytes("shared-base\n"), 1);
    a.vault.set("A-only.md", bytes("a-v1\n"), 2);
    a.vault.set("Assets/shared.bin", deterministicBinary(4096, 11), 3);
    await a.session.sync({ operation: "forcePush", allowThresholdOverride: false });

    const b = device("device-b");
    await b.session.sync({ operation: "forcePull", allowThresholdOverride: false });
    b.vault.set("B-local.md", bytes("created on stale device b\n"), 10);

    a.vault.set("A-only.md", bytes("a-v2\n"), 11);
    a.vault.set("nested/new-from-a.md", bytes("new from a\n"), 12);
    await a.session.sync({
      operation: "normal",
      allowThresholdOverride: false,
      changes: [
        { type: "modify", path: "A-only.md", mtime: 11 },
        { type: "modify", path: "nested/new-from-a.md", mtime: 12 },
      ],
    });

    const caughtUp = await b.session.sync({
      operation: "normal",
      allowThresholdOverride: false,
      changes: [{ type: "modify", path: "B-local.md", mtime: 10 }],
    });
    assert.equal(["pull-push", "push"].includes(caughtUp.mode), true);
    assert.deepEqual(b.vault.files.get("A-only.md")?.bytes, bytes("a-v2\n"));
    assert.deepEqual(b.vault.files.get("nested/new-from-a.md")?.bytes, bytes("new from a\n"));
    assert.deepEqual(b.vault.files.get("B-local.md")?.bytes, bytes("created on stale device b\n"));
    assertNoConflictCopies(b.vault, "disjoint stale catch-up created a conflict copy");

    // A newly published GraphQL CAS can precede REST ref visibility. Prove
    // that the expected commit is observable before checking a fresh reader;
    // otherwise this assertion confounds an old HEAD read with lost data.
    assert.ok(b.index.remoteCommitSha, "stale device did not record a published remote commit");
    await waitForBranchHead(config, b.index.remoteCommitSha);
    const c = device("device-c");
    await c.session.sync({ operation: "forcePull", allowThresholdOverride: false });
    assertVaultEquals(c.vault, b.vault, "fresh device after disjoint stale catch-up");
  });
}

async function runCopyConflictScenario(config: GitHubConfig, mode: V4StorageMode): Promise<void> {
  await runScenario(config, mode, "two-device-same-file-copy-conflict", async ({ context, device }) => {
    const a = device("device-a");
    a.vault.set("shared.md", bytes("base\n"), 1);
    await a.session.sync({ operation: "forcePush", allowThresholdOverride: false });

    const fixedNow = 424242;
    const b = device("device-b", () => fixedNow);
    await b.session.sync({ operation: "forcePull", allowThresholdOverride: false });

    a.vault.set("shared.md", bytes("from-a\n"), 2);
    await a.session.sync({
      operation: "normal",
      allowThresholdOverride: false,
      changes: [{ type: "modify", path: "shared.md", mtime: 2 }],
    });

    b.vault.set("shared.md", bytes("from-b\n"), 3);
    await b.session.sync({
      operation: "normal",
      allowThresholdOverride: false,
      changes: [{ type: "modify", path: "shared.md", mtime: 3 }],
    });

    const conflictPath = `shared.conflict-remote-device-b-${fixedNow}.md`;
    assert.deepEqual(b.vault.files.get("shared.md")?.bytes, bytes("from-b\n"));
    assert.deepEqual(b.vault.files.get(conflictPath)?.bytes, bytes("from-a\n"));
    assert.equal([...b.vault.files.keys()].filter(path => path.includes(".conflict-remote-")).length, 1);

    const c = device("device-c");
    await c.session.sync({ operation: "forcePull", allowThresholdOverride: false });
    assert.deepEqual(c.vault.files.get("shared.md")?.bytes, bytes("from-b\n"));
    assert.deepEqual(c.vault.files.get(conflictPath)?.bytes, bytes("from-a\n"));
    await verifyEncryptedObjectTransport(c, context);
  });
}

async function runRenameVsEditScenario(config: GitHubConfig, mode: V4StorageMode): Promise<void> {
  await runScenario(config, mode, "two-device-rename-vs-stale-edit", async ({ device }) => {
    const a = device("device-a");
    const base = bytes("rename-base\n");
    const staleEdit = bytes("edited-on-stale-device-b\n");
    a.vault.set("Notes/rename-me.md", base, 1);
    await a.session.sync({ operation: "forcePush", allowThresholdOverride: false });

    const b = device("device-b", () => 515151);
    await b.session.sync({ operation: "forcePull", allowThresholdOverride: false });
    const oldRecord = recordFor(a, "Notes/rename-me.md");

    a.vault.files.delete("Notes/rename-me.md");
    a.vault.set("Notes/renamed.md", base, 2);
    await a.session.sync({
      operation: "normal",
      allowThresholdOverride: false,
      changes: [{ type: "rename", oldPath: "Notes/rename-me.md", path: "Notes/renamed.md", mtime: 2 }],
    });
    const renamedRecord = recordFor(a, "Notes/renamed.md");
    assert.equal(renamedRecord.fileId, oldRecord.fileId);
    if (mode === "encrypted") assert.equal(renamedRecord.remotePath, oldRecord.remotePath);

    b.vault.set("Notes/rename-me.md", staleEdit, 3);
    await b.session.sync({
      operation: "normal",
      allowThresholdOverride: false,
      changes: [{ type: "modify", path: "Notes/rename-me.md", mtime: 3 }],
    });

    // GraphQL CAS may succeed before REST refs expose the newly published head.
    // A fresh reader must see b's exact SHA before we can call absent bytes data
    // loss. Waiting is test synchronization, not a runtime retry workaround.
    const expectedCommitSha = b.index.remoteCommitSha;
    assert.ok(expectedCommitSha, "stale rename/edit device did not record the final remote commit");
    await waitForBranchHead(config, expectedCommitSha);

    const c = device("device-c");
    await c.session.sync({ operation: "forcePull", allowThresholdOverride: false });
    assert.equal(c.index.remoteCommitSha, expectedCommitSha, "fresh reader did not load the published SHA");
    assertVaultContainsBytes(c.vault, base, "rename lineage bytes were lost");
    assertVaultContainsBytes(c.vault, staleEdit, "stale edited lineage bytes were lost");
    for (const record of liveRecords(c)) {
      assert.ok(c.vault.files.has(record.path), `fresh pull missing record path ${record.path}`);
    }
  });
}

async function runDeleteRecreateScenario(config: GitHubConfig, mode: V4StorageMode, controlledMissing = false): Promise<void> {
  await runScenario(config, mode, "two-device-delete-recreate-identity-break", async ({ context, device }) => {
    const a = device("device-a");
    a.vault.set("Notes/reborn.md", bytes("generation-one\n"), 1);
    await a.session.sync({ operation: "forcePush", allowThresholdOverride: false });

    const b = device("device-b");
    await b.session.sync({ operation: "forcePull", allowThresholdOverride: false });
    const oldFileId = recordFor(a, "Notes/reborn.md").fileId;

    a.vault.files.delete("Notes/reborn.md");
    await a.session.sync({
      operation: "normal",
      allowThresholdOverride: false,
      changes: [{ type: "delete", path: "Notes/reborn.md", mtime: 2 }],
    });

    a.vault.set("Notes/reborn.md", bytes("generation-two\n"), 3);
    await a.session.sync({
      operation: "normal",
      allowThresholdOverride: false,
      changes: [{ type: "modify", path: "Notes/reborn.md", mtime: 3 }],
    });
    const newRecord = recordFor(a, "Notes/reborn.md");
    assert.notEqual(newRecord.fileId, oldFileId, "delete/recreate reused the old file identity");
    // GraphQL CAS may be visible before the REST branch ref read catches up.
    // Verify the exact new published commit and its immutable object before
    // asking another device to sync; keep a publication defect distinguishable
    // from a peer reading a stale ref.
    const publishedSha = a.index.remoteCommitSha!;
    await waitForBranchHead(config, publishedSha);
    const publishedCommit = await a.client.getGitCommit(publishedSha);
    const publishedTree = await a.client.getTreeAt(publishedCommit.treeSha, true);
    assert.equal(publishedTree.truncated, false, "delete/recreate commit tree is truncated");
    assert.ok(publishedTree.tree.some(entry => entry.path === newRecord.remotePath && entry.type === "blob"),
      `delete/recreate published head ${publishedSha} is missing object ${newRecord.remotePath}`);
    const codec = new V4StorageCodec({
      mode,
      pathLayout: expectedV4PathLayout(mode),
      keyring: context.keyring,
    });
    const publishedPlaintext = await codec.read(newRecord, async objectPath => {
      const object = await a.client.getFileBytes(objectPath, publishedSha);
      assert.ok(object, `delete/recreate missing immutable object ${objectPath}`);
      return object.bytes;
    });
    assert.deepEqual(publishedPlaintext, bytes("generation-two\n"),
      "delete/recreate decoded published object disagrees with local new generation");

    if (controlledMissing) {
      assert.equal(mode, "plaintext", "controlled fault must use the synthetic plaintext scenario");
      const beforeBytes = b.vault.files.get("Notes/reborn.md")?.bytes.slice();
      assert.ok(beforeBytes, "peer must have the original generation before fault injection");
      const beforeHead = b.index.remoteCommitSha;
      const beforeMutations = b.client.transportMetricsSnapshot.mutations;
      const fault: ControlledMissingObjectFault = { expectedCommit: publishedSha, fired: false };
      // Production runtime ALWAYS supplies a recovery store and a staging
      // backend. The ordinary E2E MemoryVault does not, and its trash()
      // simply deletes from a Map. Exercise the production-like pre-stage
      // barrier rather than mislabeling the no-WAL mock as production data loss.
      let stageBegins = 0;
      let stageAborts = 0;
      b.vault.staging = {
        async beginStage() {
          stageBegins++;
          return {
            async append() { throw new Error("Unexpected staged content before controlled missing read"); },
            async finish() { throw new Error("Unexpected successful stage on controlled missing read"); },
            async abort() { stageAborts++; },
          };
        },
        async stageSource() { throw new Error("Unexpected push stage in pull-only diagnostic"); },
        async open() { throw new Error("Unexpected completed stage in failing diagnostic"); },
        async remove() {},
        pathFor: stageId => `diagnostic-stage/${stageId}.bin`,
      };
      diagnosticRecoveryStores.set(b.client, {
        async load() { return null; },
        async save() { throw new Error("WAL mutation attempted before all remote content was staged"); },
      });
      missingObjectFaults.set(b.client, fault);
      try {
        await assert.rejects(
          () => b.session.sync({ operation: "normal", allowThresholdOverride: false }),
          (error: unknown) => error instanceof V4RemoteObjectMissingError
            && error.remoteCommitSha === publishedSha
            && error.remotePath === "Notes/reborn.md"
            && error.fileId === newRecord.fileId,
          "a controlled missing read must remain a typed, fail-closed Sync error",
        );
        assert.equal(fault.fired, true, "fault did not intercept the exact immutable peer read");
        assert.equal(stageBegins, 1, "WAL staging must start before any local trash");
        assert.equal(stageAborts, 1, "failed WAL download must abort its incomplete stage");
        assert.equal(fault.evidenceOutcome, "blob-present-in-tree",
          "independent read-only immutable Git evidence did not see the published blob");
        assert.deepEqual(b.vault.files.get("Notes/reborn.md")?.bytes, beforeBytes,
          "failed pull altered the peer's original user note");
        assert.equal(b.index.remoteCommitSha, beforeHead,
          "failed pull advanced the peer's persisted remote base");
        assert.equal(b.client.transportMetricsSnapshot.mutations, beforeMutations,
          "failed pull unexpectedly mutated GitHub");
        console.log(JSON.stringify({
          kind: "synthetic-missing-object-fail-closed-proof",
          injected: fault.fired,
          independentTreeOutcome: fault.evidenceOutcome,
          originalBytesRetained: true,
          recoveryStagingAborted: true,
          localBaseUnchanged: true,
          peerRemoteMutations: 0,
          originalErrorPreserved: true,
        }));
      } finally {
        missingObjectFaults.delete(b.client);
        diagnosticRecoveryStores.delete(b.client);
        delete b.vault.staging;
      }
      return;
    }

    await b.session.sync({ operation: "normal", allowThresholdOverride: false });
    assert.deepEqual(b.vault.files.get("Notes/reborn.md")?.bytes, bytes("generation-two\n"));
    assert.equal(recordFor(b, "Notes/reborn.md").fileId, newRecord.fileId);
  });
}

async function runBinaryOverwriteScenario(config: GitHubConfig, mode: V4StorageMode): Promise<void> {
  await runScenario(config, mode, "two-device-binary-overwrite", async ({ context, device }) => {
    const revisionOne = deterministicBinary(256 * 1024, 0x1010);
    const revisionTwo = deterministicBinary(256 * 1024, 0x2020);
    const a = device("device-a");
    a.vault.set("Assets/shared.bin", revisionOne, 1);
    await a.session.sync({ operation: "forcePush", allowThresholdOverride: false });

    const b = device("device-b");
    await b.session.sync({ operation: "forcePull", allowThresholdOverride: false });
    b.vault.set("Assets/shared.bin", revisionTwo, 2);
    await b.session.sync({
      operation: "normal",
      allowThresholdOverride: false,
      changes: [{ type: "modify", path: "Assets/shared.bin", mtime: 2 }],
    });

    await a.session.sync({ operation: "normal", allowThresholdOverride: false });
    assert.deepEqual(a.vault.files.get("Assets/shared.bin")?.bytes, revisionTwo);
    await verifyEncryptedObjectTransport(a, context, "Assets/shared.bin");
  });
}

async function runControlledRaceScenario(config: GitHubConfig): Promise<void> {
  await runScenario(config, "plaintext", "controlled-external-branch-head-race", async ({ device }) => {
    const a = device("device-a");
    a.vault.set("race.md", bytes("base\n"), 1);
    await a.session.sync({ operation: "forcePush", allowThresholdOverride: false });

    a.vault.set("race.md", bytes("plugin-after-race\n"), 2);
    armInterference("controlled-race");
    let publishError: unknown;
    try {
      await a.rawSession.sync({
        operation: "normal",
        allowThresholdOverride: false,
        changes: [{ type: "modify", path: "race.md", mtime: 2 }],
      });
    } catch (error) {
      publishError = error;
    }
    interference.armed = false;

    assert.equal(interference.fired, true, "controlled branch-head interference hook did not fire");
    const externalCommitSha = interference.externalCommitSha;
    assert.ok(externalCommitSha, "controlled branch-head interference did not create an external commit");
    assert.ok(publishError, "plugin publish unexpectedly succeeded over an externally advanced branch");
    assert.equal(isV4PublicationRaceError(publishError), true, "controlled publication race was not classified as V4PublicationRaceError");

    const afterRaceHistory = await a.client.listCommits({ perPage: 100 });
    assert.equal(afterRaceHistory.some(commit => commit.sha === externalCommitSha), true, "external commit is not reachable after rejected plugin publish");

    const rerun = await a.session.sync({
      operation: "normal",
      allowThresholdOverride: false,
      changes: [{ type: "modify", path: "race.md", mtime: 2 }],
    });
    assert.equal(["push", "pull-push", "noop"].includes(rerun.mode), true);
    assert.deepEqual(a.vault.files.get("race.md")?.bytes, bytes("plugin-after-race\n"));

    const finalHistory = await a.client.listCommits({ perPage: 100 });
    assert.equal(finalHistory.some(commit => commit.sha === externalCommitSha), true, "external commit disappeared after replan");

    const c = device("device-c");
    await c.session.sync({ operation: "forcePull", allowThresholdOverride: false });
    assert.deepEqual(c.vault.files.get("race.md")?.bytes, bytes("plugin-after-race\n"));
  });
}

const targetEnvironment = readGitHubE2ETargetEnvironment();
const initialTarget = await resolveGitHubE2ETarget(targetEnvironment);
const config = initialTarget.config;
installRequestUrlBridge(config);

after(async () => {
  try {
    await resetGitHubE2EDisposableBranch(targetEnvironment);
    console.log(`GitHub E2E branch cleanup verified: ${config.branch}`);
  } finally {
    setRequestUrlHandler(null);
  }
});

test("V4 real GitHub strict CAS survives realistic superuser and two-device scenarios", { timeout: 900_000 }, async () => {
  if (process.env["GITHUB_E2E_ONLY_SCENARIO"] === "wal-recover-process-loss"
    || process.env["GITHUB_E2E_ONLY_SCENARIO"] === "wal-recover-process-loss-negative") {
    await d385RecoverPublishedDestinationInNewProcess(config,
      process.env["GITHUB_E2E_ONLY_SCENARIO"] === "wal-recover-process-loss-negative");
    return;
  }
  if (process.env["GITHUB_E2E_ONLY_SCENARIO"] === "orphan-root-encrypted") {
    await runOrphanRootBootstrapScenario(config);
    return;
  }
  if (process.env["GITHUB_E2E_ONLY_SCENARIO"] === "readonly-rekey-encrypted") {
    await runReencryptionReadOnlyScenario(config);
    return;
  }
  if (process.env["GITHUB_E2E_ONLY_SCENARIO"] === "installed-source-parity-encrypted"
    || process.env["GITHUB_E2E_ONLY_SCENARIO"] === "installed-source-backup-handoff-encrypted") {
    await runInstalledAuthenticatedSourceParityScenario(config);
    return;
  }
  if (process.env["GITHUB_E2E_ONLY_SCENARIO"] === "frozen-backup-encrypted"
    || process.env["GITHUB_E2E_ONLY_SCENARIO"] === "wal-backup-encrypted"
    || process.env["GITHUB_E2E_ONLY_SCENARIO"] === "wal-backup-ambiguous"
    || process.env["GITHUB_E2E_ONLY_SCENARIO"] === "wal-stage-encrypted"
    || process.env["GITHUB_E2E_ONLY_SCENARIO"] === "wal-candidate-encrypted"
    || process.env["GITHUB_E2E_ONLY_SCENARIO"] === "wal-scratch-encrypted"
    || process.env["GITHUB_E2E_ONLY_SCENARIO"] === "wal-publish-encrypted"
    || process.env["GITHUB_E2E_ONLY_SCENARIO"] === "wal-publish-lost-response"
    || process.env["GITHUB_E2E_ONLY_SCENARIO"] === "wal-publish-process-loss"
    || process.env["GITHUB_E2E_ONLY_SCENARIO"] === "wal-publish-process-loss-negative") {
    await runFrozenBackupReadbackScenario(config);
    return;
  }
  if (process.env["GITHUB_E2E_ONLY_SCENARIO"] === "newkey-destination-encrypted") {
    await runFrozenBackupReadbackScenario(config, true);
    return;
  }
  if (process.env["GITHUB_E2E_ONLY_SCENARIO"] === "delete-recreate-plaintext"
    || process.env["GITHUB_E2E_ONLY_SCENARIO"] === "delete-recreate-encrypted"
    || process.env["GITHUB_E2E_ONLY_SCENARIO"] === "diagnostic-missing-plaintext") {
    await runDeleteRecreateScenario(config, process.env["GITHUB_E2E_ONLY_SCENARIO"] === "delete-recreate-encrypted" ? "encrypted" : "plaintext", process.env["GITHUB_E2E_ONLY_SCENARIO"] === "diagnostic-missing-plaintext");
    return;
  }
  if (process.env["GITHUB_E2E_ONLY_SCENARIO"] === "rename-vs-stale-edit-plaintext"
    || process.env["GITHUB_E2E_ONLY_SCENARIO"] === "rename-vs-stale-edit-encrypted") {
    await runRenameVsEditScenario(config, process.env["GITHUB_E2E_ONLY_SCENARIO"] === "rename-vs-stale-edit-encrypted" ? "encrypted" : "plaintext");
    return;
  }
  if (process.env["GITHUB_E2E_ONLY_SCENARIO"]) throw new Error("Unknown manual GitHub E2E scenario filter.");
  for (const mode of ["plaintext", "encrypted"] as const) {
    await runBaselineScenario(config, mode);
    await runStaleCatchupScenario(config, mode);
    await runCopyConflictScenario(config, mode);
    await runRenameVsEditScenario(config, mode);
    await runDeleteRecreateScenario(config, mode);
    await runBinaryOverwriteScenario(config, mode);
  }
  await runControlledRaceScenario(config);
  // Permanent manual full-suite coverage for the read-only rekey source gate.
  // Each runScenario resets only the independently approved disposable branch.
  await runReencryptionReadOnlyScenario(config);
  await runFrozenBackupReadbackScenario(config);
  await runFrozenBackupReadbackScenario(config, true);
  // The read-only source scenario publishes an encrypted source branch.
  // The orphan-root scenario needs a fresh, twice-verified absent ref.
  // Reset only this independently preflighted disposable E2E branch.
  await resetGitHubE2EDisposableBranch(targetEnvironment);
  await runOrphanRootBootstrapScenario(config);
});
