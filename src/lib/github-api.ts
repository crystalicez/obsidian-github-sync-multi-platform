import { requestUrl, type RequestUrlParam, type RequestUrlResponse } from "obsidian";
import { fromBase64, toBase64, utf8ToBytes } from "./bytes";
import type { GitHubCreateTreeEntry, GitHubGitCommit, GitHubGitRef } from "./github-git-types";
import { V4RequestScheduler } from "./v4/request-scheduler";

const V4_BOOTSTRAP_PATH = ".obsidian-github-sync-v4/bootstrap";

export interface GitHubConfig {
  owner: string;
  repo: string;
  branch: string;
  token: string;
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

export class GitHubClient {
  private config: GitHubConfig;
  private readonly requestScheduler = new V4RequestScheduler({ readConcurrency: 4, writeConcurrency: 2 });

  constructor(config: GitHubConfig) {
    this.config = config;
  }

  private async request(options: RequestUrlParam): Promise<RequestUrlResponse> {
    const method = (options.method ?? "GET").toUpperCase();
    const kind = method === "GET" || method === "HEAD" ? "read" : "write";
    return this.requestScheduler.run(kind, async () => {
      const response = await requestUrl(options);
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
    });
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

  async getFileBytes(path: string, ref = this.config.branch): Promise<{ bytes: Uint8Array; sha: string } | null> {
    const encodedPath = path.split('/').map(encodeURIComponent).join('/');
    const url = `${this.baseUrl}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}&_=${Date.now()}`;
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
        if (sha) return { bytes: await this.getBlob(sha), sha };
        if (json.encoding === "base64" && typeof json.content === "string") {
          return { bytes: fromBase64(json.content), sha };
        }
        throw new Error(`GitHub Contents response has no decodable payload for ${path}.`);
      }
      if (response.status === 404) return null;
      throw new Error("Failed to get file bytes " + path + ": HTTP " + response.status + " - " + response.text);
    } catch (error) {
      const httpError = error as { status?: number };
      if (httpError.status === 404) return null;
      throw error;
    }
  }

  async getBlob(sha: string): Promise<Uint8Array> {
    const url = `${this.baseUrl}/git/blobs/${sha}`;
    try {
      const response = await this.request({
        url,
        method: "GET",
        headers: {
          ...this.headers,
          Accept: "application/vnd.github.raw+json",
        },
        throw: false,
      });

      if (response.status === 200) {
        return new Uint8Array(response.arrayBuffer);
      }
      throw new Error("Failed to get blob " + sha + ": HTTP " + response.status + " - " + response.text);
    } catch (error) {
      throw error;
    }
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
    try {
      return await this.getGitRef();
    } catch (error) {
      if ((error as { status?: number }).status === 404) return null;
      throw error;
    }
  }

  async ensureGitRepositoryInitialized(): Promise<GitHubGitRef | null> {
    const refs = await this.request({
      url: `${this.baseUrl}/git/refs?per_page=1&_=${Date.now()}`,
      method: "GET",
      headers: this.headers,
      throw: false,
    });
    if (refs.status === 200 && Array.isArray(refs.json) && refs.json.length > 0) return null;
    if (refs.status !== 200 && refs.status !== 404 && refs.status !== 409) {
      throw this.gitHttpError("Failed to inspect git refs", refs.status, refs.text);
    }

    const encodedPath = V4_BOOTSTRAP_PATH.split("/").map(encodeURIComponent).join("/");
    const response = await this.request({
      url: `${this.baseUrl}/contents/${encodedPath}`,
      method: "PUT",
      headers: this.headers,
      body: JSON.stringify({
        message: "obsidian-sync-v4:bootstrap",
        content: toBase64(utf8ToBytes("obsidian-github-sync-v4\n")),
      }),
      throw: false,
    });
    if (response.status !== 200 && response.status !== 201) {
      throw this.gitHttpError("Failed to bootstrap empty repository", response.status, response.text);
    }
    const commitSha = (response.json as { commit?: { sha?: string } }).commit?.sha;
    if (!commitSha) throw new Error("GitHub bootstrap response is missing its commit SHA.");
    const configured = await this.getGitRefOrNull();
    if (configured) return configured;
    await this.createGitRef(commitSha);
    return this.getGitRef();
  }


  async getGitCommit(sha: string): Promise<GitHubGitCommit> {
    const response = await this.request({
      url: `${this.baseUrl}/git/commits/${encodeURIComponent(sha)}?_=${Date.now()}`,
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
    const response = await this.request({
      url: `${this.baseUrl}/git/blobs`,
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ content: toBase64(bytes), encoding: "base64" }),
      throw: false,
    });
    if (response.status !== 201) throw this.gitHttpError("Failed to create git blob", response.status, response.text);
    return (response.json as { sha?: string }).sha ?? "";
  }

  async createGitTree(tree: GitHubCreateTreeEntry[], baseTree?: string): Promise<string> {
    const body: { tree: GitHubCreateTreeEntry[]; base_tree?: string } = { tree };
    if (baseTree) body.base_tree = baseTree;
    const response = await this.request({
      url: `${this.baseUrl}/git/trees`,
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(body),
      throw: false,
    });
    if (response.status !== 201) throw this.gitHttpError("Failed to create git tree", response.status, response.text);
    return (response.json as { sha?: string }).sha ?? "";
  }

  async createGitCommit(message: string, tree: string, parents: string[]): Promise<string> {
    const response = await this.request({
      url: `${this.baseUrl}/git/commits`,
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ message, tree, parents }),
      throw: false,
    });
    if (response.status !== 201) throw this.gitHttpError("Failed to create git commit", response.status, response.text);
    return (response.json as { sha?: string }).sha ?? "";
  }

  async updateGitRef(sha: string, _expectedSha?: string): Promise<void> {
    const response = await this.request({
      url: `${this.baseUrl}/git/refs/heads/${this.branchRefPath()}`,
      method: "PATCH",
      headers: this.headers,
      body: JSON.stringify({ sha, force: false }),
      throw: false,
    });
    if (response.status !== 200) throw this.gitHttpError("Failed to update git ref", response.status, response.text);
  }

  async createGitRef(sha: string): Promise<void> {
    const response = await this.request({
      url: `${this.baseUrl}/git/refs`,
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ ref: `refs/heads/${this.config.branch}`, sha }),
      throw: false,
    });
    if (response.status !== 201) throw this.gitHttpError("Failed to create git ref", response.status, response.text);
  }

}
