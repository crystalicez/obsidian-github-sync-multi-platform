import assert from "node:assert/strict";
import test from "node:test";
import { setRequestUrlHandler } from "obsidian";

import { GitHubClient } from "../../src/lib/github-api";

const COMMIT_SHA = "0123456789abcdef0123456789abcdef01234567";
const BLOB_SHA = "89abcdef0123456789abcdef0123456789abcdef";

function response(input: { status: number; json?: unknown; bytes?: Uint8Array; text?: string }) {
  const bytes = input.bytes ?? new Uint8Array();
  return {
    status: input.status,
    text: input.text ?? "",
    headers: {},
    json: input.json,
    arrayBuffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

test("GitHubClient recovers an immutable file from the exact Git tree when Contents temporarily reports 404", async () => {
  const payload = new TextEncoder().encode("freshly-published\n");
  const urls: string[] = [];
  setRequestUrlHandler(async (options: unknown) => {
    const request = options as { url: string };
    urls.push(request.url);
    if (request.url.includes("/contents/fresh.md?")) return response({ status: 404, text: "not visible yet" });
    if (request.url.endsWith(`/git/commits/${COMMIT_SHA}`)) {
      return response({ status: 200, json: { sha: COMMIT_SHA, tree: { sha: "tree-exact" }, parents: [] } });
    }
    if (request.url.endsWith("/git/trees/tree-exact?recursive=1")) {
      return response({
        status: 200,
        json: {
          sha: "tree-exact",
          url: "",
          truncated: false,
          tree: [{ path: "fresh.md", mode: "100644", type: "blob", sha: BLOB_SHA, size: payload.byteLength, url: "" }],
        },
      });
    }
    if (request.url.endsWith(`/git/blobs/${BLOB_SHA}`)) return response({ status: 200, bytes: payload });
    throw new Error(`Unexpected request: ${request.url}`);
  });

  try {
    const client = new GitHubClient(
      { token: "token", owner: "owner", repo: "repo", branch: "main" },
      { transportPolicy: { mutationSpacingMs: 0 } },
    );
    const file = await client.getFileBytes("fresh.md", COMMIT_SHA);
    assert.deepEqual(file?.bytes, payload);
    assert.equal(file?.sha, BLOB_SHA);
    assert.equal(urls.length, 4);
  } finally {
    setRequestUrlHandler(null);
  }
});

test("GitHubClient returns null after the exact immutable tree confirms the path is absent", async () => {
  let blobReads = 0;
  setRequestUrlHandler(async (options: unknown) => {
    const request = options as { url: string };
    if (request.url.includes("/contents/missing.md?")) return response({ status: 404 });
    if (request.url.endsWith(`/git/commits/${COMMIT_SHA}`)) {
      return response({ status: 200, json: { sha: COMMIT_SHA, tree: { sha: "tree-exact" }, parents: [] } });
    }
    if (request.url.endsWith("/git/trees/tree-exact?recursive=1")) {
      return response({ status: 200, json: { sha: "tree-exact", url: "", truncated: false, tree: [] } });
    }
    if (request.url.includes("/git/blobs/")) blobReads++;
    throw new Error(`Unexpected request: ${request.url}`);
  });

  try {
    const client = new GitHubClient(
      { token: "token", owner: "owner", repo: "repo", branch: "main" },
      { transportPolicy: { mutationSpacingMs: 0 } },
    );
    assert.equal(await client.getFileBytes("missing.md", COMMIT_SHA), null);
    assert.equal(blobReads, 0);
  } finally {
    setRequestUrlHandler(null);
  }
});

test("GitHubClient does not treat a truncated immutable tree as proof that a 404 path is absent", async () => {
  setRequestUrlHandler(async (options: unknown) => {
    const request = options as { url: string };
    if (request.url.includes("/contents/maybe.md?")) return response({ status: 404 });
    if (request.url.endsWith(`/git/commits/${COMMIT_SHA}`)) {
      return response({ status: 200, json: { sha: COMMIT_SHA, tree: { sha: "tree-truncated" }, parents: [] } });
    }
    if (request.url.endsWith("/git/trees/tree-truncated?recursive=1")) {
      return response({ status: 200, json: { sha: "tree-truncated", url: "", truncated: true, tree: [] } });
    }
    throw new Error(`Unexpected request: ${request.url}`);
  });

  try {
    const client = new GitHubClient(
      { token: "token", owner: "owner", repo: "repo", branch: "main" },
      { transportPolicy: { mutationSpacingMs: 0 } },
    );
    await assert.rejects(
      () => client.getFileBytes("maybe.md", COMMIT_SHA),
      /truncated.*immutable.*404|immutable.*tree.*truncated/iu,
    );
  } finally {
    setRequestUrlHandler(null);
  }
});
