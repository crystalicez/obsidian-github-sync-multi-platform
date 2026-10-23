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

## Real GitHub E2E on exact source SHA `5c38beedb305df92e3faa8fd690bc521ac39661d`

- Approved disposable GitHub repo numeric ID `1284153873`, fresh absent-first branches per invocation. `node scripts/run-github-e2e-disposable.mjs delete-plaintext`: **1/1 PASS, exit 0**, branch `obsidian-sync-e2e/local-5c38beedb305-d24-delete-plaintext-a313653915e8`. `delete-encrypted`: **1/1 PASS, exit 0**, branch `obsidian-sync-e2e/local-5c38beedb305-d24-delete-encrypted-7e9b3cedec25`.
- Same source SHA `full`: **3/3 suites PASS, exit 0**. Covers six plaintext + six encrypted scenario families (baseline, stale catch-up/disjoint pushes, same-file Copy conflict, rename versus stale edit, delete/recreate identity break, binary overwrite), controlled external branch-head race, and out-of-band encrypted mutation guard. All scenario telemetry reported **0 retries, 0 cooldowns, 0 unknown publication outcomes**. Fresh branch `obsidian-sync-e2e/local-5c38beedb305-d24-full-1b240f8e7a07`.
- Each of the three unique branches returned cleanup `CLEANUP_VERIFIED_TWICE` and passed a **separate read-only checker process** with `READ_ONLY_CLEANUP_VERIFIED_TWICE`, exit 0. No default-branch mutation, untracked branches or retained test screenshots.
- No missing-object failure occurred in these runs, so independent fail-closed instrumentation was not triggered. A full clean run cannot prove the D38 intermittent issue eliminated.

## Real Windows native two-instance strict UI acceptance on same source SHA

- `node --env-file=../../.env.github-e2e scripts/run-obsidian-live-github-ui.mjs --mode=encrypted --verify-peer --journey --assert-diagnostics --expected-repo-id=1284153873`: **PASS exit 0**. Fresh synthetic Windows Obsidian profiles/vaults; remote ciphertext/opaque paths verified; peer decrypted/restored data; Unicode nested creation, rename, delete/recreate, simultaneous keep-both conflict; **0 UI exceptions**.
- Sender metrics: `uploadBytes=4809`, `downloadBytes=13755`, `apiRequests=18`, `apiFailures=0`, `apiLatencyMs=10070` (sum across API calls), sampled peak renderer RSS `191655936` bytes. Peer: `downloadBytes=22006`, `apiRequests=14`, `apiFailures=0`, `apiLatencyMs≈5886.3`, sampled peak renderer RSS `200065024` bytes, **measured `decryptionMs≈0.4`**. Both are small-scale synthetic workflows; not a 100 MB or physically measured hashing/encryption result. Warm no-op ~1825.4 ms / 5 API requests / 0 bytes uploaded; peer force-pull wall time ~10352.4 ms (not standalone decryption time).
- Unique native branch `obsidian-sync-e2e/local-5c38beedb305-09c44791fc998b30` returned `cleanup=absent-verified`, then separate read-only checker returned `READ_ONLY_CLEANUP_VERIFIED_TWICE`, **exit 0**. No persisted screenshots or user-vault modifications.

## Remaining production gates

The D38 intermittent plaintext missing-object **P0 remains OPEN** without a confirmed causal trace, even though D40 removed a proven insufficient immutable-identity validation gap and passed the live full matrix. Do not silently add retries, relax fail-closed checks, or change Git CAS/merge/delete/conflict policy. Real Hashing/Encryption timing, strict native physical **<=100,000,000-byte** acceptance, macOS/Linux and physical mobile, C2 format, line-merge UX and independent security review remain release gates. No merge or release.
