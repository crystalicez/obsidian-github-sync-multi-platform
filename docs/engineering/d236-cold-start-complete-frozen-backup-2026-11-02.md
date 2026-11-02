# D236 — Reverify the complete frozen Backup after a cold start

Date: 2026-11-02. Release remains blocked; Re-encryption Wizard Run is Preview-only.

## Read-only recovery evidence

The installed Obsidian command `GitHub Sync: Verify Re-encryption Recovery (Read-only)` already reconstructed the original journal key from an immutable pinned Backup config and encrypted HEAD in D235. That is insufficient to certify the original vault: encrypted index shards and file objects could be missing or corrupt while Config and HEAD still decrypt.

D236 extends that same **explicitly invoked** command. After authenticating the old key and the D233/D234 local route HMAC chain, it:

1. Reads and pins the current physical repository identity and default branch, and derives the existing same-repository, three-branch Backup proposal.
2. Runs `verifyGitHubFrozenReencryptionBackup` twice against the exact old Backup ref, pinned commit/tree SHA and original SecretStorage passphrase. Both passes independently verify encrypted Config/HEAD, all live index shards, Git blob hashes, decrypted logical files, plaintext hashes and sizes through the existing D94 verifier.
3. Requires matching counts and byte totals across both passes. Reauthenticates the local routing HMACs and rereads the original Backup ref, physical repository identity, default branch, routing marker and both SecretStorage values before reporting success.

The report sets `completeBackupContentsReverified=true` only when every step succeeds. Failures remain `manual-recovery-required` and explicitly deny all Sync, local Cutover, rollback, remote writes and old-key cleanup. All reads are on demand, never an automatic startup network scan. The underlying GitHub verifier rederives and clears its temporary keyring after each full pass.

## Evidence boundaries

This proves a **current complete old-key Frozen Backup readback** from one GitHub repository. It does not prove backup creation chronology, independent storage, physical power-loss durability, WAL/checkpoint reconstruction, current **new-key Destination** ciphertext, an active mutable Destination Runtime Index, or stale-device safety. The owner-approved best-effort policy and Manual Recovery remain unchanged. The old writable Source branch and both passphrases are retained; no Git writes, native Settings mutations, fence removal, GitHub Actions, Native Helper, forced branch operations, release or merge.

Full-Backup traversal adds remote reads, cryptographic KDF work and latency to this manually launched check. Do not present it as an ordinary Sync fast path or run it at startup.

## Verification

Regression cases in `tests/v4/reencryption-destination-exact-commit.test.ts` verify success with immutable encrypted Git fixtures; fail closed for an index shard corrupt after D235 header authentication, for a corrupt object in the second full pass, and for branch/Settings drift during the scan. Record final offline build, test, package and typecheck results in `HANDOFF-NEXT-SESSION.md`. Live installed-Obsidian and credentialed GitHub qualification have not been done for this change.
