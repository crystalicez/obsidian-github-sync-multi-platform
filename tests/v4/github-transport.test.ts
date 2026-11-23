import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { setRequestUrlHandler } from "obsidian";

import { toBase64 } from "../../src/lib/bytes";
import { GitHubClient } from "../../src/lib/github-api";
import { V4RequestScheduler } from "../../src/lib/v4/request-scheduler";

test("GitHubClient pins the API version and paginates commit history", async () => {
  const requests: Array<Record<string, any>> = [];
  setRequestUrlHandler(async (options: unknown) => {
    requests.push(options as Record<string, any>);
    return {
      status: 200,
      text: "",
      headers: {},
      json: [{
        sha: "commit-1",
        commit: { message: "obsidian-sync-v4:journal-1", author: { date: "2026-07-13T00:00:00Z", name: "Sync" } },
        parents: [{ sha: "a".repeat(40) }],
      }],
    };
  });
  try {
    const client = new GitHubClient({ token: "token", owner: "owner", repo: "repo", branch: "main" }, { transportPolicy: { mutationSpacingMs: 0 } });
    const commits = await client.listCommits({ page: 2, perPage: 50 });

    assert.equal(commits[0].sha, "commit-1");
    assert.deepEqual(commits[0].parentShas, ["a".repeat(40)]);
    assert.match(requests[0].url, /commits\?sha=main&per_page=50&page=2/u);
    assert.equal(requests[0].headers["X-GitHub-Api-Version"], "2026-03-10");
  } finally {
    setRequestUrlHandler(null);
  }
});

test("GitHubClient reads historical trees and can create a branch ref", async () => {
  const requests: Array<Record<string, any>> = [];
  setRequestUrlHandler(async (options: unknown) => {
    const request = options as Record<string, any>;
    requests.push(request);
    if (request.method === "POST") return { status: 201, text: "", headers: {}, json: { ref: "refs/heads/v4", object: { sha: "root" } } };
    return { status: 200, text: "", headers: {}, json: { sha: "tree-old", url: "", tree: [], truncated: false } };
  });
  try {
    const client = new GitHubClient({ token: "token", owner: "owner", repo: "repo", branch: "v4" }, { transportPolicy: { mutationSpacingMs: 0 } });
    const tree = await client.getTreeAt("tree-old", false);
    await client.createGitRef("root");

    assert.equal(tree.sha, "tree-old");
    assert.equal(requests[0].url.endsWith("/git/trees/tree-old"), true);
    assert.deepEqual(JSON.parse(requests[1].body), { ref: "refs/heads/v4", sha: "root" });
  } finally {
    setRequestUrlHandler(null);
  }
});

test("D366 GitHubClient keeps the validated repository, token and branch after caller config mutation", async () => {
  const captured: Array<{ url: string; authorization: string; body?: string }> = [];
  setRequestUrlHandler(async (options: unknown) => {
    const request = options as { url: string; headers: Record<string, string>; body?: string };
    captured.push({ url: request.url, authorization: request.headers.Authorization, body: request.body });
    if (request.url.endsWith("/git/refs")) {
      return { status: 201, text: "", headers: {}, json: { ref: "refs/heads/source" } };
    }
    return { status: 200, text: "", headers: {}, json: [] };
  });
  try {
    const config = { token: "original-token", owner: "safe-owner", repo: "source-repo", branch: "source" };
    const client = new GitHubClient(config, { transportPolicy: { mutationSpacingMs: 0 } });
    config.owner = "other-owner";
    config.repo = "other-repo";
    config.branch = "other-branch";
    config.token = "other-token";

    assert.equal(client.branchName, "source");
    await client.listCommits();
    await client.createGitRef("a".repeat(40));
    assert.equal(captured.length, 2);
    assert.match(captured[0]!.url, /^https:\/\/api\.github\.com\/repos\/safe-owner\/source-repo\/commits\?sha=source&/u);
    assert.match(captured[1]!.url, /^https:\/\/api\.github\.com\/repos\/safe-owner\/source-repo\/git\/refs$/u);
    assert.deepEqual(captured.map(entry => entry.authorization), ["Bearer original-token", "Bearer original-token"]);
    assert.deepEqual(JSON.parse(captured[1]!.body!), { ref: "refs/heads/source", sha: "a".repeat(40) });
  } finally {
    setRequestUrlHandler(null);
  }
});

test("D366 strict-CAS GraphQL mutation stays on initial ref and token after repository ID lookup awaits", async () => {
  const captured: Array<{ authorization: string; body: string }> = [];
  const config = { token: "original-token", owner: "safe-owner", repo: "source-repo", branch: "source" };
  setRequestUrlHandler(async (options: unknown) => {
    const request = options as { headers: Record<string, string>; body: string };
    captured.push({ authorization: request.headers.Authorization, body: request.body });
    const json = JSON.parse(request.body) as { variables: Record<string, unknown> };
    if (captured.length === 1) {
      assert.deepEqual(json.variables, { owner: "safe-owner", repo: "source-repo" });
      // A repository-node lookup is asynchronous. Its return must not grant
      // a caller-owned config alias permission to redirect the later CAS.
      config.branch = "other-branch";
      config.token = "other-token";
      config.repo = "other-repo";
      return { status: 200, text: "", headers: {}, json: { data: { repository: { id: "original-node-id" } } } };
    }
    return { status: 200, text: "", headers: {}, json: { data: { updateRefs: {} } } };
  });
  try {
    const client = new GitHubClient(config, { transportPolicy: { mutationSpacingMs: 0 } });
    await client.updateGitRef("b".repeat(40), "a".repeat(40));
    assert.equal(captured.length, 2);
    assert.equal(captured[1]!.authorization, "Bearer original-token");
    const mutation = JSON.parse(captured[1]!.body) as {
      variables: { input: { repositoryId: string; refUpdates: Array<{ name: string }> } };
    };
    assert.equal(mutation.variables.input.repositoryId, "original-node-id");
    assert.equal(mutation.variables.input.refUpdates[0]!.name, "refs/heads/source");
  } finally {
    setRequestUrlHandler(null);
  }
});

