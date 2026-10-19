import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"
import { setRequestUrlHandler } from "obsidian"

import { GitHubClient } from "../../src/lib/github-api"
import { utf8ByteLength } from "../../src/lib/bytes"

test("UTF-8 byte accounting handles ASCII, multilingual text and invalid surrogates", () => {
  assert.equal(utf8ByteLength("plain JSON"), 10)
  assert.equal(utf8ByteLength("éไทย😃\uD800"), 2 + 9 + 4 + 3)
})

test("GitHub payload metrics count UTF-8 bytes without allocating a second large payload buffer", async () => {
  const bytes = new Uint8Array(1_048_576)
  const expectedSha = createHash("sha1")
    .update(Buffer.from(`blob ${bytes.byteLength}\0`, "utf8"))
    .update(bytes)
    .digest("hex")
  const responseText = "é".repeat(300_000)
  const expectedRequestBytes = 4 * Math.ceil(bytes.byteLength / 3) + '{"content":"","encoding":"base64"}'.length
  const originalEncode = TextEncoder.prototype.encode
  let largeEncodes = 0
  TextEncoder.prototype.encode = function (value?: string) {
    if ((value?.length ?? 0) > 128 * 1024) {
      largeEncodes++
      throw new Error("Unexpected full-size UTF-8 metrics buffer")
    }
    return originalEncode.call(this, value)
  }
  setRequestUrlHandler(async (options: unknown) => {
    const request = options as { body?: string; method?: string }
    assert.equal(request.method, "POST")
    assert.equal(request.body?.length, expectedRequestBytes)
    return { status: 201, text: responseText, headers: {}, json: { sha: expectedSha } }
  })
  try {
    const client = new GitHubClient(
      { token: "token", owner: "owner", repo: "repo", branch: "main" },
      { transportPolicy: { mutationSpacingMs: 0 } },
    )
    assert.equal(await client.createGitBlob(bytes), expectedSha)
    assert.equal(client.transportMetricsSnapshot.requestBytes, expectedRequestBytes)
    assert.equal(client.transportMetricsSnapshot.responseBytes, 600_000)
    assert.equal(largeEncodes, 0)
  } finally {
    TextEncoder.prototype.encode = originalEncode
    setRequestUrlHandler(null)
  }
})
