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

Hard cancellation can prevent cleanup from running. Residue remains confined to the pinned disposable repository and a run-ID-derived branch.

Manual cleanup must follow the same fail-closed order as the workflow:

1. Start with the maintainer-known numeric target repository ID.
2. Resolve the configured owner/repository route and require its numeric ID to equal that known target ID and differ from the source repository ID.
3. Derive exactly `obsidian-sync-e2e/run-<RUN_ID>`.
4. Require that branch to differ from the target's actual `default_branch`.
5. Read the actual default-branch Git ref successfully and require a commit SHA. Repository metadata visibility alone is not enough.
6. Inspect the exact disposable branch ref.
7. If the exact ref is present, remove only that exact ref. If it is absent, accept absence only after step 5 proved Git-ref read capability.
8. Resolve the target again and successfully read the current default-branch Git ref again.
9. Verify the exact disposable ref is absent. Treat an unrelated/ambiguous API error as failure, not absence.

Do not use a cleanup recipe where an arbitrary `404` or `422` is considered success before default-ref capability has been proven.

## Metrics

The main suite prints safe JSON metrics per scenario containing scenario/mode, elapsed time, request/mutation counts, byte totals, retries, pacing/cooldown, unknown outcomes, transient-byte peak, and status classes. It does not log tokens, passphrases, logical file contents, or raw encrypted bytes. Raw branch polling/injection fetches are intentionally outside individual `GitHubClient` transport snapshots, while scenario elapsed time includes the whole scenario.
