import assert from "node:assert/strict"
import test from "node:test"
import { setRequestUrlHandler } from "obsidian"
import { GitHubClient } from "../../src/lib/github-api"
import { publishV4CandidateRef } from "../../src/lib/v4/git-tree-writer"

const base = "a".repeat(40)
const next = "b".repeat(40)
const rewind = "9".repeat(40)
const tree = "c".repeat(40)
const candidate = { previousHeadSha: base, baseTreeSha: tree, treeSha: tree, commitSha: next, message: "obsidian-sync-v4:graphql-cas" }
const ok = (value: unknown, status = 200) => ({ status, json: value, text: "", headers: {} })
const ref = (sha: string) => ok({ ref: "refs/heads/main", object: { sha, type: "commit" } })
const newClient = () => new GitHubClient({ token: "secret", owner: "owner", repo: "repo", branch: "main" }, { transportPolicy: { mutationSpacingMs: 0 } })

function verifyRequest(request: { method: string; url: string; body?: string }) {
  assert.equal(request.method, "POST")
  assert.equal(request.url, "https://api.github.com/graphql")
  const body = JSON.parse(request.body ?? "")
  assert.match(body.query, /updateRefs\(input:/)
  const input = body.variables.input
  assert.equal(input.repositoryId, "R_repo_node")
  assert.deepEqual(input.refUpdates, [{ name: "refs/heads/main", beforeOid: base, afterOid: next, force: false }])
  return input.clientMutationId as string
}
function accepted(id: string) { return ok({ data: { updateRefs: { clientMutationId: id } } }) }

test("strict CAS rejects a rewind to an ancestor between preflight and mutation (REST fast-forward hole)", async () => {
  let head = base
  let graphqlCalls = 0
  let patchCalls = 0
  setRequestUrlHandler(async (raw: unknown) => {
    const r = raw as { method: string; url: string; body?: string }
    if (r.method === "GET" && r.url.endsWith("/repos/owner/repo")) return ok({ node_id: "R_repo_node", full_name: "owner/repo" })
    if (r.method === "GET" && r.url.includes("/git/ref/heads/main")) return ref(head)
    if (r.method === "POST" && r.url.endsWith("/graphql")) {
      graphqlCalls++
      verifyRequest(r)
      // This HEAD is an ancestor of candidate. REST PATCH force:false would accept it.
      head = rewind
      return ok({ errors: [{ message: "beforeOid failed" }], data: { updateRefs: null } })
    }
    if (r.method === "PATCH") patchCalls++
    if (r.method === "GET" && r.url.endsWith("/git/commits/" + next)) {
      return ok({ sha: next, tree: { sha: tree }, parents: [{ sha: base }], message: candidate.message })
    }
    if (r.method === "GET" && r.url.endsWith("/git/commits/" + rewind)) {
      return ok({ sha: rewind, tree: { sha: tree }, parents: [], message: "earlier ancestor" })
    }
    throw Error("unexpected request " + r.method + " " + r.url)
  })
  try {
    await assert.rejects(() => publishV4CandidateRef(newClient(), candidate), error => {
      assert.equal((error as { code?: string }).code, "V4_PUBLICATION_RACE")
      return true
    })
    assert.equal(head, rewind)
    assert.equal(graphqlCalls, 1)
    assert.equal(patchCalls, 0)
  } finally { setRequestUrlHandler(null) }
})

test("GraphQL errors even with HTTP 200 and apparent acknowledgement fail closed, no fallback", async () => {
  let posts = 0
  let patches = 0
  let head = base
  setRequestUrlHandler(async (raw: unknown) => {
    const r = raw as { method: string; url: string; body?: string }
    if (r.method === "GET" && r.url.endsWith("/repos/owner/repo")) return ok({ node_id: "R_repo_node", full_name: "owner/repo" })
    if (r.method === "GET" && r.url.includes("/git/ref/heads/main")) return ref(head)
    if (r.method === "POST" && r.url.endsWith("/graphql")) {
      posts++
      return ok({ data: { updateRefs: { clientMutationId: verifyRequest(r) } }, errors: [{ message: "permission denied" }] })
    }
    if (r.method === "PATCH") patches++
    throw Error("unexpected request")
  })
  try {
    await assert.rejects(() => publishV4CandidateRef(newClient(), candidate), /GraphQL strict CAS rejected/)
    assert.equal(posts, 1)
    assert.equal(patches, 0)
    assert.equal(head, base)
  } finally { setRequestUrlHandler(null) }
})

test("GraphQL missing acknowledgement is reconciled before success, not treated as automatic success", async () => {
  let head = base
  let mutations = 0
  setRequestUrlHandler(async (raw: unknown) => {
    const r = raw as { method: string; url: string; body?: string }
    if (r.method === "GET" && r.url.endsWith("/repos/owner/repo")) return ok({ node_id: "R_repo_node", full_name: "owner/repo" })
    if (r.method === "GET" && r.url.includes("/git/ref/heads/main")) return ref(head)
    if (r.method === "POST" && r.url.endsWith("/graphql")) {
      mutations++
      verifyRequest(r)
      head = next
      return ok({ data: { updateRefs: null } })
    }
    throw Error("unexpected request")
  })
  try {
    await publishV4CandidateRef(newClient(), candidate)
    assert.equal(head, next)
    assert.equal(mutations, 1)
  } finally { setRequestUrlHandler(null) }
})

test("repository identity mismatch fails before GraphQL or REST ref mutation", async () => {
  let writes = 0
  setRequestUrlHandler(async (raw: unknown) => {
    const r = raw as { method: string }
    if (r.method === "GET") return ok({ node_id: "R_other_repo", full_name: "other/repo" })
    writes++
    throw Error("mutation not allowed")
  })
  try {
    await assert.rejects(() => newClient().updateGitRef(next, base), /repository identity/)
    assert.equal(writes, 0)
  } finally { setRequestUrlHandler(null) }
})

test("missing expected HEAD or malformed SHA never contacts GitHub", async () => {
  let calls = 0
  setRequestUrlHandler(async () => { calls++; throw Error("unexpected request") })
  try {
    await assert.rejects(() => newClient().updateGitRef(next), /expected git ref SHA/)
    await assert.rejects(() => newClient().updateGitRef(next, "bogus"), /expected git ref SHA/)
    await assert.rejects(() => newClient().updateGitRef("bogus", base), /updated git ref SHA/)
    assert.equal(calls, 0)
  } finally { setRequestUrlHandler(null) }
})