test("V4 request scheduler retries rate limits after the requested delay", async () => {
  const sleeps: number[] = [];
  let now = 0;
  let attempts = 0;
  const scheduler = new V4RequestScheduler({
    readConcurrency: 2,
    writeConcurrency: 1,
    now: () => now,
    sleep: async milliseconds => {
      sleeps.push(milliseconds);
      now += milliseconds;
    },
  });
  const result = await scheduler.run("write", async () => {
    attempts += 1;
    if (attempts === 1) {
      const error = new Error("rate limited") as Error & { status?: number; headers?: Record<string, string> };
      error.status = 429;
      error.headers = { "retry-after": "2" };
      throw error;
    }
    return "ok";
  });

  assert.equal(result, "ok");
  assert.equal(attempts, 2);
  assert.deepEqual(sleeps, [2_000]);
});

test("GitHubClient routes REST calls through rate-limit retries", async () => {
  let attempts = 0;
  setRequestUrlHandler(async () => {
    attempts += 1;
    if (attempts === 1) return { status: 429, text: "limited", headers: { "retry-after": "0" }, json: {} };
    return { status: 200, text: "", headers: {}, json: [] };
  });
  try {
    const client = new GitHubClient({ token: "token", owner: "owner", repo: "repo", branch: "main" }, { transportPolicy: { mutationSpacingMs: 0 } });
    assert.deepEqual(await client.listCommits(), []);
    assert.equal(attempts, 2);
  } finally {
    setRequestUrlHandler(null);
  }
});

test("D357 direct Git Blob transport rejects oversize Uint8Array and ArrayBuffer before any request", async () => {
  let requests = 0;
  setRequestUrlHandler(async () => {
    requests++;
    throw new Error("Oversize Git Blob must not reach the transport");
  });
  try {
    const client = new GitHubClient(
      { token: "token", owner: "owner", repo: "repo", branch: "main" },
      { transportPolicy: { mutationSpacingMs: 0 } },
    );
    const oversize = new Uint8Array(8 * 1024 * 1024 + 1);
    await assert.rejects(client.createGitBlob(oversize), /Git Blob.*8 MiB/i);
    await assert.rejects(client.createGitBlob(oversize.buffer), /Git Blob.*8 MiB/i);
    assert.equal(requests, 0, "reject before Base64 encoding and API mutation");
  } finally {
    setRequestUrlHandler(null);
  }
});

test("D357 exactly 8 MiB Git Blob remains writable through the mocked REST transport", async () => {
  let requests = 0;
  setRequestUrlHandler(async (options: unknown) => {
    const request = options as { method: string; url: string; body: string };
    requests++;
    assert.equal(request.method, "POST");
    assert.match(request.url, /\/git\/blobs$/u);
    const body = JSON.parse(request.body) as { content: string; encoding: string };
    assert.equal(body.encoding, "base64");
    assert.equal(body.content.length, 4 * Math.ceil((8 * 1024 * 1024) / 3));
    return { status: 201, text: "", headers: {}, json: { sha: "a".repeat(40) } };
  });
  try {
    const client = new GitHubClient(
      { token: "token", owner: "owner", repo: "repo", branch: "main" },
      { transportPolicy: { mutationSpacingMs: 0 } },
    );
    assert.equal(await client.createGitBlob(new Uint8Array(8 * 1024 * 1024)), "a".repeat(40));
    assert.equal(requests, 1, "exact boundary must not be rejected");
  } finally {
    setRequestUrlHandler(null);
  }
});

test("D467 raw Git Blob read rejects mismatched bytes despite HTTP 200", async () => {
  const expected = new TextEncoder().encode("# Original note\n");
  const wrong = new TextEncoder().encode("# Wrong note\n");
  const header = new TextEncoder().encode(`blob ${expected.byteLength}\0`);
  const gitSha = createHash("sha1").update(header).update(expected).digest("hex");
  const requests: string[] = [];
  setRequestUrlHandler(async (options: unknown) => {
    const { url } = options as { url: string };
    requests.push(url);
    return { status: 200, text: "", headers: {}, arrayBuffer: wrong.buffer, json: undefined };
  });
  try {
    const client = new GitHubClient(
      { token: "token", owner: "owner", repo: "repo", branch: "main" },
      { transportPolicy: { mutationSpacingMs: 0 } },
    );
    await assert.rejects(() => client.getBlob(gitSha), /Git Blob.*(SHA|integrity|mismatch)/i,
      "HTTP 200 must never authorize corrupted historical Markdown");
    assert.equal(requests.length, 1, "do not silently retry a mismatched 200");
  } finally {
    setRequestUrlHandler(null);
  }
});

test("D467 Git Blob reader accepts exact bytes and rejects corrupted Contents fallback", async () => {
  const bytes = new TextEncoder().encode("# Original note\r\n");
  const header = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
  const gitSha = createHash("sha1").update(header).update(bytes).digest("hex");
  let altered = false;
  let blobReads = 0;
  setRequestUrlHandler(async (options: unknown) => {
    const { url } = options as { url: string };
    if (url.includes("/contents/")) {
      return { status: 200, text: "", headers: {}, json: { sha: gitSha, encoding: "none" },
        arrayBuffer: new ArrayBuffer(0) };
    }
    blobReads++;
    const raw = altered ? new TextEncoder().encode("# Incorrect note\r\n") : bytes;
    return { status: 200, text: "", headers: {}, json: undefined, arrayBuffer: raw.buffer };
  });
  try {
    const client = new GitHubClient(
      { token: "token", owner: "owner", repo: "repo", branch: "main" },
      { transportPolicy: { mutationSpacingMs: 0 } },
    );
    assert.deepEqual(await client.getBlob(gitSha), bytes);
    assert.deepEqual((await client.getFileBytes("Notes/a.md", "commit-sha"))?.bytes, bytes);
    altered = true;
    await assert.rejects(() => client.getFileBytes("Notes/a.md", "commit-sha"),
      /Git Blob.*(SHA|integrity|mismatch)/i, "unverified fallback bytes may not enter file restoration");
    assert.equal(blobReads, 3);
  } finally {
    setRequestUrlHandler(null);
  }
});

