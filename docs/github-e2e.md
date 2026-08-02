# V4 GitHub REST end-to-end test

The destructive test uses a dedicated non-default branch in a real GitHub repository. The quick smoke workload verifies small plaintext and encrypted V4 force push, encrypted rename, no-change detection, binary object validation, force pull, and final branch cleanup. It is a live network smoke measurement, not a 5 GiB qualification.

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

The quick run prints one safe JSON metric line per mode:

```json
{
  "mode": "plaintext|encrypted",
  "elapsedMs": 1234.5,
  "transport": {
    "requests": 0,
    "mutations": 0,
    "requestBytes": 0,
    "responseBytes": 0,
    "retries": 0,
    "cooldownMs": 0,
    "pacingMs": 0,
    "unknownOutcomes": 0,
    "transientBytesPeak": 0,
    "statusClasses": { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0, "network": 0 }
  }
}
```

These metrics expose request count, mutation count, request/response bytes, retries, cooldown time, pacing time, unknown outcomes, transient-byte peak, and status classes without logging tokens, logical paths, file contents, or raw encrypted bytes. The boundary is intentional: `elapsedMs` measures the live round trip for that mode after branch reset, while `transport` intentionally excludes the raw `fetch()` polling inside `waitForBranchHead()`.

For a compile-only safety check:

```bash
GITHUB_E2E_COMPILE_ONLY=1 npm run test:github-e2e
```
