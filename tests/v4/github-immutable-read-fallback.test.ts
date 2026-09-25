import assert from "node:assert/strict";
import test from "node:test";
import { setRequestUrlHandler } from "obsidian";

import { GitHubClient } from "../../src/lib/github-api";

const COMMIT_SHA = "0".repeat(40);
const ROOT_TREE_SHA = "1".repeat(40);
const DIR_TREE_SHA = "2".repeat(40);
const NESTED_TREE_SHA = "3".repeat(40);
const BLOB_SHA = "4".repeat(40);
const EXEC_BLOB_SHA = "5".repeat(40);
const OTHER_TREE_SHA = "6".repeat(40);
const GITLINK_SHA = "7".repeat(40);

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

function treeNode(path: unknown, type: unknown, mode: unknown, sha: unknown) {
  return { path, type, mode, sha, url: "" };
}

function treePayload(sha: string, truncated: unknown, tree: unknown) {
  return { sha, url: "", truncated, tree };
}

interface Scenario {
  contents?: { status: number; json?: unknown; bytes?: Uint8Array; text?: string };
  commit?: { status: number; json?: unknown; text?: string };
  trees?: Record<string, { status?: number; json?: unknown; text?: string }>;
  blobs?: Record<string, { status?: number; bytes?: Uint8Array; text?: string }>;
}

async function runScenario<T>(path: string, ref: string, scenario: Scenario, task: (client: GitHubClient, urls: string[]) => Promise<T>): Promise<T> {
  const urls: string[] = [];
  setRequestUrlHandler(async (options: unknown) => {
    const request = options as { url: string };
    urls.push(request.url);
    const parsed = new URL(request.url);
    if (parsed.pathname.includes("/contents/")) return response(scenario.contents ?? { status: 404, text: "not visible yet" });
    if (parsed.pathname.endsWith(`/git/commits/${COMMIT_SHA}`)) {
      return response(scenario.commit ?? { status: 200, json: { sha: COMMIT_SHA, tree: { sha: ROOT_TREE_SHA }, parents: [] } });
    }
    const treeMatch = parsed.pathname.match(/\/git\/trees\/([^/]+)$/u);
    if (treeMatch) {
      const sha = decodeURIComponent(treeMatch[1]);
      const item = scenario.trees?.[sha];
      if (!item) throw new Error(`Unexpected tree request: ${sha}`);
      return response({ status: item.status ?? 200, json: item.json, text: item.text });
    }
    const blobMatch = parsed.pathname.match(/\/git\/blobs\/([^/]+)$/u);
    if (blobMatch) {
      const sha = decodeURIComponent(blobMatch[1]);
      const item = scenario.blobs?.[sha];
      if (!item) throw new Error(`Unexpected blob request: ${sha}`);
      return response({ status: item.status ?? 200, bytes: item.bytes, text: item.text });
    }
    throw new Error(`Unexpected request: ${request.url}`);
  });
  try {
    const client = new GitHubClient({ token: "token", owner: "owner", repo: "repo", branch: "main" }, { transportPolicy: { mutationSpacingMs: 0 } });
    return await task(client, urls);
  } finally {
    setRequestUrlHandler(null);
  }
}

