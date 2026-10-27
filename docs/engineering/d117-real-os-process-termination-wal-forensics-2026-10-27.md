# D117 — Actual process termination at encrypted WAL checkpoints

Date: 2026-10-27. **Recovery-focused integration evidence; Re-encryption release BLOCKED.**

## Why this is different from D116

D116 released and reacquired the Desktop WAL storage **cleanly in one Node process** after every WAL phase. A hard process termination does not execute `release()`; it must leave an exclusive lock that cannot be silently stolen, while preserving encrypted slot evidence for a later **read-only forensic** investigation.

D117 uses fresh independent Windows Node processes bundled directly from `src/lib/v4/reencryption-desktop-wal.ts` and `src/lib/v4/reencryption-recovery-journal.ts`. The tests run **only in new disposable folders underneath the current repository's `.tmp`** and do not have GitHub credentials, remote writes, installed Obsidian, or user-vault access.

## Five actual termination boundaries

A child first persists and authenticates an encrypted two-slot WAL snapshot. It writes a non-secret test checkpoint file outside the WAL and then terminates **its own real OS process via SIGKILL**, without a normal release:

| Checkpoint | Encrypted WAL generation | Expected unresolved/verified state |
|---|---:|---|
| Backup ref create-intent | 2 | Pending frozen Backup |
| Staged ciphertext Blob intent | 5 | Verified Backup + pending Blob upload |
| Prepared zero-parent candidate receipt | 8 | Candidate prepared; no Destination create-intent yet |
| Destination ref create-intent | 9 | Pending Destination create-only ref |
| Destination ref independently observed | 10 | Verified Destination; **no local cutover permission** |

For **each** checkpoint the parent process verifies that the marker was reached, forced termination did not end with a normal successful exit or an uncaught JavaScript exception, **both encrypted WAL slots** remain present with no temporary file debris, and the untouched `.exclusive.lock` remains. The child is deliberately not allowed to call `release()`.

The parent launches a **new independent contender process** against the same WAL directory, verifies that it fails with `V4DesktopRekeyWalLockError` instead of reclaiming the stale lock, and then launches a **different fresh forensic process** with a rigorously read-only adapter. That process authenticates both slots with the exact key/run/source/destination identity, checks the expected generation and verifies `requiresRemoteRevalidation:true`, `permissionToPublish:false`, and `cutoverAuthorized:false`. Its adapter throws on any write/mkdir attempt. All original WAL bytes and directory entries must remain exactly unchanged after both inspection and denied takeover.

The test fixture checks that its target is underneath this worktree's `.tmp` to prevent use on actual vaults or arbitrary paths. Cleanup is confined to the test's own disposable directory, not a production stale lock.

## Scope of evidence and explicit limitations

- This is a **hard OS termination at five known post-persistence checkpoints** on Windows, not a device power-off while data is in flight, randomized instruction-boundary fault injection, or a full physical-durability qualification.
- Evidence survives a real process exit and can be authenticated in a fresh process, but `fsync` through Node on Windows remains unable to certify durable directory state over sudden power loss (`EPERM`). D115's parent-directory flush gate remains conservative.
- We intentionally **do not implement automatic stale-lock cleanup/reclaim**, replay GitHub requests, change the initiating device branch/secret/index, or promote a Native Helper. A successful forensic read is not permission to resume or publish.
- Source remains independently writable; Backup is frozen and Destination is fresh zero-parent orphan in the **same repo**, as owner-approved D90/D91. No GitHub Actions.

## Verification

- D117 focused Recovery test: **1/1** PASS covering all five independent child terminations, five rejected separate-process lock takeovers, and five authenticated read-only fresh-process forensic validations.
- Full Recovery **80/80**, Fast **913/913**, Fast repeated **10×913/913** with exit 0, Resource **11/11**, Feasibility **136/136**, Maximum Strict TypeScript, production Build, GitHub E2E compile-only (3 bundles), package and metadata validation PASS. Cryptographic soak **100,000,000 bytes / 12 chunks**, exact SHA-256 reference digest matched.
- `docs/release-gates/reencryption-wizard.json` remains `blocked`; the user-facing Re-encryption Wizard is Preview-only.

## Hard production blockers still open

Windows power-loss WAL durability proof, real cross-process **vault editing** fence (WAL lease alone does not fence Obsidian editors), crash-safe initiating-only Branch/Passphrase/Index cutover, trustworthy new-key recovery/provenance, real pinned numeric `GITHUB_E2E_EXPECTED_REPO_ID` same-repository Source/Backup/Destination acceptance, and installed two-device Windows/mobile restore testing. These require separate technical and owner review; no release or policy waiver is authorized by D117.
