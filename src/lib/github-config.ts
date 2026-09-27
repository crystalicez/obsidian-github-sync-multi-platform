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


const GIT_REF_FORBIDDEN = /[\u0000-\u0020\u007f~^:?*\[\\]/u

export function assertSafeGitHubBranch(value: string): void {
  if (typeof value !== "string" || value.length === 0) throw new Error("Invalid GitHub branch.")
  if (
    value === "@"
    || value.startsWith("/")
    || value.endsWith("/")
    || value.endsWith(".")
    || value.includes("//")
    || value.includes("..")
    || value.includes("@{")
    || GIT_REF_FORBIDDEN.test(value)
  ) {
    throw new Error("Invalid GitHub branch.")
  }
  for (const segment of value.split("/")) {
    if (!segment || segment.startsWith(".") || segment.endsWith(".lock")) {
      throw new Error("Invalid GitHub branch.")
    }
  }
}
