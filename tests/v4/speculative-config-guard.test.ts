import assert from "node:assert/strict"
import test from "node:test"

import type { GitHubGitRef } from "../../src/lib/github-git-types"
import { V4_CONFIG_PATH, V4_FORMAT_VERSION, type V4RemoteConfig } from "../../src/lib/v4/protocol-types"
import {
  assertV4SpeculativeConfigStillAbsent,
  guardV4SpeculativeConfigGithub,
} from "../../src/lib/v4/speculative-config-guard"

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))

class MemoryGithub {
  ref: GitHubGitRef | null = null
  configBytes: Uint8Array | null = null
  configReads = 0
  refReads = 0

  async getGitRefOrNull(): Promise<GitHubGitRef | null> {
    this.refReads++
    return this.ref
  }

  async getFileBytes(path: string, _ref?: string): Promise<{ bytes: Uint8Array; sha: string } | null> {
    if (path !== V4_CONFIG_PATH || !this.configBytes) return null
    this.configReads++
    return { bytes: new Uint8Array(this.configBytes), sha: "config-blob" }
  }
}

function plaintextConfig(repoId: string): V4RemoteConfig {
  return {
    formatVersion: V4_FORMAT_VERSION,
    mode: "plaintext",
    repoId,
    pathLayout: "plaintext-v1",
  }
}

async function captureError(task: () => Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    await task()
  } catch (error) {
    return error as Record<string, unknown>
  }
  throw new Error("expected task to reject")
}

test("speculative empty config recheck reports a typed bootstrap-config race when valid V4 state appears", async () => {
  const github = new MemoryGithub()
  github.ref = { ref: "refs/heads/main", sha: "winner", type: "commit" }
  github.configBytes = bytes(plaintextConfig("o/r#main"))

  const error = await captureError(() => assertV4SpeculativeConfigStillAbsent(github, "o/r#main"))

  assert.equal(error.code, "V4_PUBLICATION_RACE")
  assert.equal(error.phase, "bootstrap-config")
  assert.equal(error.expectedHeadSha, null)
  assert.equal(error.observedHeadSha, "winner")
  assert.equal(error.publicationOutcome, "unknown")
})

test("speculative guard catches V4 config that appears during the session read window", async () => {
  const github = new MemoryGithub()
  github.configBytes = bytes(plaintextConfig("o/r#main"))
  const guarded = guardV4SpeculativeConfigGithub(github, "o/r#main")

  const error = await captureError(() => guarded.getFileBytes(V4_CONFIG_PATH))

  assert.equal(error.code, "V4_PUBLICATION_RACE")
  assert.equal(error.phase, "bootstrap-config")
  assert.equal(error.observedHeadSha, null)
  assert.equal(error.publicationOutcome, "unknown")
})

test("speculative guard leaves malformed non-V4 config for the ordinary migration/error path", async () => {
  const github = new MemoryGithub()
  github.ref = { ref: "refs/heads/main", sha: "malformed", type: "commit" }
  github.configBytes = new TextEncoder().encode("not-json")

  await assertV4SpeculativeConfigStillAbsent(github, "o/r#main")
  const guarded = guardV4SpeculativeConfigGithub(github, "o/r#main")
  const file = await guarded.getFileBytes(V4_CONFIG_PATH, "malformed")

  assert.ok(file)
  assert.deepEqual(file.bytes, github.configBytes)
})

test("speculative guard leaves a different-repository V4 config for repository identity validation", async () => {
  const github = new MemoryGithub()
  github.ref = { ref: "refs/heads/main", sha: "other", type: "commit" }
  github.configBytes = bytes(plaintextConfig("different/repo#main"))

  await assertV4SpeculativeConfigStillAbsent(github, "o/r#main")
  const guarded = guardV4SpeculativeConfigGithub(github, "o/r#main")
  const file = await guarded.getFileBytes(V4_CONFIG_PATH, "other")

  assert.ok(file)
  assert.deepEqual(file.bytes, github.configBytes)
})
