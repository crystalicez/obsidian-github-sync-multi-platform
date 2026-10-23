# D42 exact-source qualification: audited REST-safe writer, real Obsidian 100 MB, full GitHub matrix

Date 2026-10-24 (Asia/Bangkok); immutable tested source SHA **`05ff11d0206dad06eb97a8f2b34181096172fefd`**. Isolated worktree `audit/2026-10-24-d42-restore-rest-safe-8mib-writer`, source based on D41 `9cc75e0eb931ccc5eb58a429b8eec8015ca06daf`. Only pre-authorized disposable target GitHub repo `diamond-crystal/test-vault-obsidian-encrypted-github-sync-multi-platform`, numeric ID `1284153873`; all branches absent-first; default branch untouched.

## Why this regression mattered

D41 native encrypted 100,000,000-byte payload failed twice with GitHub Git Blob API HTTP 422 `input was too large to process`. Its branch had accidentally lost the 8 MiB REST writer and encrypted pack limits once independently proven on historical October 18 commits `58bfaaa`, `f8e2f72`, `c7e7120`. D42 reimplemented the proven new-write ceilings on top of latest Max Strict + D41 telemetry, preserving old 48 MiB part/single/pack decoding and safety budgets rather than cherry-picking stale runtime. New 100,000,000-byte uploads use 12 content parts <=8 MiB. The change did **not** alter cryptography, Git CAS, deletion/conflict policy, retries or release settings.

## Offline qualification before live native

- `pnpm build` PASS, `pnpm typecheck:max-strict` PASS zero TypeScript errors (all maximum strict compiler flags remain enforced).
- `pnpm test:fast` **540/540 PASS**, `pnpm test:repeat` **10 x 540/540 PASS**; `pnpm test:recovery` **79/79 PASS**, `pnpm test:resource` **11/11 PASS**, `pnpm test:feasibility` **134/134 PASS**, virtual decimal 100 MB cryptographic soak **1/1 PASS**.
- `pnpm test:github-e2e:compile`: **3 bundles compiled**; package/release metadata validation and `git diff --check`: PASS. New tests validate writer/reader threshold independence, 8/16/32/50/100 MB lazy content planning, encrypted pack preflight, out-of-budget fail-closed and medium-object shape, preserved legacy readers.

## Native Windows two-instance real Obsidian: PASS exit 0

Command: `node --env-file=../../.env.github-e2e scripts/run-obsidian-live-github-ui.mjs --mode=encrypted --verify-peer --journey --native-100mb --assert-diagnostics --expected-repo-id=1284153873`.

- Exact physical payload length: **100,000,000 bytes**, matching source/peer restored SHA-256 **`f079cad53add0091ed5d0409b0469f9f5cb745b8c280be685dda73203dea90e8`**. Native Obsidian indexed/uploaded, second actual Obsidian instance decrypted/downloaded/restored; remote was verified encrypted and opaque. Included Unicode, rename, delete/recreate and simultaneous keep-both conflict; no UI exceptions.
- Sender upload wall **60,799.9 ms**; 133,345,317 bytes HTTP upload including REST JSON/Base64; API download 16,737 B, 28 requests, API failures 0, aggregate API latencies 54,431.5 ms, sampled renderer peak RSS 313,749,504 B; observed content AES-GCM encryption 89.8 ms, SHA-256 hashing 940.2 ms. Metrics are sums of measured work and not equivalent to wall time.
- Receiver Force Pull/download wall **38,690.3 ms**; HTTP download 100,053,147 B; 38 API requests, API failures 0; aggregate API latencies 36,577.9 ms, sampled renderer peak RSS 232,857,600 B; measured decryption 85.2 ms, hashing 506.7 ms.
- Subsequent warm no-ops: normal vault 2,611.2 ms/6 API requests/0 upload bytes; 100 MB vault 1,832.2 ms/5 API requests/0 upload bytes. Both no-change.
- Disposable branch `obsidian-sync-e2e/local-05ff11d0206d-a0ae0e8400c68b85`: harness `cleanup=absent-verified`, followed by independent read-only checker **READ_ONLY_CLEANUP_VERIFIED_TWICE exit 0**.

## Credentialed full GitHub E2E: PASS exit 0

`node scripts/run-github-e2e-disposable.mjs full` on **same source SHA**, separate absent-first branch `obsidian-sync-e2e/local-05ff11d0206d-d24-full-c8a1c59f6c1f`; **3/3 suites PASS**, realistic plaintext + encrypted two-device scenario matrix (baseline paths, stale catch-up/disjoint pushes, same-file Copy conflict, rename vs stale edit, delete/recreate identity, binary overwrite) plus controlled external branch-head race and refusal of untrusted encrypted external mutation. All reported per-scenario telemetry: **zero retries, zero cooldown, zero unknown publication outcomes**; no missing-object failure this run. Runner `CLEANUP_VERIFIED_TWICE`, and **separate read-only checker READ_ONLY_CLEANUP_VERIFIED_TWICE, exit 0**, confirmed branch absent after removal. Both disposable branches touched only the approved repo; nothing was written to master/main or personal vault.

## Remaining production / worktree-integration gates

This source fixes a verified HTTP 422 regression and confirms end-to-end 100 MB encrypted Sync on Windows, **not** general production readiness. Intermittent D38 `Missing V4 remote object: Notes/reborn.md` P0 remains OPEN pending causal failure trace, even after all-green D40/D42. D43 downstream isolated candidate may selectively port historic non-mutating pure review model, but D42 itself does not restore line-by-line conflict UI or Files sidebar; those need audited integration and explicit safety policy for reviewed merge bytes/snapshot freshness. Remaining platforms: actual macOS/Linux and Android/iOS, C2 format and independent security review. Permanent physical file test limit 100,000,000 B; no GitHub Actions, no default branch merge/release.
