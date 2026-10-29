import assert from "node:assert/strict"
import test from "node:test"
import { setRequestUrlHandler } from "obsidian"
import { GitHubClient } from "../../src/lib/github-api"

const leaked = "private-token: do-not-display this-private-note.md"
const client = () => new GitHubClient(
  { owner: "owner", repo: "vault", branch: "main", token: "token" },
  { transportPolicy: { mutationSpacingMs: 0, maxAttempts: 1 } },
)
const response = (status: number, text = leaked, headers: Record<string, string> = {}) => ({
  status, text, headers, json: {}, arrayBuffer: new ArrayBuffer(0),
})
function assertNoSecret(error: unknown, status: number, action: RegExp) {
  assert.ok(error instanceof Error)
  assert.match(error.message, action)
  assert.match(error.message, new RegExp(`HTTP ${status}`, "u"))
  assert.doesNotMatch(error.message, /private-token|do-not-display|private-note/u)
  assert.equal((error as Error & { status?: number }).status, status)
  return true
}

test("D161 GitHub REST read failures never echo opaque response bodies while keeping HTTP status", async () => {
  const operations = [
    { run: (github: GitHubClient) => github.listCommits(), action: /list commits/u },
    { run: (github: GitHubClient) => github.getFileBytes("private.md"), action: /get file bytes/u },
    { run: (github: GitHubClient) => github.getBlob("b".repeat(40)), action: /get blob/u },
    { run: (github: GitHubClient) => github.getRepositoryIdentity(), action: /repository identity/u },
  ]
  setRequestUrlHandler(async () => response(403))
  try {
    for (const { run, action } of operations) {
      await assert.rejects(run(client()), err => assertNoSecret(err, 403, action))
    }
  } finally {
    setRequestUrlHandler(null)
  }
})

test("D161 definitive REST mutation errors omit remote body and do not blindly retry", async () => {
  let attempts = 0
  setRequestUrlHandler(async () => { attempts++; return response(422) })
  try {
    await assert.rejects(
      client().createGitRef("a".repeat(40)),
      err => assertNoSecret(err, 422, /create git ref/u),
    )
    assert.equal(attempts, 1, "422 is definitive, not an ambiguous publication to replay")
  } finally {
    setRequestUrlHandler(null)
  }
})

test("D161 rate-limited transport preserves status and headers, never raw response body", async () => {
  setRequestUrlHandler(async () => response(429, leaked, { "retry-after": "0" }))
  try {
    await assert.rejects(
      client().listCommits(),
      err => {
        assertNoSecret(err, 429, /rate-limited/u)
        assert.equal((err as { headers?: Record<string, string> }).headers?.["retry-after"], "0")
        return true
      },
    )
  } finally {
    setRequestUrlHandler(null)
  }
})

test("D161 GraphQL HTTP-200 rejected strict CAS does not echo errors[].message", async () => {
  let mutationAttempts = 0
  setRequestUrlHandler(async (options: unknown) => {
    const body = JSON.parse((options as { body: string }).body) as { query: string }
    if (body.query.includes("repository(")) {
      return { ...response(200, ""), json: { data: { repository: { id: "repo_node" } } } }
    }
    mutationAttempts++
    return { ...response(200, ""), json: { data: { updateRefs: null }, errors: [{ message: leaked }] } }
  })
  try {
    await assert.rejects(
      client().updateGitRef("b".repeat(40), "a".repeat(40)),
      err => {
        assert.ok(err instanceof Error)
        assert.match(err.message, /GraphQL strict CAS rejected/u)
        assert.doesNotMatch(err.message, /private-token|do-not-display|private-note/u)
        return true
      },
    )
    assert.equal(mutationAttempts, 1, "CAS rejection must not trigger another mutation")
  } finally {
    setRequestUrlHandler(null)
  }
})
