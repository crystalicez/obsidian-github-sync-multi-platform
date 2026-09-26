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
        sha: "1111111111111111111111111111111111111111",
        commit: { message: "obsidian-sync-v4:journal-1", author: { date: "2026-07-13T00:00:00Z", name: "Sync" } },
        parents: [{ sha: "2222222222222222222222222222222222222222" }],
      }],
    };
  });
  try {
    const client = new GitHubClient({ token: "token", owner: "owner", repo: "repo", branch: "main" }, { transportPolicy: { mutationSpacingMs: 0 } });
    const commits = await client.listCommits({ page: 2, perPage: 50 });

    assert.equal(commits[0].sha, "1111111111111111111111111111111111111111");
    assert.deepEqual(commits[0].parentShas, ["2222222222222222222222222222222222222222"]);
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
    if (request.method === "POST") return { status: 201, text: "", headers: {}, json: { ref: "refs/heads/v4", object: { sha: "3333333333333333333333333333333333333333" } } };
    return { status: 200, text: "", headers: {}, json: { sha: "4444444444444444444444444444444444444444", url: "", tree: [], truncated: false } };
  });
  try {
    const client = new GitHubClient({ token: "token", owner: "owner", repo: "repo", branch: "v4" }, { transportPolicy: { mutationSpacingMs: 0 } });
    const tree = await client.getTreeAt("4444444444444444444444444444444444444444", false);
    await client.createGitRef("3333333333333333333333333333333333333333");

    assert.equal(tree.sha, "4444444444444444444444444444444444444444");
    assert.equal(requests[0].url.endsWith("/git/trees/tree-old"), true);
    assert.deepEqual(JSON.parse(requests[1].body), { ref: "refs/heads/v4", sha: "3333333333333333333333333333333333333333" });
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
    const file = await client.getFileBytes("binary.enc", "9999999999999999999999999999999999999999")
    assert.deepEqual(file?.bytes, raw)
    assert.equal(file?.sha, blobSha)
    assert.equal(requests.length, 2)
    assert.equal(requests.some(url => url.endsWith(`/git/blobs/${blobSha}`)), true)
  } finally {
    setRequestUrlHandler(null)
  }
})

test("GitHubClient fails closed when Git object authentication itself is unavailable", async () => {
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
    await assert.rejects(
      () => client.getFileBytes("binary.enc", "9999999999999999999999999999999999999999"),
      /verify.*blob|blob.*verification|digest/iu,
    )
    assert.equal(requests.length, 2)
    assert.equal(requests.filter(url => url.endsWith(`/git/blobs/${blobSha}`)).length, 1)
  } finally {
    crypto.subtle.digest = originalDigest
    setRequestUrlHandler(null)
  }
})

test("GitHubClient bootstraps a truly empty repository before Git ref writes", async () => {
  const requests: Array<Record<string, any>> = [];
  setRequestUrlHandler(async (options: unknown) => {
    const request = options as Record<string, any>;
    requests.push(request);
    if (request.url.includes("/git/refs?")) return { status: 409, text: "Git Repository is empty.", headers: {}, json: {} };
    if (request.method === "PUT") return { status: 201, text: "", headers: {}, json: { commit: { sha: "cccccccccccccccccccccccccccccccccccccccc" } } };
    if (request.method === "GET" && request.url.includes("/git/ref/heads/")) {
      return { status: 200, text: "", headers: {}, json: { ref: "refs/heads/main", object: { sha: "cccccccccccccccccccccccccccccccccccccccc", type: "commit" } } };
    }
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  });
  try {
    const client = new GitHubClient({ token: "token", owner: "owner", repo: "repo", branch: "main" }, { transportPolicy: { mutationSpacingMs: 0 } });
    const ref = await client.ensureGitRepositoryInitialized();

    assert.equal(ref?.sha, "cccccccccccccccccccccccccccccccccccccccc");
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
    if (request.method === "PUT") return { status: 201, text: "", headers: {}, json: { commit: { sha: "cccccccccccccccccccccccccccccccccccccccc" } } };
    if (request.method === "GET" && request.url.includes("/git/ref/heads/v4-sync")) {
      customRefReads++;
      return customRefReads === 1
        ? { status: 404, text: "missing", headers: {}, json: {} }
        : { status: 200, text: "", headers: {}, json: { ref: "refs/heads/v4-sync", object: { sha: "cccccccccccccccccccccccccccccccccccccccc", type: "commit" } } };
    }
    if (request.method === "POST" && request.url.endsWith("/git/refs")) return { status: 201, text: "", headers: {}, json: {} };
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  });
  try {
    const client = new GitHubClient({ token: "token", owner: "owner", repo: "repo", branch: "v4-sync" }, { transportPolicy: { mutationSpacingMs: 0 } });
    const ref = await client.ensureGitRepositoryInitialized();
    assert.equal(ref?.ref, "refs/heads/v4-sync");
    const createRef = requests.find(request => request.method === "POST")!;
    assert.deepEqual(JSON.parse(createRef.body), { ref: "refs/heads/v4-sync", sha: "cccccccccccccccccccccccccccccccccccccccc" });
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
      return { status: 200, text: "", headers: {}, json: { content: "", encoding: "none", sha: "413c6a76c6527732a74dbfab3c20d471cb38a573" }, arrayBuffer: new ArrayBuffer(0) };
    }
    return { status: 200, text: "payload", headers: {}, json: undefined, arrayBuffer: new TextEncoder().encode("large payload").buffer };
  });
  try {
    const client = new GitHubClient({ token: "token", owner: "owner", repo: "repo", branch: "main" }, { transportPolicy: { mutationSpacingMs: 0 } });
    const file = await client.getFileBytes("large.bin", "9999999999999999999999999999999999999999");
    assert.equal(new TextDecoder().decode(file!.bytes), "large payload");
    assert.equal(file!.sha, "413c6a76c6527732a74dbfab3c20d471cb38a573");
    assert.equal(requests.some(url => url.endsWith("/git/blobs/413c6a76c6527732a74dbfab3c20d471cb38a573")), true);
  } finally {
    setRequestUrlHandler(null);
  }
});

