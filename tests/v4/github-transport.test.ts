import assert from "node:assert/strict";
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
        parents: [{ sha: "parent-1" }],
      }],
    };
  });
  try {
    const client = new GitHubClient({ token: "token", owner: "owner", repo: "repo", branch: "main" }, { transportPolicy: { mutationSpacingMs: 0 } });
    const commits = await client.listCommits({ page: 2, perPage: 50 });

    assert.equal(commits[0].sha, "commit-1");
    assert.deepEqual(commits[0].parentShas, ["parent-1"]);
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

test("V4 request scheduler retries rate limits after the requested delay", async () => {
  const sleeps: number[] = [];
  let attempts = 0;
  const scheduler = new V4RequestScheduler({
    readConcurrency: 2,
    writeConcurrency: 1,
    sleep: async ms => { sleeps.push(ms); },
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

test("GitHubClient bootstraps a truly empty repository before Git ref writes", async () => {
  const requests: Array<Record<string, any>> = [];
  setRequestUrlHandler(async (options: unknown) => {
    const request = options as Record<string, any>;
    requests.push(request);
    if (request.url.includes("/git/refs?")) return { status: 409, text: "Git Repository is empty.", headers: {}, json: {} };
    if (request.method === "PUT") return { status: 201, text: "", headers: {}, json: { commit: { sha: "bootstrap-commit" } } };
    if (request.method === "GET" && request.url.includes("/git/ref/heads/")) {
      return { status: 200, text: "", headers: {}, json: { ref: "refs/heads/main", object: { sha: "bootstrap-commit", type: "commit" } } };
    }
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  });
  try {
    const client = new GitHubClient({ token: "token", owner: "owner", repo: "repo", branch: "main" }, { transportPolicy: { mutationSpacingMs: 0 } });
    const ref = await client.ensureGitRepositoryInitialized();

    assert.equal(ref?.sha, "bootstrap-commit");
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
    if (request.method === "PUT") return { status: 201, text: "", headers: {}, json: { commit: { sha: "bootstrap-commit" } } };
    if (request.method === "GET" && request.url.includes("/git/ref/heads/v4-sync")) {
      customRefReads++;
      return customRefReads === 1
        ? { status: 404, text: "missing", headers: {}, json: {} }
        : { status: 200, text: "", headers: {}, json: { ref: "refs/heads/v4-sync", object: { sha: "bootstrap-commit", type: "commit" } } };
    }
    if (request.method === "POST" && request.url.endsWith("/git/refs")) return { status: 201, text: "", headers: {}, json: {} };
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  });
  try {
    const client = new GitHubClient({ token: "token", owner: "owner", repo: "repo", branch: "v4-sync" }, { transportPolicy: { mutationSpacingMs: 0 } });
    const ref = await client.ensureGitRepositoryInitialized();
    assert.equal(ref?.ref, "refs/heads/v4-sync");
    const createRef = requests.find(request => request.method === "POST")!;
    assert.deepEqual(JSON.parse(createRef.body), { ref: "refs/heads/v4-sync", sha: "bootstrap-commit" });
  } finally {
    setRequestUrlHandler(null);
  }
});

test("GitHubClient falls back to Git Blob bytes when Contents omits a large payload", async () => {
  const requests: string[] = [];
  setRequestUrlHandler(async (options: unknown) => {
    const url = (options as { url: string }).url;
    requests.push(url);
    if (url.includes("/contents/")) {
      return { status: 200, text: "", headers: {}, json: { content: "", encoding: "none", sha: "large-blob" }, arrayBuffer: new ArrayBuffer(0) };
    }
    return { status: 200, text: "payload", headers: {}, json: undefined, arrayBuffer: new TextEncoder().encode("large payload").buffer };
  });
  try {
    const client = new GitHubClient({ token: "token", owner: "owner", repo: "repo", branch: "main" }, { transportPolicy: { mutationSpacingMs: 0 } });
    const file = await client.getFileBytes("large.bin", "commit-sha");
    assert.equal(new TextDecoder().decode(file!.bytes), "large payload");
    assert.equal(file!.sha, "large-blob");
    assert.equal(requests.some(url => url.endsWith("/git/blobs/large-blob")), true);
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
  let attempts = 0
  setRequestUrlHandler(async () => {
    attempts++
    throw new Error("ref response lost")
  })
  try {
    const client = new GitHubClient(
      { token: "token", owner: "owner", repo: "repo", branch: "main" },
      { transportPolicy: { mutationSpacingMs: 0 } },
    )
    await assert.rejects(
      () => client.updateGitRef("candidate", "base"),
      error => (error as Error).name === "V4GitMutationOutcomeUnknownError",
    )
    assert.equal(attempts, 1)
  } finally {
    setRequestUrlHandler(null)
  }
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
        ? { status: 200, text: "", headers: {}, json: [{ ref: "refs/heads/main", object: { sha: "bootstrap-commit", type: "commit" } }] }
        : { status: 409, text: "empty", headers: {}, json: {} }
    }
    if (request.method === "PUT") {
      puts++
      initialized = true
      throw new Error("bootstrap response lost")
    }
    if (request.method === "GET" && request.url.includes("/git/ref/heads/main")) {
      return { status: 200, text: "", headers: {}, json: { ref: "refs/heads/main", object: { sha: "bootstrap-commit", type: "commit" } } }
    }
    throw new Error(`Unexpected request: ${request.method} ${request.url}`)
  })
  try {
    const client = new GitHubClient(
      { token: "token", owner: "owner", repo: "repo", branch: "main" },
      { transportPolicy: { mutationSpacingMs: 0 } },
    )
    const ref = await client.ensureGitRepositoryInitialized()
    assert.equal(ref?.sha, "bootstrap-commit")
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
    if (request.method === "PUT") return { status: 201, text: "", headers: {}, json: { commit: { sha: "bootstrap-commit" } } }
    if (request.method === "GET" && request.url.includes("/git/ref/heads/v4-sync")) {
      return customExists
        ? { status: 200, text: "", headers: {}, json: { ref: "refs/heads/v4-sync", object: { sha: "bootstrap-commit", type: "commit" } } }
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
    assert.equal(ref?.sha, "bootstrap-commit")
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
    if (request.url.includes("/contents/")) return { status: 200, text: "", headers: {}, json: { content: "YQ==", encoding: "base64", sha: "blob" }, arrayBuffer: new ArrayBuffer(0) }
    if (request.url.includes("/git/commits/")) return { status: 200, text: "", headers: {}, json: { sha: "commit-sha", tree: { sha: "tree" }, parents: [] } }
    if (request.url.includes("/git/ref/heads/")) return { status: 200, text: "", headers: {}, json: { ref: "refs/heads/main", object: { sha: "commit-sha", type: "commit" } } }
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
