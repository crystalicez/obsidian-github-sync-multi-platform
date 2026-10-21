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

**Policy from 2026-10-21: GitHub Actions are prohibited for this project.** Qualification is local/manual only with isolated credentials and exact target repository ID. The local `pnpm qualify:local` process compiles and verifies the E2E inputs before running against a unique disposable branch, and requires cleanup/absence evidence before producing an exact-SHA qualification receipt.

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

Manual execution also resolves the checkout's GitHub `origin` **and its numeric repository ID**. It refuses a destructive target equal to either the current source repository or the canonical source repository by route/name or by numeric repository identity. Before mutation, the configured owner/repository route must resolve to `GITHUB_E2E_EXPECTED_REPO_ID`, the selected branch must differ from the actual target default branch, and the target default Git ref must be readable. If source identity cannot be proven, the manual run fails closed.

## Official local release qualification

`pnpm qualify:local` is stricter than an ordinary manual live-E2E invocation because it is release authority for one exact commit.

The qualifier loads `GITHUB_E2E_OWNER`, `GITHUB_E2E_REPO`, `GITHUB_E2E_EXPECTED_REPO_ID`, and `GITHUB_E2E_TOKEN`, but it **does not use the configured manual `GITHUB_E2E_BRANCH`**. Instead it generates a unique branch:

```text
obsidian-sync-e2e/local-<sha12>-<run-id>
```

Only the child live-E2E process receives that branch override; `.env.github-e2e` is not rewritten.

Before the live child starts, official qualification proves:

- the E2E target is not the canonical/current source repository by repository route **or numeric repository ID**,
- the configured route resolves to the pinned numeric `GITHUB_E2E_EXPECTED_REPO_ID`,
- target repository metadata and its actual default Git ref are readable,
- the generated branch is not the target repository's actual default branch.

Credential scopes are separated deliberately. Install/build/test/compile children do not receive `GITHUB_E2E_TOKEN` or standard GitHub source/publication tokens such as `GH_TOKEN` / `GITHUB_TOKEN`. The destructive live-E2E child receives the dedicated `GITHUB_E2E_TOKEN` but has the standard source/publication GitHub token variables stripped.

After the live child returns, **whether the child succeeded or failed**, the qualifier performs bounded out-of-band cleanup restricted to the `obsidian-sync-e2e/local-` namespace:

1. re-prove the pinned target repository identity and readable actual default ref before each delete attempt,
2. read the exact unique qualification branch,
3. delete it if present,
4. re-prove the pinned target identity/default-ref capability again,
5. read the exact qualification branch **after that final proof** and require absence,
6. retry the bounded cleanup/verify sequence when appropriate.

A stale earlier 404 is never accepted as cleanup proof. A qualification receipt cannot be created unless the live child succeeded **and** the final post-proof branch read is absent.

A hard process kill, machine loss, or power failure can prevent this outer cleanup from running. Because each official run uses a unique branch, any residue is isolated and the qualifier prints the safe branch identifier for manual inspection.

An already-valid remote qualification receipt for the exact current SHA/version/toolchain/gate contract may short-circuit a later `qualify:local` invocation after source/master/toolchain verification; E2E credentials are needed when creating a new qualification, not to re-prove an existing valid receipt.

## Local-only qualification — no hosted workflows

The only approved qualification workflow is the explicit maintainer-local `pnpm qualify:local` path. It verifies exact source commit SHA, canonical origin, toolchain, pinned disposable E2E repository identity, generated unique branch, real tests, and cleanup. There is no hosted qualification or GitHub Actions runner, and no need to configure GitHub Actions Environments.

Do not dispatch or enable GitHub Actions. The absence of workflow runs is intentional and is not a release blocker.

## Cleanup residue

Hard cancellation can prevent cleanup from running. Residue remains isolated by the run-specific branch.

For official local qualification, use the exact `obsidian-sync-e2e/local-...` branch printed by `qualify:local`.

Cleanup is fail-closed. Before each delete attempt for an official local qualification branch, the tool re-resolves the configured target, requires its numeric repository ID to equal `GITHUB_E2E_EXPECTED_REPO_ID`, rejects canonical/current source repository IDs, rejects the actual default branch, and proves the default Git ref is readable. Success requires another target proof followed by a fresh exact-branch read that is absent; an absence observed before that proof is not sufficient.

Never treat an arbitrary 404/422 as sufficient cleanup proof, and never reuse cleanup guidance against the source repository or a real notes branch.

## Metrics

The main suite prints safe JSON metrics per scenario containing scenario/mode, elapsed time, request/mutation counts, byte totals, retries, pacing/cooldown, unknown outcomes, transient-byte peak, and status classes. It does not log tokens, passphrases, logical file contents, or raw encrypted bytes. Raw branch polling/injection fetches are intentionally outside individual `GitHubClient` transport snapshots, while scenario elapsed time includes the whole scenario.
