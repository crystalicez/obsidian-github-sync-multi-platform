# V4 GitHub REST end-to-end test

The destructive suite uses a dedicated non-default branch in a real GitHub repository. One physical runner simulates independent Obsidian devices A/B/C with separate in-memory vaults, V4 indexes, device IDs, `GitHubClient`s, and `V4SyncSession`s while sharing one real remote branch. This makes stale-device conflicts and branch-head races real network behavior without requiring multiple physical machines.

The suite is deliberately deterministic: sequential multi-device scenarios and controlled one-shot interference are preferred over random concurrency or correctness-by-sleep timing.

## Scenario coverage

The main plaintext/encrypted suite covers:

- force push -> no-op -> history -> clean-vault force pull,
- Unicode/emoji/nested paths, spaces/punctuation, dotfile-style content, zero-byte files, and deterministic binary payloads,
- encrypted logical-path opacity and authenticated object verification,
- two-device stale catch-up plus disjoint local creation,
- same-file concurrent edits using Copy policy,
- rename versus stale edit,
- delete -> publish -> recreate identity break,
- cross-device binary overwrite,
- controlled plaintext branch-head interference with a real external Git commit.

A second focused live test covers encrypted out-of-band mutation. It publishes encrypted V4, injects a normal Git commit that does not update the authenticated V4 journal/head contract, and proves normal encrypted sync refuses the mutation without silently overwriting the injected commit or trusting it in the local index.

The runner executes E2E test files serially so their destructive branch reset/cleanup phases cannot race one another.

## Qualification boundary

This is a live network and multi-device correctness smoke suite. It is **not** physical-device qualification, 5 GiB qualification, pack-scale benchmarking, or a large-file performance claim. Physical Windows/Android evidence remains separate in `tests/baselines/v4/` and `docs/testing/v4-windows-android-validation.md`.

## Local/manual configuration

Set these process variables in `.env.github-e2e` or the shell:

```text
GITHUB_E2E_OWNER=owner
GITHUB_E2E_REPO=dedicated-disposable-repository
GITHUB_E2E_BRANCH=local-v4-e2e
GITHUB_E2E_TOKEN=token-with-contents-write-access
```

The target repository must be dedicated disposable test state, never a real notes repository. Manual E2E may be launched from a fork checkout, but the runner refuses a destructive target equal to either:

- the checkout's current GitHub `origin` repository, or
- the canonical source repository `crystalicez/obsidian-github-sync-multi-platform`.

The runner also rejects protected-looking branch names (`main`, `master`, `production`, `prod`, `release`, `stable`) and reads the target repository metadata before mutation so it can reject the repository's **actual default branch**, even when that branch has another name such as `trunk`.

Run:

```bash
pnpm test:github-e2e:quick
```

For a credential-free bundle check on any supported shell, including PowerShell:

```text
pnpm test:github-e2e:compile
```

The runner also accepts `node scripts/run-github-e2e.mjs --compile-only`. `GITHUB_E2E_COMPILE_ONLY=1` remains supported for CI/backward compatibility, but the package script is preferred for local use because it does not depend on shell-specific environment-variable syntax.

Compile-only mode does not require a Git checkout, credentials, or E2E configuration. Ordinary CI uses only this compile gate.

## Official local release qualification

`pnpm qualify:local` is stricter than an ordinary manual live-E2E invocation because it is release authority for one exact commit.

The qualifier loads `GITHUB_E2E_OWNER`, `GITHUB_E2E_REPO`, and `GITHUB_E2E_TOKEN`, but it **does not use the configured manual `GITHUB_E2E_BRANCH`**. Instead it generates a unique branch:

```text
obsidian-sync-e2e/local-<sha12>-<run-id>
```

Only the child live-E2E process receives that branch override; `.env.github-e2e` is not rewritten.

Before the live child starts, official qualification proves:

- the E2E target is not the canonical source repository,
- target repository metadata is readable,
- the generated branch is not the target repository's actual default branch.

After the live child returns, **whether the child succeeded or failed**, the qualifier performs bounded out-of-band cleanup:

1. read the unique branch ref,
2. delete it if present,
3. read again and require absence,
4. retry the bounded cleanup/verify sequence when appropriate.

A qualification receipt cannot be created unless the live child succeeded **and** branch absence was verified.

A hard process kill, machine loss, or power failure can prevent this outer cleanup from running. Because each official run uses a unique branch, any residue is isolated and the qualifier prints the safe branch identifier for manual inspection.

An already-valid remote qualification receipt for the exact current SHA/version/toolchain/gate contract may short-circuit a later `qualify:local` invocation after source/master/toolchain verification; E2E credentials are needed when creating a new qualification, not to re-prove an existing valid receipt.

## GitHub Actions live qualification

The source repository contains **GitHub E2E Live**, a `workflow_dispatch`-only workflow. Configure repository **Settings -> Environments -> `github-e2e`** with:

```text
Environment variable: E2E_OWNER
Environment variable: E2E_REPO
Environment secret:   E2E_TOKEN
```

Do not try to create GitHub configuration variables/secrets named `GITHUB_E2E_*`; GitHub reserves the `GITHUB_` prefix. The workflow maps `E2E_*` into the runner's `GITHUB_E2E_*` process environment.

`E2E_OWNER/E2E_REPO` must identify a **dedicated disposable E2E repository**, never this plugin source repository and never a real user vault. Prefer a fine-grained token scoped only to that disposable repository with repository Contents read/write permission.

For each workflow run the branch is derived automatically:

```text
obsidian-sync-e2e/run-${GITHUB_RUN_ID}
```

Different runs therefore have independent branch state. The `qualify` job refuses stale/non-master source SHAs and refuses a target repository equal to the plugin source repository. The `cleanup` job independently deletes and verifies the run-specific branch, with bounded retries. A live run is release-qualifying only when **both `qualify` and `cleanup` succeed**.

The optional qualification JSON artifact is for human audit only. Stable release authority comes from exact-SHA workflow/job metadata, so artifact expiry or upload-service failure cannot turn an otherwise successful exact-SHA live run into false qualification evidence.

The Actions qualification path and local qualification-tag path are independent authorities in v1: Actions Stable Release continues to require the Actions-native exact-SHA run, while `release:local` requires the exact remote annotated local qualification receipt.

## Cleanup residue

Hard cancellation can prevent any cleanup process/job from running. Residue is isolated by a unique run ID and is safe to inspect/delete manually.

For an Actions run the branch is:

```text
obsidian-sync-e2e/run-<GITHUB_RUN_ID>
```

For official local qualification, use the exact `obsidian-sync-e2e/local-...` branch printed by `qualify:local`.

With a token scoped to the disposable repo, a branch can be removed through the GitHub Contents/ref API after a maintainer confirms it is disposable E2E residue. Do not reuse this cleanup guidance against the source repository or a real notes branch.

## Metrics

The main suite prints safe JSON metrics per scenario containing scenario/mode, elapsed time, request/mutation counts, byte totals, retries, pacing/cooldown, unknown outcomes, transient-byte peak, and status classes. It does not log tokens, passphrases, logical file contents, or raw encrypted bytes. Raw branch polling/injection fetches are intentionally outside individual `GitHubClient` transport snapshots, while scenario elapsed time includes the whole scenario.
