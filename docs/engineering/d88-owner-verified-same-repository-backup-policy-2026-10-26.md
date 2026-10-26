# D88 — Owner-approved same-repository VERIFIED backup release policy

Date: 2026-10-26 (Asia/Bangkok). This decision supersedes D87's previously unresolved independent-backup release acceptance question.

## Explicit decision

The owner selected **B** after reviewing the consequences: a **verified backup branch within the same physical GitHub repository is acceptable for the first-release Re-encryption Wizard**, even though it is not an independent failure domain. This is a deliberate relaxation of the *independent storage location* requirement ONLY, not of backup correctness, durability, source preservation, recovery, or device cutover standards.

Shared failure-domain risks remain: GitHub account/repository deletion, compromise, loss of account access and provider-wide failures can affect the source, destination, and backup refs together. Old encrypted Git history, clones and caches may remain decryptable with the old key. Local vault copies are not guaranteed independent backups. UX must disclose these risks before any migration.

## Required verified-backup evidence BEFORE a release-gate pass

- The backup is a **separate, collision-safe Git ref** in the same pinned numeric physical repository, distinct from source, orphan destination and default branch. The original source branch remains unchanged; the backup ref must unambiguously point at a verified immutable source commit with the exact expected tree and objects.
- Perform trustworthy remote ref/commit/tree/blob re-reads, verify complete authenticated source inventory and byte/hash parity, prove full readback and an isolated restore; handle unknown writes/404/422/network failures and concurrent ref creation as fail-closed. Do not trust a proposed ref name, stale local cache, or return value of a Git write call as backup proof.
- Freeze/coordinate old-branch sync across devices and pause local editing according to owner policy A/A. Offline/old clients cannot be remotely frozen just by displaying a warning; missing coordination or changed source HEAD blocks migration. Validate source HEAD and local content at publication/cutover boundaries.
- Keep old source and backup refs until explicitly deleted by the user. No automatic cleanup, history erasure promises, passphrase-archive feature, native helper or GitHub Actions.
- Windows Node.js-only WAL remains **NOT** physically crash-durability qualified: D86 directory fsync returned EPERM. Failed durability assertions, missing recovery evidence, incomplete cross-platform/native acceptance and second-device restore MUST continue to block migration and release.

## Enforcement and current evidence

`docs/release-gates/reencryption-wizard.json` now contains a pinned `backupPolicy` declaration with `acceptedMode:"verified-same-repository-branch"`, `sharedRepositoryFailureDomainAccepted:true`, and `independentCopyRequired:false`. `scripts/reencryption-release-gate.mjs` rejects a supposedly qualified manifest lacking these exact facts, even if all check statuses are forged as passed. `safePreviewAndBackup` remains **pending** and the complete gate is **blocked**: no backup branch has been actually created/read back or qualified by this policy-only work.

`V4_OWNER_REENCRYPTION_DECISIONS` reflects B while keeping `independentBackupProvidedByChoiceC:false`. The backup proposal still reports `actualBackupCreated:false`, `independentStorageVerified:false`, `backupReadbackVerified:false`, `permissionToPublish:false`, `cutoverAuthorized:false` and `oldBranchDeletionAuthorized:false`. No production migration entrypoint or real vault/GitHub repo is touched.

Focused release-gate tests use RED before implementation and GREEN after: a missing manifest policy and falsely unacknowledged risk must fail even if every check is declared passed. No `qualified` status is written to the tracked manifest.

## Next

Implement and verify protected same-repo backup-ref creation and immutable Git evidence in isolation, readback/restore independent of its writer and actual two-Obsidian-device testing, while retaining the Node.js WAL durability and stale-client safety blockers. Do not treat owner acceptance as evidence that backup exists or that migration is ready.