test("immutable Contents 404 traverses only the exact deep path with non-recursive trees", async () => {
  const payload = new TextEncoder().encode("freshly-published\n");
  await runScenario("dir/nested/file.md", COMMIT_SHA, {
    trees: {
      [ROOT_TREE_SHA]: { json: treePayload(ROOT_TREE_SHA, false, [treeNode("dir", "tree", "040000", DIR_TREE_SHA), treeNode("unrelated", "tree", "040000", OTHER_TREE_SHA)]) },
      [DIR_TREE_SHA]: { json: treePayload(DIR_TREE_SHA, false, [treeNode("nested", "tree", "040000", NESTED_TREE_SHA)]) },
      [NESTED_TREE_SHA]: { json: treePayload(NESTED_TREE_SHA, false, [treeNode("file.md", "blob", "100644", BLOB_SHA)]) },
    },
    blobs: { [BLOB_SHA]: { bytes: payload } },
  }, async (client, urls) => {
    const file = await client.getFileBytes("dir/nested/file.md", COMMIT_SHA);
    assert.deepEqual(file?.bytes, payload);
    assert.equal(file?.sha, BLOB_SHA);
    assert.equal(urls.filter(url => url.includes("/git/commits/")).length, 1);
    assert.equal(urls.filter(url => url.includes("/git/trees/")).length, 3);
    assert.equal(urls.filter(url => url.includes("/git/blobs/")).length, 1);
    assert.equal(urls.some(url => url.includes("recursive=1")), false);
    assert.equal(urls.some(url => url.includes(OTHER_TREE_SHA)), false);
  });
});

test("exact Unicode/punctuation paths, executable blobs, and positive truncated entries succeed", async () => {
  const unicodePayload = new TextEncoder().encode("unicode\n");
  const unicodePath = "folder space/π ![]()#.md";
  await runScenario(unicodePath, COMMIT_SHA, {
    trees: {
      [ROOT_TREE_SHA]: { json: treePayload(ROOT_TREE_SHA, false, [treeNode("folder space", "tree", "040000", DIR_TREE_SHA)]) },
      [DIR_TREE_SHA]: { json: treePayload(DIR_TREE_SHA, false, [treeNode("π ![]()#.md", "blob", "100644", BLOB_SHA)]) },
    },
    blobs: { [BLOB_SHA]: { bytes: unicodePayload } },
  }, async (client, urls) => {
    assert.deepEqual((await client.getFileBytes(unicodePath, COMMIT_SHA))?.bytes, unicodePayload);
    assert.equal(urls.some(url => url.includes("folder%20space/%CF%80%20!%5B%5D()%23.md")), true);
  });

  const executable = new TextEncoder().encode("#!/bin/sh\n");
  await runScenario("tool.sh", COMMIT_SHA, {
    trees: { [ROOT_TREE_SHA]: { json: treePayload(ROOT_TREE_SHA, false, [treeNode("tool.sh", "blob", "100755", EXEC_BLOB_SHA)]) } },
    blobs: { [EXEC_BLOB_SHA]: { bytes: executable } },
  }, async client => assert.deepEqual((await client.getFileBytes("tool.sh", COMMIT_SHA))?.bytes, executable));

  const positive = new TextEncoder().encode("positive\n");
  await runScenario("found.md", COMMIT_SHA, {
    trees: { [ROOT_TREE_SHA]: { json: treePayload(ROOT_TREE_SHA, true, [treeNode("found.md", "blob", "100644", BLOB_SHA)]) } },
    blobs: { [BLOB_SHA]: { bytes: positive } },
  }, async client => assert.deepEqual((await client.getFileBytes("found.md", COMMIT_SHA))?.bytes, positive));
});

