# D49 — safe immutable-object forensic evidence for intermittent delete/recreate P0

Date: 2026-10-24 (Asia/Bangkok). Isolated owner-ledger worktree `.worktrees/d49-missing-object-evidence`, branch `audit/2026-10-24-d49-missing-object-evidence`, direct descendant of clean pushed D48 `ce5f14cfdd773770e349a8710ce8d381fc650e2b`.

## Motivation

D38 real GitHub full matrix intermittently failed plaintext two-device delete/recreate on peer Pull with `Missing V4 remote object: Notes/reborn.md` after another device had already read published immutable bytes. Later D39–D48 credentialed suites often passed. Separate D45 plaintext E2E intermittently saw `expectedHeadSha=<valid commit>, observedHeadSha=null` at pre-publish. Neither failure has a confirmed causal explanation; a passing E2E run cannot close either P0.

The original missing-object observer examined a *recursive* tree returned after a null `getFileBytes` and printed raw error messages. It could not distinguish whether an immutable commit, intermediate folder tree, exact file entry or incomplete tree had been observed, and a recursive tree could be truncated. Reading a body/error text as diagnostic would also risk printing incidental sensitive data.

## Change: synthetic GitHub E2E harness ONLY

- Added pure `tests/github-e2e/support/immutable-missing-evidence.ts`. It is used **only** after `GitHubClient.getFileBytes("Notes/reborn.md", ref)` has returned `null` in a synthetic GitHub E2E device. Normal successful reads and reads of all other paths are unchanged.
- The probe independently inspects exact immutable Git commit SHA followed by each nested, nonrecursive Git tree SHA (at most 16 path segments). It validates returned SHA identities, checks duplicate exact entries and expected Git tree/blob mode, and differentiates `http-unavailable`, `identity-mismatch`, `malformed-response`, `incomplete-tree`, `absent-in-complete-tree`, `unexpected-node` and `blob-present-in-tree`. Only a non-truncated complete tree can constitute path-absence evidence.
- Each probe observation records only HTTP status, validated requested/received SHA, sanitized node SHA/type, path segment, and the categorical outcome. No API response body, bearer token, blob bytes, decrypted data or raw caught error messages are reported. Exceptions produce a fixed `observation-failed` code. The request wrapper permits **one read-only GET per object** for the probe, without implicit 5xx retry; all other E2E call sites preserve their existing request retry defaults.
- The original null remains null. No publication, mutation, upload, retry, CAS, recovery, merge, conflict, deletion policy or remote format changed. **No production `src/**` files changed.** The independent follow-up is not simultaneous with the failed read; even `blob-present-in-tree` cannot alone prove the original response was wrong or isolate GitHub cache visibility.
- The existing D47 read-only pre-publish head-null observer remains unchanged. Do not classify these different failures as one root cause without proof.

## Testing

- New pure evidence tests **4/4 PASS**: two-stage tree path exact immutable identity and no blob downloading, complete absence vs truncated/incomplete, HTTP 404, commit/tree SHA mismatch, duplicated nodes, malformed paths/refs and exception message scrubbing.
- Maximum Strict TypeScript **0 errors**, production build PASS, GitHub E2E all **3 bundles** compile PASS.
- Fast **586/586 PASS**, recovery **79/79**, resource **11/11**, feasibility **134/134**, virtual bounded 100,000,000-byte soak **1/1**, metadata and package validation PASS.
- Full fast repeat completed **10 × 586/586 PASS**, verified ten distinct round markers and 586-pass summaries / exit 0.

## Exact-SHA real GitHub focused E2E — three independent rounds

Clean pushed D49 source SHA `d8ca191affb6a24263adff13629d9856220c4a34`, approved disposable repository `diamond-crystal/test-vault-obsidian-encrypted-github-sync-multi-platform` with pinned numeric ID `1284153873`. Executed `node scripts/run-github-e2e-disposable.mjs delete-plaintext` three separate times, each with a preflight-absent, unique synthetic branch and its own teardown. **3/3 PASS, exit 0 each**; two-device plaintext delete/recreate identity break succeeded, 0 retries, 0 cooldowns, 0 unknown publication outcomes. Device A observed 41 requests / 23 expected mutations; device B 11 requests / zero mutations in each round. No `Missing V4 remote object` occurred, so the D49 read-only probe correctly remained inactive; absence of failure does NOT prove P0 resolved.

- Round 1: `obsidian-sync-e2e/local-d8ca191affb6-d24-delete-plaintext-1236297d2c7b`, elapsed scenario 33,312 ms; runner `CLEANUP_VERIFIED_TWICE`, independent read-only pinned-repository `READ_ONLY_CLEANUP_VERIFIED_TWICE`, exit 0.
- Round 2: `obsidian-sync-e2e/local-d8ca191affb6-d24-delete-plaintext-49694c2678de`, elapsed scenario 33,509.3 ms; runner `CLEANUP_VERIFIED_TWICE`, independent `READ_ONLY_CLEANUP_VERIFIED_TWICE`, exit 0.
- Round 3: `obsidian-sync-e2e/local-d8ca191affb6-d24-delete-plaintext-6857e653f7ed`, elapsed scenario 33,925.9 ms; runner `CLEANUP_VERIFIED_TWICE`, independent `READ_ONLY_CLEANUP_VERIFIED_TWICE`, exit 0.

All three unique branches are independently absent-verified. These are **three scoped plaintext scenario runs, NOT a new full 3/3 GitHub matrix, native Obsidian 100 MB run or proof of an intermittent bug fix**. Latest previously qualified full/native E2E production source remains D46 (exact SHA `81aea119cc87`), whose `src/**` is unchanged by D47–D49.

## Safety and remaining release blockers

Production executable behavior is byte-for-byte source-identical to D48. No personal vault, GitHub default branch, release or other historical worktree is changed. The physical file test ceiling is **100,000,000 bytes**, and writer part-size policy stays **8 MiB**; no GitHub Actions and no Node native hashing switch. The temporary D45 detached checkout remains protected by workspace safety; the original inherited D45 unstaged user WIP is preserved.

D38 missing-object and D45 head-null P0 remain OPEN without causal evidence. Before release: capture failure-driven observations, investigate without weakening CAS or recoverability, qualify real Android/iOS and macOS/Linux, independent security/format review and vetted manual line merge UI. Any decision to allow retry of a missing object/head or to alter publication/recovery semantics requires user approval.
