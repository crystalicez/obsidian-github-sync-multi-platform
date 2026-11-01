# D218 — Independent Source HEAD during fenced Re-encryption restart inspection

Date: 2026-11-01. Scope: internal **read-only** Recovery diagnostics. First-public-release Re-encryption gate stays **blocked**; installed Wizard stays Preview-only.

## Why this change is necessary

The owner-approved D90 topology preserves three branches: an independently writable original Source, a frozen Backup pinned to the exact authenticated original Source commit/tree, and a new orphan encrypted Destination. D89 and D94 already allow other devices to keep syncing to the old Source while the frozen Backup preserves the migration snapshot.

D177 nevertheless required **all three** branch refs to stay at the migration-time SHA. When another device advanced the old Source, D178 → D185 → D217 could return `manual-recovery-required` despite unchanged frozen Backup, Destination, local Source/Shadow, WAL and Fence. This falsely treated an expected concurrent user operation as a broken frozen ref.

## Implementation

In `reencryption-fenced-three-branch-revalidation.ts`, observe all three Git refs under the same cooperative initiating-device lease, best-effort authenticated WAL and canonical D173 Sync Fence, twice:

- **Source:** require the expected Source branch name, physical repository identity, a full lowercase 40-hex current Git commit SHA, a reachable exact commit object with matching SHA, valid 40-hex tree SHA and valid parent identifiers. It may point to a different commit/tree than the migration snapshot and may advance between the two observations. This is merely a **readable independent Source** witness, not proof of fast-forward ancestry, absence of rewrite or Source plaintext verification.
- **Backup:** still require the exact frozen original Source commit SHA and tree SHA, including correctly formed ancestry. D216/D217 separately decrypt every old-key Backup object twice against this immutable snapshot.
- **Destination:** still require the exact new encrypted orphan commit/tree SHA with **zero parents**; D178/D185/D217 separately authenticate all encrypted Destination metadata, ciphertext and plaintext digests.
- Require one consistent repository default branch, no unexpected GitHub client method or Run/WAL/fence identity substitution and identical authenticated WAL across the two complete remote observations. No remote-write, rollback, old-key cleanup, resume-Sync or local-cutover permission is granted.

The D177 result now distinguishes a pinned historical Source reading (`three-refs-match-pinned-wal-uncommitted`) from an independently moved Source observation (`backup-destination-pinned-source-independent-uncommitted`). D178 accepts **both** non-authorizing D177 observations but still rejects drift of either frozen branch, invalid Source ref/commit and corrupt WAL/Fence. D185/D217 therefore no longer fail **solely** because a valid Source branch is independently updated.

## Tests

Deterministic D218 tests in `tests/v4/reencryption-fenced-three-branch-revalidation.test.ts` first produced the expected **RED** failures on D217: valid updated Source returned Manual Recovery and failed to reach a second scan, while a malformed Source parent was accepted as valid. D218 now confirms:

- Source advances to a valid new SHA/tree while Backup and Destination remain pinned.
- Source advances again **between** read passes without a false frozen-Source claim.
- Source advanced concurrently with a moved frozen Backup or Destination still demands Manual Recovery.
- Missing, short, wrong-branch, mismatched Git commit, malformed tree/parent Source evidence fails closed; a moved frozen ref or invalid orphan commit remains blocked.
- No local or remote writes, full Sync Fence remains intact and every successful report remains uncommitted and non-authorizing.

A composed D217 test in `tests/v4/reencryption-destination-exact-commit.test.ts` uses real AES-GCM old-key Backup + new-key Destination verification and changes the old Source ref during **D216's** in-flight encrypted Backup Git Blob read. It confirms the entire single-owner-lease crash-window proof remains coherent without changing Settings/SecretStorage/Index, writing GitHub data or authorizing Cutover. Strict TypeScript, full offline tests, Windows simulated Recovery and 100 MB cryptographic soak are verified separately in the persistent handoff.

## Remaining limitations and release work

The observations do **not** prove that an independently moved Source HEAD is descended from the pinned migration commit; guaranteeing that would need a bounded provenance walk or an authenticated remote compare and more Git API requests. This read-only report must not be used to authorize automatic Cutover or assert the old branch's historical continuity. It also cannot detect transient remote ABA between observations or stop noncooperating old-key clients. Frozen Backup and Destination pins, not the moving Source, are the migration's immutable content witness.

The installed Wizard Run, authoritative committed Receipt+Selector, best-effort restart-safe Settings/SecretStorage/active Index switch, safe Manual Recovery/Sync Resume, stale multi-device validation and installed Obsidian Desktop/Android/iOS E2E acceptance remain pending. Keep original Source, frozen Backup, orphan Destination, old passphrase and Git history. Do not add Native Helper, GitHub Actions, force push, live migration, branch deletion, merge or release as part of D218.
