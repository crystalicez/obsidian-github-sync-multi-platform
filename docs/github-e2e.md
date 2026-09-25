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

Release-qualifying GitHub Actions deliberately do **not** compile the live suites on the credentialed runner. Ordinary read-only CI compiles the exact three E2E bundles and publishes a provenance-bound artifact; **GitHub E2E Live** consumes only those verified bundles on a fresh runner.

## Local/manual configuration

Credentialed local execution requires all of these values in `.env.github-e2e` or the shell:

```text
GITHUB_E2E_OWNER=owner
GITHUB_E2E_REPO=dedicated-disposable-repository
GITHUB_E2E_EXPECTED_REPO_ID=123456789
GITHUB_E2E_BRANCH=local-v4-e2e
GITHUB_E2E_TOKEN=<credential scoped only to that repository>
```

`GITHUB_E2E_EXPECTED_REPO_ID` is mandatory and must be the target repository's numeric GitHub ID. Owner/repository text is routing information only; the resolved numeric ID is checked before destructive work. Never use `main`, `master`, `production`, `prod`, `release`, or `stable`, and never point this configuration at a real notes repository.

For release-qualifying use, the credential's mutable repository scope must be limited to the dedicated disposable target repository. A token that can modify the plugin source repository or unrelated repositories is not acceptable qualification configuration.

Run the local convenience flow with:

```bash
pnpm test:github-e2e:quick
```

Local quick mode compiles and runs in one process. For a credential-free compile check on any supported shell, including PowerShell:

```text
pnpm test:github-e2e:compile
```

The runner also accepts `node scripts/run-github-e2e.mjs --compile-only`. Compile-only mode does not load the target env file and requires no target credential or repository ID.

Manual execution also resolves the checkout's GitHub `origin` and refuses a destructive target equal to that current source repository or the canonical source repository. Before mutation, the configured owner/repository route must resolve to `GITHUB_E2E_EXPECTED_REPO_ID`, the selected branch must differ from the actual target default branch, and the target default Git ref must be readable.

## Official local release qualification

`pnpm qualify:local` is stricter than an ordinary manual live-E2E invocation because it is release authority for one exact commit.

The qualifier loads `GITHUB_E2E_OWNER`, `GITHUB_E2E_REPO`, `GITHUB_E2E_EXPECTED_REPO_ID`, and `GITHUB_E2E_TOKEN`, but it **does not use the configured manual `GITHUB_E2E_BRANCH`**. Instead it generates a unique branch:

```text
obsidian-sync-e2e/local-<sha12>-<run-id>
```

Only the child live-E2E process receives that branch override; `.env.github-e2e` is not rewritten.

Before the live child starts, official qualification proves:

- the E2E target is not the canonical/current source repository,
- the configured route resolves to the pinned numeric `GITHUB_E2E_EXPECTED_REPO_ID`,
- target repository metadata and its actual default Git ref are readable,
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

In repository **Settings -> Environments**, create or update `github-e2e`:

```text
Settings -> Environments -> github-e2e
Deployment branches and tags -> Selected branches and tags
Allowed branch -> master
Allowed tags -> none

Variable: E2E_OWNER
Variable: E2E_REPO
Variable: E2E_REPO_ID
Secret:   E2E_TOKEN
```

Do not choose **Protected branches only** while `master` has no branch-protection rule. The environment must explicitly allow `master` and no release tags.

Do not create variables/secrets named `GITHUB_E2E_*`; GitHub reserves the `GITHUB_` prefix. The workflow maps environment configuration into process variables only in the fixed steps that need them.

`E2E_REPO_ID` is the authority. `E2E_OWNER/E2E_REPO` only route the API request. Before target work, the workflow resolves current repository metadata and requires:

```text
resolved target ID == E2E_REPO_ID
resolved target ID != source GITHUB_REPOSITORY_ID
run-derived branch != actual target default branch
actual target default-branch Git ref is readable
```

For each workflow run the destructive branch is exactly:

```text
obsidian-sync-e2e/run-${GITHUB_RUN_ID}
```

Different workflow run IDs therefore isolate branch state. Reruns of one workflow run intentionally reuse that run's branch.

### Release-qualifying execution flow

A qualifying current workflow attempt is:

```text
newest exact-SHA ordinary CI push run/current attempt succeeds
-> exact github-e2e-input artifact is selected and verified
-> fresh live runner validates archive digest/shape/manifest/bundle hashes
-> pinned target identity + default-ref capability are proven
-> same-attempt qualification receipt is uploaded successfully
-> exact three verified bundles execute serially with target credential
-> cleanup independently re-proves current pinned target identity/capability
-> cleanup succeeds in that same workflow attempt
```

The receipt artifact is named:

```text
github-e2e-target-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}
```

It binds the live attempt to its exact source SHA, authoritative CI producer/artifact, and observed target identity. Receipt persistence is blocking and occurs before scenario target mutation. The receipt does not itself prove the tests passed; `qualify` job success does that.

A release qualification must be cohesive in one **current/latest workflow attempt**: `qualify` success, a valid same-attempt receipt, and `cleanup` success. Older job executions are never mixed with a newer attempt.

If cleanup fails, **Re-run failed jobs** may safely remove residue. That cleanup-only attempt is maintenance evidence only and is **not** release qualification. To restore release qualification, use **Re-run all jobs** so the new current attempt runs `qualify`, writes a new receipt, executes the bundles, and completes cleanup.

## Cleanup residue

Hard cancellation can prevent cleanup from running. Residue remains isolated by the run-specific branch.

For an Actions run:

```text
obsidian-sync-e2e/run-<GITHUB_RUN_ID>
```

For official local qualification, use the exact `obsidian-sync-e2e/local-...` branch printed by `qualify:local`.

Cleanup is fail-closed. Before deleting an official local qualification branch, the tool re-resolves the configured target and requires its numeric repository ID to equal `GITHUB_E2E_EXPECTED_REPO_ID`, rejects the actual default branch, and proves the default Git ref is readable. After branch absence is observed, it re-proves the same pinned target identity/capability before qualification can succeed.

For Actions residue, follow the pinned-ID/default-ref procedure documented by the workflow. Never treat an arbitrary 404/422 as sufficient cleanup proof, and never reuse cleanup guidance against the source repository or a real notes branch.

## Metrics

The main suite prints safe JSON metrics per scenario containing scenario/mode, elapsed time, request/mutation counts, byte totals, retries, pacing/cooldown, unknown outcomes, transient-byte peak, and status classes. It does not log tokens, passphrases, logical file contents, or raw encrypted bytes. Raw branch polling/injection fetches are intentionally outside individual `GitHubClient` transport snapshots, while scenario elapsed time includes the whole scenario.
