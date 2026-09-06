import assert from "node:assert/strict"
import test from "node:test"
import { setRequestUrlHandler } from "obsidian"

import { GitHubClient } from "../../src/lib/github-api"
import { resolveV4PublicationBase } from "../../src/lib/v4/git-tree-writer"

async function capture(task: () => Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    await task()
  } catch (error) {
    return error as Record<string, unknown>
  }
  throw new Error("expected rejection")
}

test("custom-branch empty bootstrap replans when another initializer creates only the default ref", async () => {
  let refInspections = 0
  const requests: string[] = []
  setRequestUrlHandler(async (options: unknown) => {
    const request = options as { url: string; method?: string }
    requests.push(`${request.method ?? "GET"} ${request.url}`)

    if (request.url.includes("/git/refs?")) {
      refInspections++
      return refInspections === 1
        ? { status: 409, text: "Git Repository is empty.", headers: {}, json: {} }
        : {
          status: 200,
          text: "",
          headers: {},
          json: [{ ref: "refs/heads/main", object: { sha: "winner-bootstrap", type: "commit" } }],
        }
    }
    if (request.method === "PUT" && request.url.includes("/contents/.obsidian-github-sync-v4/bootstrap")) {
      return { status: 422, text: "repository was initialized concurrently", headers: {}, json: {} }
    }
    if (request.method === "GET" && request.url.includes("/git/ref/heads/v4-sync")) {
      return { status: 404, text: "configured branch not created yet", headers: {}, json: {} }
    }
    throw new Error(`Unexpected request: ${request.method} ${request.url}`)
  })

  try {
    const client = new GitHubClient(
      { token: "token", owner: "owner", repo: "repo", branch: "v4-sync" },
      { transportPolicy: { mutationSpacingMs: 0 } },
    )

    const error = await capture(() => resolveV4PublicationBase(client))

    assert.equal(error.code, "V4_PUBLICATION_RACE")
    assert.equal(error.phase, "bootstrap-publish")
    assert.equal(error.expectedHeadSha, null)
    assert.equal(error.observedHeadSha, "winner-bootstrap")
    assert.equal(error.publicationOutcome, "unknown")
    assert.equal(error.evidence, "bootstrap-repository-state-changed")
    assert.equal(refInspections, 2, "definitive bootstrap conflict must re-inspect repository state")
  } finally {
    setRequestUrlHandler(null)
  }
})
