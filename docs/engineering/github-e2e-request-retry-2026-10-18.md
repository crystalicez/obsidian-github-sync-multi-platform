# GitHub E2E mutation retry safety (2026-10-18)

## Finding

The real-GitHub E2E request bridge in `tests/github-e2e/v4-real-github-e2e.test.ts` previously retried every HTTP request after 429, 401, 403, or HTTP 5xx, including `POST` and `PATCH` mutations. GitHub can apply a ref update or object creation even when its response is lost or indicates an uncertain outcome. An automatic second request can change the observed result, mask the original failure, and produce false E2E evidence. This was a **test harness defect**. It does not establish a production-client mutation retry defect.

## Change

`tests/github-e2e/support/request-retry.ts` now retries only read-only `GET` or `HEAD` requests after HTTP 429 or 5xx. It never replays `POST`, `PUT`, `PATCH`, or `DELETE` after a response or thrown network error. It returns the original failed mutation response to the production GitHub client, which owns mutation-outcome reconciliation. Unauthorized 401 and other non-retryable responses return without retry.

The harness uses the same helper for the Obsidian `requestUrl` bridge and for its direct external-commit requests. The existing exact-target and branch cleanup safety checks remain unchanged. No repository, GitHub branch, production sync policy, or runtime byte path was mutated by the regression tests.

## Evidence and limits

The first focused execution failed 3 of 4 tests for expected behavioral mismatches: `PATCH` returned the result of a second request, `POST` did the same, and 401 was requested three times. These were assertion failures, not missing imports or fixture errors. After the repair, the focused suite passed **6/6**, covering HTTP 503, HTTP 429, all four write methods, an unknown network outcome, GET retry, and 401 refusal. The working tree's `pnpm build`, `pnpm test:fast`, `pnpm test:repeat` (10 runs), `pnpm test:github-e2e:compile`, `pnpm test:recovery`, `pnpm test:resource`, `pnpm test:feasibility`, `pnpm validate:metadata`, and `pnpm validate:package` all exited 0.

These results are **non-credentialed**. They do not clear the earlier intermittent full-suite `controlled-external-branch-head-race` failure. That scenario must still pass a fully captured live run with an exact committed source SHA and verified disposable-branch cleanup. Hosted CI, independent review, physical mobile, and release qualification remain open. Draft PR #8 must not be merged or released on this evidence alone.

The primary checkout also contains pre-existing unstaged `tests/v4/github-transport.test.ts` changes. Those changes were not edited or staged for this work. The deterministic test results are from a working tree, not an independent clean exact-SHA checkout.
