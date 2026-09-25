import assert from "node:assert/strict"
import test from "node:test"
import { setRequestUrlHandler } from "obsidian"

import { GitHubClient } from "../../src/lib/github-api"

const COMMIT_SHA = "0".repeat(40)
const ROOT_TREE_SHA = "1".repeat(40)
const DIR_TREE_SHA = "2".repeat(40)
const NESTED_TREE_SHA = "3".repeat(40)
const BLOB_SHA = "4".repeat(40)

function response(input: { status: number; json?: unknown; bytes?: Uint8Array; text?: string }) {
  const bytes = input.bytes ?? new Uint8Array()
  return {
    status: input.status,
    text: input.text ?? "",
    headers: {},
    json: input.json,
    arrayBuffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  }
}

function treeNode(path: string, type: "blob" | "tree", mode: string, sha: string) {
  return { path, type, mode, sha, url: "" }
}

function treePayload(sha: string, truncated: boolean, tree: unknown[]) {
  return { sha, url: "", truncated, tree }
}

test("immutable fallback descends through an exact positive entry in a truncated intermediate tree", async () => {
  const payload = new TextEncoder().encode("deep-positive\n")
  const urls: string[] = []
  setRequestUrlHandler(async (options: unknown) => {
    const url = (options as { url: string }).url
    urls.push(url)
    const path = new URL(url).pathname
    if (path.includes("/contents/")) return response({ status: 404, text: "not visible" })
    if (path.endsWith(`/git/commits/${COMMIT_SHA}`)) {
      return response({ status: 200, json: { sha: COMMIT_SHA, tree: { sha: ROOT_TREE_SHA }, parents: [] } })
    }
    if (path.endsWith(`/git/trees/${ROOT_TREE_SHA}`)) {
      return response({ status: 200, json: treePayload(ROOT_TREE_SHA, false, [treeNode("dir", "tree", "040000", DIR_TREE_SHA)]) })
    }
    if (path.endsWith(`/git/trees/${DIR_TREE_SHA}`)) {
      return response({
        status: 200,
        json: treePayload(DIR_TREE_SHA, true, [
          treeNode("nested", "tree", "040000", NESTED_TREE_SHA),
          treeNode("some-positive-entry", "blob", "100644", BLOB_SHA),
        ]),
      })
    }
    if (path.endsWith(`/git/trees/${NESTED_TREE_SHA}`)) {
      return response({ status: 200, json: treePayload(NESTED_TREE_SHA, true, [treeNode("file.md", "blob", "100644", BLOB_SHA)]) })
    }
    if (path.endsWith(`/git/blobs/${BLOB_SHA}`)) return response({ status: 200, bytes: payload })
    throw new Error(`Unexpected request: ${url}`)
  })

  try {
    const client = new GitHubClient(
      { token: "token", owner: "owner", repo: "repo", branch: "main" },
      { transportPolicy: { mutationSpacingMs: 0 } },
    )
    const file = await client.getFileBytes("dir/nested/file.md", COMMIT_SHA)
    assert.deepEqual(file?.bytes, payload)
    assert.equal(file?.sha, BLOB_SHA)
    assert.equal(urls.filter(url => url.includes("/git/trees/")).length, 3)
    assert.equal(urls.some(url => url.includes("recursive=1")), false)
  } finally {
    setRequestUrlHandler(null)
  }
})

test("immutable fallback also activates when Contents throws an error carrying status 404", async () => {
  const payload = new TextEncoder().encode("thrown-404-fallback\n")
  let contentsCalls = 0
  setRequestUrlHandler(async (options: unknown) => {
    const url = (options as { url: string }).url
    const path = new URL(url).pathname
    if (path.includes("/contents/")) {
      contentsCalls++
      throw Object.assign(new Error("Contents unavailable"), { status: 404 })
    }
    if (path.endsWith(`/git/commits/${COMMIT_SHA}`)) {
      return response({ status: 200, json: { sha: COMMIT_SHA, tree: { sha: ROOT_TREE_SHA }, parents: [] } })
    }
    if (path.endsWith(`/git/trees/${ROOT_TREE_SHA}`)) {
      return response({ status: 200, json: treePayload(ROOT_TREE_SHA, false, [treeNode("file.md", "blob", "100644", BLOB_SHA)]) })
    }
    if (path.endsWith(`/git/blobs/${BLOB_SHA}`)) return response({ status: 200, bytes: payload })
    throw new Error(`Unexpected request: ${url}`)
  })

  try {
    const client = new GitHubClient(
      { token: "token", owner: "owner", repo: "repo", branch: "main" },
      { transportPolicy: { mutationSpacingMs: 0 } },
    )
    const file = await client.getFileBytes("file.md", COMMIT_SHA)
    assert.deepEqual(file?.bytes, payload)
    assert.equal(file?.sha, BLOB_SHA)
    assert.equal(contentsCalls, 1)
  } finally {
    setRequestUrlHandler(null)
  }
})
