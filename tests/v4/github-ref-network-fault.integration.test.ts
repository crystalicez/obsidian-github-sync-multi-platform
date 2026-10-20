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

test("GitHubClient HTTP fault simulation accepts a committed ref after its PATCH response is lost", async () => {
  let head = baseSha
  let patchCalls = 0
  let headReads = 0
  setRequestUrlHandler(async (options: unknown) => {
    const request = options as { method: string; url: string; body?: string }
    if (request.method === "GET" && request.url.includes("/git/ref/heads/main")) {
      headReads++
      return response(200, ref(head))
    }
    if (request.method === "PATCH" && request.url.endsWith("/git/refs/heads/main")) {
      patchCalls++
      assert.deepEqual(JSON.parse(request.body ?? ""), { sha: candidateSha, force: false })
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

test("GitHubClient HTTP fault simulation retries PATCH once after proving a lost request did not update HEAD", async () => {
  let head = baseSha
  let patchCalls = 0
  let headReads = 0
  setRequestUrlHandler(async (options: unknown) => {
    const request = options as { method: string; url: string; body?: string }
    if (request.method === "GET" && request.url.includes("/git/ref/heads/main")) {
      headReads++
      return response(200, ref(head))
    }
    if (request.method === "PATCH" && request.url.endsWith("/git/refs/heads/main")) {
      patchCalls++
      if (patchCalls === 1) throw new Error("connection lost before GitHub received PATCH")
      head = candidateSha
      return response(200, ref(head))
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

test("GitHubClient HTTP fault simulation never replays a lost PATCH when another writer advances HEAD", async () => {
  let head = baseSha
  let patchCalls = 0
  setRequestUrlHandler(async (options: unknown) => {
    const request = options as { method: string; url: string }
    if (request.method === "GET" && request.url.includes("/git/ref/heads/main")) {
      return response(200, ref(head))
    }
    if (request.method === "PATCH" && request.url.endsWith("/git/refs/heads/main")) {
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

test("GitHubClient HTTP fault simulation does not retry a lost PATCH when reconciliation is also offline", async () => {
  let patchCalls = 0
  setRequestUrlHandler(async (options: unknown) => {
    const request = options as { method: string; url: string }
    if (request.method === "GET" && request.url.includes("/git/ref/heads/main")) {
      if (patchCalls > 0) throw new Error("still offline")
      return response(200, ref(baseSha))
    }
    if (request.method === "PATCH" && request.url.endsWith("/git/refs/heads/main")) {
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
