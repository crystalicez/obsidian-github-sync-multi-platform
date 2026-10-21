import assert from "node:assert/strict"
import test from "node:test"
import { setRequestUrlHandler } from "obsidian"

import { GitHubClient } from "../../src/lib/github-api"
import { publishV4CandidateRef, type V4CandidateCommit } from "../../src/lib/v4/git-tree-writer"

const baseSha = "a".repeat(40)
const candidateSha = "b".repeat(40)
const externalSha = "c".repeat(40)
const treeSha = "d".repeat(40)

function candidate(): V4CandidateCommit {
  return {
    previousHeadSha: baseSha,
    baseTreeSha: "e".repeat(40),
    treeSha,
    commitSha: candidateSha,
    message: "obsidian-sync-v4:lost-http-response",
  }
}

function response(status: number, json: unknown) {
  return { status, text: "", headers: {}, json }
}

function ref(sha: string) {
  return { ref: "refs/heads/main", object: { sha, type: "commit" } }
}

function client() {
  return new GitHubClient(
    { token: "token", owner: "owner", repo: "repo", branch: "main" },
    { transportPolicy: { mutationSpacingMs: 0 } },
  )
}

test("GitHubClient GraphQL CAS fault simulation reconciles a lost successful response", async () => {
  let head = baseSha
  let patchCalls = 0
  let headReads = 0
  setRequestUrlHandler(async (options: unknown) => {
    const request = options as { method: string; url: string; body?: string }
    if (request.method === "GET" && request.url === "https://api.github.com/repos/owner/repo") {
      return response(200, { node_id: "R_repo_node", full_name: "owner/repo" })
    }
    if (request.method === "GET" && request.url.includes("/git/ref/heads/main")) {
      headReads++
      return response(200, ref(head))
    }
    if (request.method === "POST" && request.url === "https://api.github.com/graphql") {
      patchCalls++
      const input = JSON.parse(request.body ?? "").variables.input
      assert.deepEqual(input.refUpdates, [{ name: "refs/heads/main", beforeOid: baseSha, afterOid: candidateSha, force: false }])
      assert.equal(input.repositoryId, "R_repo_node")
      head = candidateSha
      throw new Error("connection lost after GitHub accepted PATCH")
    }
    throw new Error(`Unexpected request: ${request.method} ${request.url}`)
  })
  try {
    await publishV4CandidateRef(client(), candidate())
    assert.equal(head, candidateSha)
    assert.equal(patchCalls, 1)
    assert.equal(headReads, 2)
  } finally {
    setRequestUrlHandler(null)
  }
})

test("GitHubClient GraphQL CAS fault simulation retries once after proving the first request never changed HEAD", async () => {
  let head = baseSha
  let patchCalls = 0
  let headReads = 0
  setRequestUrlHandler(async (options: unknown) => {
    const request = options as { method: string; url: string; body?: string }
    if (request.method === "GET" && request.url === "https://api.github.com/repos/owner/repo") {
      return response(200, { node_id: "R_repo_node", full_name: "owner/repo" })
    }
    if (request.method === "GET" && request.url.includes("/git/ref/heads/main")) {
      headReads++
      return response(200, ref(head))
    }
    if (request.method === "POST" && request.url === "https://api.github.com/graphql") {
      patchCalls++
      if (patchCalls === 1) throw new Error("connection lost before GitHub received GraphQL CAS")
      head = candidateSha
      return response(200, { data: { updateRefs: { clientMutationId: JSON.parse(request.body ?? "").variables.input.clientMutationId } } })
    }
    throw new Error(`Unexpected request: ${request.method} ${request.url}`)
  })
  try {
    await publishV4CandidateRef(client(), candidate())
    assert.equal(head, candidateSha)
    assert.equal(patchCalls, 2)
    assert.equal(headReads, 3)
  } finally {
    setRequestUrlHandler(null)
  }
})

test("GitHubClient GraphQL CAS never replays a lost response after another writer advances HEAD", async () => {
  let head = baseSha
  let patchCalls = 0
  setRequestUrlHandler(async (options: unknown) => {
    const request = options as { method: string; url: string }
    if (request.method === "GET" && request.url === "https://api.github.com/repos/owner/repo") {
      return response(200, { node_id: "R_repo_node", full_name: "owner/repo" })
    }
    if (request.method === "GET" && request.url.includes("/git/ref/heads/main")) {
      return response(200, ref(head))
    }
    if (request.method === "POST" && request.url === "https://api.github.com/graphql") {
      patchCalls++
      head = externalSha
      throw new Error("connection lost while another writer published")
    }
    if (request.method === "GET" && request.url.endsWith(`/git/commits/${candidateSha}`)) {
      return response(200, {
        sha: candidateSha,
        tree: { sha: treeSha },
        parents: [{ sha: baseSha }],
        message: candidate().message,
      })
    }
    if (request.method === "GET" && request.url.endsWith(`/git/commits/${externalSha}`)) {
      return response(200, {
        sha: externalSha,
        tree: { sha: "f".repeat(40) },
        parents: [{ sha: baseSha }],
        message: "external change",
      })
    }
    throw new Error(`Unexpected request: ${request.method} ${request.url}`)
  })
  try {
    await assert.rejects(() => publishV4CandidateRef(client(), candidate()), error => {
      const race = error as { code?: string; phase?: string; observedHeadSha?: string; publicationOutcome?: string }
      assert.equal(race.code, "V4_PUBLICATION_RACE")
      assert.equal(race.phase, "post-publish")
      assert.equal(race.observedHeadSha, externalSha)
      assert.equal(race.publicationOutcome, "unknown")
      return true
    })
    assert.equal(head, externalSha)
    assert.equal(patchCalls, 1)
  } finally {
    setRequestUrlHandler(null)
  }
})

test("GitHubClient GraphQL CAS does not retry a lost response when reconciliation is also offline", async () => {
  let patchCalls = 0
  setRequestUrlHandler(async (options: unknown) => {
    const request = options as { method: string; url: string }
    if (request.method === "GET" && request.url === "https://api.github.com/repos/owner/repo") {
      return response(200, { node_id: "R_repo_node", full_name: "owner/repo" })
    }
    if (request.method === "GET" && request.url.includes("/git/ref/heads/main")) {
      if (patchCalls > 0) throw new Error("still offline")
      return response(200, ref(baseSha))
    }
    if (request.method === "POST" && request.url === "https://api.github.com/graphql") {
      patchCalls++
      throw new Error("connection lost after PATCH was sent")
    }
    throw new Error(`Unexpected request: ${request.method} ${request.url}`)
  })
  try {
    await assert.rejects(() => publishV4CandidateRef(client(), candidate()), error => {
      assert.equal((error as Error).name, "V4GitMutationOutcomeUnknownError")
      return true
    })
    assert.equal(patchCalls, 1)
  } finally {
    setRequestUrlHandler(null)
  }
})
