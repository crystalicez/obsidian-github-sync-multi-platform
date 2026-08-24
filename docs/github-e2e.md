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

Never use `main`, `master`, `production`, `prod`, `release`, or `stable`; the runner rejects those exact branch names. The target repository/branch is destructive test state and must not be a real notes repository.

Run:

```bash
pnpm test:github-e2e:quick
```

For a credential-free bundle check:

```bash
GITHUB_E2E_COMPILE_ONLY=1 pnpm test:github-e2e:quick
```

Ordinary CI uses only this compile gate.

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

## Cleanup residue

Hard cancellation can prevent any cleanup job from running. Residue is isolated by run ID and is safe to inspect/delete manually. With a token scoped to the disposable repo:

```bash
export E2E_OWNER=owner
export E2E_REPO=repository
export E2E_TOKEN=token
export RUN_ID=123456789
node - <<'NODE'
const owner = process.env.E2E_OWNER;
const repo = process.env.E2E_REPO;
const token = process.env.E2E_TOKEN;
const branch = `obsidian-sync-e2e/run-${process.env.RUN_ID}`;
const ref = branch.split("/").map(encodeURIComponent).join("/");
const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${ref}`, {
  method: "DELETE",
  headers: {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  },
});
if (![204, 404].includes(response.status)) throw new Error(`cleanup HTTP ${response.status}: ${await response.text()}`);
console.log(`cleanup status ${response.status}`);
NODE
```

## Metrics

The main suite prints safe JSON metrics per scenario containing scenario/mode, elapsed time, request/mutation counts, byte totals, retries, pacing/cooldown, unknown outcomes, transient-byte peak, and status classes. It does not log tokens, passphrases, logical file contents, or raw encrypted bytes. Raw branch polling/injection fetches are intentionally outside individual `GitHubClient` transport snapshots, while scenario elapsed time includes the whole scenario.
