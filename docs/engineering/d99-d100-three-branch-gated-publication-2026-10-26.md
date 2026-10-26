# D99–D100 — Same-repository frozen Backup and orphan Destination gated publication (2026-10-26)

**Status: implemented internal guarded helpers with offline tests; still NOT end-user or release qualified.**

## Binding decisions
D90 preserves normal independently writable Sync on the old Source branch while the initiating client forks a SHA-pinned encrypted V4 snapshot. D91 requires **three distinct branch roles** inside one physical GitHub repository: old/source, frozen old-key backup ref, and fresh zero-parent orphan destination. No global pause, central marker, auto-delete, forced other-device cutover, auto-merge, or GitHub Actions. Backup shares the repository failure domain by owner approval D88.

## D99 — Backup creation proof + complete old-key readback

`src/lib/v4/reencryption-backup-create-verified.ts` adds `createAndVerifyV4FrozenBackupRef`.

- Consumes authenticated D70/D95 source report, existing strict D93 pinned ref writer, original old passphrase and GitHub branch-scoped writer/reader. Requires caller's external exclusive lease and crash-durable intent callback BEFORE create. Rechecks lease immediately at the irreversible GitHub mutation boundary (even if preliminary reads took long).
- Tracks whether **THIS call actually reached createGitRef** and whether it returned normally. A collision/ref mismatch or lease/intent failure **before create** is not permitted to masquerade as a successfully lost response. An HTTP definitive failure (e.g. 422) also propagates without treating a third-party exact same SHA as success; only truly ambiguous outcomes can be classified through D95.
- Runs D95 separate complete encrypted content readback on the Backup branch, compares file count and plaintext-byte totals with authenticated original Source report. D95 now returns exact verified file count + bytes; absent and conflicting results are zero by construction. Checks actual physical repo ID/default branch/ref stability, every blob, AES-GCM, SHA-256, source tree and pinned commit. Classifies `response-confirmed`, `lost-create-response-reconciled`, `post-create-readback-reconciled`. Never retries create.
- Success deliberately reports `independentlyProvenCreationProvenance:false`, `independentlyAuditedDurableIntent:false`, `installedObsidianRestoreVerified:false`, `destinationPublicationAuthorized:false`, `initiatingDeviceCutoverAuthorized:false`. A callback completing is not physical journal durability evidence.

## D100 — Three-branch evidence-gated destination publication

`src/lib/v4/reencryption-three-branch-publish.ts` adds `publishV4ThreeBranchDestinationAfterBackup`.

- Requires exact D90/D91 approved Backup topology and matching D99 created/ref-verified report, an **isolated D85 scratch restore round-trip** report, D96 zero-parent orphan candidate and expected contents/commit/repo identity. Validates source/destination names, pinned SHA/tree, physical repository ID, complete file counts and plaintext-byte parity **BEFORE ANY destination ref mutation**.
- Caller must supply an exclusive migration lease, guard for unchanged initiating-device vault data, explicit WAL crash-durability check, and durable exact ref-publication-intent recorder. The guard is invoked before publication and inside critical mutation boundaries; a Windows Node.js `fsync EPERM` refusal or local edit detector failure prevents destination ref creation. **The actual Backup ref is re-read repeatedly** through an independently branch-scoped GET-only reader, including physical GitHub repository identity, default branch (not Backup/Destination), exact pinned Backup ref SHA and its immutable source tree. A moved/deleted Backup ref at any checked boundary blocks Destination creation; an external ref race between checks is not magically made atomic.
- Uses actual D98 create-once+mandatory read-only post-publication exact-commit decryption. Independently rechecks full destination/source-backup counts. No local settings, passphrase, remote old/backup branch, index or vault file is changed here.
- Even fully passing test report explicitly gives `powerLossDurabilityIndependentlyAudited:false` and `initiatingDeviceCutoverAuthorized:false`. **Neither a structural report nor a mock/no-op callback is proof of durability, independent provenance or an installed Obsidian restore.** The adapter and caller trust boundary remains a blocking production integration issue.

## Security review and verification

- D98/D99 were hardened to distinguish **pre-create exceptions**, **ambiguous GitHub mutation outcome**, **post-create remote readback exceptions**, and **definitive HTTP 422 refusal**. Definitive errors are never adopted via a later matching ref. In-memory tests model late competing refs including the *same exact Git commit SHA*.
- Fast suite **836/836 PASS**, recovery **79/79**, resource **11/11**, feasibility **136/136**, `pnpm typecheck:max-strict`, `pnpm build`, `pnpm test:github-e2e:compile` (3 bundles), `pnpm validate:package`, `pnpm validate:metadata` all PASS.
- New full-path test cases: authenticated backup creation with independent old-source HEAD advance, lost POST, post-create ref GET failure, preexisting identical ref, HTTP 422, lost initiator lease just before POST, wrong original passphrase, failed WAL intent; D100 correct 3-role proof, forged/misaligned backup/scratch evidence, unproven Windows durability, concurrent local changes, removed/retargeted backup ref after prior proof and default-branch drift. Full V4 authenticated ciphertext verifies in mock GitHub clients, not live GitHub.
- Real GitHub E2E **not run this stage**. Earlier D98 attempt stopped before network mutations because locally configured `.env.github-e2e` is missing the mandatory numeric `GITHUB_E2E_EXPECTED_REPO_ID`. Do not invent or bypass that pin. No actual Obsidian two-device/mobile acceptance and no user-vault writes.

## Why not enabled

This is NOT a complete trusted migration coordinator. Three critical engineering gaps remain before exposing actual Re-encrypt:

1. **Crash-durable Node.js-only Windows publication WAL** — D86 `acquireV4DesktopRekeyWalStorage(...).assertCrashDurable()` demonstrably fails where Windows directory fsync yields `EPERM`. A provided `assertCrashDurable` callback in D100 can be mocked and cannot prove power-loss persistence, as reports correctly indicate. The entire source/backup/blob/tree/commit/ref/cutover intent chain still needs real restartable encrypted WAL, lock ownership and cross-process crash tests before remote writes may be considered production safe.
2. **Trusted orchestrator/source+destination staging** — D99/D100 accept prebuilt verified reports; no single production function yet acquires a real source lease, verifies local edits, persists destination credentials securely, invokes D79 staging and D85 scratch restore, handles restart and atomically switches only the initiating device branch/key/index. A failed action must never silently overwrite old work.
3. **End-to-end platform acceptance** — pinned numeric disposable real GitHub repository E2E, exact 3-ref migration with cleanup, 2-device installed Obsidian Windows and mobile restore, cancellation/crash/rate-limit cases, UX screenshots, security/resource review. Physical test file cap stays at 100 MB. Other devices remain on independently syncing old Source until manually changed.

Release gate `docs/release-gates/reencryption-wizard.json` remains **`status:"blocked"`** with only topology accepted; Settings entry remains **Preview wizard**, not production migration. No Native OS Helper, GitHub Actions or durability waiver.
