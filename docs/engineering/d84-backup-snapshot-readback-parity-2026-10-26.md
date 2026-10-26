# D84 — Read-only whole-vault backup snapshot content parity (not proof of physical independence)

Date: 2026-10-26 (Asia/Bangkok). Based on clean/pushed D83 `f223eae65f5e5144137c63eae6156f9367927e48`. Worktree `.worktrees/d84-backup-readback-parity`, branch `audit/2026-10-26-d84-backup-readback-parity`.

## Why retained Git history is NOT a verified independent backup

The owner approved topology A: a new orphan-root branch in the **same physical GitHub repository**, keeping the original branch/history for recovery and requiring a verified second device before cutover. Retaining the source ref is valuable but **does not provide an independent copy**: accidental deletion, credential/account compromise, repository loss, or a common configuration mistake can affect both. Neither D69 authenticated source ciphertext, D82 Git Blob receipts nor D83 exact orphan destination readback proves that a **separate restorable backup** exists.

D84 intentionally implements a **read-only backup-snapshot content parity** layer without choosing a storage provider, archiving method, retention policy, OS path, or encryption-key escrow. Those are later operational/owner-sensitive decisions. No archive is created, no backup is uploaded, no migration ref or vault data is modified.

## Contract

`src/lib/v4/reencryption-backup-readback.ts` exports `verifyV4ReencryptionBackupReadback` and a bounded `V4BackupSnapshotReader` adapter protocol:

- The caller supplies a fully authenticated/pinned original V4 encrypted config/head/index/shards and a trusted source HEAD observer. D68 verifies **every** original metadata bucket, logical signature and keyed opaque path identity before any backup content read.
- The reader must offer a **non-live snapshot** identified by a 64-digit immutable-looking snapshot ID, the exact pinned original Git commit, full listing of logical file paths/hash/size/mtime, independent snapshot-ID observations and bounded `openFile(path, expectedSize)` content source. The adapter must actually read a **separately stored copy**, NOT proxy the live vault or original GitHub branch. This critical provenance assumption is *not verified by an arbitrary callback* and is expressly reported as unproven.
- The complete manifest must match **all and only** live source files. Tombstones remain historical and are not restored. Reject missing, extra, duplicated, unsafe traversal, non-normalized/canonical-colliding, and file-as-directory paths; wrong expected hash, size, or mtime; invalid source shard/signature; oversized inventories over 100,000 files. The guard is a deliberate fail-closed bound, not a new product file limit.
- Read all backup file bytes through existing `V4ContentSource.chunks(1 MiB)` and production incremental SHA-256; never buffer entire large backup files in the verifier. Check each source stream's declared size, every nonzero/bounded Uint8Array chunk, total bytes and complete SHA-256 against the authenticated source index. Detect missing, truncated, extra, malformed/oversized chunks and content corruption, including for Unicode paths, empty files and multipart-sized logical files.
- Reobserve both backup snapshot identity and original Git source HEAD after all reads; fail if either changes. This is **sampling**, not an atomic lock: ABA changes and concurrent old-device writes are not fenced, and the reader can lie about its origin. Do not treat this preview as backup provenance or source quiescence proof.
- Return only frozen path- and key-redacted evidence: `integrityScope:"backup-snapshot-content-parity-only"`, `backupContentsMatchSource:true`, **`independentStorageVerified:false`, `restoreTested:false`, `permissionToPublish:false`, `cutoverAuthorized:false`**. Importantly this is NOT the separate Wizard gate's `backupVerified` evidence. No path, passphrase, salt, plaintext or storage locator is emitted to UI.

## Tests

Fail-first: no D84 module exists; then tests `tests/v4/reencryption-backup-readback.test.ts`. Focused **10 tests** include:

1. Whole-vault copy with Unicode, binary, empty and 8 MiB+17 multipart-shaped logical file.
2. Missing, extra, duplicate or resurrected deleted path refuses **before byte reading**.
3. Wrong manifest hash/size/mtime and separately corrupted restored bytes fail.
4. Truncated, extra, empty or >1 MiB chunk fails with bounded reader.
5. Changed backup ID or source HEAD fails.
6. Missing source shard/hash fails before opening backup.
7. Tombstone-only source expects an empty backup and zero logical file count.
8. Unsafe traversal/canonical alias/file-dirs and incorrect backup source commit fail closed.
9. Cancellation during a partially streamed read aborts without verified report.
10. Explicit flags never claim independently verified storage, actual restore or cutover.

All tests use copied in-memory data. **This is NOT a real independent external backup, not a complete live GitHub-to-local restoration, and not a physical OS/Obsidian E2E test.** Frozen offline install, Maximum Strict TypeScript `pnpm build`, full fast/resource/recovery/feasibility, GitHub E2E three-bundle compile and metadata/package validators must pass before final commit; no GitHub Actions.

## Remaining first-release blockers

1. Choose/implement an **actually independent and durable backup medium** and export an immutable snapshot through a reviewed, safe provider adapter. Prove that storage physically/logically differs from the original physical GitHub repository and that the user controls access; do not accept a caller-set boolean as evidence.
2. Independently restore backed-up data using installed Obsidian, compare all logical paths/hash/mtime and note device-local changes; exercise crash/cancel and OS durability.
3. Keep original source branch for recovery, and use D83 exact destination commit full-content proof only after future migration publication. Durable D80 WAL and cross-process exclusive lock, complete migration writer, second-device acceptance, mobile best-effort edge cases, and Git history disclosure review remain outstanding.
4. Owner has NOT yet approved freezing all old-branch Sync clients during migration and individual cutover versus reconciliation. D84 deliberately does not select either policy.

D66 first-public-release `docs/release-gates/reencryption-wizard.json` stays `blocked`: only `ownerApprovedMigrationTopology:passed`, **six other checks pending**. Do not promote this partial backup-content parity to `safePreviewAndBackup:passed`.