test("D467 raw Git Blob reader refuses malformed IDs and missing bytes without a false success", async () => {
  let requests = 0;
  setRequestUrlHandler(async () => {
    requests++;
    return { status: 200, text: "not raw bytes", headers: {}, json: { content: "not a blob" } };
  });
  try {
    const client = new GitHubClient(
      { token: "token", owner: "owner", repo: "repo", branch: "main" },
      { transportPolicy: { mutationSpacingMs: 0 } },
    );
    await assert.rejects(() => client.getBlob("../unsafe"), /Invalid Git Blob SHA/u);
    assert.equal(requests, 0, "a malformed object ID must never reach the network");
    await assert.rejects(() => client.getBlob("a".repeat(40)), /Git Blob.*no raw bytes/u);
    assert.equal(requests, 1);
  } finally {
    setRequestUrlHandler(null);
  }
});

test("GitHubClient pins file reads to an explicit commit SHA", async () => {
  const requestUrls: string[] = [];
  let accept = "";
  setRequestUrlHandler(async (options: unknown) => {
    const request = options as { url: string; headers: Record<string, string> };
    requestUrls.push(request.url);
    if (request.url.includes("/contents/")) {
      accept = request.headers.Accept;
      return {
        status: 200,
        text: "",
        headers: {},
        json: { content: "dHJhbnNmb3JtZWQ=", encoding: "base64", sha: "a5df5b6112f9310f9b7d922dc562cd9d413ecf02" },
        arrayBuffer: new ArrayBuffer(0),
      };
    }
    return {
      status: 200,
      text: "payload",
      headers: {},
      json: undefined,
      arrayBuffer: new TextEncoder().encode("payload").buffer,
    };
  });
  try {
    const client = new GitHubClient({ token: "token", owner: "owner", repo: "repo", branch: "main" }, { transportPolicy: { mutationSpacingMs: 0 } });
    const file = await client.getFileBytes(".obsidian-github-sync-v4/head", "commit/sha");
    assert.match(requestUrls[0], /ref=commit%2Fsha/u);
    assert.equal(accept, "application/vnd.github.object+json");
    assert.equal(new TextDecoder().decode(file!.bytes), "transformed");
    assert.equal(file!.sha, "a5df5b6112f9310f9b7d922dc562cd9d413ecf02");
    assert.equal(requestUrls.length, 1);
  } finally {
    setRequestUrlHandler(null);
  }
});

function githubContentsUtf16beTransform(bytes: Uint8Array): Uint8Array {
  let text = ""
  for (let index = 0; index + 1 < bytes.byteLength; index += 2) {
    text += String.fromCharCode((bytes[index] << 8) | bytes[index + 1])
  }
  if ((bytes.byteLength & 1) !== 0) text += "\uFFFD"
  return new TextEncoder().encode(text)
}

test("GitHubClient falls back to the canonical Git Blob when Contents transforms binary bytes", async () => {
  const raw = Uint8Array.from([
    79, 71, 83, 52, 1, 253, 142, 97, 212, 167, 10, 51, 86, 115, 77, 87, 209, 244, 140,
    48, 80, 42, 244, 84, 28, 131, 154, 197, 154, 111, 119, 70, 50, 225, 97, 66, 143,
  ])
  const blobSha = "5a469309d6d8c744bb48764f30ff665c3c2d65ca"
  const requests: string[] = []
  setRequestUrlHandler(async (options: unknown) => {
    const request = options as { url: string }
    requests.push(request.url)
    if (request.url.includes("/contents/")) {
      return {
        status: 200,
        text: "",
        headers: {},
        json: { content: toBase64(githubContentsUtf16beTransform(raw)), encoding: "base64", sha: blobSha },
        arrayBuffer: new ArrayBuffer(0),
      }
    }
    return { status: 200, text: "", headers: {}, json: undefined, arrayBuffer: raw.buffer }
  })
  try {
    const client = new GitHubClient(
      { token: "token", owner: "owner", repo: "repo", branch: "main" },
      { transportPolicy: { mutationSpacingMs: 0 } },
    )
    const file = await client.getFileBytes("binary.enc", "commit-sha")
    assert.deepEqual(file?.bytes, raw)
    assert.equal(file?.sha, blobSha)
    assert.equal(requests.length, 2)
    assert.equal(requests.some(url => url.endsWith(`/git/blobs/${blobSha}`)), true)
  } finally {
    setRequestUrlHandler(null)
  }
})

