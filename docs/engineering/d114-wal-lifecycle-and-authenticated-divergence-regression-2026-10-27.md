# D114 — Re-encryption WAL phase-by-phase restart and authenticated sibling regression

Date: 2026-10-27. **Test-only production hardening; release gate remains BLOCKED.**

## Scope and rationale

D113 requires adjacent AES-GCM-authenticated, same-run WAL slots to encode precisely one permitted state transition, not just numerically consecutive generations. A fail-closed check is only safe if it accepts **every actual transition** used by the three-branch flow and rejects plausible independently authenticated but contradictory siblings. D113 covered an upload intent→receipt pair and an incompatible Blob A/Blob B pair; D114 expands coverage without changing persistence, encryption, GitHub behavior, UI or user settings.

## Added reproducible tests

File: `tests/v4/reencryption-recovery-journal.test.ts`.

1. Exercise the real WAL API over **every generation**, from begin → Backup intent → Backup readback → Staging handoff → Blob intent → Blob receipt → Candidate pre-commit preparation digest → prepared Git commit/tree/manifest receipt → Destination intent → Destination ref readback. After **each** transition, instantiate a fresh journal, require `load()` equality and `assertHealthySnapshot(generation)` equality. At no point may WAL evidence alone permit publishing or local cutover; remote revalidation remains required.
2. Construct two separately valid encrypted same-run histories, splice gen-2 Backup ref intent from one into the gen-3 Backup readback of the other, with a **different authenticated tree SHA**. `load()`, healthy readback and mutation all fail closed. Assert that refused mutation leaves raw WAL files untouched.
3. Splice a valid gen-5 pre-commit preparation digest from one run history into another's gen-6 prepared Candidate commit receipt with a **different authenticated preparation SHA-256**. Reading and downstream Destination intent both fail closed.
4. Splice a valid gen-6 prepared Git commit receipt from one history into gen-7 Destination intent from another with a **different authenticated Git commit SHA**. Reading and healthy mutation precondition both reject the pair.

The fixture intentionally reuses **the same key, run ID, Source SHA and Destination repository identity** across different legal histories. Thus the negative cases challenge the *transition ancestry* rule, not basic AES-GCM authentication or slot header validation.

## Qualification

- WAL focused regression: **28/28 PASS** (four new D114 cases); Maximum Strict TypeScript: PASS.
- Full Fast **910/910**, repeat **10 complete Fast rounds × 910/910**, Recovery **79/79**, Resource **11/11**, Feasibility **136/136**, Build, GitHub E2E **compile-only (3 bundles)**, package and metadata validation: PASS.
- No credentialed real-GitHub sync/test-repository mutations, installed real Obsidian 2-device E2E, local user-vault writes, filesystem power-off test or device cutover performed. Version-control publication of this audit branch is separate from migration acceptance.
- File mutation is test-only; source runtime logic and all existing published formats remain untouched.

## Release boundary remains unchanged

This provides evidence for permitted transitions and rejected **inconsistent adjacent siblings** only. It is not a cryptographic chain across all past WAL generations, not a proof against forged WAL with a stolen key, and not OS power-loss durability or a cross-process Vault write fence. Windows Node-only directory `fsync EPERM` still blocks the durable production migration claim. Initiator-only crash-safe branch/passphrase/local-index cutover, new-key provenance, multi-device/mobile acceptance and pinned numeric `GITHUB_E2E_EXPECTED_REPO_ID` live same-repository three-branch qualification remain pending.

Owner D90/D91 policy is unchanged: independently writable old Source, frozen Backup and new encrypted zero-parent orphan Destination in the same repository. No force-push/pull, automatic other-device migration, branch cleanup, GitHub Actions, Native Helper promotion, durability waiver or release. `docs/release-gates/reencryption-wizard.json` remains `blocked` and the Wizard is Preview-only.
