# D162 — contain untrusted requestUrl exceptions without losing immutable Git reads

Date: 2026-10-30. Scope: GitHub transport exception handling in normal V4 Sync. Re-encryption Wizard remains Preview-only and the release gate remains blocked.

## Finding

D161 removed raw GitHub HTTP response bodies from thrown errors. However, `GitHubClient.request()` still rethrew arbitrary errors from Obsidian's `requestUrl`. An adapter exception can include a sensitive token/file path in `message` or `cause` and can carry forged `status` and `headers`.

That fake status can have functional consequences. The Contents read path previously interpreted a thrown `status: 404` as confirmed absence for mutable refs. A thrown `status: 422` in a Git ref write could also misclassify a potentially successful mutation as definitive. These are not authenticated HTTP responses.

## Repair

- At the single `requestUrl` rejection boundary, increment the existing network-failure metric, discard untrusted exception text, headers, status and cause, and raise a fixed `GitHubTransportUnconfirmedError` with no HTTP status. This preserves `unknown-outcome` classification for uncertain Git mutations. The existing reachable-ref no-retry policy stays intact.
- If this request's V4 operation signal is aborted, raise a generic `V4CancelledError` instead of exposing an adapter message. For uncertain in-flight mutations, the mutation wrapper still reports unknown outcome; it does not claim successful cancellation or replay a reachable ref.
- Preserve the existing read-only immutable-commit fallback. When Contents fails with the sanitized transport error and the requested ref is a full 40-hex commit SHA, `getFileBytes` verifies the commit/tree/blob through independent Git reads. A mutable branch receives a transport error rather than a fabricated missing file. Actual HTTP 404 responses continue to take the existing path.
- Actual HTTP responses and the existing 403/429 Retry-After handling, scheduler cooldown, status-based mutation classification and strict GraphQL CAS are unchanged. No GitHub mutation, repository format, KDF or recovery policy change is part of D162.

## Tests and evidence

Added three `tests/v4/github-error-redaction.test.ts` behavior checks. Thrown Error objects with fake `404` or `422`, synthetic credential/file text, forged headers, plain strings and `null` now yield only fixed messages; mutable files do not appear missing; reachable-ref writes report unknown outcome exactly once with a sanitized cause; aborted reads retain typed cancellation. Network-failure and unknown-outcome counters are checked.

Expanded `github-immutable-read-fallback-additional.test.ts` to prove authenticated immutable Git content still loads after Contents throws both fake `404` and fake `403` exceptions. The original source failed three new focused checks before the repair. The first full Fast run found the older 404 fallback regression, which was repaired without trusting the thrown status. Focused checks pass; repeated full Fast, Recovery, Feasibility, Resource, maximum strict TypeScript build, GitHub E2E compile-only (three bundles), metadata/package validation and bounded 100,000,000-byte SHA-matched cryptographic soak all exit 0.

No native Obsidian application, live GitHub test-repository writes, physical Android/iOS tests, power-loss test or real vault migration was performed for D162. This change does not establish OS-wide writer isolation, power-loss durability, cross-store cutover safety or release readiness.