test("GitHubClient refuses unverified fallback when SHA calculation fails", async () => {
  const raw = Uint8Array.from([79, 71, 83, 52, 1, 253, 142, 97])
  const blobSha = "0123456789abcdef0123456789abcdef01234567"
  const requests: string[] = []
  const originalDigest = crypto.subtle.digest
  crypto.subtle.digest = (async () => { throw new Error("forced digest failure") }) as typeof crypto.subtle.digest
  setRequestUrlHandler(async (options: unknown) => {
    const request = options as { url: string }
    requests.push(request.url)
    if (request.url.includes("/contents/")) {
      return {
        status: 200,
        text: "",
        headers: {},
        json: { content: toBase64(raw), encoding: "base64", sha: blobSha },
        arrayBuffer: new ArrayBuffer(0),
      }
    }
    return { status: 200, text: "", headers: {}, json: undefined, arrayBuffer: raw.buffer }
  })
  try {
    const client = new GitHubClient(
      { token: "token", owner: "owner", repo: "repo", branch: "main" },
      { transportPolicy: { mutationSpacingMs: 0 } },
    )
    await assert.rejects(() => client.getFileBytes("binary.enc", "commit-sha"),
      /forced digest failure/, "a failed checksum must not approve raw fallback bytes")
    assert.equal(requests.length, 2)
    assert.equal(requests.filter(url => url.endsWith(`/git/blobs/${blobSha}`)).length, 1)
  } finally {
    crypto.subtle.digest = originalDigest
    setRequestUrlHandler(null)
  }
})

test("D337 repository bootstrap refuses malformed nonempty Git ref listings before any write", async () => {
  const valid = { ref: "refs/heads/main", object: { sha: "a".repeat(40), type: "commit" } }
  for (const json of [
    [{}],
    [{ object: valid.object }],
    [{ ref: valid.ref, object: { sha: "not-a-git-sha", type: "commit" } }],
    [{ ref: valid.ref, object: { sha: "g".repeat(40), type: "commit" } }],
    [{ ref: valid.ref, object: { sha: "a".repeat(39), type: "commit" } }],
    [{ ref: valid.ref, object: { sha: valid.object.sha } }],
    [{ ref: valid.ref, object: { sha: valid.object.sha, type: "tag" } }],
    [{ ref: "", object: valid.object }],
    [{ ref: "refs/", object: valid.object }],
    [null],
  ]) {
    const methods: string[] = []
    setRequestUrlHandler(async (options: unknown) => {
      const request = options as { method: string }
      methods.push(request.method)
      return { status: 200, text: "", headers: {}, json }
    })
    try {
      const client = new GitHubClient(
        { token: "token", owner: "owner", repo: "repo", branch: "main" },
        { transportPolicy: { mutationSpacingMs: 0 } },
      )
      await assert.rejects(() => client.ensureGitRepositoryInitialized(), /invalid.*git.*ref/i,
        "malformed list is neither an empty repository nor proof of a valid Git ref")
      assert.deepEqual(methods, ["GET"], "invalid listing cannot authorize bootstrap writes")
    } finally {
      setRequestUrlHandler(null)
    }
  }
  for (const ref of [
    valid,
    { ref: "refs/tags/release-1", object: { sha: "b".repeat(40), type: "tag" } },
  ]) {
    const methods: string[] = []
    setRequestUrlHandler(async (options: unknown) => {
      const request = options as { method: string }
      methods.push(request.method)
      return { status: 200, text: "", headers: {}, json: [ref] }
    })
    try {
      const client = new GitHubClient(
        { token: "token", owner: "owner", repo: "repo", branch: "main" },
        { transportPolicy: { mutationSpacingMs: 0 } },
      )
      assert.equal(await client.ensureGitRepositoryInitialized(), null)
      assert.deepEqual(methods, ["GET"], "valid existing ref must not trigger bootstrap")
    } finally {
      setRequestUrlHandler(null)
    }
  }
})

test("GitHubClient bootstraps a truly empty repository before Git ref writes", async () => {
  const requests: Array<Record<string, any>> = [];
  setRequestUrlHandler(async (options: unknown) => {
    const request = options as Record<string, any>;
    requests.push(request);
    if (request.url.includes("/git/refs?")) return { status: 409, text: "Git Repository is empty.", headers: {}, json: {} };
    if (request.method === "PUT") return { status: 201, text: "", headers: {}, json: { commit: { sha: "b".repeat(40) } } };
    if (request.method === "GET" && request.url.includes("/git/ref/heads/")) {
      return { status: 200, text: "", headers: {}, json: { ref: "refs/heads/main", object: { sha: "b".repeat(40), type: "commit" } } };
    }
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  });
  try {
    const client = new GitHubClient({ token: "token", owner: "owner", repo: "repo", branch: "main" }, { transportPolicy: { mutationSpacingMs: 0 } });
    const ref = await client.ensureGitRepositoryInitialized();

    assert.equal(ref?.sha, "b".repeat(40));
    const put = requests.find(request => request.method === "PUT")!;
    assert.match(put.url, /\/contents\/\.obsidian-github-sync-v4\/bootstrap$/u);
    const body = JSON.parse(put.body);
    assert.equal(body.branch, undefined);
    assert.equal(body.message, "obsidian-sync-v4:bootstrap");
  } finally {
    setRequestUrlHandler(null);
  }
});

test("GitHubClient creates a configured custom branch after empty-repository bootstrap", async () => {
  const requests: Array<Record<string, any>> = [];
  let customRefReads = 0;
  setRequestUrlHandler(async (options: unknown) => {
    const request = options as Record<string, any>;
    requests.push(request);
    if (request.url.includes("/git/refs?")) return { status: 409, text: "empty", headers: {}, json: {} };
    if (request.method === "PUT") return { status: 201, text: "", headers: {}, json: { commit: { sha: "b".repeat(40) } } };
    if (request.method === "GET" && request.url.includes("/git/ref/heads/v4-sync")) {
      customRefReads++;
      return customRefReads === 1
        ? { status: 404, text: "missing", headers: {}, json: {} }
        : { status: 200, text: "", headers: {}, json: { ref: "refs/heads/v4-sync", object: { sha: "b".repeat(40), type: "commit" } } };
    }
    if (request.method === "POST" && request.url.endsWith("/git/refs")) return { status: 201, text: "", headers: {}, json: {} };
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  });
  try {
    const client = new GitHubClient({ token: "token", owner: "owner", repo: "repo", branch: "v4-sync" }, { transportPolicy: { mutationSpacingMs: 0 } });
    const ref = await client.ensureGitRepositoryInitialized();
    assert.equal(ref?.ref, "refs/heads/v4-sync");
    const createRef = requests.find(request => request.method === "POST")!;
    assert.deepEqual(JSON.parse(createRef.body), { ref: "refs/heads/v4-sync", sha: "b".repeat(40) });
  } finally {
    setRequestUrlHandler(null);
  }
});

