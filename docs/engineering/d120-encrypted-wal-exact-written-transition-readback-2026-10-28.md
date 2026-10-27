# D120 — Verify exact WAL transition after authenticated write readback

Date: 2026-10-28. **Fail-closed encrypted WAL correctness hardening; re-encryption release remains BLOCKED.**

## Reproduced defect

The two-slot encrypted Re-encryption WAL `save()` implementation used to verify the newly written slot by calling `readSlot(generation % 2)` and checking **only** that the authenticated `generation` matched. Because two independently encrypted AES-GCM slots belonging to the **same journal identity/key/source/destination and generation** can contain **different legitimate phase transitions**, a stale/replaced same-generation sibling slot could be returned as successful evidence of the **wrong** upload intent, Backup/Destination ref intent, or prepared Git candidate receipt. D113's adjacent-slot transition check cannot rule out two different valid successors to the same predecessor: both can have valid MACs and consistent generations.

Two new regression tests **first failed on unpatched code**, demonstrating the exact false-success condition: the storage writer acknowledges the operation, but test-only intercepted storage makes the WAL readback contain a different valid encrypted same-generation sibling.

## Runtime fix

In `src/lib/v4/reencryption-recovery-journal.ts` the low-level `save()` now constructs the exact expected immutable `snapshot` from **all** caller-intended state: generation, staged Blob receipts, pending Blob intents, pending Git ref intents, observed Git refs, one-shot Staging handoff, preparation digest, and sealed candidate commit/tree/manifest receipt. After the real authenticated slot readback, it requires the full normalized serialized snapshot to match exactly, not merely the generation. Any mismatch throws `V4ReencryptionJournalRecoveryRequiredError` and **must not be interpreted as successful WAL persistence**.

This check applies to **every** WAL transition, including `begin()`, Blob intents/receipts, Backup and Destination intents/readbacks, Staging handoff and candidate preparation/receipt. It does not permit automatic clearing of a corrupted/replaced WAL, forced remote retry, ref publication or local cutover. Recovery still requires independent remote verification and operator review.

## Test cases

- **Sibling Blob upload intent:** Start an authenticated generation-1 journal. Independently create a same-key/same-run valid generation-2 encrypted slot for Blob B. Intercept a caller's attempted WAL Blob A write and substitute the valid Blob B slot as the readback. The save operation must throw `V4ReencryptionJournalRecoveryRequiredError` rather than return a successful Blob A intent. The observed WAL continues to require remote revalidation; no publish/cutover flags are ever granted.
- **Sibling prepared Git candidate:** Advance a journal through Backup intent, exact Backup readback, Staging handoff and candidate preparation digest. Independently prepare a valid next-generation encrypted WAL slot referring to another candidate commit SHA. Intercept the intended prepared Git candidate receipt with that slot; the save must refuse success even though the slot's authentication and generation are correct.

Both tests initially failed under the original code, then passed after exact content checking. Existing D113/D114 encrypted WAL ancestry tests, D116 real disk restart and lost-response tests, and D117 independent OS kill recovery remain unchanged.

## Verification and limitations

- Focused journal suite **30/30** PASS.
- Full Fast **921/921**, repeated Fast **10×921/921** (exit 0, no failures), Recovery **80/80**, Resource **11/11**, Feasibility **136/136**, Maximum Strict TypeScript, Production Build, GitHub E2E **compile-only (3 bundles)**, package and metadata validation PASS.
- Cryptographic Soak **100,000,000 bytes / 12 chunks / two parts**, full SHA-256 matched independent reference, exit 0.
- This is deliberately hostile **test adapter** injection of an authenticated sibling state, not a claim that the actual filesystem spontaneously produces such a state. It is nevertheless a concrete code-path defect where an authenticated readback could be mistaken for a successful requested write.
- No live GitHub test-repository writes, user-vault mutations, installed two-device Obsidian migration, Native Helper promotion, GitHub Actions or first-public release performed.

## Unchanged production hard blockers

Real Windows Node-only directory `fsync EPERM` prevents certifying power-loss durable WAL. Independent OS-wide initiating-vault edit fence, crash-safe initiating-only branch/passphrase/index cutover, trusted new-key provenance and recovery, numeric-pinned same-repository three-ref GitHub qualification, and installed Windows/mobile acceptance remain mandatory. D90/D91 independent writable old Source + frozen Backup + zero-parent orphan new-key Destination topology stays fixed. Re-encryption Wizard remains Preview-only, `docs/release-gates/reencryption-wizard.json` remains `blocked`.
