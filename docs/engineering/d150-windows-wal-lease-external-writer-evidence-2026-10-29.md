# D150 — Windows independent writer bypass of cooperative re-encryption WAL lease

Date: 2026-10-29. Owner-selected **A** remains Node.js-first, strict Crash-safe Re-encryption, no Native Helper and no GitHub Actions. Re-encryption Wizard is Preview-only and its first-release gate stays **blocked**.

## What was actually tested

`tests/recovery/reencryption-selector-external-writer-fence.test.ts` obtains the **real D86** `acquireV4DesktopRekeyWalStorage()` exclusive lease in a disposable Windows `.tmp/d150-foreign-writer-*` root, then creates the **test-only** D146 AES-GCM Selector vector in two fixed, pre-existing WAL-shaped file slots in that same leased directory. A second cooperating writer is correctly denied by the `wx+` lock, and the initial holder verifies the authentic pinned lock.

Next, an **independent Node OS subprocess** running the existing D149 crash-stop worker bypasses the lease protocol and directly opens the **same leased directory** slot with `O_RDWR | O_DSYNC`. It is intentionally killed after its recorded stage; the parent reopens the real bytes and verifies the pinned WAL lease token **has not changed**, and `assertExclusiveStageLease()` still succeeds. No mocked filesystem or hypothetical writer is used.

| Target and external child stage | Actual result after reopen | Security interpretation |
| --- | --- | --- |
| Empty slot 1, `after-open` | A authentic, B empty, `authenticated-uncommitted` | Foreign writer can enter the file without acquiring a lease; bytes do not reveal whether it planned a transaction |
| Empty slot 1, `after-partial` | A authentic, B 17 malformed ciphertext bytes, `manual-recovery-required` | Existing lease is no protection from a foreign torn write |
| Empty slot 1, `after-full` | A authentic, B authentic, `manual-recovery-required` | Two complete records do not identify a uniquely committed generation |
| Existing slot 0, `after-truncate` | A empty, B empty, `manual-recovery-required` | An external writer can erase sole valid ciphertext despite the held lock |

All 4 process-based cases passed on **Windows Node.js v24**; the complete Recovery suite grows to **93/93**. The child now refuses any path that does not resolve lexically beneath the repository's disposable `.tmp` root, even when invoked directly; no user vault/GitHub refs or real secret values are touched.

## What this proves and what it does not

- **Proved:** the real D86 exclusive sentinel prevents *cooperating* lease acquisitions, but cannot fence a non-cooperating independent Windows process from directly modifying the candidate slots, even while the lock owner remains valid. The stored ciphertext can become invalid, ambiguous or disappear; a pinned lock alone cannot certify global filesystem immutability.
- **Not proved:** a Node.js mandatory OS-wide file lock is impossible, or that all possible Windows filesystem APIs are inadequate. Only the **current design** was measured. A global Vault/editor fence remains an open requirement for strict crash-safe local cutover, independently of whether fixed-file slots eliminate transaction-time directory rename.
- **Never inferred:** authenticated bytes, held lease or successful file `fsync` imply an atomic cross-store Commit or physical power-loss survival. The D147 directory persistence blocker, independent durable generation/intent, Obsidian Settings/SecretStorage, Source/Shadow Index, GitHub multi-device attestation, and actual power-cut tests remain unresolved.
- **Code hardening:** explicitly document the cooperative-only scope of `V4DesktopRekeyWalStorage` in its source so future caller integrations cannot accidentally treat a `.exclusive.lock` as an OS-wide Vault editor fence.
- **Operator policy:** no auto-reclaim of orphaned locks, no auto-resume or old-passphrase cleanup on ambiguous evidence. D145 Option A Source/Shadow topology, user-selected re-encryption intent and Preview-only Wizard remain unchanged.

This is a **diagnostic evidence stage**, not a production writer or a physical power-loss qualification. Do not enable Cutover or adopt Native Helper without a separate owner architecture decision.
