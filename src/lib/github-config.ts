const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u
const GITHUB_REPOSITORY = /^[A-Za-z0-9._-]{1,100}$/u

export function assertSafeGitHubOwner(value: string, allowEmpty = false): void {
  if (allowEmpty && value === "") return
  if (!GITHUB_OWNER.test(value)) throw new Error("Invalid GitHub owner.")
}

export function assertSafeGitHubRepository(value: string, allowEmpty = false): void {
  if (allowEmpty && value === "") return
  if (!GITHUB_REPOSITORY.test(value) || value === "." || value === "..") {
    throw new Error("Invalid GitHub repository.")
  }
}

export function assertSafeGitHubRepositoryCoordinates(
  owner: string,
  repo: string,
  options: { allowEmpty?: boolean } = {},
): void {
  assertSafeGitHubOwner(owner, options.allowEmpty)
  assertSafeGitHubRepository(repo, options.allowEmpty)
}
