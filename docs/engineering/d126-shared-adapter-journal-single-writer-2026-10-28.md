# D126 — One live Node adapter cannot have two concurrent encrypted WAL journal writers

Date: 2026-10-28. **WAL integrity hardening only; Re-encryption remains RELEASE BLOCKED.**

## Reproduced defect (RED before implementation)

The two-slot encrypted `V4ReencryptionRecoveryJournal` historically had an instance-local `busy` field. Different journal objects constructed over the **same** `V4LocalIndexAdapter` each had a separate busy flag. In a real desktop migration, one `acquireV4DesktopRekeyWalStorage()` lease exposes one adapter, and different internal components could construct separate journal objects with that adapter. Both could observe g1 and attempt distinct g2 transitions before either completed the write/readback. The per-instance flag could not serialize the full `observe() → generation check → save()` transaction.

New deterministic `tests/v4/reencryption-recovery-journal.test.ts` uses one in-memory adapter, two journal instances, and an async barrier at the first g2 write. It proves that a second journal can proceed toward an incompatible same-generation write while the first is still pending. **On original code the regression failed** because the second instance was not rejected while the first was in flight; the alternate candidate write was observable. This is separate from D119's directory-fsync proof and D120/D121's exact slot-readback/ancestry checks.

## Runtime change

`src/lib/v4/reencryption-recovery-journal.ts` now maintains a module-level `WeakSet<V4LocalIndexAdapter>` tracking adapters in the middle of a journal operation. Inside `locked()`, it synchronously checks both the journal's own `busy` state **and** whether the shared adapter is already active, claims that adapter before the first `await`, and releases it in `finally` on success **or** error. This prevents separately constructed journal instances sharing an adapter from concurrently observing and writing the same generation. `load()` now uses the same operation guard to avoid returning a concurrent, intermediate view; `assertHealthySnapshot()` and all journal mutations already used `locked()`.

The fix neither queues nor retries a rejected operation, nor clears existing WAL. Instead it raises `V4ReencryptionJournalRecoveryRequiredError` without beginning a second write. Cryptographic WAL format, run identity, saved generation, and manual-recovery policy are unchanged.

## Test evidence and real filesystem behavior

- **RED→GREEN:** one deterministic same-adapter, same-generation concurrent journal-instance test. After the change, only the first g2 upload intent is written, its exact authenticated healthy snapshot survives, and the second attempt plus a concurrent read-only `load()` fail closed. Focused encrypted Recovery Journal **33/33 PASS**.
- A second regression in `tests/v4/reencryption-desktop-wal.test.ts` acquires one **real Windows Node filesystem** exclusive lease, then runs two independently constructed journals over that lease's actual adapter. Exactly one g2 record is persisted, one is rejected, and the full healthy WAL still has `permissionToPublish:false` and `cutoverAuthorized:false`. Desktop WAL focused **20/20 PASS**.
- Existing D86 independent child-process `wx+` lock exclusion, stale-lock refusal, D117 independent-process SIGKILL/recovery, D118 symlink/hardlink checks and D119 fsync fail-closed tests remain unchanged and are re-run in the full verification suite.
- Full Fast **932/932**, Fast repeat **10×932/932** (exit 0, no failures), Recovery **80/80**, Resource **11/11**, Feasibility **136/136**, Maximum Strict TypeScript, Production Build, GitHub E2E compile-only (3 bundles), package and metadata validation PASS. Bounded cryptographic Soak **100,000,000 bytes / 12 chunks / 2 parts** PASS, reference SHA-256 matched exactly.

## Important limitations — NOT a vault-wide fence

A JavaScript `WeakSet` is process-local and keyed by **adapter object identity**. It does **not** coordinate unrelated adapters, other Node processes, different OS processes, or any Obsidian editor/external process writing to Vault files. Cross-process exclusion for the WAL relies on the existing OS `wx+` lock file and its identity checks; it still leaves a non-reclaimable lock on unclean shutdown. The helper cannot resolve Windows Node-only directory `fsync EPERM` for physical power-loss durability. Never interpret either proof as permission to enable migration or initiating-device Branch/Passphrase/Index cutover.

Owner-approved D90/D91 remains independent writable old Source, frozen Backup pinned at the original SHA and a new-key, zero-parent orphan Destination **in the same GitHub repository**, with manual peer cutover and no automatic branch deletion. No GitHub Actions, Native Helper promotion, durability waiver, live user Vault mutation or real GitHub test-repository write was performed. Full OS-wide Vault write fencing, hardware power-loss-safe WAL, crash-safe local cutover/key provenance, pinned numeric-ID same-repo live GitHub acceptance and installed Windows/mobile multi-device tests remain release blockers. Re-encryption Wizard stays Preview-only and `docs/release-gates/reencryption-wizard.json` stays `blocked`.
