# Stage D40 — immutable Git identity fail-closed hardening and missing-object forensic evidence

Date: 2026-10-24 (Asia/Bangkok). Isolated `.worktrees/d40-missing-object-forensics`, branch `audit/2026-10-24-d40-missing-object-forensics`, based on clean, pushed D39 `1b0793e38939d29ad6190b846ad7d35bd1c8b717`. The root Zed checkout, main/release, user vault, credentials and Native Helper Issue #9 are untouched. No GitHub Actions.

## P0 investigation and confirmed defect (not a confirmed D38 root cause)

D38 reported intermittent plaintext two-device delete/recreate `Missing V4 remote object: Notes/reborn.md` even after an immutable published object had been read. D39 full credentialed GitHub E2E was 3/3 green, and two scoped followups green, but this cannot prove the rare failure gone. Review traced `V4SyncSession.readRemoteRecordObject` -> `GitHubClient.getFileBytes(path, commitSha)` -> immutable commit/tree fallback after Contents 404. No auto-retry or CAS/conflict/deletion/rate policy change is justified without further evidence.

**Concrete fail-closed proof gap found:** Immutable tree traversal previously accepted `truncated:false` tree entry absence without comparing the response's tree `sha` to the immutable object SHA requested. It also accepted a Git commit body with an inconsistent `sha`, and GitHubClient substituted a requested SHA when the response omitted that field. A mismatched/missing REST result could thus be treated as complete evidence of blob absence, rather than rejected. This is a deterministic safety flaw in response validation; no evidence yet proves GitHub actually sent such a mismatched body in D38.

**Minimal production changes:** `readImmutableGitFile` checks returned commit SHA (when supplied by adapter) and all returned tree SHA identities, rejecting mismatch before acting on path absence or accepting payload. `GitHubClient.getGitCommit` requires the body to identify the exact requested 40-hex immutable commit SHA (cannot synthesize it when absent). `V4RemoteObjectMissingError` now reports the immutable ref, file identity/version/storage and object path when a genuine missing read is encountered; it remains fatal, leaves local bytes and base SHA unchanged, and is not classified as a CAS race. No new HTTP requests, retries, crypto or protocol changes in the successful path.

**Test-only missing-object observer:** Scoped to `Notes/reborn.md` and **only when getFileBytes returned null**, a read-only follow-up GET of that exact immutable commit and recursive tree records `commitTreeSha`, `treeResponseSha`, `treeTruncated`, matching node SHA/type/mode, or a diagnostic error. It does not convert the missing result into success or retry, and does not log tokens/content bytes. Evidence observed afterward is diagnostic, not a logically atomic snapshot. Other file requests keep the original promise with no added scheduling.

## RED→GREEN and offline tests

- Three new immutable commit/tree identity regressions were RED on previous behavior: mismatched commit, mismatched tree, and omitted commit SHA were incorrectly accepted as authoritative absence. On D40 they fail closed, while legitimate complete absence and valid nested/Unicode/blob reads continue to pass. Focused fallback **16/16 PASS** after production fix.
- Existing missing-Pull regression extended to assert a typed immutable commit SHA, fileId, remoteVersion, storage and path; fail-first import/expectations RED; on D40 `sync-session` focused **88/88 PASS**, with no unverified local mutation or local base advancement.
- `pnpm typecheck:max-strict` **0 errors**, `pnpm build` PASS. Full fast suite **535/535 PASS** after sequential build (an overlapping initial build/test exposed test harness dependence on generated `main.js`, not a source bug).
- Recovery **79/79**, Resource **11/11**, Feasibility **134/134**, bounded virtual 100,000,000-byte soak **1/1**, GitHub E2E compile-only **3 bundles**, release metadata and package validation PASS. `pnpm test:repeat` **10 rounds × 535/535 PASS, exit 0**.

## Pending real qualification / release gates

Pin exact clean candidate commit and rerun credentialed approved disposable GitHub E2E and two-instance Windows Obsidian. Every temporary branch must be independently read-only verified absent twice. Until resolved, D38 missing-object intermittent P0 remains **OPEN**—this work prevents wrong-SHA evidence being mistaken for absence, not proven race elimination. Real Hashing/Encryption timing, strict native 100 MB, macOS/Linux/physical mobile, C2 format, line-merge UX and independent security review remain release gates. No merge/release.
