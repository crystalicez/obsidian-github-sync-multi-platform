# D506 — Remaining qualification: native plaintext failure and offline gates

Date 2026-11-25. Tested clean detached `455f0ac2b41410c913a63331e7d8c3ee35b678d3` in `.worktrees/d493-native-live-qualification`. Test-only changes enable plaintext peer mode and retain explicit mode/passphrase checks; production code unchanged. Physical iOS testing waived by user. Use only pinned disposable repository 1284153873; fixture cap 500 MiB (virtual resource shapes do not allocate their logical size), ordinary mobile ceiling 32 MiB.

## Native plaintext

Task `4b014f95-3229-422b-adba-c4b33d040634`, exit 1. Actual Obsidian + GitHub, preflight passed for initially absent branch `obsidian-sync-e2e/local-455f0ac2b414-c46d8683b49daf58`. Initial Sync and UI Sync now passed, 18 API requests / 0 failures, no-op 1.7031 s, 4/0 API and zero upload/changed files. Creation of nested Unicode and scratch notes published. Combined rename, modify, delete returned lifecycle no-change, trigger manual, phase saving-index, no thrown exception, zero API failures, so runner correctly failed; peer not started. Cause not established. Do not claim a product fix or plaintext qualification. Runner reports cleanup absent-verified; independent read-only checker could not start due global durable task capacity. Retry independently before further live runs.

New test-only diagnostic checks before/after native Vault path, size and SHA-256 inventories and independent disk bytes before each combined Sync. Do not relax success assertions. This addition is not yet executed; syntax checks below apply to 455f0ac, not diagnostic addition.

## Offline and release gates

| Gate | Result | Task |
|---|---|---|
| Production build | PASS | 1edd0929-331e-4076-93b2-b039922b90c0 |
| Native runner syntax | PASS (455f0ac) | a30f96ea-30f4-4326-9a17-4ac2297d2fa5 |
| Native peer syntax | PASS | 1e263b45-b368-4fde-90a8-a6aa543ed575 |
| Recovery | PASS exit 0 | 46a1c70d-88ce-48be-9b19-0a69c54a4d0f |
| Resource | 11/11 PASS | 1cb9c935-6d0a-40ab-9bfd-b0853705e653 |
| Feasibility | PASS exit 0 | 7b885500-536f-46ba-b6f4-4c114edf9355 |
| Metadata | PASS | 549b20bd-50e5-4cda-8b1b-a52e9a24df22 |
| Package | PASS | 5e1ece6b-3dc9-4376-ad30-29a83465e25c |
| GitHub E2E compile-only | PASS | a7f44434-663e-41dc-9c45-e03700718393 |
| Offline Fast (156 files) | INCOMPLETE: 12 ordinary groups (1641 cases), D0-199 (57), D200-229 (49), D230 (6), D231 (4), D232 (6) receipts passed; D233 running at last observation | 9693a3c1-f53e-41a3-9040-9aee2f2e5fbc |

Full Fast plan: 155 ordinary files, 190 heavy cases, 26 total groups; do not claim full coverage without terminal qualification or fingerprint-bound finalize. Recovery and Feasibility output truncated; exact counts not established. Global shell task limit rejected extra runs (including independent branch checker, max-strict and installed pre-cutover); no unrelated tasks cancelled. Final local release qualification also requires clean master and exact toolchain, not met by detached audit source. No production changes, personal Vault, master, tag, or release writes. Preserve unrelated Re-encryption WIP. Publication crash and installed migration/cutover remain unqualified.
