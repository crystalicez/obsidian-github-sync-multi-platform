import { requestUrl, type RequestUrlParam, type RequestUrlResponse } from "obsidian";
import { fromBase64, toBase64, toHex, utf8ToBytes } from "./bytes";
import type { GitHubCreateTreeEntry, GitHubGitCommit, GitHubGitRef } from "./github-git-types";
import {
  canRetryV4MutationAfterUnknownOutcome,
  classifyV4MutationFailure,
  V4GitMutationOutcomeUnknownError,
  type V4MutationRetryClass,
  type V4MutationRetryEvidence,
} from "./v4/git-mutation-policy";
import {
  createV4ResourceController,
  DEFAULT_V4_RESOURCE_LIMITS,
  estimateV4GitBlobTransportBytes,
  estimateV4JsonValueTransportBytes,
  type V4ResourceController,
} from "./v4/resource-controller";
import { V4RequestScheduler } from "./v4/request-scheduler";
import { V4TransportMetrics, type V4TransportMetricsSnapshot } from "./v4/transport-metrics";
import { resolveV4TransportPolicy, type V4TransportPolicy } from "./v4/transport-policy";

const V4_BOOTSTRAP_PATH = ".obsidian-github-sync-v4/bootstrap";
const GIT_COMMIT_SHA = /^[0-9a-f]{40}$/iu;

export interface GitHubConfig {
  owner: string;
  repo: string;
  branch: string;
  token: string;
}

export interface GitHubClientOptions {
  transportPolicy?: Partial<V4TransportPolicy>;
  transportMetrics?: V4TransportMetrics;
  transportResources?: Pick<V4ResourceController, "withTransportBytes">;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}

export interface GitHubTreeNode {
  path: string;
  mode: string;
  type: "blob" | "tree";
  sha: string;
  size?: number;
  url: string;
}

export interface GitHubTree {
  sha: string;
  url: string;
  tree: GitHubTreeNode[];
  truncated: boolean;
}

export interface GitHubCommitSummary {
  sha: string;
  message: string;
  authorName: string;
  authoredAt: string;
  parentShas: string[];
}

interface MutationRequestInput {
  options: Omit<RequestUrlParam, "body">;
  bodyValue: unknown;
  retryClass: V4MutationRetryClass;
  retryEvidence?: V4MutationRetryEvidence;
  successStatuses: readonly number[];
  transientBytes?: number;
  reservationAlreadyHeld?: boolean;
  action: string;
}

export class GitHubClient {
  private config: GitHubConfig;
  private readonly requestScheduler: V4RequestScheduler;
  private readonly transportPolicy: V4TransportPolicy;
  private readonly transportMetrics: V4TransportMetrics;
  private readonly transportResources: Pick<V4ResourceController, "withTransportBytes">;
  private operationSignal?: AbortSignal;

  constructor(config: GitHubConfig, options: GitHubClientOptions = {}) {
    this.config = config;
    this.transportPolicy = resolveV4TransportPolicy(options.transportPolicy);
    this.transportMetrics = options.transportMetrics ?? new V4TransportMetrics();
    this.transportResources = options.transportResources ?? createV4ResourceController(DEFAULT_V4_RESOURCE_LIMITS);
    this.requestScheduler = new V4RequestScheduler({
      ...this.transportPolicy,
      sleep: options.sleep,
      now: options.now,
      onRetry: () => this.transportMetrics.recordRetry(),
      onDelay: delay => delay.reason === "cooldown"
        ? this.transportMetrics.recordCooldown(delay.milliseconds)
        : this.transportMetrics.recordPacing(delay.milliseconds),
    });
  }

  setV4AbortSignal(signal?: AbortSignal): void { this.operationSignal = signal; }

  get transportMetricsSnapshot(): V4TransportMetricsSnapshot {
    return this.transportMetrics.snapshot;
  }

