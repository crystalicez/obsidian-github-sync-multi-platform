import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"
import { setRequestUrlHandler } from "obsidian"
import { GitHubClient } from "../../src/lib/github-api"

const COMMIT = "a".repeat(40)
const body = new TextEncoder().encode("immutable content\\n")

function blobSha(bytes: Uint8Array): string {
  const header = Buffer.from(`blob ${bytes.byteLength}\0`, "utf8")
  return createHash("sha1").update(header).update(bytes).digest("hex")
}

function response(sha: unknown) {
  return {
    status: 200,
    text: "",
    headers: {},
    json: { encoding: "base64", content: Buffer.from(body).toString("base64"), sha },
    arrayBuffer: new ArrayBuffer(0),
  }
}

test("Contents 200 rejects missing or malformed object identities before accepting payload", async () => {
  for (const sha of [undefined, "", "malformed", "A".repeat(40)]) {
    const urls: string[] = []
    setRequestUrlHandler(async (value: unknown) => {
      const url = (value as { url: string }).url
      urls.push(url)
      return response(sha)
    })
    try {
      const client = new GitHubClient({ token: "token", owner: "owner", repo: "repo", branch: "main" })
      await assert.rejects(() => client.getFileBytes("Notes/reborn.md", COMMIT), /contents.*(sha|identity)|blob.*sha/iu)
      assert.equal(urls.length, 1, "malformed Contents identity must not trigger any blob URL")
    } finally {
      setRequestUrlHandler(null)
    }
  }
})

test("Contents 200 with a valid matching blob identity remains readable", async () => {
  setRequestUrlHandler(async () => response(blobSha(body)))
  try {
    const client = new GitHubClient({ token: "token", owner: "owner", repo: "repo", branch: "main" })
    const file = await client.getFileBytes("Notes/reborn.md", COMMIT)
    assert.equal(file?.sha, blobSha(body))
    assert.deepEqual(file?.bytes, body)
  } finally {
    setRequestUrlHandler(null)
  }
})
