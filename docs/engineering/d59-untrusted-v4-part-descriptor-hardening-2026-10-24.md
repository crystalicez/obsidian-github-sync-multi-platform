# D59 — Fail-closed validation for untrusted V4 chunked part descriptors

Date: 2026-10-24 (Asia/Bangkok). Worktree `.worktrees/d59-untrusted-chunk-part-descriptors`, branch `audit/2026-10-24-d59-part-descriptors`, directly based on clean pushed D58 SHA `db6c3b68e365973b8ef016930fc4f464df4d130f`. All D59 credentialed/native E2E was run from the first **clean and committed code SHA `d8c1134d157c6137e81f0ca4eac927a85bb35e5a`**. This report and canonical handoff were written after live tests.

## Scope, approvals and safety

No default/release branch merge, GitHub Actions, native OS helper, personal vault access, user D45 worktree modifications, OS race-policy decision or broad architecture change. **The only production source change** is in `src/lib/v4/remote-index.ts` in the **remote metadata validation** path. No changes to GitHub CAS/publish retry, missing-remote-object semantics, encryption/ciphertext/wire format, data deletion or WAL replay/no-WAL policies, or REST writer part-size **8 MiB**. Test files remained bounded by user-approved **100,000,000 decimal bytes**. Production source from D58 was otherwise retained.

## Security finding — RED/ GREEN

`assertNormalizedRemoteRecord(record, config)` validated logical remote paths and some storage shapes, but for `storage: "chunked"` checked only truthy `record.partPaths?.length`, `remotePath === partPaths[0]` and a safe `remoteVersion`. A GitHub-sourced JSON descriptor could present a **plain object masquerading as an indexed array** with `{0: partPath, length: 1}`, which passed the validator despite violating the expected array contract. It could likewise contain extra part paths with relative `..` components, absolute paths, paths outside the V4 internal namespaces, non-strings and repeated part paths without fail-closed rejection. The protocol reader later trusts the descriptor for GitHub content lookups; the finding is an **untrusted-input trust-boundary hardening gap**, not demonstrated local Windows-vault traversal, credential exfiltration or a real exploit. No secret was printed.

**Fail first:** add the new `D59 untrusted chunk part coordinates fail closed before remote content reads` test in `tests/v4/staged-remote-descriptors.test.ts`; focused suite **failed with 6 pass / 1 fail** specifically on `Missing expected rejection: object pretending to be array`. The code was then corrected, not the attack input.

**Fix:** Require `Array.isArray(record.partPaths)`, nonempty; remotePath matches first part; each part is a string under either `.obsidian-github-sync-v4/large/` or `.obsidian-github-sync-v4/parts/`; normalized by `normalizeV4VaultPath` with exact spelling retained (rejects traversal, slash aliases and unsafe segments); reject duplicates via a Set. Errors use generic descriptions rather than echoing untrusted remote paths. Deliberately accept both existing V4 internal part namespace forms; do **not** reconstruct or require a new part naming/version layout that would silently invalidate historic 48 MiB part references.

Additional new `D59 encrypted chunks stay readable only with normalized V4 part coordinates` test preserves valid encrypted `parts/` descriptors and rejects a forged metadata `head` path. Existing historical 48 MiB plaintext multipart and encrypted packed descriptor tests remain GREEN. Post-fix focused **8/8 PASS** and Maximum Strict TypeScript **0 errors**.

### Residual security scope

This is not a complete independent security review. It does **not** prove cryptographic authentication of plaintext GitHub metadata, enforce every historical part filename/version derivation or mitigate all filesystem race conditions. It does not address D38/D45 GitHub intermittency nor D54–D57 partial WAL replay. The stricter validation intentionally rejects previously tolerated **malformed** V4 descriptors; compatibility with unshipped malformed documents is not guaranteed. Legitimate historic 48 MiB multipart references and legacy encrypted pack fixtures were explicitly checked.

## Full local qualification

From D59 audit worktree: package install frozen-lockfile PASS; production esbuild PASS; Maximum Strict TypeScript **0 errors**; focused descriptor **8/8 PASS**; fast **607/607 PASS**; repeat **10 × 607/607 PASS / exit 0** (ten complete repeat round markers and ten 607-pass summaries independently verified); recovery **79/79**, resource **11/11**, feasibility **134/134**; virtual bounded **100,000,000-byte** soak **1/1 PASS**; GitHub E2E **3 bundles compile PASS**; release metadata/package validation PASS; `git diff --check` and staged check PASS.

