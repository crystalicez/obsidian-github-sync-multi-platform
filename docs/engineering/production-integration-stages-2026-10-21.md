# Staged production integration — October 21, 2026

**Scope:** Isolated worktree `.tmp/staged-production-6c67c8a`, branch `audit/2026-10-21-staged-production-integration`. Base `origin/master` SHA `6c67c8a6d77cd03ab66fdd4b7654c5a5afd23ade`. Full vetted candidate `d3b1979ad2851efcc933fecd60b7332809b11a51` has **531 ahead commits**, 247 differing files; master has two master-only commits. Do not merge the entire history.

**Permanent constraints:** No GitHub Actions ever. No master push, no tag/release, no personal vault. Remote write tests only on pinned disposable repo ID **1284153873** with absent-first unique branches and verified cleanup. Maximum test-file size **100,000,000 decimal bytes**. Preserve root Zed checkout and user `AGENTS.md`.

## Independently reviewed integration stages

| Stage | Intent / gates | State |
| --- | --- | --- |
| A — Portable identity and bounded test infrastructure | Candidate's cross-platform path segment guard and regression tests; test runner per-execution temp directories; both soak command and its source reject >100 MB. No remote protocol migration. | Integrated locally and tested |
| B — HTTP scheduler queue reliability | Candidate's mutation-start pacing gate, queued/active metrics, timer drift/abort tests, configurable retryRateLimits; legacy default unchanged until GitHubClient cooldown integrated. | Integrated locally and tested |
| C — Metadata/index and bounded storage | C1 imports **wire/config/head/shard byte bounds** and AES-GCM overhead accounting without changing the protocol; independent strict boundary tests. Local-index limits, remote descriptor/topology validation, sharding/pack/part optimizations and compatibility still require further reviewed stages. | **C1 integrated in separate isolated audit branch; C2+ pending** |
| D — Conflict planning / durable Recovery | Bring transactional two-slot recovery, staged local writes and journal/HEAD reconciliation with full proof of rollback, stale local files and ambiguous outcomes. | Pending |
| E — GitHub strict CAS and persistent cooldown | Coordinate GraphQL `updateRefs(beforeOid)`, GitHubClient, runtime/sync-session, secrets/settings and UI. Never publish a client-only change without journal reconciliation or silently fall back to REST PATCH. | Pending, high coupling |
| F — User-visible UX, full release candidate | Select telemetry/merge UI; all deterministic/local guards, actual Obsidian 2-instance encrypted + 1000-note scenario and safe GitHub target from same candidate SHA. Physical mobile/macOS/Linux later; independent security audit. | Pending |

**Honest scope:** Current staging proves the old master baseline plus self-contained safety components. It is **not** equivalent to the full encrypted V4 100 MB push/pull soak (the baseline currently uses bounded virtual hashing). `master` still lacks strict CAS and cooldown until further coordinated integration. Historical 5 GiB docs are obsolete as execution guidance; never run oversized tests again.

**Approval boundary:** User authorized staging in an isolated worktree, not pushing to `master` or releasing. Ask before changing encryption schema, conflict behavior, or destructive policy.
