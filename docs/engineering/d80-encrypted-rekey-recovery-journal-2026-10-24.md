# D80 — Encrypted two-slot recovery journal for orphan Re-encryption staging

Date: 2026-10-24 (Asia/Bangkok). Parent commit D79 `7486358cccbb9b9a7896b72c78de014d4ee73469`. Isolated worktree `.worktrees/d80-rekey-recovery-journal`.

## Safety problem

D79 stages one immutable ciphertext blob at a time and only produces a complete manifest after every file is authenticated and finalized. But crashes, cancellation, process suspension, or an ambiguous GitHub Git Blob API outcome could leave **unreachable staged blobs** with no durable record of what upload was attempted or what SHA was returned. A network acknowledgement alone does **not** demonstrate Git object reachability, complete destination tree, or a valid new orphan commit. The missing receipt must not be guessed, and the old branch must remain unchanged.

## New read/write LOCAL journal capability — isolated and NOT live-wired

`src/lib/v4/reencryption-recovery-journal.ts` exports `createV4ReencryptionRecoveryJournal({ adapter, root, destinationRepoId, sourceCommitSha, runId, journalKey })`. This is a pluggable **local persistent-store protocol** over the existing `V4LocalIndexAdapter` interface, **not** a GitHub migration coordinator and **not** proof of disk fsync or truly crash-safe physical storage. It does not change the existing normal Sync WAL.

- The record is an AES-GCM-authenticated and encrypted payload (`kind:"journal"`), using a destination-scoped 32-byte journal key. AAD binds destination repoId, exact pinned source SHA, independent run ID, and monotonically increasing generation. No plaintext logical file paths, tokens, key material, opaque Git object paths or receipt SHAs appear in the **unencrypted** header. A SHA-256 integrity digest over the header detects random torn writes; AES-GCM authenticates the content and destination/source context.
- Alternates `slot-0.json`/`slot-1.json` with generation numbers, bounded to 2 MiB serialized record size; validates both on recovery. If the latest slot is torn, a previous fully authenticated generation can be returned, but always flagged `requiresRemoteRevalidation:true`. A damaged slot blocks **further journal updates** until manual reconciliation. If both slots are missing on first install, `begin()` creates generation 1. If both are present and invalid, throw `V4ReencryptionJournalRecoveryRequiredError` and never implicitly start a new run.
- **Explicit two-phase upload evidence:** `recordUploadIntent({opaquePath, expectedGitBlobSha, byteLength}, expectedGeneration)` must complete **before** calling the GitHub Blob API; then `appendReceipt(..., expectedGeneration)` is permitted only when the exact previously persisted intent matches SHA, path and byte length. An ambiguous GitHub success or power loss in between leaves an unresolved pending intent; re-open never promotes this to a confirmed receipt or publishes it.
- All path, positive length <= fixed 8 MiB, 40-digit lower-case Git SHA, run ID, source SHA and context formats are validated. Duplicate paths and stale journal generations are rejected without updating other slots. The API uses an in-process no-overlap guard; a **platform-level exclusive process/device lock** is still required before two journal writers can touch the same backing path.
- Readback `load()` and all returned snapshots always specify `permissionToPublish:false`, `cutoverAuthorized:false`, and `requiresRemoteRevalidation:true`. Both pending intents and seemingly confirmed staging receipts require later remote object existence/identity checks before any migration can become publishable. No journal “clear”, “auto-resume”, “publish”, or “cutover” method is exposed. The journal and old branch are not automatically deleted.

## Validation

New `tests/v4/reencryption-recovery-journal.test.ts` **8/8 PASS** with independent in-memory adapter, covering:
- encrypted two-slot generation progression and recovery after process-object restart; redaction of opaque paths and blob SHAs;
- corrupt newest slot falling back to older generation **unverified** and refusing writes until explicit reconciliation;
- corrupted BOTH slots fail closed;
- wrong destination, source commit, run ID, or journal key are rejected;
- invalid/duplicate receipt paths, SHA IDs, sizes, generations rejected without storage changes;
- simulated torn new-slot write/power loss retains older valid generation;
- pending intent surviving restart, tampered receipt not clearing an existing intent;
- no public automatic reset, publication, or cutover actions.

`pnpm install --offline --frozen-lockfile`, Maximum Strict TypeScript `pnpm build`, full `pnpm test:fast`, `pnpm test:resource`, `pnpm test:recovery`, `pnpm test:feasibility`, GitHub E2E 3-bundle compilation, metadata and package validators all PASS. No live GitHub actions/writes, installed Obsidian runtime test, OS/fsync crash injection, or device migration occurred in D80.

## Unresolved production gates (do not overclaim)

**Critical missing integration:** D80 journal has not yet been connected to the D79 `stageImmutableObject()` callback or native Obsidian local adapter; no local OS fsync durability, browser/mobile suspension, external multiple-writer serialization, atomic write proof, cloud object re-read, reconciliation after 404/422/5xx/timeout, or journal garbage collection/recovery UX has been demonstrated. A local adapter returning success is not a durable write guarantee. The encrypted WAL is deliberately bounded (2 MiB) and not yet paged for huge vaults; capacity exhaustion must fail closed rather than discard receipts.

A previous slot returned after a torn newer write may lack a previously completed upload and must NEVER be used to claim the blob still exists. A journal snapshot must not be treated as a backup or destination provenance proof.

Owner-approved topology remains **A: new zero-parent orphan Git branch within the same physical repository**, old source branch kept intact for recovery. The owner has **not** decided whether all devices on the old branch are to pause Sync during migration and until individually cut over; no policy chosen. D66 first-public-release `reencryption-wizard.json` remains `blocked`, only owner-approved topology passed, **six remaining checks pending**. No automatic migration writer, ref creation, backup verification, second-device restore or cutover is authorized.

## Next

Bind a **single-writer, crash-durable native/platform adapter** and connect upload intent + staged receipt to D79. Before any ref publish: independent exact-Git-SHA object re-read, complete destination metadata and ciphertext authentication, verified independent backup, interrupt/restart reconciliation, and second-device restored-vault comparison.
