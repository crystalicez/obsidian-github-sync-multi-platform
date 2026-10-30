# D168 — Best-effort orphan candidate preparation

Date: 2026-10-30. Status: internal implementation; public Re-encryption Wizard and first-release gate remain blocked.

## Change

D167 delivered best-effort encrypted Destination Git Blob Staging after verified frozen Backup. The subsequent Git metadata/Tree/zero-parent Commit preparation in `prepareV4JournaledOrphanCandidate()` still required directory `fsync` via `assertCrashDurable()`, which Windows Node rejects. The owner-approved best-effort policy permits proceeding with explicit warnings and Manual Recovery when evidence is uncertain; it does not justify blind mutation retries or local Cutover.

D168 adds a separate `prepareV4BestEffortJournaledOrphanCandidate()` internal entrypoint with mandatory literal acknowledgement `accept-best-effort-power-loss-recovery-risk` and live WAL lease/readback methods. The strict entrypoint remains unchanged. Both paths use the **same** candidate preparation/verification logic with their own WAL checkpoint: strict `hold(assertCrashDurable)` or the existing D165/D166 authenticated best-effort three-readback/two-AES-GCM-snapshot inspection, pinned to the exact WAL generation, Source commit and Destination repository. No fake crash durability claim and no second orphan Git object creator.

## Safety invariants

- The journal must already contain a completed verified frozen Backup observation and a completed staged ciphertext receipt inventory with no pending uploads or ref mutations.
- A one-shot SHA-256 candidate preparation fingerprint is journaled before any metadata Git Blob, Tree or Commit POST. The fingerprint binds original Source config, new Destination encryption config, device/journal identifiers, creation time, staged records and ciphertext receipts.
- Every metadata Blob/Tree/Commit POST boundary re-checks the authenticated WAL generation, candidate fingerprint and absence of unresolved mutation intents. Each candidate Git object must match its SHA and the final unreferenced Git commit must have zero parents. The exact candidate receipt is separately written and authenticated before success is returned.
- A lost POST response, torn/unreadable WAL, generation drift, changed caller-owned manifest, or post-commit receipt failure never permits automatic retry, Destination ref publication, local Cutover or deletion of old secrets. The unresolved preparation remains as evidence for explicit Manual Recovery.

## Tests

New D168 tests in `tests/v4/reencryption-orphan-publication.test.ts` exercise the existing one-shot GitHub mock object writer and real AES-GCM WAL journal. They verify: full metadata/Tree/zero-parent Commit creation and exact authenticated receipt without a Git ref; refusal of missing risk acknowledgement before any I/O; failed WAL readback after intent persistence with zero metadata writes and refusal of repeat; ambiguous Git Blob response with exactly one POST and no repeat; mutated sealed manifest after first Blob with no later Tree/Commit; and a disposable real Windows Node WAL backing with the matching authenticated candidate receipt.

Focused orphan tests, Full Fast, Recovery, Feasibility, Resource, maximum strict TypeScript, Production Build and local tooling checks pass as noted in the handoff. All GitHub mutations in these new tests are mocked; no credentialed GitHub E2E or installed Obsidian migration was run.

## Remaining work

D168 stops at an **unreferenced** orphan commit. Separate best-effort Destination ref publication must still bind exact WAL ref intent, freshly verify Source/Backup/initiator parity and fully decrypt/read back the new Destination before reporting remote publication. Cross-store local Settings/SecretStorage/active Index Cutover, deterministic Manual Recovery UI, real disposable GitHub and native Desktop/Mobile acceptance remain open. Keep Source and Backup branches intact. `docs/release-gates/reencryption-wizard.json` remains `blocked`.
