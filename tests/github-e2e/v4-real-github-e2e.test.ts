import assert from "node:assert/strict";
import test, { after } from "node:test";
import { setRequestUrlHandler } from "obsidian";

import { GitHubClient, type GitHubConfig } from "../../src/lib/github-api";
import { randomBytes, sha256Hex, toBase64, toBase64Url } from "../../src/lib/bytes";
import { deriveV4Keyring, type V4Keyring } from "../../src/lib/v4/crypto";
import { V4HistoryService } from "../../src/lib/v4/history-service";
import { verifyGitHubReencryptionSource } from "../../src/lib/v4/reencryption-trusted-loader";
import {
  planV4OrphanReencryptionDestination,
  assertV4OrphanDestinationRefObservations,
  assertV4OrphanReencryptionRoot,
} from "../../src/lib/v4/reencryption-orphan-branch";
import { buildV4RemoteMetadata } from "../../src/lib/v4/remote-index";
import { createEmptyV4LocalIndex, type V4LocalIndex } from "../../src/lib/v4/local-index";
import { isV4PublicationRaceError } from "../../src/lib/v4/publication-race";
import { expectedV4PathLayout, V4_FORMAT_VERSION, type V4RemoteConfig, type V4RemoteHead, type V4StorageMode } from "../../src/lib/v4/protocol-types";
import { V4StorageCodec } from "../../src/lib/v4/storage-codec";
import { V4RemoteObjectMissingError, V4SyncSession, type V4SessionVault, type V4SyncRunState } from "../../src/lib/v4/sync-session";
import type { V4RecoveryStore } from "../../src/lib/v4/recovery-store";
import type { V4StagingStore } from "../../src/lib/v4/staging-store";
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
      headers: request.headers,
      body: request.body,
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
  interference.marker = undefined;
  interference.externalCommitSha = undefined;
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
  return { mode, remoteConfig, keyring };
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
    keyring: context.keyring,
    conflictPolicy: "copy" as const,
    abortChangePercent: 0,
    now,
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
                return { status: response.status, sha: body.object?.sha };
              },
              readExpectedCommit: async sha => {
                const response = await githubRequest(config, `/git/commits/${sha}`);
                if (response.status !== 200) return { status: response.status };
                const body = await response.json() as { sha?: string; tree?: { sha?: string } };
                return { status: response.status, sha: body.sha, treeSha: body.tree?.sha };
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
    const [byPath, byBlob] = await Promise.all([
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
  if (process.env.GITHUB_E2E_ONLY_SCENARIO === "orphan-root-encrypted") {
    await runOrphanRootBootstrapScenario(config);
    return;
  }
  if (process.env.GITHUB_E2E_ONLY_SCENARIO === "readonly-rekey-encrypted") {
    await runReencryptionReadOnlyScenario(config);
    return;
  }
  if (process.env.GITHUB_E2E_ONLY_SCENARIO === "delete-recreate-plaintext"
    || process.env.GITHUB_E2E_ONLY_SCENARIO === "delete-recreate-encrypted"
    || process.env.GITHUB_E2E_ONLY_SCENARIO === "diagnostic-missing-plaintext") {
    await runDeleteRecreateScenario(config, process.env.GITHUB_E2E_ONLY_SCENARIO === "delete-recreate-encrypted" ? "encrypted" : "plaintext", process.env.GITHUB_E2E_ONLY_SCENARIO === "diagnostic-missing-plaintext");
    return;
  }
  if (process.env.GITHUB_E2E_ONLY_SCENARIO === "rename-vs-stale-edit-plaintext"
    || process.env.GITHUB_E2E_ONLY_SCENARIO === "rename-vs-stale-edit-encrypted") {
    await runRenameVsEditScenario(config, process.env.GITHUB_E2E_ONLY_SCENARIO === "rename-vs-stale-edit-encrypted" ? "encrypted" : "plaintext");
    return;
  }
  if (process.env.GITHUB_E2E_ONLY_SCENARIO) throw new Error("Unknown manual GitHub E2E scenario filter.");
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
  await runOrphanRootBootstrapScenario(config);
});
