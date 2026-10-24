# D50 — Deterministic fail-closed missing-object probe qualification

Date: 2026-10-24 (Asia/Bangkok). Isolated host-owned worktree `.worktrees/d50-forensic-injection-qualification`, branch `audit/2026-10-24-d50-forensic-injection`, direct descendant of clean and pushed D49 docs SHA `3bf9c8d91502185649008f949299055e3c753156`. No production `src/**` changes, default/release merge, GitHub Actions, user vault changes, native helper, hash algorithm switch or legacy worktree cleanup.

## Confirmed evidence gap before D50

D49's immutable missing-object probe was covered by four pure offline tests and remained dormant through three successful live `delete-plaintext` E2E runs. Consequently its invocation, immutable follow-up evidence and nonmutating failure behavior had **not actually been exercised end-to-end on the live approved GitHub repository**. This was an evidence/testing gap, not proof of D38 P0's cause. D38 intermittent `Missing V4 remote object` and D45 intermittent null REST branch ref remain release blockers.

## Synthetic test-only fault mode

A deliberately isolated manual test mode, `diagnostic-missing-plaintext`, runs **only** through `scripts/run-github-e2e-disposable.mjs` with its existing repository-ID pinning, two preflight absence checks, synthetic branch and verified cleanup. It reuses the existing two-device delete/recreate scenario. Device A publishes generation two and *independently* proves the exact immutable object is actually readable and decodes to the published plaintext. **Only then**, on device B's first read of `Notes/reborn.md` at the exact new immutable published commit, a one-shot in-memory test-harness shim substitutes a `null` result **after** the underlying `GitHubClient.getFileBytes` really read the bytes. The shim exists in `tests/github-e2e/v4-real-github-e2e.test.ts` only. All default/full/rename/delete modes are unaffected.

The already-integrated D49 observer must then walk independently through the exact immutable commit and nonrecursive tree levels via read-only GitHub GET, return `blob-present-in-tree`, and never substitute returned bytes for the original missing result. The test insists on original `V4RemoteObjectMissingError` with the exact commit, record fileId and path; original user-note bytes preserved on peer; peer local index/base SHA unchanged; no peer-side remote mutation. Any failure is a **RED synthetic E2E** and cannot be turned into a green result by logging. No production retry/CAS/recovery/publish policy is altered.

The one-shot shim simulates **only the read-level symptom**, not the unknown real-world cause of D38 (GitHub eventual visibility, incorrect ref or a runtime fault). A synthetic green must never be reported as a causal repair or guarantee that intermittent P0 is resolved. A deterministic failure that reveals local file corruption should be escalated as production blocker and fixed only with carefully reviewed recovery semantics and user approval.

## Validation

- TypeScript Maximum Strict: **0 errors**.
- Production build: **PASS**.
- GitHub E2E bundles: **3/3 compile PASS**.
- Unmodified full local fast suite: **586/586 PASS**.
- Credentialed exact-SHA diagnostic GitHub E2E and independent branch-absence verification: **pending terminal run and documentation**.
- Additional repeat/recovery/resource/feasibility and package checks to be recorded after terminal results, not presumed.
