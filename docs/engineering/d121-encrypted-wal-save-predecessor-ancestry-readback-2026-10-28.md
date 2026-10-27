# D121 — Require intact authenticated predecessor before WAL write success

Date: 2026-10-28. **Re-encryption recovery safety hardening; first public release remains BLOCKED.**

## Verified defect (RED before change)

D120 made `createV4ReencryptionRecoveryJournal.save()` validate the **exact intended authenticated payload** of the newly written alternating slot. However, low-level `save()` could still report success after a write even if the **other slot carrying the previous generation** disappeared or became damaged during the write. The later `assertHealthySnapshot()` would reject such evidence, but the earlier low-level write acknowledgment incorrectly suggested that the full two-slot journal transition had succeeded.

Two new isolated test adapter fault injections in `tests/v4/reencryption-recovery-journal.test.ts` reproduced this exact false-success path **before the patch**:

- After the valid new g2 upload intent is stored, delete its old authenticated g1 predecessor. The write previously returned success even though later healthy readback correctly refuses the missing predecessor.
- After the valid new g2 upload intent is stored, corrupt its old authenticated g1 predecessor. The write previously returned success even though later healthy readback requires recovery.

Both injected cases failed with *Missing expected rejection* before applying the runtime fix.

## Runtime change

After authenticating and verifying the exact intended newest snapshot, `save()` reads the **alternate predecessor slot** as well:

- For the first generation (g1), the alternate slot must be completely absent, preventing implicit reuse of unexplained prior WAL data.
- For all later generations, the predecessor must be authenticated, belong to the same journal identity, have exactly `generation - 1`, and satisfy `isAdjacentWalTransition(predecessor, newest)`. Missing, damaged, out-of-sequence or non-ancestor predecessors cause `V4ReencryptionJournalRecoveryRequiredError`.
- No silent old-slot recreation, automatic retry, GitHub mutation, branch write, permission to publish or initiating-device cutover is introduced. Damaged WAL evidence is preserved for operator-guided recovery.

The check executes on the low-level `save()` path for **every** WAL operation. D120's exact-content check remains in place. Only one additional authenticated predecessor read is required for each save, not a second full reread of the target slot. This is an isolated core safety gate, not an assurance that the storage medium can survive physical power loss.

## Regression and limitations

- **RED→GREEN:** Two new disappearing/corrupt predecessor tests failed before the change, passed after it.
- Focused encrypted recovery WAL **32/32 PASS**, complete Fast **923/923**, Fast repeat **10×923/923** (exit 0, zero failures), Recovery **80/80**, Resource **11/11**, Feasibility **136/136**, Maximum Strict TypeScript and production build PASS. GitHub E2E **compile-only (3 bundles)**, package and metadata validation PASS. Bounded cryptographic Soak **100,000,000 bytes / 12 chunks** PASS, digest exactly matched reference SHA-256.
- The tests deliberately change the in-memory adapter *after the target write* to reproduce the corner case deterministically. They do not establish protection against an actively malicious OS mutator that swaps ancestor directories or edits files after the final check.
- Existing integration suites still exercise real Windows filesystem WAL storage, lease, kill/restart and encrypted Backup→Staging→Candidate→Destination lifecycle.

## Unchanged owner policy and release blockers

D90/D91 independent writable old-key Source, frozen same-repository Backup pinned to original SHA, and new-key zero-parent orphan Destination **in the same GitHub repository** remain mandatory. Do not auto-delete branches, force old clients to switch, enable GitHub Actions, promote a Native OS Helper, or waive crash durability. Windows Node-only directory `fsync EPERM` remains a hard blocker for physical power-loss safety. True initiating-vault cross-process write fence, crash-safe branch/passphrase/index cutover with key provenance, numeric-pinned same-repo live GitHub three-ref qualification and installed Windows/mobile multi-device acceptance are still required. Re-encryption Wizard Preview-only; `docs/release-gates/reencryption-wizard.json` stays `blocked`.
