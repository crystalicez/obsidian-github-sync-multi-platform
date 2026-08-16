# V4 GitHub REST end-to-end test

The destructive test uses a dedicated non-default branch in a real GitHub repository. One physical runner process can simulate multiple independent Obsidian devices: Device A, B, and C each have their own in-memory vault, V4 local index, device ID, `GitHubClient`, and `V4SyncSession`, while every device talks to the same real GitHub repository and branch. This makes stale-device conflicts and branch-head races real remote behavior even when the test runs on one machine.

The current runner is a small/medium real-REST release smoke suite with safe metrics. It is intentionally deterministic: sequential multi-device scenarios and a one-shot controlled race are used instead of random concurrency or arbitrary sleep timing.

## Scenario coverage

For plaintext and encrypted V4, the quick E2E covers:

- force push -> no-op -> history -> clean-vault force pull,
- Unicode/emoji/nested paths, spaces/punctuation, dotfile-style user content, zero-byte files, and a deterministic 1 MiB binary,
- encrypted logical-path opacity plus Contents API vs canonical Git Blob byte equality,
- two-device stale catch-up while the stale device also creates a disjoint local file,
- same-file concurrent edits using the `copy` conflict policy, followed by a third-device clean pull that proves both lineages survive,
- rename on Device A versus a stale edit on Device B,
- delete -> publish -> recreate at the same logical path with a required file-identity break,
- cross-device binary overwrite and exact pull-back verification.

The suite also runs one controlled plaintext branch-head race. Immediately before a targeted plugin branch-ref `PATCH`, the harness creates a valid external Git commit on the same disposable branch and publishes it with `force: false`. The plugin publish must not silently overwrite that commit; the failure/replan contract is asserted, sync is rerun from the advanced head, and branch history must retain the injected external commit.

Every scenario resets only the configured disposable branch. The final `after()` cleanup deletes that branch and verifies it is absent.

## Qualification boundary

This E2E is a live network and multi-device correctness smoke test. It is **not** a physical-device qualification, 5 GiB qualification, pack-scale benchmark, or large-file performance claim. Physical Windows large-file evidence remains separate in `tests/baselines/v4/windows.json` and `docs/testing/v4-windows-android-validation.md`.

Pack and multi-gigabyte workloads require separate runners and evidence for request counts, memory, elapsed time, interruption/recovery, and final-byte equality. Do not add pack/large-file environment variables to this quick runner until those workloads are implemented deliberately.

## Configuration

Set these values in `.env.github-e2e` or the process environment:

```text
GITHUB_E2E_OWNER=owner
GITHUB_E2E_REPO=repository
GITHUB_E2E_BRANCH=codex-v4-e2e
GITHUB_E2E_TOKEN=token-with-contents-write-access
```

Never use `main`, `master`, `production`, `prod`, `release`, or `stable`; the runner rejects those names. Use a disposable repository/branch because the suite deletes and recreates the configured branch repeatedly.

Run:

```bash
pnpm test:github-e2e:quick
```

The run prints one safe JSON metric line per scenario. The shape is approximately:

```json
{
  "scenario": "two-device-same-file-copy-conflict",
  "mode": "plaintext|encrypted",
  "elapsedMs": 1234.5,
  "devices": {
    "device-a": {
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
}
```

Metrics expose scenario/mode, elapsed time, request and mutation counts, request/response bytes, retries, cooldown/pacing time, unknown outcomes, transient-byte peak, and status classes. They never log tokens, passphrases, logical file contents, or raw encrypted bytes. Raw `fetch()` calls made by branch polling and the controlled external-commit injector are intentionally outside each `GitHubClient` transport snapshot, while `elapsedMs` includes the whole scenario.

For a compile-only safety check that requires no GitHub credentials:

```bash
GITHUB_E2E_COMPILE_ONLY=1 pnpm test:github-e2e:quick
```

CI runs this compile-only gate so changes to the destructive harness cannot silently stop bundling.