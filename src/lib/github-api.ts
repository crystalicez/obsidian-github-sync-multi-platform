import { requestUrl, type RequestUrlParam, type RequestUrlResponse } from "obsidian";
import { fromBase64, sha256Hex, toBase64, toHex, utf8ToBytes } from "./bytes";
import { assertSafeGitHubBranch, assertSafeGitHubRepositoryCoordinates } from "./github-config";
import type { GitHubCreateTreeEntry, GitHubGitCommit, GitHubGitRef } from "./github-git-types";
import { V4RepositoryBootstrapRaceError } from "./v4/bootstrap-race";
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
import type { V4RateLimitCooldownStore } from "./v4/rate-limit-cooldown";
import { V4TransportMetrics, type V4TransportMetricsSnapshot } from "./v4/transport-metrics";
import { resolveV4TransportPolicy, type V4TransportPolicy } from "./v4/transport-policy";
import { readImmutableGitFile } from "./v4/immutable-git-read";

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
  sleep?: ((milliseconds: number, signal?: AbortSignal) => Promise<void>) | undefined;
  now?: () => number;
  cooldownStore?: V4RateLimitCooldownStore | undefined;
}

export interface GitHubRepositoryIdentity {
  readonly id: number;
  readonly fullName: string;
}

export interface GitHubTreeNode {
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
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
  private operationSignal: AbortSignal | undefined;
  private repositoryNodeIdPromise: Promise<string> | undefined;
  private readonly cooldownScope: Promise<string> | undefined;
  private readonly cooldownStore?: V4RateLimitCooldownStore | undefined;

