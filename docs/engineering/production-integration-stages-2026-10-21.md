# Staged production integration — October 21, 2026

**Scope:** Isolated worktree `.tmp/staged-production-6c67c8a`, branch `audit/2026-10-21-staged-production-integration`. Base `origin/master` SHA `6c67c8a6d77cd03ab66fdd4b7654c5a5afd23ade`. Full vetted candidate `d3b1979ad2851efcc933fecd60b7332809b11a51` has **531 ahead commits**, 247 differing files; master has two master-only commits. Do not merge the entire history.

**Permanent constraints:** No GitHub Actions ever. No master push, no tag/release, no personal vault. Remote write tests only on pinned disposable repo ID **1284153873** with absent-first unique branches and verified cleanup. Maximum test-file size **100,000,000 decimal bytes**. Preserve root Zed checkout and user `AGENTS.md`.

## Independently reviewed integration stages

| Stage | Intent / gates | State |
| --- | --- | --- |
| A — Portable identity and bounded test infrastructure | Candidate's cross-platform path segment guard and regression tests; test runner per-execution temp directories; both soak command and its source reject >100 MB. No remote protocol migration. | Integrated locally and tested |
| B — HTTP scheduler queue reliability | Candidate's mutation-start pacing gate, queued/active metrics, timer drift/abort tests, configurable retryRateLimits; legacy default unchanged until GitHubClient cooldown integrated. | Integrated locally and tested |
| C — Metadata/index and bounded storage | **Stage C1 integrated:** strict byte limits on config/head/shard/journal before JSON parse or decrypt; local index header/shard cache byte limits plus adapter stat preflight, invalid cache triggers rebuild; encoder rejects oversized new metadata. No wire layout changes. **C2 pending:** record/topology compatibility, shard-hash validation, opaque pack/part writer-reader coherency. | C1 tested; C2 pending |
| D — Conflict planning / durable Recovery | Bring transactional two-slot recovery, staged local writes and journal/HEAD reconciliation with full proof of rollback, stale local files and ambiguous outcomes. | Pending |
| E — GitHub strict CAS and persistent cooldown | Coordinate GraphQL `updateRefs(beforeOid)`, GitHubClient, runtime/sync-session, secrets/settings and UI. Never publish a client-only change without journal reconciliation or silently fall back to REST PATCH. | Pending, high coupling |
| F — User-visible UX, full release candidate | Select telemetry/merge UI; all deterministic/local guards, actual Obsidian 2-instance encrypted + 1000-note scenario and safe GitHub target from same candidate SHA. Physical mobile/macOS/Linux later; independent security audit. | Pending |

## Stage C1 evidence — metadata bounds and local cache trust

This stage adds remote **config 64 KiB**, **head 256 KiB**, **shard 16 MiB** and **journal 32 MiB** limits before parsing and decrypting, accounting for encrypted framing precisely. Writers reject new oversized metadata; existing oversized metadata fails closed rather than being silently rewritten. The remote encryption/data layout and conflict protocol are unchanged.

Local Index header (64 KiB) and cache shard (32 MiB) use UTF-8 byte accounting. An available Obsidian adapter stat result is checked before reading, and a stale stat hint cannot bypass post-read validation. Oversized cached state is discarded and rebuilt rather than trusting the cached remote commit.

On this **master-derived partial integration**, Build PASS, Fast **440/440**, Repeat **10/10 rounds × 440/440**, Recovery **43/43**, Resource **11/11**, Feasibility **132/132**, metadata/package/E2E compile PASS and **100,000,000-byte virtual hashing Soak 1/1**. Adversarial tests cover plaintext/encrypted wire sizes, oversized History Journal and invalid Local Index cache. This is not the full candidate's encrypted 100 MB push/pull soak. **Stage C2 remains pending**: remote descriptor/topology and shard hashes must be assessed jointly with pack/part reader-writer compatibility.

**Honest scope:** Current staging proves the old master baseline plus self-contained safety components. It is **not** equivalent to the full encrypted V4 100 MB push/pull soak (the baseline currently uses bounded virtual hashing). `master` still lacks strict CAS and cooldown until further coordinated integration. Historical 5 GiB docs are obsolete as execution guidance; never run oversized tests again.

**Approval boundary:** User authorized staging in an isolated worktree, not pushing to `master` or releasing. Ask before changing encryption schema, conflict behavior, or destructive policy.
