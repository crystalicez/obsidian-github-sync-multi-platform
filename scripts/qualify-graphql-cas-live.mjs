#!/usr/bin/env node
// Live GitHub GraphQL strict-CAS qualification. Only the pinned disposable repo.
// A unique absent-first branch is created and deleted after the experiment.
import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { loadGitHubE2EEnv, requireGitHubE2EConfig, qualificationE2EBranch } from "./github-e2e-env.mjs"
import { preflightE2ERemote, readE2EBranch, cleanupE2EBranch } from "./github-e2e-remote.mjs"
import { CANONICAL_REPOSITORY_ID, CANONICAL_REPOSITORY } from "./github-repo.mjs"

const here = resolve(fileURLToPath(new URL(".", import.meta.url)))
const root = resolve(here, "../../..")
const TEST_REPOSITORY = "diamond-crystal/test-vault-obsidian-encrypted-github-sync-multi-platform"
const TEST_REPOSITORY_ID = "1284153873"
const SHA = /^[0-9a-f]{40}$/u

const { env } = await loadGitHubE2EEnv({
  cwd: root,
  env: { ...process.env, GITHUB_E2E_EXPECTED_REPO_ID: TEST_REPOSITORY_ID },
})
const config = requireGitHubE2EConfig(env, { currentSourceRepo: CANONICAL_REPOSITORY })
assert.equal(config.targetRepository.toLowerCase(), TEST_REPOSITORY, "Refuse non-disposable repository")
assert.equal(config.expectedRepoId, TEST_REPOSITORY_ID, "Refuse unpinned repository ID")
const sourceCommit = "66d749b0c27d6934da2c410e68227f7f5cf374a0"
const branch = qualificationE2EBranch(sourceCommit, randomBytes(10).toString("hex"))
const api = `https://api.github.com/repos/${config.owner}/${config.repo}`
const headers = {
  Authorization: `Bearer ${config.token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2026-03-10",
  "Content-Type": "application/json",
}
async function request(url, method = "GET", body) {
  let response
  try {
    response = await fetch(url, {
      method, headers, ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30000),
    })
  } catch {
    throw Error(`GitHub ${method} network request failed`)
  }
  let data
  try { data = await response.json() } catch { data = null }
  return { status: response.status, data }
}
function success(r, codes, label) {
  if (!codes.includes(r.status)) throw Error(`${label}: HTTP ${r.status}`)
  return r.data
}
let attemptedCreation = false
let created = false
let cleanupVerified = false
let qualification = "not-run"
let error
try {
  const preflight = await preflightE2ERemote({ config: { ...config, branch, currentSourceRepoId: CANONICAL_REPOSITORY_ID } })
  assert.equal(preflight.id, TEST_REPOSITORY_ID)
  assert.match(preflight.defaultBranchSha, SHA)
  assert.equal((await readE2EBranch({ ...config, branch })).kind, "absent", "Test branch already exists")
  const repository = success(await request(api), [200], "Read repository identity")
  assert.equal(String(repository.id), TEST_REPOSITORY_ID)
  assert.equal(repository.full_name.toLowerCase(), TEST_REPOSITORY)
  assert.ok(typeof repository.node_id === "string" && repository.node_id.length > 0)
  const rootCommit = success(await request(`${api}/git/commits/${preflight.defaultBranchSha}`), [200], "Read default commit")
  const tree = rootCommit?.tree?.sha
  assert.match(tree, SHA)

  // Only create an isolated branch after proving the configured repository ID,
  // source repo exclusion, default branch, and exact absence of the test ref.
  attemptedCreation = true
  success(await request(`${api}/git/refs`, "POST", {
    ref: `refs/heads/${branch}`, sha: preflight.defaultBranchSha,
  }), [201], "Create isolated branch")
  created = true
  assert.equal((await readE2EBranch({ ...config, branch })).sha, preflight.defaultBranchSha)

  const commits = []
  let parent = preflight.defaultBranchSha
  for (let i = 0; i < 2; i++) {
    const body = success(await request(`${api}/git/commits`, "POST", {
      message: `obsidian-sync-v4:graphql-cas-qualification-${i}`,
      tree, parents: [parent],
    }), [201], "Create immutable candidate")
    assert.match(body.sha, SHA)
    commits.push(body.sha)
    parent = body.sha
  }
  const [first, second] = commits
  async function cas(beforeOid, afterOid, marker) {
    return request("https://api.github.com/graphql", "POST", {
      query: "mutation StrictV4CAS($input: UpdateRefsInput!) { updateRefs(input: $input) { clientMutationId } }",
      variables: { input: {
        repositoryId: repository.node_id,
        refUpdates: [{ name: `refs/heads/${branch}`, beforeOid, afterOid, force: false }],
        clientMutationId: marker,
      } },
    })
  }
  const firstResult = success(await cas(preflight.defaultBranchSha, first, "cas-first"), [200], "First strict CAS")
  assert.equal(firstResult?.data?.updateRefs?.clientMutationId, "cas-first")
  assert.ok(!firstResult?.errors?.length, "First CAS returned GraphQL errors")
  assert.equal((await readE2EBranch({ ...config, branch })).sha, first)

  // Second is a descendant of first: normal REST fast-forward would allow it.
  // But the supplied beforeOid is now stale and GraphQL must reject it.
  const rejected = await cas(preflight.defaultBranchSha, second, "cas-rejected-stale")
  assert.ok(rejected.status >= 400 || Array.isArray(rejected.data?.errors),
    "GraphQL accepted CAS despite a stale beforeOid")
  assert.equal((await readE2EBranch({ ...config, branch })).sha, first,
    "Stale GraphQL CAS overwrote the ref")

  const secondResult = success(await cas(first, second, "cas-second"), [200], "Second strict CAS")
  assert.equal(secondResult?.data?.updateRefs?.clientMutationId, "cas-second")
  assert.ok(!secondResult?.errors?.length, "Second CAS returned GraphQL errors")
  assert.equal((await readE2EBranch({ ...config, branch })).sha, second)
  qualification = "pass"
} catch (caught) {
  error = caught
  qualification = "failed"
} finally {
  if (attemptedCreation) {
    try {
      await cleanupE2EBranch({ ...config, branch, expectedRepoId: TEST_REPOSITORY_ID,
        currentSourceRepoId: CANONICAL_REPOSITORY_ID })
      cleanupVerified = (await readE2EBranch({ ...config, branch })).kind === "absent"
    } catch (cleanupError) {
      error = error ?? cleanupError
      cleanupVerified = false
    }
  } else {
    cleanupVerified = true // Nothing created or sent to GitHub to create.
  }
}
console.log(JSON.stringify({
  test: "GraphQL strict CAS on uniquely created disposable test branch",
  branch, created, outcome: qualification, cleanupVerified,
  ...(error ? { failure: String(error?.message || error).slice(0,300) } : {}),
}))
if (error || !cleanupVerified || qualification !== "pass") process.exitCode = 1
