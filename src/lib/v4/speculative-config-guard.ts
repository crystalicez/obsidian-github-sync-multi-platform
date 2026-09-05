import type { GitHubGitRef } from "../github-git-types"
import { decodeV4RemoteConfig } from "./remote-index"
import { V4_CONFIG_PATH } from "./protocol-types"
import { V4PublicationRaceError } from "./publication-race"

export interface V4SpeculativeConfigGithub {
  getGitRefOrNull(): Promise<GitHubGitRef | null>
  getFileBytes(path: string, ref?: string): Promise<{ bytes: Uint8Array; sha: string } | null>
}

function validConfigForRepo(bytes: Uint8Array, repoId: string): boolean {
  try {
    return decodeV4RemoteConfig(bytes).repoId === repoId
  } catch {
    // Malformed/non-V4 state must continue through the ordinary migration/error path.
    return false
  }
}

function bootstrapConfigRace(observedHeadSha: string | null): V4PublicationRaceError {
  return new V4PublicationRaceError({
    phase: "bootstrap-config",
    expectedHeadSha: null,
    observedHeadSha,
    publicationOutcome: "unknown",
    evidence: "remote-config-appeared",
    message: "V4 remote configuration appeared while initializing an empty branch.",
  })
}

export async function assertV4SpeculativeConfigStillAbsent(
  github: V4SpeculativeConfigGithub,
  repoId: string,
): Promise<void> {
  const ref = await github.getGitRefOrNull()
  if (!ref) return
  const file = await github.getFileBytes(V4_CONFIG_PATH, ref.sha)
  if (file && validConfigForRepo(file.bytes, repoId)) throw bootstrapConfigRace(ref.sha)
}

export function guardV4SpeculativeConfigGithub<T extends V4SpeculativeConfigGithub>(
  github: T,
  repoId: string,
): T {
  const getGitRefOrNull = github.getGitRefOrNull.bind(github)
  const getFileBytes = github.getFileBytes.bind(github)

  return new Proxy(github, {
    get(target, property, receiver) {
      if (property === "getGitRefOrNull") {
        return async (): Promise<GitHubGitRef | null> => {
          const ref = await getGitRefOrNull()
          if (!ref) return null
          const file = await getFileBytes(V4_CONFIG_PATH, ref.sha)
          if (file && validConfigForRepo(file.bytes, repoId)) throw bootstrapConfigRace(ref.sha)
          return ref
        }
      }
      if (property === "getFileBytes") {
        return async (path: string, ref?: string): Promise<{ bytes: Uint8Array; sha: string } | null> => {
          const file = await getFileBytes(path, ref)
          if (path !== V4_CONFIG_PATH || !file || !validConfigForRepo(file.bytes, repoId)) return file
          const observedHeadSha = ref ?? (await getGitRefOrNull())?.sha ?? null
          throw bootstrapConfigRace(observedHeadSha)
        }
      }
      const value = Reflect.get(target, property, receiver)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}