## Live real Windows Obsidian and disposable GitHub qualification (exact source SHA)

Pinned approved test repository `diamond-crystal/test-vault-obsidian-encrypted-github-sync-multi-platform`, numeric ID **1284153873**. All three newly randomized branches were preflight-absent, runner cleaned them up and **separate independent read-only checkers** each reported `READ_ONLY_CLEANUP_VERIFIED_TWICE` / exit 0. No user vault, permanent remote test branch, sensitive token or screenshot artifact left in the source tree.

1. **Real Windows Obsidian two-instance encrypted 100 MB:** `node --env-file=../../.env.github-e2e scripts/run-obsidian-live-github-ui.mjs --mode=encrypted --verify-peer --native-100mb --assert-diagnostics --expected-repo-id=1284153873`. Run SHA `d8c1134d157c6137e81f0ca4eac927a85bb35e5a`; branch `obsidian-sync-e2e/local-d8c1134d157c-1cbbad68f289b222`. **PASS / exit 0**; remote AES-GCM opaque ciphertext verified, two actual Obsidian vault instances used, exact 100,000,000-byte binary uploaded/decrypted/restored with SHA-256 `f079cad53add0091ed5d0409b0469f9f5cb745b8c280be685dda73203dea90e8`. Upload wall **53,991.8 ms**, peer restore wall **35,682 ms**, observed upload traffic **133,345,125 bytes**, peer download traffic **100,043,469 bytes**; sampled source hashing **941.8 ms**, encryption **82.0 ms**, peak renderer RSS **312,041,472 bytes**; peer hashing **463 ms**, decryption **69.6 ms**, RSS **246,575,104 bytes**; API failures **0**, UI exceptions **0**, successful no-op with no remote publish. Scoped runner cleanup `absent-verified` and independent read-only absence twice PASS.
2. **Live GitHub plaintext two-device delete/recreate:** `node scripts/run-github-e2e-disposable.mjs delete-plaintext`. Unique branch `obsidian-sync-e2e/local-d8c1134d157c-d24-delete-plaintext-bfa7643d9d86`, exact same code SHA. **1/1 PASS / exit 0**, source device 41 requests, peer 11, **0 retries / 0 unknown publication outcomes**; wrapper `CLEANUP_VERIFIED_TWICE`, separate read-only checker PASS.
3. **Live GitHub encrypted two-device delete/recreate:** `node scripts/run-github-e2e-disposable.mjs delete-encrypted`. Unique branch `obsidian-sync-e2e/local-d8c1134d157c-d24-delete-encrypted-905495d1a5d9`, exact same code SHA. **1/1 PASS / exit 0**, source device 45 requests, peer 14, **0 retries / 0 unknown publication outcomes**; wrapper `CLEANUP_VERIFIED_TWICE`, separate read-only checker PASS.

D58—not D59—remains the most recent **full 3/3 GitHub matrix and full real Windows two-instance Unicode/conflict UI journey**. D59 deliberately qualifies the changed remote-part validator with native encrypted 100 MB and the two focused live delete/recreate modes, **not a new full matrix claim**. No D38/D45 intermittent P0 was reproduced in these D59 tests; the historical failures remain unresolved.

## Release blockers and owner decisions

- **D54–D57 partial replay remains OPEN.** An already-applied Trash/finalized backup can precede a later unreadable or hash-corrupt stage. No proposed all-stage preflight PoC or production recovery semantic change was authorized here; ask for approval separately.
- **D50 no-WAL fallback policy A/B remains OPEN.** A fail closed on mutating Pull when recovery store unavailable (recommended), B redesign bounded fallback; D59 does not choose.
- D38 intermittent missing immutable object and D45 pre-publish REST head-null remain P0 open without verified root cause even after successful live E2E.
- Independent broader security/C2 review, real macOS/Linux and physical Android/iOS, true filesystem crash/power-loss durability and vetted manual line-level conflict merge UI remain release gates.
- **Not production ready.** No default-branch merge or release.