test("complete evidence returns null for structural regular-file absence", async () => {
  await runScenario("missing.md", COMMIT_SHA, { trees: { [ROOT_TREE_SHA]: { json: treePayload(ROOT_TREE_SHA, false, []) } } }, async client => {
    assert.equal(await client.getFileBytes("missing.md", COMMIT_SHA), null);
  });
  await runScenario("missing/file.md", COMMIT_SHA, { trees: { [ROOT_TREE_SHA]: { json: treePayload(ROOT_TREE_SHA, false, [treeNode("other", "tree", "040000", OTHER_TREE_SHA)]) } } }, async client => {
    assert.equal(await client.getFileBytes("missing/file.md", COMMIT_SHA), null);
  });

  for (const node of [
    treeNode("blocked", "blob", "100644", BLOB_SHA),
    treeNode("blocked", "blob", "100755", BLOB_SHA),
    treeNode("blocked", "blob", "120000", BLOB_SHA),
    treeNode("blocked", "commit", "160000", GITLINK_SHA),
  ]) {
    await runScenario("blocked/file.md", COMMIT_SHA, { trees: { [ROOT_TREE_SHA]: { json: treePayload(ROOT_TREE_SHA, false, [node]) } } }, async (client, urls) => {
      assert.equal(await client.getFileBytes("blocked/file.md", COMMIT_SHA), null);
      assert.equal(urls.filter(url => url.includes("/git/trees/")).length, 1);
    });
  }

  for (const node of [treeNode("target", "tree", "040000", DIR_TREE_SHA), treeNode("target", "commit", "160000", GITLINK_SHA)]) {
    await runScenario("target", COMMIT_SHA, { trees: { [ROOT_TREE_SHA]: { json: treePayload(ROOT_TREE_SHA, false, [node]) } } }, async client => {
      assert.equal(await client.getFileBytes("target", COMMIT_SHA), null);
    });
  }
});

test("absence requires truncated === false at the level proving absence", async () => {
  const incompletePayloads: unknown[] = [
    treePayload(ROOT_TREE_SHA, true, []),
    { sha: ROOT_TREE_SHA, url: "", tree: [] },
    treePayload(ROOT_TREE_SHA, null, []),
    treePayload(ROOT_TREE_SHA, "false", []),
  ];
  for (const payload of incompletePayloads) {
    await runScenario("missing.md", COMMIT_SHA, { trees: { [ROOT_TREE_SHA]: { json: payload } } }, async client => {
      await assert.rejects(() => client.getFileBytes("missing.md", COMMIT_SHA), /immutable.*tree.*incomplete|incomplete.*immutable/iu);
    });
  }

  await runScenario("dir/missing.md", COMMIT_SHA, {
    trees: {
      [ROOT_TREE_SHA]: { json: treePayload(ROOT_TREE_SHA, false, [treeNode("dir", "tree", "040000", DIR_TREE_SHA)]) },
      [DIR_TREE_SHA]: { json: treePayload(DIR_TREE_SHA, true, []) },
    },
  }, async client => {
    await assert.rejects(() => client.getFileBytes("dir/missing.md", COMMIT_SHA), /immutable.*tree.*incomplete|incomplete.*immutable/iu);
  });
});

test("duplicate exact names and malformed tree/node evidence fail closed", async () => {
  await runScenario("dup.md", COMMIT_SHA, {
    trees: { [ROOT_TREE_SHA]: { json: treePayload(ROOT_TREE_SHA, false, [treeNode("dup.md", "blob", "100644", BLOB_SHA), treeNode("dup.md", "blob", "100644", EXEC_BLOB_SHA)]) } },
  }, async client => {
    await assert.rejects(() => client.getFileBytes("dup.md", COMMIT_SHA), /duplicate.*exact.*entry|duplicate.*dup\.md/iu);
  });

  const malformed: unknown[] = [
    treePayload(ROOT_TREE_SHA, false, {}),
    treePayload(ROOT_TREE_SHA, false, [treeNode(42, "blob", "100644", BLOB_SHA)]),
    treePayload(ROOT_TREE_SHA, false, [treeNode("target.md", "tag", "100644", BLOB_SHA)]),
    treePayload(ROOT_TREE_SHA, false, [treeNode("target.md", "blob", 100644, BLOB_SHA)]),
    treePayload(ROOT_TREE_SHA, false, [treeNode("target.md", "blob", "100644", "short")]),
  ];
  for (const payload of malformed) {
    await runScenario("target.md", COMMIT_SHA, { trees: { [ROOT_TREE_SHA]: { json: payload } } }, async client => {
      await assert.rejects(() => client.getFileBytes("target.md", COMMIT_SHA), /immutable.*tree.*malformed|malformed.*immutable|unsupported.*git.*object/iu);
    });
  }
});

