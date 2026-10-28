# D144 — Source-phase versus Destination-phase continuity is not an atomic snapshot

Date: 2026-10-28. **Re-encryption Wizard remains Preview-only, release gate remains blocked.**

## Discovered incompatibility

D143's `inspectV4ReencryptionLiveBackupCrossSurface()` wraps D138 and D136, and requires the active local Index and saved initiating-device Settings to remain at **Source** (original branch + original passphrase Secret ID). Its strongest observation is `all-three-ref-evidence-coherent-uncommitted`.

D142's `inspectV4ReencryptionProposedCommitAfterRestart()` requires the active local Index **and** saved initiating-device Settings to select **Destination** (new branch + new passphrase Secret ID), and observes an authenticated hypothetical marker with uncommitted status.

These preconditions are **mutually exclusive on one stable active-index root and one Settings snapshot**. It is therefore incorrect to call D143 followed by D142 and claim that both successes prove an atomic local commit: **there must be a local selection transition between them**, and D140/D141 showed that its Settings + Index + SecretStorage persistence and recovery are not independently qualified after power loss. A returned D143 report does not freeze the Git refs or local storage forever. A D142 marker is test-only, never a durable committed receipt.

## New diagnostic-only code and tests

`src/lib/v4/reencryption-phase-continuity.ts` exports `auditV4ReencryptionCrossPhaseContinuity()`, a **pure, no-I/O**, non-authorizing preflight comparing **caller-supplied** D143 Source-phase inputs with D142 Destination-phase inputs. It pins run, source index root, device, WAL generation, three branches, Source Git commit/tree, Destination Git commit/tree, both Secret IDs, the candidate zero-parent status and physical GitHub repository ID. It independently reconstructs the candidate manifest SHA-256 from the provided Shadow record snapshot, D143 candidate and expected remote receipts. It rejects source/shadow adapter/lease mismatches, differing cross-phase lease holders, WAL reader/storage adapter/SecretStorage callbacks, journal Source/Destination identities, remote Destination commit SHA, wrong settings scopes, changed branch, invalid digest and mismatched identities. It also rejects missing essential proof contexts rather than treating two absent lease holders as a match. All of this is **only cross-phase identity consistency**: the provided Shadow records and inputs are not independently authenticated by this pure function.

This preflight checks **in-process object/callback identity** for the two supplied phase inputs. Across an actual process restart those objects will be re-created, so the preflight cannot serve as a persisted cross-restart attestation; a future receipt would need independent authenticated serializable identities instead.

A positive diagnostic is called `identities-consistent-but-phases-sequential`, **not** `ready` or `committed`. Both positive and rejected reports hardcode `singleAtomicSnapshotProofPossible:false`, `persistentTransitionAuthenticated:false`, `localCutoverAuthorized:false`, `resumeSyncAuthorized:false`, `rollbackAuthorized:false`, `remoteWritesAuthorized:false`, `oldPassphraseCleanupAuthorized:false`.

`tests/v4/reencryption-phase-continuity.test.ts` uses the actual destination manifest digest implementation, an actual orphan plan and nonsecret pinned identities. All adapter, WAL, GitHub and SecretStorage mock readers throw if invoked: a passing positive test verifies **zero I/O**. Tests cover matching sequential identity without authorization; inability of one shared Settings object to satisfy both source/destination stages; wrong run/WAL/branches/Git SHAs/trees/manifest/device/key IDs and physical repository; changed adapter, WAL, lease/durable and secret callbacks; missing/extra Shadow records and null inputs; and snapshot mutation after a returned immutable diagnostic.

The preflight is not wired into Wizard/Sync and **does not modify** Index, Vault, GitHub, Settings, SecretStorage or WAL. The inherited input types can carry a destination passphrase, journal key and secret lookup callback; the audit neither reads those values nor serializes/returns the input. Never log or persist the input context as diagnostic evidence.

## Architecture decision still outstanding

A safe full implementation must choose a legitimate transaction authority and recovery design:

- **A — Immutable local Source and Shadow roots with one separately defined authoritative local selector, journaled transition and independent crash-durability qualification.** This avoids overwriting the Source cache before a durable Destination selection, but the selector must remain reconcilable with Obsidian Settings, SecretStorage and power-loss semantics. Recommended as a *design direction*, not an approved implementation.
- **B — Overwrite the existing active Index in place, keep a separately recoverable exact Source snapshot and authenticated per-step journal, then reconcile each torn Settings/Index state.** More potentially destructive intermediate states and more complicated rollback/crash reasoning; no reliable atomicity proof today.
- Do **not** relax strict crash-safety into best-effort, call `saveData()` readback a power-loss commit, or embed a Native Helper in release without explicit owner approval. Existing isolated Native OS Helper PoC permission is not rollout approval.

The next substantive production step depends on this architectural choice **and** validated filesystem/Obsidian persistence guarantees on Windows/macOS/Linux/Android/iOS. No platform is currently qualified for Re-encryption cutover: Node-only Windows directory fsync reports EPERM, other physical acceptance is absent. Real live disposable GitHub three-ref acceptance, writer exclusion, full two-device installed Obsidian acceptance and security tests also remain pending. Source branch retains its owner-approved syncability; frozen Backup and orphan Destination remain separate.

No GitHub Actions, branch deletion, forced ref mutation, live personal Vault modification, local cutover or release took place. **Final verification:** focused D144 6/6, full Fast 1043/1043, final exact-source isolated Fast repeat **10×1043/1043 PASS (exit 0, zero failures)**, Recovery 88/88, Resource 11/11, Feasibility 136/136, Maximum Strict TypeScript, Production Build, GitHub E2E compile-only three bundles, release metadata/package validators and reference SHA-matched 100 MB crypto soak PASS. The earlier repeat attempts interleaved with changing D144 tests/guards were not accepted as proof; only the final unchanged-source repeat was used. Commit identity and remaining release blockers are recorded in `HANDOFF-NEXT-SESSION.md`.
