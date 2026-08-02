# Task 2 checkpoint report

## Implementation

- Added `GitHubClient.gitBlobSha1()` using Git's `blob <byteLength>\0` object identity and the existing byte utilities.
- Validated decoded Contents bytes when GitHub returned a canonical 40-hex SHA.
- Preserved the one-request fast path for matching payloads and non-Git-shaped fake SHAs.
- Added exactly one canonical `getBlob(sha)` fallback for mismatched or unverifiable valid SHAs.
- Added a focused regression test that forces digest verification to fail and confirms `GitHubClient` still falls back to the canonical Git blob path.

## Files changed

- `src/lib/github-api.ts`
- `tests/v4/github-transport.test.ts` now includes the digest-failure fallback regression test in addition to the earlier Contents-transform case.

## Verification

- `git diff --check`: passed (exit code 0).
- `npm test -- --filter=tests/v4/github-transport.test.ts`: passed (21/21), run 5 consecutive times.
- `npm test -- --filter=tests/v4/sync-session.test.ts`: passed (86/86).
- Task 2 implementation commits: `2f9130f` and `1143568`.
- Whole-branch verification is recorded separately in `task-6-report.md` (build, fast 349/349, recovery 30/30, resource 11/11, feasibility 6/6, soak, repeat, and real E2E).

## Intentionally deferred tests

No additional broad suites were run beyond the two required focused suites (`tests/v4/github-transport.test.ts` and `tests/v4/sync-session.test.ts`).

## Notes

- The earlier default-sandbox `EPERM` during controller execution was permission-related, not a product failure; the elevated run completed successfully.
