import type { GitHubConfig } from "../../../src/lib/github-api"

const API = "https://api.github.com"
const FORBIDDEN_LOCAL_BRANCHES = new Set(["main", "master", "production", "prod", "release", "stable"])

export interface GitHubE2ETargetEnvironment {
  owner: string
  repo: string
  branch: string
  token: string
  expectedRepositoryId: string
  sourceRepositoryId?: string
  requiredBranch?: string
}

export interface ResolvedGitHubE2ETarget {
  config: GitHubConfig
  repositoryId: string
  fullName: string
  defaultBranch: string
  defaultBranchSha: string
}

export type GitHubE2EFetch = (url: string, init?: RequestInit) => Promise<Response>

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim()
  if (!value) throw new Error(`Missing required env var: ${name}`)
  return value
}

export function readGitHubE2ETargetEnvironment(env = process.env): GitHubE2ETargetEnvironment {
  const branch = required(env, "GITHUB_E2E_BRANCH")
  const expectedRepositoryId = required(env, "GITHUB_E2E_EXPECTED_REPO_ID")
  if (!/^[1-9][0-9]*$/u.test(expectedRepositoryId)) {
    throw new Error("GITHUB_E2E_EXPECTED_REPO_ID must be a numeric GitHub repository ID.")
  }
  if (FORBIDDEN_LOCAL_BRANCHES.has(branch.toLowerCase())) {
    throw new Error(`Refusing destructive GitHub E2E branch: ${branch}`)
  }
  return {
    owner: required(env, "GITHUB_E2E_OWNER"),
    repo: required(env, "GITHUB_E2E_REPO"),
    branch,
    token: required(env, "GITHUB_E2E_TOKEN"),
    expectedRepositoryId,
    sourceRepositoryId: env.GITHUB_E2E_SOURCE_REPO_ID?.trim() || undefined,
    requiredBranch: env.GITHUB_E2E_REQUIRED_BRANCH?.trim() || undefined,
  }
}

export function encodeGitHubE2ERefPath(branch: string): string {
  return branch.split("/").map(encodeURIComponent).join("/")
}

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2026-03-10",
  }
}

async function json<T>(response: Response, statuses: readonly number[], action: string): Promise<T> {
  const text = await response.text()
  if (!statuses.includes(response.status)) throw new Error(`${action}: HTTP ${response.status} ${text}`)
  return (text ? JSON.parse(text) : {}) as T
}

export async function resolveGitHubE2ETarget(
  input: GitHubE2ETargetEnvironment,
  request: GitHubE2EFetch = fetch,
): Promise<ResolvedGitHubE2ETarget> {
  const route = `${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}`
  const metadata = await json<{ id?: number; full_name?: string; default_branch?: string }>(
    await request(`${API}/repos/${route}`, { headers: headers(input.token) }),
    [200],
    "Cannot inspect GitHub E2E repository",
  )
  const repositoryId = String(metadata.id ?? "")
  if (repositoryId !== input.expectedRepositoryId) {
    throw new Error("GitHub E2E target repository ID does not match the pinned repository ID.")
  }
  if (input.sourceRepositoryId && repositoryId === input.sourceRepositoryId) {
    throw new Error("GitHub E2E target repository must not be the source repository.")
  }
  if (!metadata.full_name || !metadata.default_branch) throw new Error("GitHub E2E repository metadata is incomplete.")
  if (input.requiredBranch && input.branch !== input.requiredBranch) {
    throw new Error("GitHub E2E branch does not match the required workflow branch.")
  }
  if (input.branch === metadata.default_branch) throw new Error("GITHUB_E2E_BRANCH must not be the repository default branch.")

  const [owner, repo, ...extra] = metadata.full_name.split("/")
  if (!owner || !repo || extra.length > 0) throw new Error("GitHub E2E repository full_name is invalid.")
  const canonicalBase = `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
  const defaultRef = await json<{ object?: { sha?: string } }>(
    await request(`${canonicalBase}/git/ref/heads/${encodeGitHubE2ERefPath(metadata.default_branch)}`, { headers: headers(input.token) }),
    [200],
    "Cannot prove Git-ref read capability on target default branch",
  )
  if (!defaultRef.object?.sha) throw new Error("Target default-branch ref is missing its commit SHA.")

  return {
    config: { owner, repo, branch: input.branch, token: input.token },
    repositoryId,
    fullName: metadata.full_name,
    defaultBranch: metadata.default_branch,
    defaultBranchSha: defaultRef.object.sha,
  }
}

async function recognizedMissingRef(response: Response): Promise<boolean> {
  if (response.status === 404) {
    await response.arrayBuffer().catch(() => undefined)
    return true
  }
  if (response.status !== 422) return false
  const text = await response.text()
  try {
    return (JSON.parse(text) as { message?: string }).message === "Reference does not exist"
  } catch {
    return false
  }
}

export async function resetGitHubE2EDisposableBranch(
  input: GitHubE2ETargetEnvironment,
  request: GitHubE2EFetch = fetch,
): Promise<ResolvedGitHubE2ETarget> {
  const target = await resolveGitHubE2ETarget(input, request)
  const base = `${API}/repos/${encodeURIComponent(target.config.owner)}/${encodeURIComponent(target.config.repo)}`
  const exact = `${base}/git/refs/heads/${encodeGitHubE2ERefPath(target.config.branch)}`
  const auth = headers(input.token)

  const before = await request(exact, { headers: auth })
  if (await recognizedMissingRef(before)) return target
  if (before.status !== 200) throw new Error(`Cannot inspect GitHub E2E disposable ref: HTTP ${before.status}`)
  await before.arrayBuffer().catch(() => undefined)

  const deleted = await request(exact, { method: "DELETE", headers: auth })
  if (deleted.status === 204) await deleted.arrayBuffer().catch(() => undefined)
  else if (!(await recognizedMissingRef(deleted))) {
    throw new Error(`Cannot remove GitHub E2E disposable ref: HTTP ${deleted.status}`)
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    await resolveGitHubE2ETarget(input, request)
    const verify = await request(exact, { headers: auth })
    if (await recognizedMissingRef(verify)) return target
    if (verify.status !== 200) throw new Error(`Cannot verify GitHub E2E disposable ref absence: HTTP ${verify.status}`)
    await verify.arrayBuffer().catch(() => undefined)
    if (attempt < 3) await new Promise(resolve => setTimeout(resolve, attempt * 500))
  }
  throw new Error(`GitHub E2E disposable branch still exists: ${input.branch}`)
}