test("GitHubClient retries a lost blob response because the immutable mutation is idempotent", async () => {
  let attempts = 0
  setRequestUrlHandler(async () => {
    attempts++
    if (attempts === 1) throw new Error("blob response lost")
    return { status: 201, text: "", headers: {}, json: { sha: "5555555555555555555555555555555555555555" } }
  })
  try {
    const client = new GitHubClient(
      { token: "token", owner: "owner", repo: "repo", branch: "main" },
      { transportPolicy: { mutationSpacingMs: 0 } },
    )
    assert.equal(await client.createGitBlob(new TextEncoder().encode("body")), "5555555555555555555555555555555555555555")
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
    return { status: 201, text: "", headers: {}, json: { sha: "6666666666666666666666666666666666666666" } }
  })
  try {
    const client = new GitHubClient(
      { token: "token", owner: "owner", repo: "repo", branch: "main" },
      { transportPolicy: { mutationSpacingMs: 0 } },
    )
    assert.equal(await client.createGitTree([{ path: "A", mode: "100644", type: "blob", sha: "5555555555555555555555555555555555555555" }]), "6666666666666666666666666666666666666666")
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
    return { status: 201, text: "", headers: {}, json: { sha: "7777777777777777777777777777777777777777" } }
  })
  try {
    const client = new GitHubClient(
      { token: "token", owner: "owner", repo: "repo", branch: "main" },
      { transportPolicy: { mutationSpacingMs: 0 } },
    )
    assert.equal(
      await client.createGitCommit("obsidian-sync-v4:j", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", ["base"], { originalCannotBeReachable: true }),
      "7777777777777777777777777777777777777777",
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
      () => client.updateGitRef("8888888888888888888888888888888888888888", "base"),
      error => (error as Error).name === "V4GitMutationOutcomeUnknownError",
    )
    assert.equal(attempts, 1)
  } finally {
    setRequestUrlHandler(null)
  }
})

