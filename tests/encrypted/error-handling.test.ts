import assert from "node:assert/strict";
import test from "node:test";
import { setRequestUrlHandler } from "obsidian";
import { classifyRemoteRepo } from "../../src/lib/encrypted/remote-state";
import { ForeignRemoteError, userMessageForSyncError, WrongPassphraseError } from "../../src/lib/encrypted/sync-errors";
import { EncryptedManifestStore } from "../../src/lib/encrypted/manifest-store";
import { GitHubClient } from "../../src/lib/github-api";

class FakeGitHub {
  blobs: Map<string, string>;
  truncated = false;

  constructor(entries: Record<string, string> = {}, options: { truncated?: boolean } = {}) {
    this.blobs = new Map(Object.entries(entries));
    this.truncated = options.truncated ?? false;
  }

  async getRemoteHeadSha() {
    return this.blobs.size > 0 ? "head" : null;
  }

  async getTree() {
    return {
      sha: "tree",
      url: "",
      truncated: this.truncated,
      tree: [...this.blobs.keys()].map(path => ({ path, mode: "100644", type: "blob" as const, sha: `sha-${path}`, url: "" })),
    };
  }

  async getFile(path: string) {
    if (path === ".obsidian-github-sync-encrypted") {
      const exists = [...this.blobs.keys()].some(p => p.startsWith(".obsidian-github-sync-encrypted/"));
      return exists ? [] : null;
    }
    const content = this.blobs.get(path);
    if (content === undefined) return null;
    return { content: Buffer.from(content, "utf8").toString("base64"), sha: `sha-${path}`, path, size: content.length };
  }

  async putFile(path: string, content: string) {
    this.blobs.set(path, content);
    return `sha-${path}-${content.length}`;
  }
}

test("classifyRemoteRepo detects empty, encrypted, foreign, and corrupt states", async () => {
  assert.equal((await classifyRemoteRepo(new FakeGitHub() as unknown as GitHubClient)).kind, "empty");
  assert.equal((await classifyRemoteRepo(new FakeGitHub({ ".obsidian-github-sync-encrypted/config.json": "{}" }) as unknown as GitHubClient)).kind, "encrypted-plugin");
  assert.equal((await classifyRemoteRepo(new FakeGitHub({ "Notes/a.md": "plain" }) as unknown as GitHubClient)).kind, "foreign-nonempty");
  assert.equal((await classifyRemoteRepo(new FakeGitHub({ ".obsidian-github-sync-encrypted/orphan": "x" }) as unknown as GitHubClient)).kind, "corrupt-plugin");
});

test("classifyRemoteRepo operates successfully without using getTree", async () => {
  const fake = new FakeGitHub({ ".obsidian-github-sync-encrypted/config.json": "{}" });
  fake.getTree = async () => {
    throw new Error("getTree should not be called!");
  };
  const result = await classifyRemoteRepo(fake as unknown as GitHubClient);
  assert.equal(result.kind, "encrypted-plugin");
});

test("manifest store blocks foreign non-empty repos unless explicitly allowed", async () => {
  const foreign = new FakeGitHub({ "Notes/a.md": "plain" }) as unknown as GitHubClient;
  await assert.rejects(() => new EncryptedManifestStore(foreign, "pw").loadOrCreate(), ForeignRemoteError);

  const allowed = new FakeGitHub({ "Notes/a.md": "plain" }) as unknown as GitHubClient;
  const result = await new EncryptedManifestStore(allowed, "pw", true).loadOrCreate();
  assert.equal(result.manifest.formatVersion, 1);
});

test("wrong passphrase and user-facing error messages are specific", () => {
  const wrong = new WrongPassphraseError();
  assert.match(wrong.message, /passphrase is wrong/u);
  assert.equal(userMessageForSyncError("forcePull", wrong, "Notes/a.md"), `Encrypted forcePull failed for Notes/a.md: ${wrong.message}`);
});

