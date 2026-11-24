# D492 — Actual test evidence and remaining release gates

2026-11-24. Audit base HEAD `30a90e8413c7aca7439e9fc93ab8770af14f36b6`. Existing unrelated Re-encryption worktree edits remained present and untouched. This is scoped validation, not a clean-commit full release qualification.

## Real GitHub transport — PASS (focused scenarios)

The approved disposable repository ID 1284153873 was verified by the existing `scripts/run-github-e2e-disposable.mjs` wrapper; root ignored credentials were consumed without displaying or modifying them. Every branch was verified absent before use, and cleanup was verified absent twice afterward. No source/default branch or personal Vault mutations.

| Command / scenario | Result |
| --- | --- |
| `node scripts/run-github-e2e-disposable.mjs rename-encrypted` | Exit 0; encrypted rename vs stale edit, third simulated device obtains exact published SHA and both note contents, stable file identity and opaque remote path. 77 real API requests (27+34+16), zero retries/unknown outcomes. |
| `node scripts/run-github-e2e-disposable.mjs delete-plaintext` | Exit 0; delete/recreate identity break, immutable remote object readback and peer reconciliation. 58 real API requests (41+17), zero retries/unknown outcomes. |

Branch receipts:
- `obsidian-sync-e2e/local-30a90e8413c7-d24-rename-encrypted-756ddfcf64c6`: ABSENT_FIRST, LIVE_E2E_PASS, CLEANUP_VERIFIED_TWICE.
- `obsidian-sync-e2e/local-30a90e8413c7-d24-delete-plaintext-fe7b24aeec54`: ABSENT_FIRST, LIVE_E2E_PASS, CLEANUP_VERIFIED_TWICE.

These tests use real GitHub API and production engine, but simulated Vault/device adapters. They do NOT prove actual Obsidian network/UI or physical mobile convergence. The ordinary runner preflight initially lacked env configuration in the worktree; loading root env alone still lacked pinned repo ID. Existing approved wrapper resolved that independent known ID safely.

## Installed Windows Obsidian — offline PASS, online not qualified

`node scripts/run-obsidian-offline-first-use.mjs --run`: first two runs failed at renderer acquisition during an independent launch/restart. Added fixed stage labels (no raw errors or private paths), independent CDP port per launch, and at most one retry ONLY for missing target before renderer evaluation. Identity mismatch, handshake, plugin load and product assertions are never retried. Third run exit 0; `cdpLaunchRetries:0`, two independent fresh installations plus legacy repair, Settings Save and restart, distinct IDs, exact persisted recovery-copy bytes (BOM/Unicode/CRLF), original preserved, malformed UTF-8 refusal. Synthetic cleanup succeeded. `node --check` exit 0.

The native Settings fence path still substitutes a harmless execute callback; history restore uses synthetic historical content but actual installed UI and disk writes. No live GitHub credentials/network in native smoke. The preceding two failures are retained as evidence of runner flakiness; a single passing rerun does not prove the cause was port reuse.

Existing `scripts/run-obsidian-live-github-ui.mjs --mode=encrypted --verify-peer --journey --assert-diagnostics --expected-repo-id=1284153873` is the preferred next end-to-end target. It requires a clean checkout and verified disposable GitHub branch, uses actual installed UI and a second real Obsidian Vault. Creating a detached clean worktree was denied by tool permissions; do not stash/reset unrelated changes or bypass that guard.

## Actual local filesystem / process interruption

Recovery filters via `node scripts/run-tests.mjs --tier=recovery --filter=NAME`:
- staged-process-kill: 1/1, actual child exit at staged rename/WAL boundaries, byte-exact recovery in fresh child.
- staged-external-termination: 1/1, external OS process termination around real rename operations, verified WAL recovery.
- reencryption-selector-fixed-slots-process-kill: 1/1, actual process kill during slot writes, authenticated/uncommitted or manual recovery required.
- windows-vault-write-fence-feasibility: 2/2, demonstrates external process CAN edit/create/rename despite Node-only sentinel; also post-scan edit race. PASS means the limitation was demonstrated, not that writes are fenced.

These are process interruption tests, not physical power-loss proof.

## Release gates still open

1. Clean-source, installed Windows Obsidian + real GitHub, two actual independent Vaults; validate exact note and attachment bytes, history, conflict, restart and no-op. Start with existing encrypted peer journey.
2. Actual network interruption/recovery during upload and publication; verify ambiguous-write behavior and convergence, not merely injected adapter error.
3. Android/iOS physical first use, sync/restore, app suspend/restart and mobile resource limits.
4. Full source-fingerprinted offline Fast and complete live matrix on release candidate. No release/tag/merge yet.

Do not sum unit tests, mock integration, live transport, and installed native offline results into a single production-readiness metric.
