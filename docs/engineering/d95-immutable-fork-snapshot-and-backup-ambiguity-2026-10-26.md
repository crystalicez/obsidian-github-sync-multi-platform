# D95 — Immutable fork-source snapshot under independent old-branch Sync; ambiguous backup-ref recovery (2026-10-26)

> **Technical design and verified scope.** A companion [D95 implementation overview](d95-immutable-fork-and-backup-reconciliation-2026-10-26.md) summarizes user-facing behavior and limitations; neither document authorizes production publication or cutover.

## Binding policy

The owner approved D90–D91: the old source branch remains writable by other devices after machine A pins a source snapshot; an existing backup must be a separate ref pinned to that immutable commit, and a destination is a completely new encrypted orphan branch. Do NOT turn legitimate old-source HEAD movement into a fleet-wide freeze or cancellation. Three distinct source/backup/destination roles remain mandatory.

## Read-only immutable fork-source preflight

Existing D69/D70 `verifyV4ReencryptionSourceObjects` and `verifyGitHubReencryptionSource` refused all old-source HEAD movement at any time during encrypted content inspection; this was correct for their original *stable-head* acceptance but contradicted D90's independent, immutable snapshot operation.

D95 adds an explicit optional `sourceRefPolicy` to the pure D69 verifier:
- The **default** `require-stable-head` retains D69/D70 refusal of source-ref drift before and after content read. Existing paths and tests keep their strict behavior.
- The opt-in `pinned-immutable-commit` skips LIVE source-ref revalidation after the anchor commit was chosen. This pure helper is **not by itself a trustworthy anchor**; it relies on the caller selecting the commit through an authenticated GitHub branch ref and reading **every** config/head/shard/ciphertext object by that exact immutable commit SHA, checking AES-GCM, authenticated metadata and per-file plaintext hashes, never the moving branch.
- `verifyGitHubReencryptionForkSource` in `src/lib/v4/reencryption-trusted-loader.ts` is the trusted front door for this D90 fork semantics: first validates exact named source Git ref, full 40-hex commit SHA and numeric repository identity, pins that commit and verifies all data from its immutable commit/tree/blob identities. Source HEAD may advance later. The original `verifyGitHubReencryptionSource` remains stable-head by default, and frozen-backup readback remains strict about **the BACKUP ref** retaining the pinned SHA.
- The Settings Wizard preview Step 1 uses the fork-specific verifier. It checks GitHub physical repository ID/fullName **both before and after the full snapshot verification**, and checks actual GitHub default branch again, rejecting inconsistency; the GUI still performs **no publication, local cutover or vault write**.

`tests/v4/reencryption-content-verifier.test.ts` tests pure pinned mode with source HEAD already/mid-read advanced, invalid policy and corrupted ciphertext rejection. `tests/v4/reencryption-trusted-loader.test.ts` tests the trusted fork reader while a second device moves old source HEAD and rejects invalid initial source SHA; historical D70 moving-head fail-closed tests remain unchanged. The ref can advance only *after* the original anchor is selected; all bytes remain bound to the same immutable commit.

## Read-only reconciliation of ambiguous frozen backup branch creation

`src/lib/v4/reencryption-backup-reconcile.ts` adds `inspectV4FrozenBackupAfterAmbiguousCreate`. Its purpose is to safely inspect a possible backup ref after `createGitRef` had an unknown API outcome. It does **not** retry create, overwrite/delete an existing ref, claim authorship, permit destination writes, restore into a vault, or authorize cutover.

- Validates D87 blocked backup proposal, physical GitHub repo ID and exact backup-branch scope, real default branch and all three distinct branch roles; rejects unsafe/malformed/wrong Git refs.
- Reads frozen backup ref twice: two null observations become **`ref-unobserved-at-two-checks`**, wrong commit becomes **`ref-occupied-by-other-commit`**, and an exact pinned SHA triggers a complete authenticated backup-branch full-content readback via `verifyGitHubFrozenReencryptionBackup`. The exact ref must still match after content verification.
- Re-checks numeric repo identity and default branch at finish. Unknown outcomes, ref drift, wrong data, API read failures or cancellation cannot be promoted into permission to retry or write.
- A successful full-content readback still has `creationProven:false`, `automaticallyRetryCreateAuthorized:false`, `destinationPublicationAuthorized:false`, `installedObsidianRestoreVerified:false`, `cutoverAuthorized:false`. It is neither a provenance receipt nor durable backup/restore proof.
- Five additional isolated mock-GitHub tests exercise absent/colliding/matching refs and complete decrypt/readback, wrong default/repo/ref, mid-read drift, malformed data/API outage/cancellation; no production GUI/Sync link and **no live GitHub mutation**.

## Verification and limits

Maximum Strict TypeScript: PASS; `pnpm build`: PASS; `pnpm test:fast`: **800/800 PASS** for D95 current worktree. `pnpm test:recovery` **79/79**, `pnpm test:resource` **11/11**, `pnpm test:feasibility` **136/136**, `pnpm test:github-e2e:compile` (three bundles), `pnpm validate:metadata` and `pnpm validate:package` all PASS. D95 makes no change to normal V4 publish/write paths, only read-only Re-encryption helper paths. No native Obsidian/Android/iOS acceptance or credentialed real GitHub migration.

**Hard release gate remains `blocked`**. Production still needs complete trusted backup writer + restore provenance/durable receipts, new-encryption orphan staging and publication, crash-safe local cutover and Node.js-only Windows power-loss-safe WAL (directory fsync `EPERM` still unresolved). There is no backup/destination creation button in the Wizard; all destructive or partially durable transitions remain disabled. Do not assert that a complete Re-encryption feature is production-ready.