test("GitHubClient falls back to verified Git Blob bytes when Contents omits a large payload", async () => {
  const requests: string[] = [];
  const raw = new TextEncoder().encode("large payload");
  const blobSha = createHash("sha1")
    .update(new TextEncoder().encode(`blob ${raw.byteLength}\0`)).update(raw).digest("hex");
  setRequestUrlHandler(async (options: unknown) => {
    const url = (options as { url: string }).url;
    requests.push(url);
    if (url.includes("/contents/")) {
      return { status: 200, text: "", headers: {}, json: { content: "", encoding: "none", sha: blobSha }, arrayBuffer: new ArrayBuffer(0) };
    }
    return { status: 200, text: "payload", headers: {}, json: undefined, arrayBuffer: raw.buffer };
  });
  try {
    const client = new GitHubClient({ token: "token", owner: "owner", repo: "repo", branch: "main" }, { transportPolicy: { mutationSpacingMs: 0 } });
    const file = await client.getFileBytes("large.bin", "commit-sha");
    assert.equal(new TextDecoder().decode(file!.bytes), "large payload");
    assert.equal(file!.sha, blobSha);
    assert.equal(requests.some(url => url.endsWith(`/git/blobs/${blobSha}`)), true);
  } finally {
    setRequestUrlHandler(null);
  }
});

test("GitHubClient retries a lost blob response because the immutable mutation is idempotent", async () => {
  let attempts = 0
  setRequestUrlHandler(async () => {
    attempts++
    if (attempts === 1) throw new Error("blob response lost")
    return { status: 201, text: "", headers: {}, json: { sha: "blob-stable" } }
  })
  try {
    const client = new GitHubClient(
      { token: "token", owner: "owner", repo: "repo", branch: "main" },
      { transportPolicy: { mutationSpacingMs: 0 } },
    )
    assert.equal(await client.createGitBlob(new TextEncoder().encode("body")), "blob-stable")
    assert.equal(attempts, 2)
  } finally {
    setRequestUrlHandler(null)
  }
})

test("GitHubClient retries a lost tree response because the immutable mutation is idempotent", async () => {
  let attempts = 0
  setRequestUrlHandler(async () => {
    attempts++
    if (attempts === 1) throw new Error("tree response lost")
    return { status: 201, text: "", headers: {}, json: { sha: "tree-stable" } }
  })
  try {
    const client = new GitHubClient(
      { token: "token", owner: "owner", repo: "repo", branch: "main" },
      { transportPolicy: { mutationSpacingMs: 0 } },
    )
    assert.equal(await client.createGitTree([{ path: "A", mode: "100644", type: "blob", sha: "blob-stable" }]), "tree-stable")
    assert.equal(attempts, 2)
  } finally {
    setRequestUrlHandler(null)
  }
})

test("GitHubClient retries a lost commit response only with explicit orphan-safe evidence", async () => {
  let attempts = 0
  setRequestUrlHandler(async () => {
    attempts++
    if (attempts === 1) throw new Error("commit response lost")
    return { status: 201, text: "", headers: {}, json: { sha: "commit-second" } }
  })
  try {
    const client = new GitHubClient(
      { token: "token", owner: "owner", repo: "repo", branch: "main" },
      { transportPolicy: { mutationSpacingMs: 0 } },
    )
    assert.equal(
      await client.createGitCommit("obsidian-sync-v4:j", "tree", ["base"], { originalCannotBeReachable: true }),
      "commit-second",
    )
    assert.equal(attempts, 2)
  } finally {
    setRequestUrlHandler(null)
  }
})

test("GitHubClient never blindly retries a normal ref mutation after a lost response", async () => {
  let mutationAttempts = 0
  setRequestUrlHandler(async (options: unknown) => {
    const body = JSON.parse((options as { body: string }).body)
    if (body.query.includes("repository(")) return { status: 200, text: "", headers: {}, json: { data: { repository: { id: "R_repo_node" } } } }
    mutationAttempts++
    throw new Error("ref response lost")
  })
  try {
    const client = new GitHubClient(
      { token: "token", owner: "owner", repo: "repo", branch: "main" },
      { transportPolicy: { mutationSpacingMs: 0 } },
    )
    await assert.rejects(
      () => client.updateGitRef("b".repeat(40), "a".repeat(40)),
      error => (error as Error).name === "V4GitMutationOutcomeUnknownError",
    )
    assert.equal(mutationAttempts, 1)
  } finally {
    setRequestUrlHandler(null)
  }
})

test("E1 fail-first: GitHubClient publishes existing branch through exact GraphQL beforeOid CAS only", async () => {
  const requests: Array<Record<string, any>> = []
  const oldSha = "a".repeat(40)
  const newSha = "b".repeat(40)
  setRequestUrlHandler(async (options: unknown) => {
    const request = options as Record<string, any>
    requests.push(request)
    if (request.url !== "https://api.github.com/graphql") throw new Error("REST ref writes are forbidden")
    const body = JSON.parse(request.body)
    if (body.query.includes("repository(")) return { status: 200, text: "", headers: {}, json: { data: { repository: { id: "R_repo_node" } } } }
    if (body.query.includes("updateRefs")) return { status: 200, text: "", headers: {}, json: { data: { updateRefs: { clientMutationId: null } } } }
    throw new Error("unexpected GraphQL operation")
  })
  try {
    const client = new GitHubClient({ token: "token", owner: "owner", repo: "repo", branch: "feature/deep" }, { transportPolicy: { mutationSpacingMs: 0 } })
    await client.updateGitRef(newSha, oldSha)
    assert.equal(requests.length, 2)
    const mutation = JSON.parse(requests[1].body)
    assert.equal(mutation.query.includes("updateRefs("), true)
    assert.deepEqual(mutation.variables.input, {
      repositoryId: "R_repo_node",
      refUpdates: [{ name: "refs/heads/feature/deep", beforeOid: oldSha, afterOid: newSha, force: false }],
    })
    assert.equal(requests.every(request => request.headers.Authorization === "Bearer token"), true)
  } finally { setRequestUrlHandler(null) }
})