test("managed-path symlinks and unsupported final mode/type combinations fail closed", async () => {
  await runScenario("link.md", COMMIT_SHA, {
    trees: { [ROOT_TREE_SHA]: { json: treePayload(ROOT_TREE_SHA, false, [treeNode("link.md", "blob", "120000", BLOB_SHA)]) } },
  }, async client => {
    await assert.rejects(() => client.getFileBytes("link.md", COMMIT_SHA), /symlink.*unsupported|unsupported.*symlink/iu);
  });

  for (const node of [
    treeNode("target", "blob", "040000", BLOB_SHA),
    treeNode("target", "tree", "100644", DIR_TREE_SHA),
    treeNode("target", "commit", "100644", GITLINK_SHA),
    treeNode("target", "blob", "100600", BLOB_SHA),
  ]) {
    await runScenario("target", COMMIT_SHA, { trees: { [ROOT_TREE_SHA]: { json: treePayload(ROOT_TREE_SHA, false, [node]) } } }, async client => {
      await assert.rejects(() => client.getFileBytes("target", COMMIT_SHA), /unsupported.*git.*object|invalid.*mode|mode.*type/iu);
    });
  }
});

test("commit root SHA and downstream Git API failures propagate", async () => {
  for (const value of [undefined, "", "short"] as const) {
    await runScenario("target.md", COMMIT_SHA, {
      commit: { status: 200, json: { sha: COMMIT_SHA, tree: value === undefined ? {} : { sha: value }, parents: [] } },
    }, async (client, urls) => {
      await assert.rejects(() => client.getFileBytes("target.md", COMMIT_SHA), /immutable.*commit.*tree.*sha|tree.*sha.*immutable/iu);
      assert.equal(urls.some(url => url.includes("/git/trees/")), false);
    });
  }

  await runScenario("target.md", COMMIT_SHA, { trees: { [ROOT_TREE_SHA]: { status: 503, text: "tree unavailable" } } }, async client => {
    await assert.rejects(() => client.getFileBytes("target.md", COMMIT_SHA), /Failed to get historical tree.*503/iu);
  });
  await runScenario("target.md", COMMIT_SHA, {
    trees: { [ROOT_TREE_SHA]: { json: treePayload(ROOT_TREE_SHA, false, [treeNode("target.md", "blob", "100644", BLOB_SHA)]) } },
    blobs: { [BLOB_SHA]: { status: 502, text: "blob unavailable" } },
  }, async client => {
    await assert.rejects(() => client.getFileBytes("target.md", COMMIT_SHA), /Failed to get blob.*502/iu);
  });
});

test("invalid immutable path segments fail without reinterpretation", async () => {
  for (const path of ["", "/a.md", "a.md/", "a//b.md", "a/./b.md", "a/../b.md"]) {
    await runScenario(path, COMMIT_SHA, {}, async (client, urls) => {
      await assert.rejects(() => client.getFileBytes(path, COMMIT_SHA), /invalid.*immutable.*path|immutable.*path.*segment/iu);
      assert.equal(urls.some(url => url.includes("/git/commits/")), false);
    });
  }
});

test("mutable 404 and successful Contents behavior remain unchanged", async () => {
  await runScenario("missing.md", "main", {}, async (client, urls) => {
    assert.equal(await client.getFileBytes("missing.md", "main"), null);
    assert.equal(urls.length, 1);
    assert.equal(urls.some(url => url.includes("/git/")), false);
  });

  const payload = new TextEncoder().encode("contents-success\n");
  const content = Buffer.from(payload).toString("base64");
  await runScenario("direct.md", COMMIT_SHA, { contents: { status: 200, json: { content, encoding: "base64", sha: "contents-sha" } } }, async (client, urls) => {
    const file = await client.getFileBytes("direct.md", COMMIT_SHA);
    assert.deepEqual(file?.bytes, payload);
    assert.equal(file?.sha, "contents-sha");
    assert.equal(urls.length, 1);
  });
});
