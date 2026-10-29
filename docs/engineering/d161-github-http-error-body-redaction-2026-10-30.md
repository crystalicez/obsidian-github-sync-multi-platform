# D161 — GitHub REST/GraphQL untrusted response body redaction

Date: 2026-10-30. Normal Sync production security hardening. No native helper, GitHub Actions, release, live GitHub/Vault/SecretStorage writes or Re-encryption Cutover. `docs/release-gates/reencryption-wizard.json` remains `blocked`, Wizard Preview-only.

## Finding

`src/lib/github-api.ts` assembled REST error messages by directly concatenating GitHub `response.text` for rate limits, Contents file reads, Blob reads, and the shared HTTP error creator for repository/ref/commit/tree/GraphQL metadata, including mutations. The V4 Runtime publishes genuine `Error.message` into Sync Status and a Notice, so an upstream error response could echo a token-like string, private file content or arbitrary error body. GraphQL `updateRefs` also included untrusted `errors[].message` from HTTP-200 responses in the thrown strict CAS failure.

This is an **actual trust-boundary leak**, not a formatting issue. Truncation would not prevent exposure of a short secret; these untrusted body fields must be omitted.

## Implemented scope

- For REST errors, keep a deterministic high-level action and **HTTP status** only. Shared `gitHttpError` retains `error.status` so `classifyV4MutationFailure` still distinguishes definitive (e.g. 422) from unknown outcomes. Contents and Blob GET failure paths now use that same constructor rather than interpolating `response.text`.
- 429 / rate-limited 403 request errors still expose their trusted numeric status and normalized rate-limit **headers** (Retry-After/X-RateLimit) to `V4RequestScheduler`, while no longer embedding untrusted response text in the error message. No policy changes to rate limiting, mutation retries, repository identity, or CAS preconditions.
- HTTP-200 GraphQL `updateRefs` with `errors[]` now throws a fixed strict-CAS rejection message instructing HEAD/beforeOid review, without incorporating `errors[].message`. The existing caller reconciliation must still reread actual HEAD; no automatic override, REST fallback or blind ref retry is added.
- These boundaries do not swallow errors or turn unknown publication outcomes into safe successes.

## Focused behavioral evidence

`tests/v4/github-error-redaction.test.ts` uses Obsidian's fake `requestUrl` transport and a body containing a synthetic credential and sensitive filename. Four focused tests cover:
1. GitHub REST 403 failures on list commits, file Contents read, Blob read, and repository-identity read: message includes action + numeric status but **no body**.
2. Definitive REST 422 `createGitRef` mutation: status preserved, private body absent, exactly **one** mutation attempt.
3. 429 `listCommits`: status and `retry-after` header still available for scheduler, private text absent.
4. HTTP-200 GraphQL `updateRefs` with `errors[].message`: fixed strict-CAS message, no sensitive GraphQL text, one mutation attempt and no REST ref fallback.

Focused **4/4 PASS**. The existing transport policy and publication CAS suites continue to verify retry/cooldown and unknown-outcome correctness.

## Boundaries and next work

This patch eliminates the directly concatenated GitHub *HTTP response body* from transport errors, not every possible exception source: an exception thrown by a third-party `requestUrl` implementation may independently carry arbitrary text in `Error.message` or `cause`. A future review may isolate those transport-level exceptions at source while preserving status and abort semantics. This stage neither proves OS-wide writer exclusion and power-cut durability nor changes Re-encryption release permissions.