test("E1 fail-first: missing expected HEAD is rejected locally without any remote mutation", async () => {
  let requests = 0
  setRequestUrlHandler(async () => { requests++; throw new Error("should not request") })
  try {
    const client = new GitHubClient({ token: "token", owner: "owner", repo: "repo", branch: "main" })
    await assert.rejects(() => client.updateGitRef("b".repeat(40)), /expected|beforeOid|CAS/i)
    assert.equal(requests, 0)
  } finally { setRequestUrlHandler(null) }
})

test("E1 fail-first: GraphQL 200 with errors never publishes or silently falls back to REST", async () => {
  const requests: string[] = []
  setRequestUrlHandler(async (options: unknown) => {
    const request = options as Record<string, any>
    requests.push(request.url)
    if (request.url !== "https://api.github.com/graphql") throw new Error("unsafe REST fallback")
    const body = JSON.parse(request.body)
    if (body.query.includes("repository(")) return { status: 200, text: "", headers: {}, json: { data: { repository: { id: "R_repo_node" } } } }
    return { status: 200, text: "", headers: {}, json: { errors: [{ message: "beforeOid does not match current ref" }], data: { updateRefs: null } } }
  })
  try {
    const client = new GitHubClient({ token: "token", owner: "owner", repo: "repo", branch: "main" }, { transportPolicy: { mutationSpacingMs: 0 } })
    await assert.rejects(() => client.updateGitRef("b".repeat(40), "a".repeat(40)), /beforeOid|GraphQL|ref/i)
    assert.equal(requests.length, 2)
    assert.ok(requests.every(url => url.endsWith("/graphql")))
  } finally { setRequestUrlHandler(null) }
})

test("empty-repository bootstrap observes initialization before retrying a lost Contents PUT", async () => {
  const requests: Array<Record<string, any>> = []
  let initialized = false
  let puts = 0
  setRequestUrlHandler(async (options: unknown) => {
    const request = options as Record<string, any>
    requests.push(request)
    if (request.url.includes("/git/refs?")) {
      return initialized
        ? { status: 200, text: "", headers: {}, json: [{ ref: "refs/heads/main", object: { sha: "b".repeat(40), type: "commit" } }] }
        : { status: 409, text: "empty", headers: {}, json: {} }
    }
    if (request.method === "PUT") {
      puts++
      initialized = true
      throw new Error("bootstrap response lost")
    }
    if (request.method === "GET" && request.url.includes("/git/ref/heads/main")) {
      return { status: 200, text: "", headers: {}, json: { ref: "refs/heads/main", object: { sha: "b".repeat(40), type: "commit" } } }
    }
    throw new Error(`Unexpected request: ${request.method} ${request.url}`)
  })
  try {
    const client = new GitHubClient(
      { token: "token", owner: "owner", repo: "repo", branch: "main" },
      { transportPolicy: { mutationSpacingMs: 0 } },
    )
    const ref = await client.ensureGitRepositoryInitialized()
    assert.equal(ref?.sha, "b".repeat(40))
    assert.equal(puts, 1)
  } finally {
    setRequestUrlHandler(null)
  }
})

test("bootstrap branch creation observes the configured ref before retrying a lost create-ref response", async () => {
  let customExists = false
  let posts = 0
  setRequestUrlHandler(async (options: unknown) => {
    const request = options as Record<string, any>
    if (request.url.includes("/git/refs?")) return { status: 409, text: "empty", headers: {}, json: {} }
    if (request.method === "PUT") return { status: 201, text: "", headers: {}, json: { commit: { sha: "b".repeat(40) } } }
    if (request.method === "GET" && request.url.includes("/git/ref/heads/v4-sync")) {
      return customExists
        ? { status: 200, text: "", headers: {}, json: { ref: "refs/heads/v4-sync", object: { sha: "b".repeat(40), type: "commit" } } }
        : { status: 404, text: "missing", headers: {}, json: {} }
    }
    if (request.method === "POST" && request.url.endsWith("/git/refs")) {
      posts++
      customExists = true
      throw new Error("create-ref response lost")
    }
    throw new Error(`Unexpected request: ${request.method} ${request.url}`)
  })
  try {
    const client = new GitHubClient(
      { token: "token", owner: "owner", repo: "repo", branch: "v4-sync" },
      { transportPolicy: { mutationSpacingMs: 0 } },
    )
    const ref = await client.ensureGitRepositoryInitialized()
    assert.equal(ref?.sha, "b".repeat(40))
    assert.equal(posts, 1)
  } finally {
    setRequestUrlHandler(null)
  }
})