test("manifest store reuses derived encryption keys for the same passphrase and config", async () => {
  const originalDeriveKey = crypto.subtle.deriveKey.bind(crypto.subtle);
  let deriveKeyCalls = 0;
  crypto.subtle.deriveKey = ((...args: Parameters<SubtleCrypto["deriveKey"]>) => {
    deriveKeyCalls += 1;
    return originalDeriveKey(...args);
  }) as SubtleCrypto["deriveKey"];

  try {
    const github = new FakeGitHub() as unknown as GitHubClient;
    await new EncryptedManifestStore(github, "cache-test-passphrase", true).loadOrCreate();
    await new EncryptedManifestStore(github, "cache-test-passphrase", true).loadOrCreate();
    assert.equal(deriveKeyCalls, 1);
  } finally {
    crypto.subtle.deriveKey = originalDeriveKey as SubtleCrypto["deriveKey"];
  }
});

test("manifest store bounds the derived key cache", async () => {
  const originalDeriveKey = crypto.subtle.deriveKey.bind(crypto.subtle);
  let deriveKeyCalls = 0;
  crypto.subtle.deriveKey = ((...args: Parameters<SubtleCrypto["deriveKey"]>) => {
    deriveKeyCalls += 1;
    return originalDeriveKey(...args);
  }) as SubtleCrypto["deriveKey"];

  try {
    const githubs: GitHubClient[] = [];
    for (let index = 0; index < 40; index++) {
      const github = new FakeGitHub() as unknown as GitHubClient;
      githubs.push(github);
      await new EncryptedManifestStore(github, "cache-passphrase-" + index, true).loadOrCreate();
    }
    await new EncryptedManifestStore(githubs[0], "cache-passphrase-0", true).loadOrCreate();
    assert.equal(deriveKeyCalls, 41);
  } finally {
    crypto.subtle.deriveKey = originalDeriveKey as SubtleCrypto["deriveKey"];
  }
});

test("manifest store rejects malformed remote encrypted config", async () => {
  const configPath = ".obsidian-github-sync-encrypted/config.json";
  await assert.rejects(
    () => new EncryptedManifestStore(new FakeGitHub({ [configPath]: "{not-json" }) as unknown as GitHubClient, "pw").loadOrCreate(),
    /Invalid encrypted config/i,
  );

  const badConfig = {
    formatVersion: 1,
    indexMode: "single",
    algorithm: "AES-GCM",
    kdf: "PBKDF2-SHA-256",
    kdfParams: { iterations: 1_000_000_000, salt: "not base64 url" },
    createdAt: 1,
    updatedAt: 1,
  };
  await assert.rejects(
    () => new EncryptedManifestStore(new FakeGitHub({ [configPath]: JSON.stringify(badConfig) }) as unknown as GitHubClient, "pw").loadOrCreate(),
    /Invalid encrypted config/i,
  );
});

test("manifest store rejects decrypted manifests with unsafe paths", async () => {
  const github = new FakeGitHub() as unknown as GitHubClient;
  const first = new EncryptedManifestStore(github, "pw", true);
  const loaded = await first.loadOrCreate();
  loaded.manifest.files["../escape.md"] = {
    id: "unsafe",
    path: "../escape.md",
    objectPath: ".obsidian-github-sync-encrypted/objects/un/safe/unsafe.enc",
    plaintextSha256: "0".repeat(64),
    size: 1,
    mtime: 1,
    storage: "single",
  };
  await first.save(loaded.manifest, loaded.key, loaded.manifestSha);

  await assert.rejects(
    () => new EncryptedManifestStore(github, "pw").loadOrCreate(),
    /Invalid encrypted manifest/u,
  );
});


