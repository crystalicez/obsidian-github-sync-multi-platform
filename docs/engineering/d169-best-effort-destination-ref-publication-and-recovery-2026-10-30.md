# D169 — Authenticated best-effort Destination ref publication and recovery

Date: 2026-10-30. Status: internal guarded implementation, **not production enabled**. First-public-release Re-encryption Wizard remains **blocked**.

## Context

After D166 frozen Backup, D167 Destination ciphertext Staging and D168 zero-parent orphan candidate preparation, the existing D102 three-branch Destination publication still unconditionally required successful directory fsync through Node's `assertCrashDurable()`. The owner approved a best-effort approach when Windows does not support directory fsync, with explicit risk warning, authenticated WAL readback and Manual Recovery rather than claiming physical power-loss durability.

## Implementation

`publishV4BestEffortJournaledThreeBranchDestination()` is a separate, explicitly acknowledged internal entrypoint in `reencryption-ref-journal-coordinator.ts`. It verifies the live cooperative WAL lease and uses the D165/D166 authenticated best-effort checkpoint (three stable filesystem readbacks, two AES-GCM journal snapshots pinned to source commit, Destination repo and exact WAL generation). The original strict entrypoint still uses `assertCrashDurable()`.

Both paths share one high-level D102 coordinator. It checks exact pinned frozen Backup ref observation, complete staged Git Blob receipts, candidate preparation fingerprint, and sealed zero-parent candidate manifest. Before the create-only Destination Git ref POST it records one exact pending ref intent in the encrypted WAL. The existing D100 publisher remains the single implementation of Source/Backup physical repository and ref guards, isolated scratch Backup restore, full initiating Vault file SHA-256 parity, source configuration/lock guard, one-shot GitHub ref creation and full NEW-key encrypted Destination readback. The engine calls the authenticated WAL checkpoint again at every publication guard, then authenticates and records the Destination ref readback in the WAL before returning.

`reconcileV4PendingOrphanWithJournalBestEffort()` provides separate read-only Recovery when the GitHub response or subsequent readback is unknown. It requires the exact pending Destination ref intent, pinned Backup and prepared-candidate evidence, rechecks GitHub Backup, then verifies the exact Destination commit and decrypts all new-key ciphertext before storing a verified observation in the WAL. It **never** calls createGitRef a second time. Missing, conflicting, moved, corrupted or unverifiable remote data remains pending and requires Manual Recovery; the remote ref is not overwritten.

The low-level three-branch publisher now uses a shared guarded implementation parameterized by a strict or best-effort WAL checkpoint. The risk token `accept-best-effort-power-loss-recovery-risk` is required by both the low-level and coordinator best-effort entrypoints. This does not make a fake durability proof, grant local Cutover or automatically remove the old passphrase. Source and frozen Backup retain independent branch roles.

## D169 verification and bug found

The new `reencryption-orphan-publication.test.ts` cases exercise: successful exact one-shot ref creation and full new-key readback; missing acknowledgement rejected before WAL/network writes; a damaged WAL after ref intent blocking the POST; lost GitHub create response with read-only recovery and no second POST; a conflicting ref after unknown response retaining the pending WAL; and a disposable **real Windows WAL** filesystem run reaching a verified destination observation while explicitly denying Cutover.

The first conflict test incorrectly expected all lost create responses to fail, even when immediate GitHub readback succeeds and verifies full contents. Corrected the simulated fault to make both POST response and the post-POST GitHub read unavailable. The conflict test now enters true pending/Manual Recovery and verifies that a subsequently changed remote ref is rejected without a retry. Focused Orphan tests **61/61 PASS**.

Full Fast, Recovery, Feasibility, Resource, maximum strict TypeScript, production build, GitHub E2E compile-only, package/metadata validation and bounded 100,000,000-byte SHA-256 cryptographic soak are local-only verification stages. The new GitHub calls in tests are mocked; no actual credentialed disposable GitHub migration, installed Obsidian acceptance or physical power-loss experiment was performed.

## Release blockers

No public Wizard Run entrypoint is connected to this internal flow. Safe local cutover across Settings, SecretStorage, Source/Shadow Index and authoritative Selector with restart/Manual Recovery still needs implementation and real installed cross-platform verification. First release must include a genuinely usable Re-encryption Wizard; do not mark `docs/release-gates/reencryption-wizard.json` passed until all gates and real E2E evidence are complete. There is no Native Helper or GitHub Actions.
