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

test("D162 thrown requestUrl failures do not leak secrets or masquerade as confirmed file absence", async () => {
  for (const thrown of [
    Object.assign(new Error(leaked), { status: 404, headers: { "retry-after": "120" } }),
    leaked,
    null,
  ]) {
    let requests = 0
    setRequestUrlHandler(async () => { requests++; throw thrown })
    try {
      const github = client()
      await assert.rejects(github.getFileBytes("private.md"), error => {
        assert.ok(error instanceof Error)
        assert.equal(error.message, "GitHub transport request failed; remote result is unconfirmed.")
        assert.equal((error as { status?: number }).status, undefined)
        assert.equal((error as { cause?: unknown }).cause, undefined)
        assert.doesNotMatch(JSON.stringify(error), /private-token|do-not-display|private-note/u)
        return true
      })
      assert.equal(requests, 1)
      assert.equal(github.transportMetricsSnapshot.statusClasses.network, 1)
    } finally {
      setRequestUrlHandler(null)
    }
  }
})

test("D162 thrown adapter status does not turn an uncertain ref write into a definitive failure or retry", async () => {
  let attempts = 0
  setRequestUrlHandler(async () => {
    attempts++
    throw Object.assign(new Error(leaked), { status: 422, headers: { "retry-after": "0" }, cause: leaked })
  })
  try {
    const github = new GitHubClient(
      { owner: "owner", repo: "vault", branch: "main", token: "token" },
      { transportPolicy: { mutationSpacingMs: 0, maxAttempts: 2 } },
    )
    await assert.rejects(github.createGitRef("a".repeat(40)), error => {
      assert.ok(error instanceof Error)
      assert.equal(error.name, "V4GitMutationOutcomeUnknownError")
      assert.match(error.message, /unknown outcome/u)
      assert.doesNotMatch(JSON.stringify(error, Object.getOwnPropertyNames(error)), /private-token|do-not-display|private-note/u)
      const cause = (error as Error & { cause?: unknown }).cause
      assert.ok(cause instanceof Error)
      assert.equal(cause.message, "GitHub transport request failed; remote result is unconfirmed.")
      assert.equal((cause as { status?: number }).status, undefined)
      return true
    })
    assert.equal(attempts, 1, "A reachable-ref write must never replay after an uncertain transport failure")
    assert.equal(github.transportMetricsSnapshot.statusClasses.network, 1)
    assert.equal(github.transportMetricsSnapshot.unknownOutcomes, 1)
  } finally {
    setRequestUrlHandler(null)
  }
})

test("D162 requestUrl abort does not expose adapter message and keeps read cancellation", async () => {
  const abort = new AbortController()
  setRequestUrlHandler(async () => {
    abort.abort()
    throw new Error(leaked)
  })
  try {
    const github = client()
    github.setV4AbortSignal(abort.signal)
    await assert.rejects(github.listCommits(), error => {
      assert.ok(error instanceof Error)
      assert.equal(error.name, "V4CancelledError")
      assert.doesNotMatch(error.message, /private-token|do-not-display|private-note/u)
      return true
    })
    assert.equal(github.transportMetricsSnapshot.statusClasses.network, 1)
  } finally {
    setRequestUrlHandler(null)
  }
})
