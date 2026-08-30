import assert from "node:assert/strict"
import test from "node:test"
import {
  readGitHubE2ETargetEnvironment,
  resetGitHubE2EDisposableBranch,
  resolveGitHubE2ETarget,
  type GitHubE2EFetch,
  type GitHubE2ETargetEnvironment,
} from "../github-e2e/support/target-safety"

function scriptedFetch(steps: Array<{ method?: string; path: string; status: number; body?: unknown }>): GitHubE2EFetch {
  let index = 0
  return async (url, init = {}) => {
    const step = steps[index++]
    assert.ok(step, `unexpected request ${(init.method ?? "GET").toUpperCase()} ${url}`)
    assert.equal((init.method ?? "GET").toUpperCase(), step.method ?? "GET")
    assert.equal(new URL(url).pathname, step.path)
    const body = step.status === 204 ? null : (step.body === undefined ? "" : JSON.stringify(step.body))
    return new Response(body, {
      status: step.status,
      headers: step.status === 204 ? undefined : { "content-type": "application/json" },
    })
  }
}

const base: GitHubE2ETargetEnvironment = {
  owner: "TargetOwner",
  repo: "TargetRepo",
  branch: "obsidian-sync-e2e/run-77",
  token: "redacted-test-token",
  expectedRepositoryId: "222",
  sourceRepositoryId: "111",
  requiredBranch: "obsidian-sync-e2e/run-77",
}

const metadata = { id: 222, full_name: "CanonicalOwner/CanonicalRepo", default_branch: "trunk" }
const defaultRef = { object: { sha: "d".repeat(40) } }
const repositoryPath = "/repos/TargetOwner/TargetRepo"
const defaultRefPath = "/repos/CanonicalOwner/CanonicalRepo/git/ref/heads/trunk"
const exactReadPath = "/repos/CanonicalOwner/CanonicalRepo/git/ref/heads/obsidian-sync-e2e/run-77"
const exactDeletePath = "/repos/CanonicalOwner/CanonicalRepo/git/refs/heads/obsidian-sync-e2e/run-77"

function resolvedSteps() {
  return [
    { path: repositoryPath, status: 200, body: metadata },
    { path: defaultRefPath, status: 200, body: defaultRef },
  ]
}

test("rejects a route resolving to the source repository ID", async () => {
  await assert.rejects(resolveGitHubE2ETarget({ ...base, expectedRepositoryId: "111" }, scriptedFetch([
    { path: repositoryPath, status: 200, body: { ...metadata, id: 111 } },
  ])), /must not be the source repository/u)
})

test("rejects resolved target ID that differs from pinned ID", async () => {
  await assert.rejects(resolveGitHubE2ETarget(base, scriptedFetch([
    { path: repositoryPath, status: 200, body: { ...metadata, id: 333 } },
  ])), /pinned repository ID/u)
})

test("rejects actual default branch even when named trunk", async () => {
  await assert.rejects(resolveGitHubE2ETarget({ ...base, branch: "trunk", requiredBranch: undefined }, scriptedFetch([
    { path: repositoryPath, status: 200, body: metadata },
  ])), /default branch/u)
})

test("rejects Actions branch mismatch", async () => {
  await assert.rejects(resolveGitHubE2ETarget({ ...base, branch: "other" }, scriptedFetch([
    { path: repositoryPath, status: 200, body: metadata },
  ])), /required workflow branch/u)
})

test("metadata failure fails closed", async () => {
  await assert.rejects(resolveGitHubE2ETarget(base, scriptedFetch([
    { path: repositoryPath, status: 404, body: { message: "Not Found" } },
  ])), /Cannot inspect GitHub E2E repository/u)
})

test("unreadable default ref fails closed", async () => {
  await assert.rejects(resolveGitHubE2ETarget(base, scriptedFetch([
    { path: repositoryPath, status: 200, body: metadata },
    { path: defaultRefPath, status: 404, body: { message: "Not Found" } },
  ])), /Git-ref read capability/u)
})

test("exact disposable 404 is accepted only after default-ref capability", async () => {
  const resolved = await resetGitHubE2EDisposableBranch(base, scriptedFetch([
    ...resolvedSteps(),
    { path: exactReadPath, status: 404, body: { message: "Not Found" } },
  ]))
  assert.equal(resolved.repositoryId, "222")
})

test("arbitrary 422 is not absence", async () => {
  await assert.rejects(resetGitHubE2EDisposableBranch(base, scriptedFetch([
    ...resolvedSteps(),
    { path: exactReadPath, status: 422, body: { message: "Validation Failed" } },
  ])), /Cannot inspect GitHub E2E disposable ref/u)
})

test("recognized 422 missing reference is absence after capability", async () => {
  await resetGitHubE2EDisposableBranch(base, scriptedFetch([
    ...resolvedSteps(),
    { path: exactReadPath, status: 422, body: { message: "Reference does not exist" } },
  ]))
})

test("concurrent already-absent delete still performs final capability and absence proof", async () => {
  await resetGitHubE2EDisposableBranch(base, scriptedFetch([
    ...resolvedSteps(),
    { path: exactReadPath, status: 200, body: { object: { sha: "a".repeat(40) } } },
    { method: "DELETE", path: exactDeletePath, status: 422, body: { message: "Reference does not exist" } },
    ...resolvedSteps(),
    { path: exactReadPath, status: 404, body: { message: "Not Found" } },
  ]))
})

test("post-delete loss of default-ref capability fails", async () => {
  await assert.rejects(resetGitHubE2EDisposableBranch(base, scriptedFetch([
    ...resolvedSteps(),
    { path: exactReadPath, status: 200, body: { object: { sha: "a".repeat(40) } } },
    { method: "DELETE", path: exactDeletePath, status: 204 },
    { path: repositoryPath, status: 200, body: metadata },
    { path: defaultRefPath, status: 403, body: { message: "Forbidden" } },
  ])), /Git-ref read capability/u)
})

test("bounded absence polling can outlive three still-present observations", async () => {
  const stillPresent = { path: exactReadPath, status: 200, body: { object: { sha: "a".repeat(40) } } }
  const steps: Array<{ method?: string; path: string; status: number; body?: unknown }> = [
    ...resolvedSteps(),
    stillPresent,
    { method: "DELETE", path: exactDeletePath, status: 204 },
  ]
  for (let index = 0; index < 4; index++) steps.push(...resolvedSteps(), stillPresent)
  steps.push(...resolvedSteps(), { path: exactReadPath, status: 404, body: { message: "Not Found" } })

  await resetGitHubE2EDisposableBranch(base, scriptedFetch(steps), {
    verificationTimeoutMs: 1_000,
    verificationPollMs: 1,
  })
})

test("credentialed environment requires numeric expected repository ID", () => {
  assert.throws(() => readGitHubE2ETargetEnvironment({
    GITHUB_E2E_OWNER: "owner",
    GITHUB_E2E_REPO: "repo",
    GITHUB_E2E_BRANCH: "local-e2e",
    GITHUB_E2E_TOKEN: "secret",
  }), /GITHUB_E2E_EXPECTED_REPO_ID/u)
  assert.throws(() => readGitHubE2ETargetEnvironment({
    GITHUB_E2E_OWNER: "owner",
    GITHUB_E2E_REPO: "repo",
    GITHUB_E2E_BRANCH: "local-e2e",
    GITHUB_E2E_TOKEN: "secret",
    GITHUB_E2E_EXPECTED_REPO_ID: "repo-name",
  }), /numeric GitHub repository ID/u)
})
