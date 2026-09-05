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

async function runScenario<T>(
  path: string,
  ref: string,
  scenario: Scenario,
  task: (client: GitHubClient, urls: string[]) => Promise<T>,
): Promise<T> {
  const urls: string[] = [];
  setRequestUrlHandler(async (options: unknown) => {
    const request = options as { url: string };
    urls.push(request.url);
    const parsed = new URL(request.url);

    if (parsed.pathname.includes("/contents/")) {
      const item = scenario.contents ?? { status: 404, text: "not visible yet" };
      return response(item);
    }
    if (parsed.pathname.endsWith(`/git/commits/${COMMIT_SHA}`)) {
      const item = scenario.commit ?? {
        status: 200,
        json: { sha: COMMIT_SHA, tree: { sha: ROOT_TREE_SHA }, parents: [] },
      };
      return response(item);
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
    const client = new GitHubClient(
      { token: "token", owner: "owner", repo: "repo", branch: "main" },
      { transportPolicy: { mutationSpacingMs: 0 } },
    );
    return await task(client, urls);
  } finally {
    setRequestUrlHandler(null);
  }
}

test("immutable Contents 404 traverses only the exact deep path with non-recursive trees", async () => {
  const payload = new TextEncoder().encode("freshly-published\n");
  await runScenario("dir/nested/file.md", COMMIT_SHA, {
    trees: {
      [ROOT_TREE_SHA]: {
        json: treePayload(ROOT_TREE_SHA, false, [
          treeNode("dir", "tree", "040000", DIR_TREE_SHA),
          treeNode("unrelated", "tree", "040000", OTHER_TREE_SHA),
        ]),
      },
      [DIR_TREE_SHA]: {
        json: treePayload(DIR_TREE_SHA, false, [treeNode("nested", "tree", "040000", NESTED_TREE_SHA)]),
      },
      [NESTED_TREE_SHA]: {
        json: treePayload(NESTED_TREE_SHA, false, [treeNode("file.md", "blob", "100644", BLOB_SHA)]),
      },
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

test("immutable traversal preserves exact spaces punctuation and Unicode segments", async () => {
  const payload = new TextEncoder().encode("unicode\n");
  const path = "folder space/π ![]()#.md";
  await runScenario(path, COMMIT_SHA, {
    trees: {
      [ROOT_TREE_SHA]: { json: treePayload(ROOT_TREE_SHA, false, [treeNode("folder space", "tree", "040000", DIR_TREE_SHA)]) },
      [DIR_TREE_SHA]: { json: treePayload(DIR_TREE_SHA, false, [treeNode("π ![]()#.md", "blob", "100644", BLOB_SHA)]) },
    },
    blobs: { [BLOB_SHA]: { bytes: payload } },
  }, async (client, urls) => {
    const file = await client.getFileBytes(path, COMMIT_SHA);
    assert.deepEqual(file?.bytes, payload);
    assert.equal(urls.some(url => url.includes("folder%20space/%CF%80%20!%5B%5D()%23.md")), true);
    assert.equal(urls.some(url => url.includes("recursive=1")), false);
  });
});

test("immutable fallback accepts regular executable blobs", async () => {
  const payload = new TextEncoder().encode("#!/bin/sh\n");
  await runScenario("tool.sh", COMMIT_SHA, {
    trees: {
      [ROOT_TREE_SHA]: { json: treePayload(ROOT_TREE_SHA, false, [treeNode("tool.sh", "blob", "100755", EXEC_BLOB_SHA)]) },
    },
    blobs: { [EXEC_BLOB_SHA]: { bytes: payload } },
  }, async (client) => {
    const file = await client.getFileBytes("tool.sh", COMMIT_SHA);
    assert.deepEqual(file?.bytes, payload);
    assert.equal(file?.sha, EXEC_BLOB_SHA);
  });
});

test("positive exact entry evidence may be used from a truncated tree", async () => {
  const payload = new TextEncoder().encode("positive evidence\n");
  await runScenario("found.md", COMMIT_SHA, {
    trees: {
      [ROOT_TREE_SHA]: { json: treePayload(ROOT_TREE_SHA, true, [treeNode("found.md", "blob", "100644", BLOB_SHA)]) },
    },
    blobs: { [BLOB_SHA]: { bytes: payload } },
  }, async (client) => {
    assert.deepEqual((await client.getFileBytes("found.md", COMMIT_SHA))?.bytes, payload);
  });
});

test("complete tree evidence confirms final and intermediate absence", async () => {
  await runScenario("missing.md", COMMIT_SHA, {
    trees: { [ROOT_TREE_SHA]: { json: treePayload(ROOT_TREE_SHA, false, []) } },
  }, async (client) => {
    assert.equal(await client.getFileBytes("missing.md", COMMIT_SHA), null);
  });

  await runScenario("missing/file.md", COMMIT_SHA, {
    trees: { [ROOT_TREE_SHA]: { json: treePayload(ROOT_TREE_SHA, false, [treeNode("other", "tree", "040000", OTHER_TREE_SHA)]) } },
  }, async (client) => {
    assert.equal(await client.getFileBytes("missing/file.md", COMMIT_SHA), null);
  });
});

test("valid non-tree intermediate entries prove a deeper regular file is absent", async () => {
  for (const [name, node] of [
    ["blob", treeNode("blocked", "blob", "100644", BLOB_SHA)],
    ["executable", treeNode("blocked", "blob", "100755", BLOB_SHA)],
    ["symlink", treeNode("blocked", "blob", "120000", BLOB_SHA)],
    ["gitlink", treeNode("blocked", "commit", "160000", GITLINK_SHA)],
  ] as const) {
    await test.step(name, async () => {
      await runScenario("blocked/file.md", COMMIT_SHA, {
        trees: { [ROOT_TREE_SHA]: { json: treePayload(ROOT_TREE_SHA, false, [node]) } },
      }, async (client, urls) => {
        assert.equal(await client.getFileBytes("blocked/file.md", COMMIT_SHA), null);
        assert.equal(urls.filter(url => url.includes("/git/trees/")).length, 1);
      });
    });
  }
});

test("final tree and gitlink are confirmed regular-file absence", async () => {
  for (const [name, node] of [
    ["tree", treeNode("target", "tree", "040000", DIR_TREE_SHA)],
    ["gitlink", treeNode("target", "commit", "160000", GITLINK_SHA)],
  ] as const) {
    await test.step(name, async () => {
      await runScenario("target", COMMIT_SHA, {
        trees: { [ROOT_TREE_SHA]: { json: treePayload(ROOT_TREE_SHA, false, [node]) } },
      }, async (client) => {
        assert.equal(await client.getFileBytes("target", COMMIT_SHA), null);
      });
    });
  }
});

test("missing exact segment never becomes absence without explicit truncated false", async () => {
  for (const [name, payload] of [
    ["truncated true", treePayload(ROOT_TREE_SHA, true, [])],
    ["truncated missing", { sha: ROOT_TREE_SHA, url: "", tree: [] }],
    ["truncated null", treePayload(ROOT_TREE_SHA, null, [])],
    ["truncated string", treePayload(ROOT_TREE_SHA, "false", [])],
  ] as const) {
    await test.step(name, async () => {
      await runScenario("missing.md", COMMIT_SHA, {
        trees: { [ROOT_TREE_SHA]: { json: payload } },
      }, async (client) => {
        await assert.rejects(() => client.getFileBytes("missing.md", COMMIT_SHA), /immutable.*tree.*incomplete|incomplete.*immutable/iu);
      });
    });
  }
});

test("nested incomplete evidence fails closed independently of a complete parent", async () => {
  await runScenario("dir/missing.md", COMMIT_SHA, {
    trees: {
      [ROOT_TREE_SHA]: { json: treePayload(ROOT_TREE_SHA, false, [treeNode("dir", "tree", "040000", DIR_TREE_SHA)]) },
      [DIR_TREE_SHA]: { json: treePayload(DIR_TREE_SHA, true, []) },
    },
  }, async (client) => {
    await assert.rejects(() => client.getFileBytes("dir/missing.md", COMMIT_SHA), /immutable.*tree.*incomplete|incomplete.*immutable/iu);
  });
});

test("duplicate exact segment names are malformed evidence", async () => {
  await runScenario("dup.md", COMMIT_SHA, {
    trees: {
      [ROOT_TREE_SHA]: {
        json: treePayload(ROOT_TREE_SHA, false, [
          treeNode("dup.md", "blob", "100644", BLOB_SHA),
          treeNode("dup.md", "blob", "100644", EXEC_BLOB_SHA),
        ]),
      },
    },
  }, async (client) => {
    await assert.rejects(() => client.getFileBytes("dup.md", COMMIT_SHA), /duplicate.*exact.*entry|duplicate.*dup\.md/iu);
  });
});

test("malformed tree and matching-node fields fail closed", async () => {
  const cases: Array<[string, unknown]> = [
    ["tree is not an array", treePayload(ROOT_TREE_SHA, false, {})],
    ["entry path is not a string", treePayload(ROOT_TREE_SHA, false, [treeNode(42, "blob", "100644", BLOB_SHA)])],
    ["entry type is unsupported", treePayload(ROOT_TREE_SHA, false, [treeNode("target.md", "tag", "100644", BLOB_SHA)])],
    ["entry mode is not a string", treePayload(ROOT_TREE_SHA, false, [treeNode("target.md", "blob", 100644, BLOB_SHA)])],
    ["entry sha is malformed", treePayload(ROOT_TREE_SHA, false, [treeNode("target.md", "blob", "100644", "short")])],
  ];
  for (const [name, payload] of cases) {
    await test.step(name, async () => {
      await runScenario("target.md", COMMIT_SHA, {
        trees: { [ROOT_TREE_SHA]: { json: payload } },
      }, async (client) => {
        await assert.rejects(() => client.getFileBytes("target.md", COMMIT_SHA), /immutable.*tree.*malformed|malformed.*immutable|unsupported.*git.*object/iu);
      });
    });
  }
});

test("final symlink is an explicit unsupported managed-path object", async () => {
  await runScenario("link.md", COMMIT_SHA, {
    trees: {
      [ROOT_TREE_SHA]: { json: treePayload(ROOT_TREE_SHA, false, [treeNode("link.md", "blob", "120000", BLOB_SHA)]) },
    },
  }, async (client) => {
    await assert.rejects(() => client.getFileBytes("link.md", COMMIT_SHA), /symlink.*unsupported|unsupported.*symlink/iu);
  });
});

test("unsupported or mismatched final mode/type combinations fail closed", async () => {
  for (const [name, node] of [
    ["blob with tree mode", treeNode("target", "blob", "040000", BLOB_SHA)],
    ["tree with blob mode", treeNode("target", "tree", "100644", DIR_TREE_SHA)],
    ["commit with blob mode", treeNode("target", "commit", "100644", GITLINK_SHA)],
    ["unsupported blob mode", treeNode("target", "blob", "100600", BLOB_SHA)],
  ] as const) {
    await test.step(name, async () => {
      await runScenario("target", COMMIT_SHA, {
        trees: { [ROOT_TREE_SHA]: { json: treePayload(ROOT_TREE_SHA, false, [node]) } },
      }, async (client) => {
        await assert.rejects(() => client.getFileBytes("target", COMMIT_SHA), /unsupported.*git.*object|invalid.*mode|mode.*type/iu);
      });
    });
  }
});

test("immutable commit must provide a valid root tree SHA", async () => {
  for (const value of [undefined, "", "short"] as const) {
    await test.step(String(value), async () => {
      await runScenario("target.md", COMMIT_SHA, {
        commit: { status: 200, json: { sha: COMMIT_SHA, tree: value === undefined ? {} : { sha: value }, parents: [] } },
      }, async (client, urls) => {
        await assert.rejects(() => client.getFileBytes("target.md", COMMIT_SHA), /immutable.*commit.*tree.*sha|tree.*sha.*immutable/iu);
        assert.equal(urls.some(url => url.includes("/git/trees/")), false);
      });
    });
  }
});

test("tree and blob API failures propagate rather than becoming absence", async () => {
  await runScenario("target.md", COMMIT_SHA, {
    trees: { [ROOT_TREE_SHA]: { status: 503, text: "tree unavailable" } },
  }, async (client) => {
    await assert.rejects(() => client.getFileBytes("target.md", COMMIT_SHA), /Failed to get historical tree.*503/iu);
  });

  await runScenario("target.md", COMMIT_SHA, {
    trees: {
      [ROOT_TREE_SHA]: { json: treePayload(ROOT_TREE_SHA, false, [treeNode("target.md", "blob", "100644", BLOB_SHA)]) },
    },
    blobs: { [BLOB_SHA]: { status: 502, text: "blob unavailable" } },
  }, async (client) => {
    await assert.rejects(() => client.getFileBytes("target.md", COMMIT_SHA), /Failed to get blob.*502/iu);
  });
});

test("invalid immutable path segments fail without reinterpretation", async () => {
  for (const path of ["", "/a.md", "a.md/", "a//b.md", "a/./b.md", "a/../b.md"]) {
    await test.step(JSON.stringify(path), async () => {
      await runScenario(path, COMMIT_SHA, {}, async (client, urls) => {
        await assert.rejects(() => client.getFileBytes(path, COMMIT_SHA), /invalid.*immutable.*path|immutable.*path.*segment/iu);
        assert.equal(urls.some(url => url.includes("/git/commits/")), false);
      });
    });
  }
});

test("mutable-ref Contents 404 remains null without Git-object fallback", async () => {
  await runScenario("missing.md", "main", {}, async (client, urls) => {
    assert.equal(await client.getFileBytes("missing.md", "main"), null);
    assert.equal(urls.length, 1);
    assert.equal(urls.some(url => url.includes("/git/")), false);
  });
});

test("successful Contents read remains direct and does not enter Git-object fallback", async () => {
  const payload = new TextEncoder().encode("contents-success\n");
  const content = Buffer.from(payload).toString("base64");
  await runScenario("direct.md", COMMIT_SHA, {
    contents: { status: 200, json: { content, encoding: "base64", sha: "contents-sha" } },
  }, async (client, urls) => {
    const file = await client.getFileBytes("direct.md", COMMIT_SHA);
    assert.deepEqual(file?.bytes, payload);
    assert.equal(file?.sha, "contents-sha");
    assert.equal(urls.length, 1);
  });
});
