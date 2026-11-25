# D505 — Actual Windows Obsidian 1,000-note encrypted bulk roundtrip

Date: 2026-11-25. Tested exact clean detached source `2de2dd74877dadfec0014ae7c7ca8ec9ef246b87` in `.worktrees/d493-native-live-qualification`. Production build task `15225b22-0fe9-4c3a-8f4a-ea32c1036795` exit 0. No production source changes.

Initial read-only preflight `a1b66f15-77b7-4001-8c1e-de7394e0d72e` failed before remote I/O (missing owner in worktree env). Corrected using existing root credential file without copying or logging it. Read-only preflight `aaca98c9-555c-406c-8825-609561e4a170` passed. Live runner performed its own fresh preflight with pinned test repository ID 1284153873, initially absent unique ref.

Command: `node --env-file=../../.env.github-e2e scripts/run-obsidian-live-github-ui.mjs --mode=encrypted --verify-peer --native-1000-notes --assert-diagnostics --expected-repo-id=1284153873`. Task `40c53030-301c-4149-88d0-f548e00fc71a`, exit 0, PASS, zero UI exceptions, remote encryption verified, remote HEAD advanced, peer restored.

| Measurement | Result |
|---|---|
| Source creates 1,000 notes | 7,152.299 ms; source disk inventory independently observed 1,000 |
| Bulk upload | 280,961.3 ms; 270 API requests; 0 failures; 2,594,105 wire upload bytes; 254,554,112 bytes sampled peak renderer RSS |
| Peer Force Pull | 161,779.2 ms; 271 API requests; 0 failures; 2,461,801 wire download bytes; 428,904,448 bytes sampled peak renderer RSS |
| Peer correctness | All 1,000 bulk paths and contents checked via Obsidian and independently on disk by D504 runner; exact directory inventory and byte equality |
| Warm 1,000-note no-op | 2,574.4 ms; final runner 5 API requests, 0 failures, 0 changed files, 0 upload bytes, unchanged HEAD |
| Warm small-vault no-op | 2,087.4 ms; 5 API requests, 0 failures, 0 changed files, 0 upload bytes, unchanged HEAD |

Read-only native observer initially inferred an incorrect CDP port (connection refused, no mutation); exact owned profile process lookup established correct source/peer ports 22024/22025, and exact Vault identity was checked before reading allowlisted progress counters. Source sample progression 136,192,243,270 API requests, zero failures, phase encrypting to committing; peer progressed from loading-index to applying (177/1001 at 122.54s). Transient warm no-op observer saw 6 requests while final runner reported 5; use terminal runner evidence for the measurement. No GitHub mutation pacing or product code changed. No mobile or bulk-conflict claim; this is one Windows run of small synthetic notes and not a population benchmark.

Cleanup: exact disposable ref `obsidian-sync-e2e/local-2de2dd74877d-a9c377928b7a8175` runner absent-verified. Independent read-only task `70cab527-61f8-46bc-956a-fc83372ca151` exit 0, READ_ONLY_CLEANUP_VERIFIED_TWICE, pinned ID 1284153873. Clean detached source status verified. No personal Vault or source/default branch writes. Fixture cap 500 MiB, ordinary mobile ceiling 32 MiB. Physical iOS testing waived by user, iOS unverified. Remaining gates: native plaintext peer, publication crash/advanced HEAD, installed Re-encryption, full Fast and final local release qualification.