  constructor(config: GitHubConfig, options: GitHubClientOptions = {}) {
    // Fail before creating a scheduler or constructing an API URL for unsafe refs.
    assertSafeGitHubRepositoryCoordinates(config.owner, config.repo)
    assertSafeGitHubBranch(config.branch)
    this.config = config;
    this.cooldownStore = options.cooldownStore;
    // Token-scoped because GitHub rate limits apply across repos for one token.
    this.cooldownScope = options.cooldownStore
      ? sha256Hex(utf8ToBytes(`v4-rate-limit-github-token:${config.token}`))
      : undefined;
    this.transportPolicy = resolveV4TransportPolicy(options.transportPolicy);
    this.transportMetrics = options.transportMetrics ?? new V4TransportMetrics();
    this.transportResources = options.transportResources ?? createV4ResourceController(DEFAULT_V4_RESOURCE_LIMITS);
    this.requestScheduler = new V4RequestScheduler({
      ...this.transportPolicy,
      sleep: options.sleep,
      now: options.now,
      onRetry: () => this.transportMetrics.recordRetry(),
      onCooldown: async deadline => {
        if (this.cooldownStore && this.cooldownScope) {
          await this.cooldownStore.save(await this.cooldownScope, deadline)
        }
      },
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
    // Initialize before the first wire request, and refresh on each later one
    // so a newly swapped client cannot bypass another client\'s rate limit.
    if (this.cooldownStore && this.cooldownScope) {
      this.requestScheduler.restoreCooldown(await this.cooldownStore.load(await this.cooldownScope))
    }
    const method = (options.method ?? "GET").toUpperCase();
    const kind = method === "GET" || method === "HEAD" ? "read" : "write";
    const requestBytes = typeof options.body === "string" ? new TextEncoder().encode(options.body).byteLength : 0;
    return this.requestScheduler.run(kind, async () => {
      const requestId = this.transportMetrics.recordRequest({ mutation: kind === "write", requestBytes, transientBytes });
      try {
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
      } finally {
        this.transportMetrics.finishRequest(requestId);
      }
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
    return readImmutableGitFile(path, commitSha, {
      getCommit: sha => this.getGitCommit(sha),
      getTree: treeSha => this.getTreeAt(treeSha, false),
      getBlob: blobSha => this.getBlob(blobSha),
    });
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
        // A Contents 200 must identify its Git blob before its bytes are trusted.
        if (!/^[0-9a-f]{40}$/u.test(sha)) {
          throw new Error(`GitHub Contents response has invalid blob SHA for ${path}.`);
        }
        if (json.encoding === "base64" && typeof json.content === "string") {
          let decoded: Uint8Array | undefined;
          try {
            decoded = fromBase64(json.content);
          } catch {
            decoded = undefined;
          }
          if (decoded) {
            let verified = false;
            try { verified = await this.gitBlobSha1(decoded) === sha; } catch { /* Do not accept unverified Contents bytes. */ }
            if (verified) return { bytes: decoded, sha };
          }
        }
        return { bytes: await this.getBlob(sha), sha };
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

  /** Read physical GitHub repository identity; never infer it from a Git ref or a V4 config blob. */
  async getRepositoryIdentity(): Promise<GitHubRepositoryIdentity> {
    const response = await this.request({
      url: this.baseUrl,
      method: "GET",
      headers: this.headers,
      throw: false,
    });
    if (response.status !== 200) {
      throw this.gitHttpError("Failed to read GitHub repository identity", response.status, response.text);
    }
    const raw = response.json as { id?: unknown; full_name?: unknown } | null;
    const id = raw?.id;
    const fullName = raw?.full_name;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0
      || typeof fullName !== "string"
      || fullName.split("/").length !== 2) {
      throw new Error("Invalid GitHub repository identity response.");
    }
    const [owner, repo] = fullName.split("/");
    try {
      assertSafeGitHubRepositoryCoordinates(owner ?? "", repo ?? "");
    } catch {
      throw new Error("Invalid GitHub repository identity response.");
    }
    return { id, fullName };
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
        if (!(error instanceof V4GitMutationOutcomeUnknownError)) {
          const status = (error as { status?: number }).status;
          if (status === 409 || status === 422) {
            let observed: GitHubGitRef | null;
            try { observed = await this.inspectAnyGitRef(); }
            catch { throw error; }
            if (observed?.sha) throw new V4RepositoryBootstrapRaceError(observed.sha, error);
          }
          throw error;
        }
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
    // A mismatched or omitted immutable commit identity is not proof of the
    // requested commit's tree. Never infer remote-file absence from that body.
    if (GIT_COMMIT_SHA.test(sha) && json.sha !== sha) {
      throw new Error(`GitHub immutable commit identity mismatch (SHA): requested ${sha}, received ${String(json.sha)}.`);
    }
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

  private async repositoryNodeId(): Promise<string> {
    if (!this.repositoryNodeIdPromise) {
      this.repositoryNodeIdPromise = (async () => {
        const response = await this.request({
          url: "https://api.github.com/graphql",
          method: "POST",
          headers: this.headers,
          throw: false,
          body: JSON.stringify({
            query: "query($owner: String!, $repo: String!) { repository(owner: $owner, name: $repo) { id } }",
            variables: { owner: this.config.owner, repo: this.config.repo },
          }),
        });
        if (response.status !== 200) throw this.gitHttpError("Failed to resolve repository GraphQL ID", response.status, response.text);
        const json = response.json as { data?: { repository?: { id?: unknown } | null }; errors?: unknown };
        if (Array.isArray(json?.errors) && json.errors.length > 0) throw new Error("GitHub GraphQL repository lookup failed.");
        const id = json?.data?.repository?.id;
        if (typeof id !== "string" || id.length === 0) throw new Error("GitHub GraphQL repository lookup did not return a repository ID.");
        return id;
      })();
      void this.repositoryNodeIdPromise.catch(() => { this.repositoryNodeIdPromise = undefined; });
    }
    return this.repositoryNodeIdPromise;
  }

  async updateGitRef(sha: string, expectedSha?: string): Promise<void> {
    // A REST PATCH with force:false proves fast-forward ancestry, NOT equality
    // to the originally observed HEAD. Only GraphQL updateRefs(beforeOid)
    // supplies the server-side CAS needed by V4 WAL publication.
    if (!expectedSha || !GIT_COMMIT_SHA.test(expectedSha)) {
      throw new Error("Strict V4 CAS requires a full expected branch HEAD SHA (beforeOid).");
    }
    if (!GIT_COMMIT_SHA.test(sha)) throw new Error("Strict V4 CAS requires a full candidate commit SHA.");
    const repositoryId = await this.repositoryNodeId();
    const response = await this.mutationRequest({
      options: { url: "https://api.github.com/graphql", method: "POST", headers: this.headers, throw: false },
      bodyValue: {
        query: "mutation($input: UpdateRefsInput!) { updateRefs(input: $input) { clientMutationId } }",
        variables: {
          input: {
            repositoryId,
            refUpdates: [{ name: `refs/heads/${this.config.branch}`, beforeOid: expectedSha, afterOid: sha, force: false }],
          },
        },
      },
      retryClass: "reachable-ref",
      successStatuses: [200],
      action: "Failed to update git ref with strict CAS",
    });
    const json = response.json as { data?: { updateRefs?: unknown }; errors?: unknown };
    if (Array.isArray(json?.errors) && json.errors.length > 0) {
      // GraphQL may respond HTTP 200 to a rejected beforeOid. Publication
      // reconciliation will re-read the actual head and decide how to replan.
      throw new Error("GitHub GraphQL strict CAS rejected: " + json.errors.map(error =>
        typeof (error as { message?: unknown })?.message === "string"
          ? (error as { message: string }).message : "unknown GraphQL error",
      ).join("; "));
    }
    if (!json?.data?.updateRefs || typeof json.data.updateRefs !== "object") {
      throw new Error("GitHub GraphQL strict CAS response is missing updateRefs confirmation.");
    }
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
