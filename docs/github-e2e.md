# Real GitHub E2E Tests

These tests exercise the plugin against a real GitHub repository and are intentionally separate from `npm test`.

## Safety model

- The suite is destructive only on `GITHUB_E2E_BRANCH`.
- The runner refuses protected-looking branch names: `main`, `master`, `production`, `prod`, `release`, `stable`.
- The token is read only from environment variables or a local env file and is not written to logs or artifacts.
- Benchmark output is written to `.tmp/github-e2e-results.json`.

## Env file setup

Create `.env.github-e2e` from `.env.github-e2e.example` and put the real token there. The real file is ignored by git.

```dotenv
GITHUB_E2E_OWNER=your-owner
GITHUB_E2E_REPO=your-dedicated-test-repo
GITHUB_E2E_BRANCH=e2e-destructive
GITHUB_E2E_TOKEN=github_pat_or_fine_grained_token

GITHUB_E2E_PACK_FILES=10050
GITHUB_E2E_LARGE_MIB=51
```

Then run:

```powershell
npm run test:github-e2e
```

The token needs permission to read/write repository contents and create/read refs for the dedicated test repo. The repo may be completely empty; the runner bootstraps it with an initial file on the default branch, then creates the destructive test branch from that commit when needed.

## Custom env file

```powershell
$env:GITHUB_E2E_ENV_FILE="C:\\secure\\github-e2e.env"
npm run test:github-e2e
```

Shell environment variables override values from the env file.

## Optional benchmark controls

`GITHUB_E2E_PACK_FILES` defaults to `10050` and `GITHUB_E2E_LARGE_MIB` defaults to `51`. Defaults intentionally cross the pack-mode and chunked-object thresholds. Pack-mode and large chunked object benchmarks run as separate tests so GitHub API failures identify the exact workload. Lower these only for smoke testing.

## Compile-only check

```powershell
$env:GITHUB_E2E_COMPILE_ONLY="1"
npm run test:github-e2e
```