  private async request(options: RequestUrlParam, transientBytes = 0): Promise<RequestUrlResponse> {
    const method = (options.method ?? "GET").toUpperCase();
    const kind = method === "GET" || method === "HEAD" ? "read" : "write";
    const requestBytes = typeof options.body === "string" ? new TextEncoder().encode(options.body).byteLength : 0;
    return this.requestScheduler.run(kind, async () => {
      this.transportMetrics.recordRequest({ mutation: kind === "write", requestBytes, transientBytes });
      let response: RequestUrlResponse;
      try {
        response = await requestUrl(options);
      } catch (error) {
        this.transportMetrics.recordNetworkFailure();
        throw error;
      }
      const responseBytes = response.arrayBuffer?.byteLength ?? (response.text ? new TextEncoder().encode(response.text).byteLength : 0);
      this.transportMetrics.recordResponse(response.status, responseBytes);
      const responseHeaders = Object.fromEntries(Object.entries(response.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
      const rateLimited = response.status === 429 || (response.status === 403 && (
        responseHeaders["retry-after"] !== undefined
        || responseHeaders["x-ratelimit-reset"] !== undefined
        || responseHeaders["x-ratelimit-remaining"] === "0"
      ));
      if (rateLimited) {
        const error = new Error(`GitHub request failed: HTTP ${response.status} - ${response.text || "rate limited"}`) as Error & { status?: number; headers?: Record<string, string> };
        error.status = response.status;
        error.headers = responseHeaders;
        throw error;
      }
      return response;
    }, this.operationSignal);
  }

  private async mutationRequest(input: MutationRequestInput): Promise<RequestUrlResponse> {
    const transientBytes = input.transientBytes ?? estimateV4JsonValueTransportBytes(input.bodyValue);
    const execute = async (): Promise<RequestUrlResponse> => {
      const body = JSON.stringify(input.bodyValue);
      let lastUnknown: unknown;
      for (let attempt = 1; attempt <= this.transportPolicy.maxAttempts; attempt++) {
        try {
          const response = await this.request({ ...input.options, body }, transientBytes);
          if (input.successStatuses.includes(response.status)) return response;
          const error = this.gitHttpError(input.action, response.status, response.text);
          if (classifyV4MutationFailure(error) !== "unknown-outcome") throw error;
          lastUnknown = error;
        } catch (error) {
          if (classifyV4MutationFailure(error) !== "unknown-outcome") throw error;
          lastUnknown = error;
        }
        this.transportMetrics.recordUnknownOutcome();
        const canRetry = canRetryV4MutationAfterUnknownOutcome(input.retryClass, input.retryEvidence);
        if (!canRetry || attempt === this.transportPolicy.maxAttempts) {
          throw new V4GitMutationOutcomeUnknownError(input.retryClass, lastUnknown);
        }
        this.transportMetrics.recordRetry();
      }
      throw new V4GitMutationOutcomeUnknownError(input.retryClass, lastUnknown);
    };
    return input.reservationAlreadyHeld ? execute() : this.transportResources.withTransportBytes(transientBytes, execute, this.operationSignal);
  }

  private get baseUrl() {
    return `https://api.github.com/repos/${this.config.owner}/${this.config.repo}`;
  }

  public get headers() {
    return {
      Authorization: `Bearer ${this.config.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2026-03-10",
      "Content-Type": "application/json",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "Pragma": "no-cache",
    };
  }

  private async gitBlobSha1(bytes: Uint8Array): Promise<string> {
    const header = utf8ToBytes(`blob ${bytes.byteLength}\0`);
    const payload = new Uint8Array(header.byteLength + bytes.byteLength);
    payload.set(header);
    payload.set(bytes, header.byteLength);
    return toHex(await crypto.subtle.digest("SHA-1", payload));
  }

  private async getImmutableFileFromTree(path: string, commitSha: string): Promise<{ bytes: Uint8Array; sha: string } | null> {
    const commit = await this.getGitCommit(commitSha);
    if (!commit.treeSha) throw new Error(`GitHub immutable commit has no tree SHA: ${commitSha}`);
    const tree = await this.getTreeAt(commit.treeSha, true);
    const node = tree.tree.find(candidate => candidate.type === "blob" && candidate.path === path);
    if (node) return { bytes: await this.getBlob(node.sha), sha: node.sha };
    if (tree.truncated) {
      throw new Error(`GitHub immutable tree is truncated while confirming a Contents 404 for ${path}.`);
    }
    return null;
  }

  async getFileBytes(path: string, ref = this.config.branch): Promise<{ bytes: Uint8Array; sha: string } | null> {
    const encodedPath = path.split('/').map(encodeURIComponent).join('/');
    const freshness = ref === this.config.branch ? `&_=${Date.now()}` : "";
    const url = `${this.baseUrl}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}${freshness}`;
    try {
      const response = await this.request({
        url,
        method: "GET",
        headers: { ...this.headers, Accept: "application/vnd.github.object+json" },
        throw: false,
      });

      if (response.status === 200) {
        const json = response.json as { content?: string; encoding?: string; sha?: string };
        const sha = json.sha ?? "";
        if (json.encoding === "base64" && typeof json.content === "string") {
          let decoded: Uint8Array | undefined;
          try {
            decoded = fromBase64(json.content);
          } catch {
            decoded = undefined;
          }
          if (decoded) {
            let verified = true;
            if (/^[0-9a-f]{40}$/u.test(sha)) {
              try { verified = await this.gitBlobSha1(decoded) === sha; } catch { verified = false; }
            }
            if (verified) return { bytes: decoded, sha };
          }
        }
        if (sha) return { bytes: await this.getBlob(sha), sha };
        throw new Error(`GitHub Contents response has no decodable payload for ${path}.`);
      }
      if (response.status === 404) {
        return GIT_COMMIT_SHA.test(ref) ? this.getImmutableFileFromTree(path, ref) : null;
      }
      throw new Error("Failed to get file bytes " + path + ": HTTP " + response.status + " - " + response.text);
    } catch (error) {
      const httpError = error as { status?: number };
      if (httpError.status === 404) {
        return GIT_COMMIT_SHA.test(ref) ? this.getImmutableFileFromTree(path, ref) : null;
      }
      throw error;
    }
  }

  async getBlob(sha: string): Promise<Uint8Array> {
    const url = `${this.baseUrl}/git/blobs/${sha}`;
    const response = await this.request({
      url,
      method: "GET",
      headers: { ...this.headers, Accept: "application/vnd.github.raw+json" },
      throw: false,
    });
    if (response.status === 200) return new Uint8Array(response.arrayBuffer);
    throw new Error("Failed to get blob " + sha + ": HTTP " + response.status + " - " + response.text);
  }

  async listCommits(options: { page?: number; perPage?: number } = {}): Promise<GitHubCommitSummary[]> {
    const page = Math.max(1, Math.floor(options.page ?? 1));
    const perPage = Math.max(1, Math.min(100, Math.floor(options.perPage ?? 50)));
    const response = await this.request({
      url: `${this.baseUrl}/commits?sha=${encodeURIComponent(this.config.branch)}&per_page=${perPage}&page=${page}`,
      method: "GET",
      headers: this.headers,
      throw: false,
    });
    if (response.status !== 200) throw this.gitHttpError("Failed to list commits", response.status, response.text);
    const commits = response.json as Array<{
      sha?: string;
      commit?: { message?: string; author?: { name?: string; date?: string } };
      parents?: Array<{ sha?: string }>;
    }>;
    return commits.map(commit => ({
      sha: commit.sha ?? "",
      message: commit.commit?.message ?? "",
      authorName: commit.commit?.author?.name ?? "",
      authoredAt: commit.commit?.author?.date ?? "",
      parentShas: (commit.parents ?? []).map(parent => parent.sha ?? "").filter(Boolean),
    }));
  }

  async getTreeAt(treeSha: string, recursive = true): Promise<GitHubTree> {
    const response = await this.request({
      url: `${this.baseUrl}/git/trees/${encodeURIComponent(treeSha)}${recursive ? "?recursive=1" : ""}`,
      method: "GET",
      headers: this.headers,
      throw: false,
    });
    if (response.status !== 200) throw this.gitHttpError("Failed to get historical tree", response.status, response.text);
    return response.json as GitHubTree;
  }

  private branchRefPath(): string {
    return this.config.branch.split("/").map(encodeURIComponent).join("/");
  }

  private gitHttpError(action: string, status: number, text: string): Error & { status?: number } {
    const error = new Error(`${action}: HTTP ${status} - ${text}`) as Error & { status?: number };
    error.status = status;
    return error;
  }

  async getGitRef(): Promise<GitHubGitRef> {
    const response = await this.request({
      url: `${this.baseUrl}/git/ref/heads/${this.branchRefPath()}?_=${Date.now()}`,
      method: "GET",
      headers: this.headers,
      throw: false,
    });
    if (response.status !== 200) throw this.gitHttpError("Failed to get git ref", response.status, response.text);
    const json = response.json as { ref?: string; object?: { sha?: string; type?: string } };
    return { ref: json.ref ?? `refs/heads/${this.config.branch}`, sha: json.object?.sha ?? "", type: json.object?.type ?? "commit" };
  }

  async getGitRefOrNull(): Promise<GitHubGitRef | null> {
    try { return await this.getGitRef(); }
    catch (error) {
      if ((error as { status?: number }).status === 404) return null;
      throw error;
    }
  }

  private async inspectAnyGitRef(): Promise<GitHubGitRef | null> {
    const response = await this.request({
      url: `${this.baseUrl}/git/refs?per_page=1&_=${Date.now()}`,
      method: "GET",
      headers: this.headers,
      throw: false,
    });
    if (response.status === 200 && Array.isArray(response.json)) {
      const first = (response.json as Array<{ ref?: string; object?: { sha?: string; type?: string } }>)[0];
      if (!first) return null;
      return { ref: first.ref ?? "", sha: first.object?.sha ?? "", type: first.object?.type ?? "commit" };
    }
    if (response.status === 404 || response.status === 409) return null;
    throw this.gitHttpError("Failed to inspect git refs", response.status, response.text);
  }

  private async ensureConfiguredBootstrapRef(commitSha: string): Promise<GitHubGitRef> {
    const configured = await this.getGitRefOrNull();
    if (configured) return configured;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await this.createGitRef(commitSha);
        return await this.getGitRef();
      } catch (error) {
        if (!(error instanceof V4GitMutationOutcomeUnknownError)) throw error;
        const observed = await this.getGitRefOrNull();
        if (observed) {
          if (observed.sha !== commitSha) throw new Error("V4 bootstrap branch changed during ambiguous creation.");
          return observed;
        }
        if (attempt === 2) throw error;
      }
    }
    throw new Error("V4 bootstrap branch could not be initialized.");
  }

  async ensureGitRepositoryInitialized(): Promise<GitHubGitRef | null> {
    const initialRef = await this.inspectAnyGitRef();
    if (initialRef) return null;

    const encodedPath = V4_BOOTSTRAP_PATH.split("/").map(encodeURIComponent).join("/");
    const bodyValue = {
      message: "obsidian-sync-v4:bootstrap",
      content: toBase64(utf8ToBytes("obsidian-github-sync-v4\n")),
    };
    let commitSha: string | undefined;
    for (let attempt = 1; attempt <= 2 && !commitSha; attempt++) {
      try {
        const response = await this.mutationRequest({
          options: { url: `${this.baseUrl}/contents/${encodedPath}`, method: "PUT", headers: this.headers, throw: false },
          bodyValue,
          retryClass: "reachable-ref",
          successStatuses: [200, 201],
          action: "Failed to bootstrap empty repository",
        });
        commitSha = (response.json as { commit?: { sha?: string } }).commit?.sha;
        if (!commitSha) throw new Error("GitHub bootstrap response is missing its commit SHA.");
      } catch (error) {
        if (!(error instanceof V4GitMutationOutcomeUnknownError)) throw error;
        const observed = await this.inspectAnyGitRef();
        if (observed?.sha) commitSha = observed.sha;
        else if (attempt === 2) throw error;
      }
    }
    if (!commitSha) throw new Error("GitHub bootstrap response is missing its commit SHA.");
    return this.ensureConfiguredBootstrapRef(commitSha);
  }

  async getGitCommit(sha: string): Promise<GitHubGitCommit> {
    const response = await this.request({
      url: `${this.baseUrl}/git/commits/${encodeURIComponent(sha)}`,
      method: "GET",
      headers: this.headers,
      throw: false,
    });
    if (response.status !== 200) throw this.gitHttpError("Failed to get git commit", response.status, response.text);
    const json = response.json as { sha?: string; message?: string; tree?: { sha?: string }; parents?: Array<{ sha?: string }> };
    return { sha: json.sha ?? sha, treeSha: json.tree?.sha ?? "", parentShas: (json.parents ?? []).map(parent => parent.sha ?? "").filter(Boolean), message: json.message };
  }

  async createGitBlob(content: Uint8Array | ArrayBuffer): Promise<string> {
    const bytes = content instanceof Uint8Array ? content : new Uint8Array(content);
    const transientBytes = estimateV4GitBlobTransportBytes(bytes.byteLength);
    return this.transportResources.withTransportBytes(transientBytes, async () => {
      const bodyValue = { content: toBase64(bytes), encoding: "base64" };
      const response = await this.mutationRequest({
        options: { url: `${this.baseUrl}/git/blobs`, method: "POST", headers: this.headers, throw: false },
        bodyValue,
        retryClass: "immutable-idempotent",
        successStatuses: [201],
        transientBytes,
        reservationAlreadyHeld: true,
        action: "Failed to create git blob",
      });
      return (response.json as { sha?: string }).sha ?? "";
    });
  }

  async createGitTree(tree: GitHubCreateTreeEntry[], baseTree?: string): Promise<string> {
    const bodyValue: { tree: GitHubCreateTreeEntry[]; base_tree?: string } = { tree };
    if (baseTree) bodyValue.base_tree = baseTree;
    const response = await this.mutationRequest({
      options: { url: `${this.baseUrl}/git/trees`, method: "POST", headers: this.headers, throw: false },
      bodyValue,
      retryClass: "immutable-idempotent",
      successStatuses: [201],
      action: "Failed to create git tree",
    });
    return (response.json as { sha?: string }).sha ?? "";
  }

  async createGitCommit(
    message: string,
    tree: string,
    parents: string[],
    options: { originalCannotBeReachable?: boolean } = {},
  ): Promise<string> {
    const bodyValue = { message, tree, parents };
    const response = await this.mutationRequest({
      options: { url: `${this.baseUrl}/git/commits`, method: "POST", headers: this.headers, throw: false },
      bodyValue,
      retryClass: "orphan-safe-commit",
      retryEvidence: { originalCannotBeReachable: options.originalCannotBeReachable },
      successStatuses: [201],
      action: "Failed to create git commit",
    });
    return (response.json as { sha?: string }).sha ?? "";
  }

  async updateGitRef(sha: string, _expectedSha?: string): Promise<void> {
    await this.mutationRequest({
      options: { url: `${this.baseUrl}/git/refs/heads/${this.branchRefPath()}`, method: "PATCH", headers: this.headers, throw: false },
      bodyValue: { sha, force: false },
      retryClass: "reachable-ref",
      successStatuses: [200],
      action: "Failed to update git ref",
    });
  }

  async createGitRef(sha: string): Promise<void> {
    await this.mutationRequest({
      options: { url: `${this.baseUrl}/git/refs`, method: "POST", headers: this.headers, throw: false },
      bodyValue: { ref: `refs/heads/${this.config.branch}`, sha },
      retryClass: "reachable-ref",
      successStatuses: [201],
      action: "Failed to create git ref",
    });
  }
}