test("empty-repository bootstrap replans after a lost Contents PUT once repository state appears", async () => {
  let initialized = false
  let puts = 0
  setRequestUrlHandler(async (options: unknown) => {
    const request = options as Record<string, any>
    if (request.url.includes("/git/refs?")) {
      return initialized
        ? { status: 200, text: "", headers: {}, json: [{ ref: "refs/heads/main", object: { sha: "cccccccccccccccccccccccccccccccccccccccc", type: "commit" } }] }
        : { status: 409, text: "empty", headers: {}, json: {} }
    }
    if (request.method === "PUT") {
      puts++
      initialized = true
      throw new Error("bootstrap response lost")
    }
    throw new Error(`Unexpected request: ${request.method} ${request.url}`)
  })
  try {
    const client = new GitHubClient(
      { token: "token", owner: "owner", repo: "repo", branch: "main" },
      { transportPolicy: { mutationSpacingMs: 0 } },
    )
    await assert.rejects(
      () => client.ensureGitRepositoryInitialized(),
      error => {
        const candidate = error as Error & { code?: string; observedRefSha?: string }
        assert.equal(candidate.name, "V4RepositoryBootstrapRaceError")
        assert.equal(candidate.code, "V4_REPOSITORY_BOOTSTRAP_RACE")
        assert.equal(candidate.observedRefSha, "cccccccccccccccccccccccccccccccccccccccc")
        return true
      },
    )
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
    if (request.method === "PUT") return { status: 201, text: "", headers: {}, json: { commit: { sha: "cccccccccccccccccccccccccccccccccccccccc" } } }
    if (request.method === "GET" && request.url.includes("/git/ref/heads/v4-sync")) {
      return customExists
        ? { status: 200, text: "", headers: {}, json: { ref: "refs/heads/v4-sync", object: { sha: "cccccccccccccccccccccccccccccccccccccccc", type: "commit" } } }
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
    assert.equal(ref?.sha, "cccccccccccccccccccccccccccccccccccccccc")
    assert.equal(posts, 1)
  } finally {
    setRequestUrlHandler(null)
  }
})

test("transport metrics are in-memory and contain no request path or response body", async () => {
  setRequestUrlHandler(async () => ({ status: 201, text: "SECRET RESPONSE", headers: {}, json: { sha: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" } }))
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
      () => client.createGitRef("8888888888888888888888888888888888888888"),
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
    if (request.url.includes("/git/commits/")) return { status: 200, text: "", headers: {}, json: { sha: "9999999999999999999999999999999999999999", tree: { sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, parents: [] } }
    if (request.url.includes("/git/ref/heads/")) return { status: 200, text: "", headers: {}, json: { ref: "refs/heads/main", object: { sha: "9999999999999999999999999999999999999999", type: "commit" } } }
    throw new Error(`unexpected:${request.url}`)
  })
  try {
    const client = new GitHubClient(
      { token: "token", owner: "owner", repo: "repo", branch: "main" },
      { transportPolicy: { mutationSpacingMs: 0 } },
    )
    await client.getFileBytes("A.md", "9999999999999999999999999999999999999999")
    await client.getGitCommit("9999999999999999999999999999999999999999")
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
    return { status: 201, text: "", headers: {}, json: { sha: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" } }
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
  setRequestUrlHandler(async () => ({ status: 201, text: "é", headers: {}, json: { sha: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" } }))
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


test("empty-repository bootstrap treats an unknown Contents outcome plus a newly observed competitor ref as a bootstrap race", async () => {
  let initialized = false;
  let puts = 0;
  setRequestUrlHandler(async (options: unknown) => {
    const request = options as Record<string, any>;
    if (request.url.includes("/git/refs?")) {
      return initialized
        ? { status: 200, text: "", headers: {}, json: [{ ref: "refs/heads/main", object: { sha: "dddddddddddddddddddddddddddddddddddddddd", type: "commit" } }] }
        : { status: 409, text: "empty", headers: {}, json: {} };
    }
    if (request.method === "PUT") {
      puts++;
      initialized = true;
      throw new Error("bootstrap response lost while another initializer won");
    }
    if (request.method === "GET" && request.url.includes("/git/ref/heads/main")) {
      return { status: 200, text: "", headers: {}, json: { ref: "refs/heads/main", object: { sha: "dddddddddddddddddddddddddddddddddddddddd", type: "commit" } } };
    }
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  });

  try {
    const client = new GitHubClient(
      { token: "token", owner: "owner", repo: "repo", branch: "main" },
      { transportPolicy: { mutationSpacingMs: 0 } },
    );

    await assert.rejects(
      () => client.ensureGitRepositoryInitialized(),
      error => {
        const candidate = error as Error & { code?: string; observedRefSha?: string };
        assert.equal(candidate.name, "V4RepositoryBootstrapRaceError");
        assert.equal(candidate.code, "V4_REPOSITORY_BOOTSTRAP_RACE");
        assert.equal(candidate.observedRefSha, "dddddddddddddddddddddddddddddddddddddddd");
        return true;
      },
    );
    assert.equal(puts, 1);
  } finally {
    setRequestUrlHandler(null);
  }
});


test("GitHub client rejects malformed successful ref and commit responses at the read boundary", async () => {
  setRequestUrlHandler(async (options: unknown) => {
    const request = options as Record<string, any>;
    if (request.url.includes("/git/ref/heads/main")) {
      return { status: 200, text: "", headers: {}, json: { ref: "refs/heads/main", object: { type: "commit" } } };
    }
    if (request.url.includes("/git/commits/")) {
      return { status: 200, text: "", headers: {}, json: { sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", parents: [] } };
    }
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  });
  try {
    const client = new GitHubClient({ token: "token", owner: "owner", repo: "repo", branch: "main" }, { transportPolicy: { mutationSpacingMs: 0 } });
    await assert.rejects(() => client.getGitRef(), /ref.*sha|malformed|invalid/iu);

    setRequestUrlHandler(async (options: unknown) => {
      const request = options as Record<string, any>;
      if (request.url.includes("/git/commits/")) {
        return { status: 200, text: "", headers: {}, json: { sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", parents: [] } };
      }
      throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    });
    await assert.rejects(() => client.getGitCommit("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"), /tree.*sha|malformed|invalid/iu);
  } finally {
    setRequestUrlHandler(null);
  }
});

test("GitHub client rejects malformed successful immutable-object mutation responses before dependent writes", async () => {
  setRequestUrlHandler(async (options: unknown) => {
    const request = options as Record<string, any>;
    if (request.method === "POST" && request.url.endsWith("/git/blobs")) {
      return { status: 201, text: "", headers: {}, json: {} };
    }
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  });
  try {
    const client = new GitHubClient({ token: "token", owner: "owner", repo: "repo", branch: "main" }, { transportPolicy: { mutationSpacingMs: 0 } });
    await assert.rejects(() => client.createGitBlob(new Uint8Array([1])), /blob.*sha|malformed|invalid/iu);
  } finally {
    setRequestUrlHandler(null);
  }
});


test("GitHubClient rejects a Contents payload with a malformed Git object SHA instead of trusting unverified bytes", async () => {
  let requests = 0;
  setRequestUrlHandler(async () => {
    requests++;
    return {
      status: 200,
      text: "",
      headers: {},
      json: { content: toBase64(new TextEncoder().encode("tampered")), encoding: "base64", sha: "not-a-git-sha" },
      arrayBuffer: new ArrayBuffer(0),
    };
  });
  try {
    const client = new GitHubClient(
      { token: "token", owner: "owner", repo: "repo", branch: "main" },
      { transportPolicy: { mutationSpacingMs: 0 } },
    );
    await assert.rejects(
      () => client.getFileBytes("binary.enc", "0123456789abcdef0123456789abcdef01234567"),
      /contents.*sha|git object.*sha|malformed/iu,
    );
    assert.equal(requests, 1);
  } finally {
    setRequestUrlHandler(null);
  }
});


test("GitHubClient rejects a raw Git Blob 200 whose bytes do not match the requested object SHA", async () => {
  const expectedSha = "2e65efe2a145dda7ee51d1741299f848e5bf752e";
  setRequestUrlHandler(async () => ({
    status: 200,
    text: "",
    headers: {},
    json: undefined,
    arrayBuffer: new TextEncoder().encode("wrong").buffer,
  }));
  try {
    const client = new GitHubClient(
      { token: "token", owner: "owner", repo: "repo", branch: "main" },
      { transportPolicy: { mutationSpacingMs: 0 } },
    );
    await assert.rejects(
      () => client.getBlob(expectedSha),
      /blob.*sha|integrity|verification/iu,
    );
  } finally {
    setRequestUrlHandler(null);
  }
});


test("GitHubClient rejects malformed successful commit-list and tree responses", async () => {
  setRequestUrlHandler(async (options: unknown) => {
    const request = options as Record<string, any>;
    if (request.url.includes("/commits?")) {
      return { status: 200, text: "", headers: {}, json: { not: "an array" } };
    }
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  });
  try {
    const client = new GitHubClient(
      { token: "token", owner: "owner", repo: "repo", branch: "main" },
      { transportPolicy: { mutationSpacingMs: 0 } },
    );
    await assert.rejects(() => client.listCommits(), /commit.*list|malformed|array/iu);

    setRequestUrlHandler(async (options: unknown) => {
      const request = options as Record<string, any>;
      if (request.url.includes("/git/trees/")) {
        return { status: 200, text: "", headers: {}, json: { sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", tree: [] } };
      }
      throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    });
    await assert.rejects(() => client.getTreeAt("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", true), /tree.*truncated|malformed|boolean/iu);
  } finally {
    setRequestUrlHandler(null);
  }
});


test("GitHub client rejects non-object SHA strings in successful ref and immutable mutation responses", async () => {
  setRequestUrlHandler(async (options: unknown) => {
    const request = options as Record<string, any>;
    if (request.url.includes("/git/ref/heads/main")) {
      return { status: 200, text: "", headers: {}, json: { ref: "refs/heads/main", object: { sha: "not-a-sha", type: "commit" } } };
    }
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  });
  try {
    const client = new GitHubClient(
      { token: "token", owner: "owner", repo: "repo", branch: "main" },
      { transportPolicy: { mutationSpacingMs: 0 } },
    );
    await assert.rejects(() => client.getGitRef(), /invalid.*sha|malformed/iu);

    setRequestUrlHandler(async (options: unknown) => {
      const request = options as Record<string, any>;
      if (request.method === "POST" && request.url.endsWith("/git/blobs")) {
        return { status: 201, text: "", headers: {}, json: { sha: "not-a-sha" } };
      }
      throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    });
    await assert.rejects(() => client.createGitBlob(new Uint8Array([1])), /invalid.*sha|malformed/iu);
  } finally {
    setRequestUrlHandler(null);
  }
});
