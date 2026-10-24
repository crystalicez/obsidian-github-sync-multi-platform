# D47 — failure-only GitHub branch-head forensics (test harness)

Date: 2026-10-24 (Asia/Bangkok). Isolated ledger-owned `.worktrees/d47-branch-ref-forensics`, branch `audit/2026-10-24-d47-branch-ref-forensics`, direct child of D46 audited native/live qualification SHA `5d9a1d6`. No production source changes, default/release merge, GitHub Actions, real vault, native binary or cleanup of legacy worktrees.

## Why

The D45 real GitHub full E2E failed pre-publication in plaintext stale catch-up: expected head `3d202dbc89afd0dda103d1e04045f04dd2bf9a7d`, observed head `null`, `V4PublicationRaceError`, `phase=pre-publish`, `publicationOutcome=not-published`, one HTTP 4xx, zero mutations during the failed scenario. D46 next full run passed all 3 suites; intermittent branch REST visibility versus real deletion/other issues remains undetermined. D38's independent `Missing V4 remote object` remains open. Do not confuse one successful rerun with a causal fix.

## Forensic change (only synthetic GitHub E2E tests)

- New pure `tests/github-e2e/support/pre-publish-head-null-evidence.ts` observes only a **terminal** `pre-publish` `V4PublicationRaceError` with `expectedHeadSha` a lowercase 40-hex immutable commit, `observedHeadSha=null` and `publicationOutcome=not-published`.
- A failed synthetic device may perform two **independent read-only GETs**, after the original failure: (1) `GET /git/ref/heads/<exact-disposable-branch>` and (2) `GET /git/commits/<expected-immutable-sha>`. Capture HTTP status, validated commit/tree SHA if available, device ID, valid local-index commit SHA and expected SHA. No token, raw JSON, file path/content, or HTTP body logged. Malformed SHAs are omitted; read failures recorded as a non-sensitive fixed code.
- These observations are **not atomic** relative to the original failure and cannot establish whether a missing ref was temporary, deleted, or a race solely from a later 200. They are for triage, not authorization to publish.
- No branch observation on success, unrelated phases, unknown outcome or non-null observed head. Only the synthetic test harness is wired, when a run was going to throw anyway after its existing attempt policy. The original exception identity and failure outcome are maintained even if either observer request/logging fails. No extra mutation/retry, CAS or production networking behavior changed.
- Original D46 full E2E/writer/native evidence remains valid for production source content because `src/**` is untouched. D47's test harness was subsequently qualified with a focused credentialed synthetic scenario at the exact committed SHA, detailed below.

## Exact-SHA focused real GitHub E2E proof

The **clean and pushed** D47 `cbf6d7f8c19ddd11047cd036de7d243815d2ec85` test harness ran `node scripts/run-github-e2e-disposable.mjs delete-plaintext` against approved numeric repository ID `1284153873`, unique preflight-absent branch `obsidian-sync-e2e/local-cbf6d7f8c19d-d24-delete-plaintext-c63a8fcf0d27`. Exact-source **PASS 1/1 / exit 0**: plaintext two-device delete/recreate identity break, 0 retries, 0 unknown publication outcomes and device-a 23 expected mutations. No pre-publish head-null occurred, so the extra forensic reads were not triggered (normal behavior). Wrapper `CLEANUP_VERIFIED_TWICE`, and a separate, pinned-repository read-only process independently returned `READ_ONLY_CLEANUP_VERIFIED_TWICE` / exit 0. Nothing in this successful run establishes whether the intermittent D38 object read or D45 reference read issue has been resolved.

## Validation

- Focused new forensic tests **3/3** passing: correct statuses/identity evidence with original error rethrown, no requests in irrelevant cases, failed observer/report isolated and SHA filtering.
- Maximum Strict TypeScript `0 errors`; GitHub E2E compile-only all **3** bundles; production build PASS.
- Full fast **580/580**, repeated **10 × 580/580**. Recovery **79/79**, resource **11/11**, feasibility **134/134**, virtual bounded 100,000,000-byte soak **1/1** pass.
- Test-only patch; no permission to alter the P0 recovery/terminal policy. If the diagnostic catches a future failure, retain the original red outcome and record immutable follow-up evidence. Any proposal to treat a branch-ref 404 as retryable must separately justify missing/deletion/conflict safety and obtain user decision before production integration.
