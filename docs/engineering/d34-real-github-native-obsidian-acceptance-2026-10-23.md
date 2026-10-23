# Stage D34 — Real GitHub and native Obsidian Windows acceptance

Date: 2026-10-23. Scope: dedicated audit worktree `.worktrees/d34-live-github-acceptance`, branch `audit/2026-10-23-d34-live-github-e2e`. User's original checkout/vault, master/release, GitHub Actions and native helper/Issue #9 untouched.

## Exact tested product source

- Product `src/` was inherited from D33 commit `25540404df8715f645a64bab81967ec52afda394` **without modification**. `git diff --quiet 25540404 HEAD -- src` exits 0 after the test-only GUI harness commit `45b62b0d96d5ae8a583ebb3d5d53ff0c2209845e`.
- Independent live GitHub E2E ran from the clean initial D33 commit. Native Obsidian GUI ran from clean test-harness commit `45b62b0d96d5ae8a583ebb3d5d53ff0c2209845e`. Both exercised identical Node.js V4 product source, despite their different Git commit SHAs.

## Real GitHub E2E (full three suites)

- Runner: `node scripts/run-github-e2e-disposable.mjs full`; user-approved **test-only** repository `diamond-crystal/test-vault-obsidian-encrypted-github-sync-multi-platform`, pinned GitHub numeric repository ID `1284153873`; new absent-first branch `obsidian-sync-e2e/local-25540404df87-d24-full-06c489e0df92`.
- All **3/3 suites PASS, 0 failures** (12 scenario receipts: six plaintext, six encrypted, plus controlled external branch-head race = 13 scenario receipts). Exercises initial round-trip, stale peer/disjoint push, Copy conflict, rename vs stale edit, delete/recreate identity, binary overwrite, out-of-band protected commit and controlled CAS race. Reported scenario retry counts and unknown publication outcomes were **0**.
- Test runner exit code **0**, `LIVE_E2E_PASS`; in-run `CLEANUP_VERIFIED_TWICE`. A separate read-only process subsequently reported `READ_ONLY_CLEANUP_VERIFIED_TWICE` for the same branch, exit **0**.

## Native Windows Obsidian, two independent instances

- Test-only safety hardening imported *only* D25 `d055739` scoped screenshot evidence cleanup, plus new explicitly pinned GUI `--expected-repo-id` option. It fails closed if the CLI and environment pins conflict and uses existing GitHub repository ID preflight; no default or source branch mutation.
- `node --env-file=<root-local-e2e-env> scripts/run-obsidian-live-github-ui.mjs --mode=encrypted --verify-peer --journey --expected-repo-id=1284153873` — local env path only, no credentials stored in the repository or reported in this evidence.
- Clean test-harness SHA `45b62b0d96d5ae8a583ebb3d5d53ff0c2209845e`; separate absent-first branch `obsidian-sync-e2e/local-45b62b0d96d5-83373a03e6b28ae3`.
- Actual Obsidian app running with two separate synthetic vaults/profiles and GitHub encrypted branch **PASS, exit 0**. Encrypted Git Tree verified (`remoteEncryptionVerified:true`), peer decrypt-and-restore `peerRestored:true`, source/peer conflict preserves both notes, Unicode nested notes rename+modify+delete/recreate, manual Sync Center action, no-op warm sync without new remote commit, UI exceptions **0**, screenshot captured without secrets. Source branch HEAD changed only for actual published operations.
- Test's `cleanup:absent-verified` and a separate, read-only process's `READ_ONLY_CLEANUP_VERIFIED_TWICE` for this exact GUI branch exit **0**. Synthetic test vault/profile and exact per-run screenshot files disposed. No user's actual vault touched.

## Test-harness regression and remaining release gates

- Imported D25 three regression tests for per-run screenshot cleanup **3/3 PASS**; new explicit target pin regression in feasibility suite **PASS**, including missing/invalid/mismatched IDs. Build PASS; Fast **525/525**, Repeat Fast **10 × 525/525**, Recovery **79/79**, Resource **11/11**, Feasibility **133/133**, virtual bounded cryptographic Soak 100,000,000 logical bytes PASS; metadata/package checks PASS. No physical file over 100 MB created.
- **Strict diagnostics remains NOT ACCEPTED**: GUI was intentionally run without `--assert-diagnostics`; `diagnostics:null` in the GUI receipt. D25 had established missing real upload/download transport measurements, GitHub API latency, encryption/hashing timing and renderer peak RAM. Do not equate functional GUI PASS with full telemetry/UI acceptance.
- Further independent gates: mobile/macOS/Linux native acceptance, cross-device C2 format/coordinated multi-version acceptance, line-level merge UX, network-drive and crash/power-loss exposure, independent security audit, and user decision before changing any write/delete collision or conflict policy. No release/main merge authorized.