test("transport metrics are in-memory and contain no request path or response body", async () => {
  setRequestUrlHandler(async () => ({ status: 201, text: "SECRET RESPONSE", headers: {}, json: { sha: "blob" } }))
  try {
    const client = new GitHubClient(
      { token: "token", owner: "owner", repo: "repo", branch: "main" },
      { transportPolicy: { mutationSpacingMs: 0 } },
    )
    await client.createGitBlob(new TextEncoder().encode("PRIVATE BODY"))
    const serialized = JSON.stringify(client.transportMetricsSnapshot)
    assert.equal(serialized.includes("PRIVATE BODY"), false)
    assert.equal(serialized.includes("SECRET RESPONSE"), false)
    assert.equal(serialized.includes("/git/blobs"), false)
    assert.equal(client.transportMetricsSnapshot.mutations >= 1, true)
    assert.equal(client.transportMetricsSnapshot.transientBytesPeak > 0, true)
  } finally {
    setRequestUrlHandler(null)
  }
})

test("GitHubClient never blindly retries a normal create-ref mutation after a lost response", async () => {
  let attempts = 0
  setRequestUrlHandler(async () => {
    attempts++
    throw new Error("create-ref response lost")
  })
  try {
    const client = new GitHubClient(
      { token: "token", owner: "owner", repo: "repo", branch: "main" },
      { transportPolicy: { mutationSpacingMs: 0 } },
    )
    await assert.rejects(
      () => client.createGitRef("candidate"),
      error => (error as Error).name === "V4GitMutationOutcomeUnknownError",
    )
    assert.equal(attempts, 1)
  } finally {
    setRequestUrlHandler(null)
  }
})

test("immutable commit and content reads omit timestamp cache-busting while ref reads stay fresh", async () => {
  const urls: string[] = []
  setRequestUrlHandler(async (options: unknown) => {
    const request = options as Record<string, any>
    urls.push(request.url)
    if (request.url.includes("/contents/")) return { status: 200, text: "", headers: {}, json: { content: "YQ==", encoding: "base64", sha: "2e65efe2a145dda7ee51d1741299f848e5bf752e" }, arrayBuffer: new ArrayBuffer(0) }
    if (request.url.includes("/git/commits/")) return { status: 200, text: "", headers: {}, json: { sha: "commit-sha", tree: { sha: "b".repeat(40) }, parents: [] } }
    if (request.url.includes("/git/ref/heads/")) return { status: 200, text: "", headers: {}, json: { ref: "refs/heads/main", object: { sha: "a".repeat(40), type: "commit" } } }
    throw new Error(`unexpected:${request.url}`)
  })
  try {
    const client = new GitHubClient(
      { token: "token", owner: "owner", repo: "repo", branch: "main" },
      { transportPolicy: { mutationSpacingMs: 0 } },
    )
    await client.getFileBytes("A.md", "commit-sha")
    await client.getGitCommit("commit-sha")
    await client.getGitRef()
    assert.equal(urls[0].includes("&_="), false)
    assert.equal(urls[1].includes("?_="), false)
    assert.match(urls[2], /\?_=/u)
  } finally {
    setRequestUrlHandler(null)
  }
})

test("D251 commit history parser rejects absent parents instead of fabricating a root", async () => {
  const commitSha = "a".repeat(40)
  const client = new GitHubClient(
    { token: "token", owner: "owner", repo: "repo", branch: "main" },
    { transportPolicy: { mutationSpacingMs: 0 } },
  )
  try {
    for (const parents of [undefined, null, {}, [null], [{}], [{ sha: "invalid" }]]) {
      setRequestUrlHandler(async () => ({
        status: 200, text: "", headers: {},
        json: [{ sha: commitSha, commit: { message: "test" },
          ...(parents === undefined ? {} : { parents }) }],
      }))
      await assert.rejects(() => client.listCommits(), /parent/i)
    }
    setRequestUrlHandler(async () => ({
      status: 200, text: "", headers: {},
      json: [{ sha: commitSha, commit: { message: "root" }, parents: [] }],
    }))
    assert.deepEqual((await client.listCommits())[0]?.parentShas, [])
  } finally {
    setRequestUrlHandler(null)
  }
})

test("D251 Git commit parser refuses missing or malformed parent evidence instead of fabricating an orphan", async () => {
  const sha = "a".repeat(40)
  const treeSha = "b".repeat(40)
  const parentSha = "c".repeat(40)
  const client = new GitHubClient(
    { token: "token", owner: "owner", repo: "repo", branch: "main" },
    { transportPolicy: { mutationSpacingMs: 0 } },
  )
  try {
    for (const parents of [undefined, null, {}, [null], [{}],
      [{ sha: "" }], [{ sha: "invalid-parent" }]]) {
      setRequestUrlHandler(async () => ({
        status: 200, text: "", headers: {},
        json: { sha, tree: { sha: treeSha }, ...(parents === undefined ? {} : { parents }) },
      }))
      await assert.rejects(() => client.getGitCommit(sha), /parent/i)
    }
    setRequestUrlHandler(async () => ({
      status: 200, text: "", headers: {},
      json: { sha, tree: { sha: treeSha }, parents: [] },
    }))
    assert.deepEqual((await client.getGitCommit(sha)).parentShas, [])
    setRequestUrlHandler(async () => ({
      status: 200, text: "", headers: {},
      json: { sha, tree: { sha: treeSha }, parents: [{ sha: parentSha }] },
    }))
    assert.deepEqual((await client.getGitCommit(sha)).parentShas, [parentSha])
  } finally {
    setRequestUrlHandler(null)
  }
})

