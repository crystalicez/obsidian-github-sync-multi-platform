# D240: Bind the recovered original journal key to the saved Cutover Contract

Date: 2026-11-02. The Re-encryption Wizard remains blocked and Preview-only.

## Why

D236 authenticates the complete old-key Frozen Backup, its original encrypted Config/HEAD, the local route HMAC and the persisted candidate manifest. D239 checks a separately provided journal key against the exact WAL generation and complete Destination Git receipts. Previously, neither verifier explicitly compared D239's proposed **journal key and D183 Cutover Contract** with the key and contract that D236 recovered independently from the original Backup and local route.

A caller could therefore pass internally consistent but unrelated observations to a later Recovery composition. They must not be combined into a positive cross-stage conclusion.

## Change

`inspectV4ReencryptionColdStartJournalKey` now optionally accepts `expectedRecoveryBinding: { contract, originalJournalKey }`.

When supplied, the same existing D236 read-only check requires all of these facts to hold:

- The **exact canonical candidate manifest Contract** read from disk matches the caller's entire proposed D183 Contract, not merely the branch/run ID or transaction ID.
- The **32-byte original journal key** independently derived from the immutable Backup Config, original passphrase in Obsidian SecretStorage, and authenticated old encrypted HEAD equals the proposed key (checked across all 32 bytes).
- Both caller-supplied objects, their serialized contract value and their key bytes stay unchanged across asynchronous Git, Obsidian adapter and SecretStorage reads.
- The route HMACs, complete original Backup readback, original/new SecretStorage values and physical Backup repository/ref still pass D236; the candidate manifest and route are read again at the end.

Only then does the report set `recoveredKeyAndContractBoundToCaller=true` with `completeBackupContentsReverified=true`. Earlier D236 callers can omit the binding, preserving their existing read-only command behavior, and receive `recoveredKeyAndContractBoundToCaller=false`. The verifier never returns the derived key or writes it to a file. It zeroes both its temporary copy and derived keyring.

This is evidence **only about the old Backup and proposed caller key/contract**. The caller's key, contract, WAL root, receipt list and Git reader are not automatically trusted. The result is not a durable authorization token, a completed D236+D239 joined recovery procedure or a writable migration state.

## Verification and follow-up

Real AES-GCM/PBKDF2 regressions in `tests/v4/reencryption-destination-exact-commit.test.ts` cover a matching old Backup key+candidate manifest with zero writes, unrelated key, foreign transaction/generation, key or Contract mutation during Git reading, and a torn persisted manifest. All failures return `manual-recovery-required` with Sync, Cutover and Git writes prohibited.

This does not establish which OS-specific directory contains the WAL after Obsidian restarts, establish a cross-platform cooperative lock, reconstruct SecretStorage ownership on mobile, or prove actual power-loss durability. No GitHub Actions, Native Helper, branch changes, old-key cleanup, live GitHub mutations or public release.

Next: explicitly source the full D239 inputs from owner-authenticated persisted artifacts in the **same** installed plugin/vault instance, hold a real cooperative lease across D236/D239 and recheck the original Backup evidence after the Destination scan. Then test real Obsidian Desktop/mobile, stale devices and Manual Recovery before considering a Runtime Index writer or Sync Fence removal.
