# D217 — One-holder post-crash evidence: local state, complete Destination and complete frozen Backup

Date: 2026-11-01. Status: **internal read-only diagnostic**; Re-encryption Wizard remains **Preview-only** and the first-public-release gate remains **blocked**.

## Problem

D185 authenticates a historical D183 proposed, still-*uncommitted* Selector/Receipt and performs two current full Destination Git plaintext-content scans around local Settings/Index/SecretStorage/WAL observation. D216 independently decrypts every ciphertext in the frozen old-key Backup **twice**, under its own cooperating lease. Running these as two separate top-level calls would allow the initiator to release its exclusive lease between checks. Their reports must not be combined as if all evidence describes one atomic observation.

## Change

`src/lib/v4/reencryption-fenced-live-post-crash-verification.ts` now has two explicit entrypoints:

- The existing `inspectV4FencedLivePostCrashAfterRestart` remains the **legacy diagnostic**, which inspects local state plus Destination but does not re-decrypt Backup. Its original report has no Backup completion claim and no mutation permissions.
- The new `inspectV4FencedLivePostCrashAndBackupAfterRestart` **requires** the D216 Backup input. It rejects a missing Backup with `manual-recovery-required` instead of degrading to the legacy report. Its distinct `integrityScope: read-only-post-crash-local-current-full-git-and-frozen-backup` and `fullBackupContentReverifiedAfterRestart` field make the extra evidence explicit.

The strict entrypoint requires the same D142 run identity, device, Source/Backup/Destination IDs, Source tree/commit, D173 canonical Sync Fence adapter, exact best-effort WAL/journal, real initiating-device lease callback, the old Source SecretStorage passphrase and the D94 same-physical-repository Backup plan. The Backup Git reader must target the exact frozen branch. Pin the Backup Git client and all invoked API methods, plan, signal, scope, passphrase, and storage callbacks **before the outer lease is taken**; reject any mutation before, during or after the proof, including a holder's post-return changes.

Under **one outer owner-held cooperative lease**: read local crash evidence, decrypt and verify every Destination remote object through D178, run D216's two full independent old-key Backup scans through D94, reread the same local state, decrypt and verify the Destination again, then reread the same local state a third time. D216 receives D185's checked **borrowed holder** so it never recursively acquires the exclusive outer lease; every borrow rechecks the parent WAL, lease and source state. D178 revalidates all three Git branch refs around its full scan. Any missing/changed source, Backup, Destination, local evidence, Git method or WAL/fence identity returns **Manual Recovery**, not an assumed commit.

Successful composite reports are still explicitly **uncommitted** and carry five fixed false permissions: local Cutover, resume Sync, rollback, remote writes and old-key cleanup. No writer, ref publication, active Index selection, Settings or SecretStorage mutation, Sync Fence removal or UI Wizard execution is added.

## Tests

In `tests/v4/reencryption-destination-exact-commit.test.ts`, the D217 fixture constructs a real encrypted old-key Git metadata tree with a Unicode logical note, AES-GCM ciphertext, committed tree+blob identities and trusted WAL/Sync Fence, plus the existing fully verified encrypted Destination/Shadow/Source fixture. It uses mock GitHub HTTP responses and in-memory local storage but exercises the **production D94/D178/AES-GCM verification paths**. Its behavioral cases cover:

- One external holder call (no nested lease) and complete local/Destination/Backup readback, with all five permissions false and no writes.
- Frozen Backup ref moving or returned Git Blob corruption on the second full pass, failing the **entire composite proof**.
- Mismatched WAL, adapter, lease holder, Source SecretStorage passphrase or physical repository ID, rejected before Backup content reads.
- Source local SecretStorage or WAL changed during the awaited Backup Git read, invalidating cross-surface provenance.
- Backup Git API method swapped by the outer holder **after** otherwise successful completion, invalidating the report.
- Missing Backup input cannot silently fall back to legacy D185.

This is synthetic in-memory Windows Node test acceptance, **not** an installed Obsidian Android/iOS/Desktop migration, real credentialed GitHub E2E, actual power-loss test, externally writable filesystem snapshot or independent global GitHub writer lease. D185's Source ref reader conservatively requires the old Source HEAD to remain at the pinned commit at inspection time: if another old-key device legitimately advances the independent Source branch, this strict diagnostic may require Manual Recovery even though the immutable Backup remains sound. It does not prohibit that old-key device from syncing. Remote ABA after a final read cannot be excluded.

## Release blockers

D217 is still an internal reader, not wired to an installed Wizard Run. It does **not** establish a durable committed Receipt/Selector, validated automatic initiating-device Cutover, restart-safe Settings/SecretStorage/active Index switch, any safe Sync Fence removal, multi-device stale-client behavior, real-vault manual restore or old-passphrase cleanup. The user-approved cross-platform policy remains best-effort with truthful warning and Manual Recovery, not a fake crash-durability guarantee. Preserve the independently writable original Source, pinned frozen Backup, new encrypted zero-parent Destination, old key and Git history. No GitHub Actions, Native Helper, live mutation, branch merge/deletion, force push or release.
