# D116 — Real filesystem WAL phase restart and lost storage acknowledgment

Date: 2026-10-27. **Additional fail-closed integration evidence; Re-encryption release remains BLOCKED.**

## Motivation and scope

D114 proved every WAL phase is recoverable via encrypted in-memory two-slot adapters. D115 separately qualified the real Node Desktop WAL directory durability gate. Neither suite exercised the entire three-branch WAL state machine while **releasing and reacquiring a real filesystem-backed exclusive lease after every phase**, nor the ambiguous outcome where an actual encrypted WAL slot reaches disk but the storage adapter loses its completion acknowledgment.

D116 adds **two regression tests only** to `tests/v4/reencryption-desktop-wal.test.ts`. Runtime implementation, WAL format, Git transport, platform behaviors, owner-approved branch topology and UI are untouched.

## New regression evidence

1. **Real-fs phase lifecycle:** A disposable private Windows filesystem directory is initialized and each of the following ten transitions is followed by releasing the exclusive OS WAL lease: begin → frozen Backup ref Intent → independently observed Backup readback → Backup-to-Staging handoff → ciphertext Blob upload Intent → matching Blob receipt → one-shot Candidate preparation fingerprint → prepared Git Commit/tree/manifest receipt → Destination ref Intent → observed Destination ref readback. Before every later transition a **new** `acquireV4DesktopRekeyWalStorage` and encrypted journal instance must match the expected generation, the complete snapshot and both healthy WAL slots. Final persisted bytes must not reveal the Backup branch name, Git commit SHA or ciphertext object path. Every snapshot still has `requiresRemoteRevalidation:true`, `permissionToPublish:false`, `cutoverAuthorized:false`.
2. **Actual disk write with lost higher-level acknowledgment:** A test-only adapter delegates to the **real encrypted atomic OS WAL writer** and then deliberately throws after the successful slot rename/sync, before returning the upload-intent acknowledgment to its caller. The initiating API reports failure, yet an independently reopened journal must recover generation 2 with its unresolved upload intent. Attempting to record the same upload again is rejected as a duplicate. A mismatched fake Git receipt is rejected; the encrypted slot bytes remain unchanged. No automatic GitHub API POST or replay is attempted.

These tests do not claim a physical power-cut, abrupt child-process kill, trustworthy GitHub remote upload, or unforgeable long-term ancestry. They confirm that in an ambiguous **local acknowledgment** outcome the WAL remains conservative and human/remote revalidation remains required.

## Local verification

- Real Node/Windows Desktop WAL focused **13/13** PASS (including two D116 scenarios).
- Full Fast **913/913**, **10 repeated Fast runs × 913/913** (exit 0, zero failures), Recovery **79/79**, Resource **11/11**, Feasibility **136/136**, Maximum Strict TypeScript, production Build, GitHub E2E **compile-only three bundles**, package and metadata validation PASS. Cryptographic soak: **100,000,000 bytes / 12 chunks**, exact SHA-256 matches the reference; peak RSS delta measured (not a platform-wide memory ceiling).
- All files are confined to the project D87 audit worktree and disposable test directories. No user vault edits, live GitHub sync/test-repository mutation, encryption migration or automatic branch creation.

## Unchanged production blockers

Windows Node-only WAL directory `fsync EPERM` still prevents certification of sudden-power-loss durable intent. Safe initiating-only branch/passphrase/index cutover, secret provenance, a genuine cross-process initiating-vault write fence, live same-repository Source/Backup/zero-parent Destination GitHub acceptance pinned to numeric `GITHUB_E2E_EXPECTED_REPO_ID`, and installed Windows two-device/mobile restore remain open. Do not weaken the fail-closed gate, enable GitHub Actions, promote a Native Helper or force other devices to switch without explicit owner review. `docs/release-gates/reencryption-wizard.json` stays `blocked`, and the Settings Wizard remains Preview-only.
