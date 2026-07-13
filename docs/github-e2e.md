# V4 GitHub REST end-to-end test

The destructive test uses a dedicated non-default branch in a real GitHub repository. It verifies plaintext and encrypted V4 force push, no-change detection, and force pull, then deletes the test branch.

Set these values in `.env.github-e2e` or the process environment:

```text
GITHUB_E2E_OWNER=owner
GITHUB_E2E_REPO=repository
GITHUB_E2E_BRANCH=codex-v4-e2e
GITHUB_E2E_TOKEN=token-with-contents-write-access
```

Never use `main`, `master`, `production`, `prod`, `release`, or `stable`; the runner rejects those names.

Run:

```bash
npm run test:github-e2e
```

For a compile-only safety check:

```bash
GITHUB_E2E_COMPILE_ONLY=1 npm run test:github-e2e
```
