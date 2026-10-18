#!/usr/bin/env node
// Opt-in only; fresh disposable GitHub branch and pinned numeric repository are mandatory.
import { spawnSync } from "node:child_process"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { build } from "esbuild"

import { loadGitHubE2EEnv, requireGitHubE2EConfig, sanitizeGitHubE2ELiveEnv } from "./github-e2e-env.mjs"
import { preflightE2ERemote, readE2EBranch, readE2ERepository } from "./github-e2e-remote.mjs"
import { readOriginFetchRepository } from "./github-repo.mjs"

function option(name) {
  const arg = process.argv.slice(2).find(value => value.startsWith(`--${name}=`))
  return arg?.slice(name.length + 3)
}

const root = process.cwd()
try {
  const expectedRepoId = option("expected-repo-id")
  const branch = option("branch")
  const logicalBytes = Number(option("bytes") ?? 100_000_000)
  if (![16_000_000, 32_000_000, 50_000_000, 100_000_000].includes(logicalBytes)) {
    throw new RangeError("Live test size must be an approved value no greater than 100 MB")
  }
  if (!/^[1-9][0-9]*$/u.test(expectedRepoId ?? "")) throw new Error("Explicit pinned numeric --expected-repo-id is mandatory")
  if (!/^obsidian-sync-e2e\/local-[a-z0-9-]{8,80}$/u.test(branch ?? "")) {
    throw new Error("Explicit fresh --branch=obsidian-sync-e2e/local-... is mandatory")
  }
  const source = readOriginFetchRepository({
    runner: (cmd, args, opts) => spawnSync(cmd, args, { ...opts, shell: false }), cwd: root,
  })
  const loaded = await loadGitHubE2EEnv({ cwd: root, env: process.env })
  const env = { ...loaded.env, GITHUB_E2E_EXPECTED_REPO_ID: expectedRepoId, GITHUB_E2E_BRANCH: branch,
    GITHUB_E2E_REQUIRED_BRANCH: branch, V4_GITHUB_E2E_TEST_FILE_BYTES: String(logicalBytes) }
  const config = requireGitHubE2EConfig(env, { currentSourceRepo: source })
  const [owner, repo] = source.split("/")
  const sourceIdentity = await readE2ERepository({ owner, repo })
  env.GITHUB_E2E_SOURCE_REPO_ID = sourceIdentity.id
  await preflightE2ERemote({ config: { ...config, currentSourceRepoId: sourceIdentity.id } })
  const prior = await readE2EBranch({ owner: config.owner, repo: config.repo, branch, token: config.token })
  if (prior.kind !== "absent") throw new Error("Refusing 100 MB live test: disposable branch already exists")
  console.log(`GitHub <=100 MB live preflight PASS: bytes=${logicalBytes}, pinned target, default branch verified, disposable branch absent`)
  const outDir = path.join(root, ".tmp", "github-e2e", `100mb-${process.pid}-${Date.now()}`)
  await mkdir(outDir, { recursive: true })
  const outfile = path.join(outDir, "v4-real-100mb-github-e2e.test.mjs")
  await build({ entryPoints: [path.join(root, "tests/github-e2e/v4-real-100mb-github-e2e.test.ts")],
    outfile, bundle: true, platform: "node", format: "esm", target: "node22",
    alias: { obsidian: path.join(root, "tests/stubs/obsidian.ts") }, logLevel: "silent" })
  const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", outfile], {
    cwd: root, env: sanitizeGitHubE2ELiveEnv(env), stdio: "inherit", shell: false,
  })
  process.exit(result.status ?? 1)
} catch (error) {
  console.error("GitHub 100 MB live test refused:", error instanceof Error ? error.message : String(error))
  process.exitCode = 2
}