test("GitHubClient.getFile returns null only for 404 and throws for other HTTP errors", async () => {
  const client = new GitHubClient({ token: "token", owner: "owner", repo: "repo", branch: "main" });
  try {
    setRequestUrlHandler(async () => ({ status: 404, text: "missing", json: {} }));
    assert.equal(await client.getFile("Notes/missing.md"), null);

    setRequestUrlHandler(async () => ({ status: 403, text: "rate limited", json: {} }));
    await assert.rejects(() => client.getFile("Notes/a.md"), /HTTP 403.*rate limited/u);

    setRequestUrlHandler(async () => ({ status: 500, text: "server error", json: {} }));
    await assert.rejects(() => client.getFile("Notes/a.md"), /HTTP 500.*server error/u);
  } finally {
    setRequestUrlHandler(null);
  }
});

test("GitHubClient.deleteFile tolerates 404 and throws on other HTTP errors", async () => {
  const client = new GitHubClient({ token: "token", owner: "owner", repo: "repo", branch: "main" });
  try {
    setRequestUrlHandler(async () => ({ status: 404, text: "missing", json: {} }));
    await assert.doesNotReject(() => client.deleteFile("Notes/missing.md", "sha"));

    setRequestUrlHandler(async () => ({ status: 403, text: "forbidden", json: {} }));
    await assert.rejects(() => client.deleteFile("Notes/a.md", "sha"), /HTTP 403|forbidden/i);
  } finally {
    setRequestUrlHandler(null);
  }
});

test("GitHubClient.getFileBytes parses ETags and handles HTTP errors", async () => {
  const client = new GitHubClient({ token: "token", owner: "owner", repo: "repo", branch: "main" });
  const rawBytes = new TextEncoder().encode("file content").buffer;

  try {
    // 1. Valid ETag response
    setRequestUrlHandler(async () => ({
      status: 200,
      headers: { etag: '"sha12345"' },
      arrayBuffer: rawBytes,
      text: "file content",
      json: {}
    }));
    const res = await client.getFileBytes("Notes/a.md");
    assert.ok(res);
    assert.equal(res.sha, "sha12345");
    assert.deepEqual(res.bytes, new Uint8Array(rawBytes));

    // 2. Weak ETag response
    setRequestUrlHandler(async () => ({
      status: 200,
      headers: { ETag: 'W/"sha54321"' },
      arrayBuffer: rawBytes,
      text: "file content",
      json: {}
    }));
    const resWeak = await client.getFileBytes("Notes/a.md");
    assert.ok(resWeak);
    assert.equal(resWeak.sha, "sha54321");

    // 3. 404 Missing response
    setRequestUrlHandler(async () => ({ status: 404, text: "missing", json: {} }));
    assert.equal(await client.getFileBytes("Notes/missing.md"), null);

    // 4. 403 Rate limited response
    setRequestUrlHandler(async () => ({ status: 403, text: "rate limited", json: {} }));
    await assert.rejects(() => client.getFileBytes("Notes/a.md"), /HTTP 403.*rate limited/u);
  } finally {
    setRequestUrlHandler(null);
  }
});

test("GitHubClient.getBlob handles 200 and HTTP errors", async () => {
  const client = new GitHubClient({ token: "token", owner: "owner", repo: "repo", branch: "main" });
  const rawBytes = new TextEncoder().encode("blob data").buffer;

  try {
    // 1. Success 200
    setRequestUrlHandler(async () => ({
      status: 200,
      arrayBuffer: rawBytes,
      text: "blob data",
      json: {}
    }));
    const bytes = await client.getBlob("sha123");
    assert.deepEqual(bytes, new Uint8Array(rawBytes));

    // 2. Error 500
    setRequestUrlHandler(async () => ({ status: 500, text: "server error", json: {} }));
    await assert.rejects(() => client.getBlob("sha123"), /HTTP 500.*server error/u);
  } finally {
    setRequestUrlHandler(null);
  }
});

