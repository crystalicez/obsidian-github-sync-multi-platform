# D165 — Authenticated best-effort WAL restart inspection

Date: 2026-10-30. Owner policy: simulation-only power-loss testing, best-effort Re-encryption with prior risk warning and Manual Recovery where necessary. **Re-encryption Wizard remains Preview-only; release gate remains blocked.**

## Problem

D164 introduced `assertBestEffortCheckpoint()` for stable, bounded WAL filesystem readback on Node Desktop, without claiming power-loss durability. That method does not authenticate the encrypted journal. A stable, corrupt WAL slot can pass its raw two-read check. A caller could also authenticate one generation and observe a different generation on a later read. Neither outcome can justify automatically resuming Sync, replaying an uncertain Git mutation, changing a local selector, or deleting the old passphrase.

## D165 implementation

`src/lib/v4/reencryption-best-effort-wal-recovery.ts` exports `inspectV4BestEffortWalRecovery()`. It accepts the existing desktop WAL storage's best-effort checkpoint method, an existing AES-GCM Re-encryption recovery journal, and an explicit pinned Source Git commit, Destination repo ID and positive expected generation. The journal must match both pinned identities. No secret, token or local path is logged or returned.

It performs three WAL checkpoint readbacks and two authenticated `assertHealthySnapshot(expectedGeneration)` calls, alternating readbacks with journal authentication and checking the last readback after the second authentication. It verifies that both decoded snapshots agree and are still explicitly uncommitted and require remote revalidation. Changes to the supplied journal reader, storage method or identity while awaits run cause a manual-recovery report. Any I/O, residue, missing/invalid slot, key-authentication, generation or readback failure also produces `manual-recovery-required`, without exposing raw error text.

The only positive observation is `authenticated-uncommitted` and the observed generation. The immutable result ALWAYS has `localCutoverAuthorized: false`, `resumeSyncAuthorized: false`, `rollbackAuthorized: false`, `remoteWritesAuthorized: false`, and `oldPassphraseCleanupAuthorized: false`. No code in this module writes GitHub, Vault, WAL, Settings, SecretStorage or active local Index. This helper is read-only and **is not wired as a substitute for** the strict publication coordinator's `assertCrashDurable()`. It does not certify that an external process could not write between reads, prevent ABA, prove disk durability after power loss, or finish local Cutover.

## Test evidence

`tests/v4/reencryption-best-effort-wal-recovery.test.ts` uses actual disposable Windows filesystem WAL slots and the real encrypted Re-encryption journal. The tests cover: recovered pending object intent with two authenticated reads and three OS-backed checkpoint readbacks; missing generations and empty storage; stable corrupt ciphertext kept on disk; foreign interrupted temporary slot kept on disk; a concurrent genuine WAL generation advancement between authenticated reads; foreign residue arriving after the second authenticated read; and a changed caller identity during awaited I/O. All reports deny every cutover, automatic Sync, remote publication, rollback and old-secret cleanup authority.

## Remaining implementation

To enable Re-encryption end to end, add a genuine best-effort persistence policy to the existing staging/publication coordinator rather than faking `assertCrashDurable()`. Authenticate the complete Source, verified Backup and new orphan Destination refs and metadata, with no blind ref-write retry. Then implement a resumable or manually reconcilable local Cutover across Obsidian Settings, SecretStorage, active Source/Shadow Index and an authenticated commit receipt, ensuring old-key availability until safe. Test combined crash windows, installed Obsidian two-device restore and explicit warnings before activating the Wizard or changing `docs/release-gates/reencryption-wizard.json`.

No actual user Vault or GitHub repo mutation, electrical power cut, GitHub Actions or Native Helper was involved.