test("D339 Git commit transport rejects missing or malformed tree evidence", async () => {
  const sha = "a".repeat(40)
  const treeSha = "b".repeat(40)
  const client = new GitHubClient(
    { token: "token", owner: "owner", repo: "repo", branch: "main" },
    { transportPolicy: { mutationSpacingMs: 0 } },
  )
  try {
    for (const tree of [undefined, null, {}, { sha: "" }, { sha: "bad-tree" },
      { sha: "g".repeat(40) }, { sha: "b".repeat(39) }, { sha: 123 },
      ["b".repeat(40)]]) {
      setRequestUrlHandler(async (options: unknown) => {
        const request = options as { method: string }
        assert.equal(request.method, "GET", "invalid commit metadata must remain read-only")
        return { status: 200, text: "", headers: {}, json: {
          sha, parents: [], ...(tree === undefined ? {} : { tree }),
        } }
      })
      await assert.rejects(() => client.getGitCommit(sha), /GitHub.*tree/i,
        "a 200 response with no valid tree SHA cannot prove an immutable snapshot")
    }
    setRequestUrlHandler(async (options: unknown) => {
      const request = options as { method: string }
      assert.equal(request.method, "GET")
      return { status: 200, text: "", headers: {}, json: {
        sha, tree: { sha: treeSha }, parents: [],
      } }
    })
    const valid = await client.getGitCommit(sha)
    assert.equal(valid.sha, sha)
    assert.equal(valid.treeSha, treeSha)
    assert.deepEqual(valid.parentShas, [])
  } finally {
    setRequestUrlHandler(null)
  }
})

test("D92 default branch lookup fails closed on missing, unsafe and unavailable GitHub responses", async () => {
  const client = new GitHubClient(
    { token: "token", owner: "owner", repo: "repo", branch: "main" },
    { transportPolicy: { mutationSpacingMs: 0 } },
  )
  const urls: string[] = []
  try {
    setRequestUrlHandler(async (options: unknown) => {
      const request = options as { url: string; method: string }
      urls.push(request.url)
      assert.equal(request.method, "GET")
      return { status: 200, text: "", headers: {}, json: { default_branch: "stable/source" } }
    })
    assert.equal(await client.getRepositoryDefaultBranch(), "stable/source")
    assert.equal(urls.length, 1)
    assert.match(urls[0]!, /\/repos\/owner\/repo$/u)

    for (const json of [
      {}, null, { default_branch: "" }, { default_branch: "bad//branch" },
      { default_branch: "main.lock" }, { default_branch: "bad..branch" },
      { default_branch: 5 }, { default_branch: "@{" },
    ]) {
      setRequestUrlHandler(async () => ({ status: 200, text: "", headers: {}, json }))
      await assert.rejects(() => client.getRepositoryDefaultBranch(), /default branch|GitHub branch/i)
    }

    setRequestUrlHandler(async () => ({ status: 403, text: "forbidden", headers: {}, json: {} }))
    await assert.rejects(() => client.getRepositoryDefaultBranch(), /403/u)
  } finally {
    setRequestUrlHandler(null)
  }
})

test("GitHubClient refuses missing or malformed ref fields instead of fabricating a branch/type", async () => {
  const valid = { ref: "refs/heads/main", object: { sha: "a".repeat(40), type: "commit" } }
  const bodies: unknown[] = [
    { object: valid.object },
    { ref: valid.ref, object: { sha: "a".repeat(40) } },
    { ref: valid.ref, object: { type: "commit" } },
    { ref: valid.ref },
    { ref: "", object: valid.object },
    // A 200 OK from another branch or a non-commit object is not our HEAD.
    { ref: "refs/heads/other", object: valid.object },
    { ref: valid.ref, object: { sha: "a".repeat(40), type: "tag" } },
    { ref: valid.ref, object: { sha: "not-a-git-commit-sha", type: "commit" } },
    { ref: valid.ref, object: { sha: "g".repeat(40), type: "commit" } },
    { ref: valid.ref, object: { sha: "a".repeat(39), type: "commit" } },
    null,
  ]
  try {
    const client = new GitHubClient(
      { token: "token", owner: "owner", repo: "repo", branch: "main" },
      { transportPolicy: { mutationSpacingMs: 0 } },
    )
    for (const json of bodies) {
      setRequestUrlHandler(async () => ({ status: 200, text: "", headers: {}, json }))
      await assert.rejects(client.getGitRef(), /GitHub.*ref|invalid.*ref/i)
      await assert.rejects(client.getGitRefOrNull(), /GitHub.*ref|invalid.*ref/i,
        "malformed HTTP 200 is not evidence that the ref is absent")
    }
    setRequestUrlHandler(async () => ({ status: 200, text: "", headers: {}, json: valid }))
    assert.deepEqual(await client.getGitRef(), {
      ref: valid.ref, sha: valid.object.sha, type: valid.object.type,
    })
  } finally {
    setRequestUrlHandler(null)
  }
})

test("GitHubClient holds the transport reservation across mutation serialization and request", async () => {
  let active = false
  let reserved = 0
  setRequestUrlHandler(async () => {
    assert.equal(active, true)
    return { status: 201, text: "", headers: {}, json: { sha: "blob" } }
  })
  try {
    const client = new GitHubClient(
      { token: "token", owner: "owner", repo: "repo", branch: "main" },
      {
        transportPolicy: { mutationSpacingMs: 0 },
        transportResources: {
          withTransportBytes: async <T>(bytes: number, task: () => Promise<T>) => {
            reserved = bytes
            active = true
            try { return await task() } finally { active = false }
          },
        },
      },
    )
    await client.createGitBlob(new TextEncoder().encode("bounded"))
    assert.equal(active, false)
    assert.equal(reserved > "bounded".length, true)
  } finally {
    setRequestUrlHandler(null)
  }
})

test("transport metrics count response text as UTF-8 bytes", async () => {
  setRequestUrlHandler(async () => ({ status: 201, text: "é", headers: {}, json: { sha: "blob" } }))
  try {
    const client = new GitHubClient(
      { token: "token", owner: "owner", repo: "repo", branch: "main" },
      { transportPolicy: { mutationSpacingMs: 0 } },
    )
    await client.createGitBlob(new Uint8Array([1]))
    assert.equal(client.transportMetricsSnapshot.responseBytes, 2)
  } finally {
    setRequestUrlHandler(null)
  }
})