test("GitHubClient Git database primitives map REST contracts and HTTP errors", async () => {
  const client = new GitHubClient({ token: "token", owner: "owner", repo: "repo", branch: "feature/sync" });
  const calls: Array<{ url: string; method: string; body?: string }> = [];

  try {
    setRequestUrlHandler(async request => {
      calls.push({ url: request.url, method: request.method ?? "GET", body: request.body });
      if (request.url.includes("/git/ref/heads/feature/sync")) {
        return { status: 200, text: "ok", json: { ref: "refs/heads/feature/sync", object: { sha: "commit-a", type: "commit" } } };
      }
      if (request.url.endsWith("/git/blobs")) {
        return { status: 201, text: "created", json: { sha: "blob-a" } };
      }
      if (request.url.endsWith("/git/trees")) {
        return { status: 201, text: "created", json: { sha: "tree-a", tree: [] } };
      }
      if (request.url.endsWith("/git/commits")) {
        return { status: 201, text: "created", json: { sha: "commit-b" } };
      }
      if (request.url.includes("/git/refs/heads/feature/sync")) {
        return { status: 200, text: "updated", json: { ref: "refs/heads/feature/sync", object: { sha: "commit-b", type: "commit" } } };
      }
      return { status: 500, text: "unexpected", json: {} };
    });

    const ref = await client.getGitRef();
    assert.equal(ref.sha, "commit-a");
    assert.equal(ref.ref, "refs/heads/feature/sync");

    const blobSha = await client.createGitBlob(new TextEncoder().encode("hello"));
    assert.equal(blobSha, "blob-a");

    const treeSha = await client.createGitTree([{ path: "Notes/a.md", mode: "100644", type: "blob", sha: blobSha }], "base-tree");
    assert.equal(treeSha, "tree-a");

    const commitSha = await client.createGitCommit("sync: v3", treeSha, [ref.sha]);
    assert.equal(commitSha, "commit-b");

    await client.updateGitRef(commitSha, ref.sha);

    assert.equal(calls[0].method, "GET");
    assert.match(calls[0].url, /\/git\/ref\/heads\/feature\/sync/u);
    assert.equal(calls[1].method, "POST");
    assert.deepEqual(JSON.parse(calls[2].body ?? "{}"), { base_tree: "base-tree", tree: [{ path: "Notes/a.md", mode: "100644", type: "blob", sha: "blob-a" }] });
    assert.deepEqual(JSON.parse(calls[3].body ?? "{}"), { message: "sync: v3", tree: "tree-a", parents: ["commit-a"] });
    assert.equal(JSON.parse(calls[4].body ?? "{}").sha, "commit-b");
    assert.equal(JSON.parse(calls[4].body ?? "{}").force, false);
  } finally {
    setRequestUrlHandler(null);
  }
});

test("GitHubClient.updateGitRef reports stale refs as status 409", async () => {
  const client = new GitHubClient({ token: "token", owner: "owner", repo: "repo", branch: "main" });
  try {
    setRequestUrlHandler(async () => ({ status: 409, text: "reference update failed", json: {} }));
    await assert.rejects(() => client.updateGitRef("new-commit", "old-commit"), (error: unknown) => {
      assert.equal((error as { status?: number }).status, 409);
      assert.match((error as Error).message, /Failed to update git ref/u);
      return true;
    });
  } finally {
    setRequestUrlHandler(null);
  }
});

test("GitHubClient.getGitCommit reads commit tree sha without recursive tree", async () => {
  const client = new GitHubClient({ token: "token", owner: "owner", repo: "repo", branch: "main" });
  const calls: string[] = [];
  try {
    setRequestUrlHandler(async request => {
      calls.push(request.url);
      return { status: 200, text: "ok", json: { sha: "commit-a", tree: { sha: "tree-a" }, parents: [{ sha: "parent-a" }] } };
    });
    const commit = await client.getGitCommit("commit-a");
    assert.equal(commit.sha, "commit-a");
    assert.equal(commit.treeSha, "tree-a");
    assert.deepEqual(commit.parentShas, ["parent-a"]);
    assert.match(calls[0], /\/git\/commits\/commit-a/u);
  } finally {
    setRequestUrlHandler(null);
  }
});
