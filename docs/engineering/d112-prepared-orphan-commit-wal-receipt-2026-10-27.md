# D112 — Encrypted prepared Orphan Commit receipt before Destination publication

Date: 2026-10-27. Status: **internal migration backend hardening; not an enabled Wizard or release-qualified migration**.

## Policy preserved

Owner decisions D90/D91 remain binding: same physical GitHub repository with independently writable old Source, immutable SHA-pinned old-key Backup, and a new orphan/zero-parent encrypted Destination; other devices are not paused or automatically switched. No GitHub Actions, no Native Helper architecture change, no automatic cleanup. No production permission to bypass D86 Windows directory fsync `EPERM`.

## Remaining ambiguity after D111

D111 wrote one-shot encrypted WAL evidence **before** attempting Git metadata Blob/Tree/Commit. D110 checked the prepared candidate's final SHA/tree/manifest before creating Destination Ref. Yet successful candidate preparation did **not** save its final verified zero-parent Git Commit/Tree as a separate post-creation WAL observation. A restarted process could retain only the pre-commit marker even after a successfully created but unreachable commit, while a different process could provide candidate references that were not the exact completed result of that preparation call.

## D112 change

- `V4ReencryptionPreparedCandidateReceipt` holds the exact zero-parent orphan `commitSha`, `treeSha`, and D110 final `manifestSha256`. This is stored **inside** the existing AES-GCM WAL payload as `preparedCandidateReceipt` (nullable on older pre-release journals); no passphrase, derived key or plaintext note data is added.
- `recordPreparedCandidateReceipt(receipt, expectedGeneration)` is a **generation-CAS, one-shot mutation**. Requires a D111 sealed preparation intent, fully observed frozen Backup, completed staged ciphertext inventory, no unresolved ref/blob intent and no prior receipt; rejects malformed SHA/digest and any receipt pointing back to the old Source commit. Journal `readSlot` validates the receipt and rejects any Destination ref that disagrees with it.
- The D111 guarded `prepareV4JournaledOrphanCandidate` now obtains and verifies Git objects with its existing remote readbacks, computes the D110 candidate manifest fingerprint, writes the **one-shot prepared receipt** and rechecks both-slot WAL health, exclusive OS lease, and `assertCrashDurable`. A failure **after** Git Commit creation but **before** receipt persistence leaves D111 preparation intent and **forbids blind retry or Branch publication**.
- D102 `publishV4JournaledThreeBranchDestination` and D103 read-only restart reconciliation both require the exact WAL receipt match with the caller's Commit/Tree and recomputed D110 manifest. The low-level WAL also rejects Destination ref creation unless an exact prepared receipt exists; merely providing a plausible commit SHA and a pre-commit marker is no longer sufficient. A receipt NEVER grants local device Cutover or permits automatic publication by itself.

## Verified regression coverage

- D112 WAL unit test checks missing, malformed, substituted and duplicate candidate receipts, restart persistence, encryption of manifest digest, refusal of forged Destination commit/tree, and inability to mutate a validated candidate receipt.
- D112 full Git mock verifies that the prepared receipt is written only after an actual zero-parent commit was created and checked, before any Destination Ref. Simulated post-commit WAL receipt failure leaves a sealed preparation intent and zero Destination ref operations, with no automatic repeat.
- Full local qualification: Fast **904/904 PASS**; Recovery **79/79**, Resource **11/11**, Feasibility **136/136**, maximum-strict TypeScript, production build, GitHub E2E compile-only (three bundles), package and metadata validation all PASS.
- No live GitHub three-ref mutation, physical power-cut test or installed Obsidian two-device/mobile migration was run. Disposable test data only; physical test files remain under 100 MB.

## Still blocked before production

D86 Windows Node-only directory `fsync EPERM` prevents proving crash/power-loss durable WAL for the actual initiating desktop. D112 records authenticated in-process and ordinary restart evidence but **cannot prove a write survived power loss**. Complete trusted same-run migration orchestration, fresh secret provenance, source/backup installed restore, a real cross-process Vault write fence, durable initiating-only Branch/Passphrase/Index Cutover and rollback remain unfinished. Credentialed real GitHub E2E still requires the owner-verified numeric `GITHUB_E2E_EXPECTED_REPO_ID` (never guess/bypass). Do not assert any key/branch change from the WAL receipt alone.

The release gate `docs/release-gates/reencryption-wizard.json` remains **`status:"blocked"`**; Settings Wizard remains **Preview-only**.
